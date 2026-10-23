// =====================================================================
//  CARTBLOX CONFIG  (optional: your settings are also built into index.html)
// =====================================================================
window.CARTBLOX_CONFIG = {
  // 1) Your Render web-service URL. No key needed.
  serverUrl: "https://cart-blox.onrender.com",

  // Optional, for TESTING the money system (use 0 / 0 / 1 for the real thing):
  //   startRobux / startTix = what a brand-new player starts with.
  //   timeScale = 60 makes the play-time payouts 60x faster.
  startRobux: 0,
  startTix: 0,
  timeScale: 1,

  // 2) Firebase (Realtime Database + Anonymous sign-in): chat, home feed, catalog items, published games.
  firebase: {
    apiKey: "AIzaSyACZsyvXl-05UJr_pFjIlW1yjL1Id8kBb4",
    authDomain: "multiplayer-84fcc.firebaseapp.com",
    databaseURL: "https://multiplayer-84fcc-default-rtdb.firebaseio.com",
    projectId: "multiplayer-84fcc",
    storageBucket: "multiplayer-84fcc.firebasestorage.app",
    messagingSenderId: "1018280244915",
    appId: "1:1018280244915:web:f9f09d7b09ec51aeaba2c6"
  }
};
