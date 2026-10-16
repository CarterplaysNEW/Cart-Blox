'use strict';
/**
 * Cartblox multiplayer server.
 *  - one WebSocket endpoint (same port as the tiny HTTP API)
 *  - players are grouped into rooms per game ("obby#1", "baseplate#1", "place:abc#1" ...)
 *  - clients send their own position ~15x/sec, the server relays everybody's position back
 *  - chat normally goes through Firebase; the server also relays chat as a fallback
 * Render gives us the port in $PORT and expects us to listen on 0.0.0.0.
 */
const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = parseInt(process.env.PORT, 10) || 10000;
const MAX_PLAYERS = parseInt(process.env.MAX_PLAYERS, 10) || 16;   // per room instance
const TICK_MS = 66;                                                 // ~15 snapshots per second
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

function getRoom(game) {
  for (let i = 1; ; i++) {                       // first instance of this game that still has space
    const key = game + '#' + i;
    let r = rooms.get(key);
    if (!r) { r = { key, game, players: new Map(), dirty: false }; rooms.set(key, r); return r; }
    if (r.players.size < MAX_PLAYERS) return r;
  }
}
function leave(c) {
  const r = c.room; if (!r) return;
  r.players.delete(c.id); c.room = null;
  broadcast(r, { t: 'leave', id: c.id });
  if (!r.players.size) rooms.delete(r.key);
}

/* ---------- HTTP (health check + stats for the website) ---------- */
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Cache-Control': 'no-store' };
function stats() {
  const games = {}; let total = 0;
  for (const r of rooms.values()) { games[r.game] = (games[r.game] || 0) + r.players.size; total += r.players.size; }
  return { ok: true, players: total, games, rooms: rooms.size };
}
const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  const url = (req.url || '/').split('?')[0];
  if (url === '/stats') { res.writeHead(200, { ...cors, 'Content-Type': 'application/json' }); return res.end(JSON.stringify(stats())); }
  if (url === '/health') { res.writeHead(200, { ...cors, 'Content-Type': 'application/json' }); return res.end('{"ok":true}'); }
  res.writeHead(200, { ...cors, 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Cartblox server is running. Players online: ' + stats().players + '\n');
});

/* ---------- WebSocket game protocol ---------- */
const wss = new WebSocketServer({ server, maxPayload: 8 * 1024 });
wss.on('connection', ws => {
  const c = { id: String(nextId++), ws, room: null, name: '', look: cleanLook(null), s: { x: 0, y: 0, z: 0, ry: 0, f: 0, st: 1 }, lastState: 0, chatT: 0 };
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
        c.room = room; room.players.set(c.id, c);
        clearTimeout(joinTimer);
        send(ws, { t: 'welcome', id: c.id, room: room.key, max: MAX_PLAYERS, players: [...room.players.values()].filter(p => p !== c).map(pub) });
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
      case 'die': if (c.room) broadcast(c.room, { t: 'die', id: c.id }, c); break;
      case 'spawn': if (c.room) broadcast(c.room, { t: 'spawn', id: c.id }, c); break;
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
