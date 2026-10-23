'use strict';
/**
 * Cartblox multiplayer server.
 *  - one WebSocket endpoint (same port as the tiny HTTP API)
 *  - players are grouped into rooms per game ("obby#1", "baseplate#1", "place:abc#1" ...)
 *  - clients send their own position ~15x/sec, the server relays everybody's position back
 *  - chat normally goes through Firebase; the server also relays chat as a fallback
 *  - tools are SERVER-SIDED: the server owns everyone's health and KOs, checks every hit (range, damage
 *    limits, spawn forcefield, rate) and tells the whole room what happened
 *  - "Server" scripts in CartStudio games send their world changes through the server, which shares them with
 *    everyone and remembers them for players who join later. The first player in a room is its "host" and runs
 *    timer scripts for everybody.
 * Render gives us the port in $PORT and expects us to listen on 0.0.0.0.
 */
const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = parseInt(process.env.PORT, 10) || 10000;
const MAX_PLAYERS = parseInt(process.env.MAX_PLAYERS, 10) || 16;   // per room instance
const TICK_MS = 66;                                                 // ~15 snapshots per second
const VERSION = 4;                                                  // the website checks this (tools + server scripts need 4)
const SPAWN_FF = 3200, REGEN = 1.2;                                 // forcefield after spawning (ms), health regen per second
const MAX_HIT = { m: 30, r: 60 }, MAX_RANGE = { m: 28, r: 700 };    // melee / ranged: biggest single hit and reach
const rooms = new Map();                                            // key -> { key, game, players:Map, dirty }
let nextId = 1;

/* ---------- small helpers ---------- */
const clean = (s, n) => String(s == null ? '' : s).replace(/[^\w \-.]/g, '').trim().slice(0, n);
const num = (v, lim) => { v = Number(v); return Number.isFinite(v) ? Math.max(-lim, Math.min(lim, v)) : 0; };
const r2 = v => Math.round(v * 100) / 100;
const hex = v => (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v)) ? v : '#cccccc';
const PARTS = ['head', 'torso', 'armL', 'armR', 'legL', 'legR'];
function cleanLook(l) {
  l = l && typeof l === 'object' ? l : {};
  const colors = {}, eq = {};
  for (const k of PARTS) colors[k] = hex(l.colors && l.colors[k]);
  if (l.eq && typeof l.eq === 'object') {
    let n = 0;
    for (const k of Object.keys(l.eq)) {
      if (n++ >= 16) break;
      if (/^[a-z]{2,12}$/.test(k) && typeof l.eq[k] === 'string' && /^[\w:\-]{1,48}$/.test(l.eq[k])) eq[k] = l.eq[k];
    }
  }
  return { colors, eq };
}
const send = (ws, obj) => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); };
function broadcast(room, obj, except) {
  const msg = JSON.stringify(obj);
  for (const p of room.players.values()) if (p !== except && p.ws.readyState === 1) p.ws.send(msg);
}
const pub = p => ({ id: p.id, name: p.name, look: p.look, s: p.s });
const vec = (a, lim) => [0, 1, 2].map(i => r2(num(Array.isArray(a) ? a[i] : 0, lim)));
function allow(c, key, perSec) {                                  // simple per-player rate limit
  const now = Date.now(), b = (c.rl = c.rl || {})[key] || (c.rl[key] = { t: now, n: 0 });
  if (now - b.t >= 1000) { b.t = now; b.n = 0; }
  return ++b.n <= perSec;
}

function getRoom(game) {
  for (let i = 1; ; i++) {                       // first instance of this game that still has space
    const key = game + '#' + i;
    let r = rooms.get(key);
    if (!r) { r = { key, game, players: new Map(), dirty: false }; rooms.set(key, r); return r; }
    if (r.players.size < MAX_PLAYERS) return r;
  }
}
function pickHost(r) {
  const first = r.players.values().next().value || null;
  if (first && r.host !== first.id) { r.host = first.id; broadcast(r, { t: 'host', id: r.host }); }
  else if (!first) r.host = null;
}
function leave(c) {
  const r = c.room; if (!r) return;
  r.players.delete(c.id); c.room = null;
  broadcast(r, { t: 'leave', id: c.id });
  if (!r.players.size) rooms.delete(r.key); else if (r.host === c.id) pickHost(r);
}
function kill(r, tgt, byId) {                                      // the server decides when someone is knocked out
  if (!tgt.alive) return;
  tgt.alive = false; tgt.hp = 0;
  const out = { t: 'die', id: tgt.id };
  const killer = byId != null ? r.players.get(String(byId)) : null;
  if (killer && killer !== tgt) { killer.kos++; out.by = killer.id; out.kos = killer.kos; }
  broadcast(r, out);
}
// a script action from a CartStudio game: the server checks its shape, then shares it (it can't know the game's rules)
const SAFE_KEY = /^[a-z]{1,5}:\d{1,7}$/;
function cleanAction(a) {
  if (!a || typeof a !== 'object' || Array.isArray(a) || typeof a.a !== 'string' || !/^[a-z]{1,8}$/.test(a.a)) return null;
  const out = {}; let n = 0;
  for (const k of Object.keys(a)) {
    if (++n > 12 || !/^[a-z]{1,6}$/.test(k)) return null;
    const v = a[k];
    if (typeof v === 'number') { if (!Number.isFinite(v)) return null; out[k] = Math.max(-1e6, Math.min(1e6, v)); }
    else if (typeof v === 'string') out[k] = v.replace(/[\u0000-\u001f<>]/g, '').slice(0, 200);
    else if (typeof v === 'boolean') out[k] = v;
    else if (Array.isArray(v) && v.length <= 3 && v.every(x => typeof x === 'number' && Number.isFinite(x))) out[k] = v.map(x => Math.max(-1e5, Math.min(1e5, x)));
    else return null;
  }
  return out;
}

/* ---------- HTTP (health check + stats for the website) ---------- */
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Cache-Control': 'no-store' };
function stats() {
  const games = {}; let total = 0;
  for (const r of rooms.values()) { games[r.game] = (games[r.game] || 0) + r.players.size; total += r.players.size; }
  return { ok: true, v: VERSION, players: total, games, rooms: rooms.size };
}
const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  const url = (req.url || '/').split('?')[0];
  if (url === '/stats') { res.writeHead(200, { ...cors, 'Content-Type': 'application/json' }); return res.end(JSON.stringify(stats())); }
  if (url === '/health') { res.writeHead(200, { ...cors, 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true, v: VERSION })); }
  res.writeHead(200, { ...cors, 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Cartblox server is running. Players online: ' + stats().players + '\n');
});

/* ---------- WebSocket game protocol ---------- */
const wss = new WebSocketServer({ server, maxPayload: 8 * 1024 });
wss.on('connection', ws => {
  const c = { id: String(nextId++), ws, room: null, name: '', look: cleanLook(null), s: { x: 0, y: 0, z: 0, ry: 0, f: 0, st: 1 }, lastState: 0, chatT: 0,
    hp: 100, alive: true, ff: Date.now() + SPAWN_FF, kos: 0, lastHitBy: null, lastHitT: 0, healT: 0 };
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  const joinTimer = setTimeout(() => { if (!c.room) ws.close(1008, 'join timeout'); }, 10000);
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;
    const now = Date.now();
    switch (m.t) {
      case 'join': {
        if (c.room) return;
        const game = String(m.game || '');
        if (!/^[\w:\-]{1,40}$/.test(game)) return ws.close(1008, 'bad game');
        c.name = clean(m.name, 20) || ('Player' + c.id);
        c.look = cleanLook(m.look);
        const room = getRoom(game);
        if (!room.log) room.log = new Map();
        c.room = room; room.players.set(c.id, c);
        if (!room.host) room.host = c.id;
        clearTimeout(joinTimer);
        c.ff = now + SPAWN_FF;
        send(ws, { t: 'welcome', v: VERSION, id: c.id, host: room.host, room: room.key, max: MAX_PLAYERS, players: [...room.players.values()].filter(p => p !== c).map(pub), hp: [...room.players.values()].filter(p => p !== c).map(p => [p.id, Math.round(p.hp)]), log: [...room.log.values()] });
        broadcast(room, { t: 'join', p: pub(c) }, c);
        break;
      }
      case 'state':
        if (!c.room || now - c.lastState < 30) return;                 // max ~30 updates per second per player
        c.lastState = now;
        c.s = { x: num(m.x, 5000), y: num(m.y, 5000), z: num(m.z, 5000), ry: num(m.ry, 7), f: (m.f | 0) & 255, st: (m.st | 0) & 255 };
        c.room.dirty = true;
        break;
      case 'chat': {                                                    // fallback chat (the site normally uses Firebase)
        if (!c.room || now - c.chatT < 400) return;
        c.chatT = now;
        const text = String(m.text == null ? '' : m.text).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 120);
        if (text) broadcast(c.room, { t: 'chat', id: c.id, name: c.name, text });
        break;
      }
      case 'die': {                                                     // I fell in lava, reset, or a script knocked me out
        if (!c.room || !c.alive) return;
        // credit the KO to whoever hit me in the last 6 seconds (knocked off a ledge counts!)
        kill(c.room, c, c.lastHitBy && now - c.lastHitT < 6000 && c.room.players.has(c.lastHitBy) ? c.lastHitBy : null);
        break;
      }
      case 'hit': {                                                     // tool damage: the SERVER checks it and applies it
        if (!c.room || !allow(c, 'hit', 25) || !c.alive) return;
        const tgt = c.room.players.get(String(m.to));
        if (!tgt || tgt === c || !tgt.alive || now < tgt.ff) return;
        const w = m.w === 'm' ? 'm' : 'r';
        if (Math.hypot(tgt.s.x - c.s.x, tgt.s.y - c.s.y, tgt.s.z - c.s.z) > MAX_RANGE[w]) return;          // too far away: ignored
        const d = Math.max(0, Math.min(MAX_HIT[w], Math.round(Number(m.d) || 0))); if (!d) return;
        tgt.hp = Math.max(0, tgt.hp - d); tgt.lastHitBy = c.id; tgt.lastHitT = now;
        send(tgt.ws, { t: 'hurt', by: c.id, hp: Math.round(tgt.hp), d, kb: vec(m.kb, 200) });
        broadcast(c.room, { t: 'hp', id: tgt.id, hp: Math.round(tgt.hp) }, tgt);
        if (tgt.hp <= 0) kill(c.room, tgt, c.id);
        break;
      }
      case 'heal': {                                                    // Cartblox Cola, "Heal the player" scripts
        if (!c.room || !c.alive || !allow(c, 'heal', 2)) return;
        const d = Math.max(-100, Math.min(100, Math.round(Number(m.d) || 0))); if (!d) return;
        c.hp = Math.max(0, Math.min(100, c.hp + d));
        broadcast(c.room, { t: 'hp', id: c.id, hp: Math.round(c.hp) }, c);
        if (c.hp <= 0) kill(c.room, c, null);
        break;
      }
      case 'self': {                                                    // I hurt myself (my own rocket)
        if (!c.room || !c.alive || !allow(c, 'self', 10)) return;
        c.hp = Math.max(0, c.hp - Math.max(0, Math.min(100, Math.round(Number(m.d) || 0))));
        broadcast(c.room, { t: 'hp', id: c.id, hp: Math.round(c.hp) }, c);
        if (c.hp <= 0) kill(c.room, c, null);
        break;
      }
      case 'sx': {                                                      // a "Server" script action from a CartStudio game
        if (!c.room || !allow(c, 'sx', 20)) return;
        const a = cleanAction(m.a); if (!a) return;
        const out = { t: 'sx', id: c.id, a };
        if (m.all === true) { if (c.room.host !== c.id) return; out.all = true; }      // "every player" actions only from the host
        if (typeof m.k === 'string' && SAFE_KEY.test(m.k)) {                          // world changes are remembered for late joiners
          const log = c.room.log; log.delete(m.k); log.set(m.k, a);
          if (log.size > 400) log.delete(log.keys().next().value);
        }
        broadcast(c.room, out, c);
        break;
      }
      case 'fx': {                                                      // tool effects everybody should see
        if (!c.room || !allow(c, 'fx', 30)) return;
        if (typeof m.k !== 'string' || !/^[a-z]{1,8}$/.test(m.k)) return;
        const out = { t: 'fx', id: c.id, k: m.k };
        if (typeof m.a === 'string' && /^[a-z]{1,12}$/.test(m.a)) out.a = m.a;
        for (const key of ['o', 'v', 'p']) if (Array.isArray(m[key])) out[key] = vec(m[key], 5000);
        const at = out.o || out.p;                                      // effects must start near the player who made them
        if (at && Math.hypot(at[0] - c.s.x, at[2] - c.s.z) > 150) return;
        if (Number.isFinite(Number(m.s))) out.s = Math.abs(Math.round(Number(m.s))) % 1e9;
        if (Number.isFinite(Number(m.ang))) out.ang = num(m.ang, 7);
        broadcast(c.room, out, c);
        break;
      }
      case 'spawn':
        if (!c.room) return;
        c.alive = true; c.hp = 100; c.ff = now + SPAWN_FF; c.lastHitBy = null;
        broadcast(c.room, { t: 'spawn', id: c.id }, c);
        break;
      case 'look':
        if (!c.room) return;
        c.look = cleanLook(m.look);
        broadcast(c.room, { t: 'look', id: c.id, look: c.look }, c);
        break;
      default: break;
    }
  });
  ws.on('close', () => { clearTimeout(joinTimer); leave(c); });
  ws.on('error', () => { try { ws.terminate(); } catch (e) { /* ignore */ } });
});

// snapshot loop: every room that changed gets one compact message with every player's state
setInterval(() => {
  for (const r of rooms.values()) {
    for (const p of r.players.values()) if (p.alive && p.hp < 100) p.hp = Math.min(100, p.hp + REGEN * TICK_MS / 1000);
    if (!r.dirty) continue;
    r.dirty = false;
    const a = [];
    for (const p of r.players.values()) a.push([p.id, r2(p.s.x), r2(p.s.y), r2(p.s.z), r2(p.s.ry), p.s.f, p.s.st]);
    broadcast(r, { t: 's', a });
  }
}, TICK_MS);

// keep-alive: drop dead sockets, ping the rest (also keeps proxies from closing idle connections)
setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false; ws.ping();
  });
}, 25000);

server.listen(PORT, '0.0.0.0', () => console.log('Cartblox server listening on :' + PORT));
const shutdown = () => { wss.clients.forEach(ws => ws.close(1001, 'server restarting')); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000); };
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
