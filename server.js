// King of Tokyo Online — HTTP static server + WebSocket game server.
//
//   npm install
//   npm start            (PORT env var optional, default 3000)
//
// Game state lives in memory and is snapshotted to DATA_DIR/games.json
// after every action and on shutdown, so a restart (deploy, crash) brings
// running games back. Players reconnect with a token stored in their
// browser, so a page refresh or a server restart does not lose their seat.
//
// Environment:
//   PORT       listen port (default 3000); binds all interfaces
//   DATA_DIR   where the snapshot file lives (default ./data). Set it to a
//              writable folder; set DATA_DIR=none to disable persistence.
//   MAX_GAMES  cap on simultaneous games (default 500)

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Game, GameError, newGameCode, MONSTERS } from './game/engine.js';
import { chooseAction, botDelayMs } from './game/bot.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR === 'none' ? null : (process.env.DATA_DIR || path.join(__dirname, 'data'));
const SNAPSHOT_FILE = DATA_DIR ? path.join(DATA_DIR, 'games.json') : null;
const MAX_GAMES = Number(process.env.MAX_GAMES) || 500;
const LOBBY_GRACE_MS = Number(process.env.LOBBY_GRACE_MS) || 2 * 60 * 1000; // keep a waiting-room seat while a phone is backgrounded
const GAME_TTL_MS = 6 * 60 * 60 * 1000;   // drop idle games after 6 hours
const EMPTY_TTL_MS = 10 * 60 * 1000;      // drop games nobody is connected to after 10 minutes
const MAX_MESSAGE_BYTES = 16 * 1024;      // a game action is a few hundred bytes
const RATE_BURST = 20;                    // messages a connection may send at once...
const RATE_PER_SEC = 5;                   // ...and the sustained rate after that
const VERSION = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version;
const STARTED_AT = Date.now();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// ------------------------------------------------------- game registry
/** code -> { game, tokens: Map<playerId, token>, sockets: Map<playerId, Set<ws>>, snap } */
const games = new Map();

function healthReport() {
  let playing = 0, lobby = 0, connections = 0;
  for (const room of games.values()) {
    if (room.game.phase === 'playing') playing++;
    else if (room.game.phase === 'lobby') lobby++;
    for (const set of room.sockets.values()) connections += set.size;
  }
  return { ok: true, version: VERSION, games: games.size, playing, lobby, connections, uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000), persistence: !!SNAPSHOT_FILE };
}

// ------------------------------------------------------------ HTTP
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(healthReport()));
    return;
  }
  let file = url.pathname === '/' ? '/index.html' : url.pathname;
  file = path.normalize(file).replace(/^(\.\.[/\\])+/, '');
  const full = path.join(PUBLIC_DIR, file);
  if (!full.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end(); return; }
  if (file === '/index.html') { sendIndex(res); return; }
  fs.readFile(full, (err, data) => {
    if (err) { sendIndex(res); return; } // Single-page app: unknown paths fall back to index.html (e.g. /ABCD join links)
    const ext = path.extname(full);
    // Assets are referenced as /app.js?v=<version> (see sendIndex), so a versioned URL can be
    // cached forever by browsers and CDNs: every deploy changes the URL. Unversioned requests
    // stay revalidated so nothing stale survives a deploy.
    const cache = url.searchParams.get('v') === VERSION ? 'public, max-age=31536000, immutable' : 'no-cache';
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': cache });
    res.end(data);
  });
});

/**
 * Serve index.html with the package version stamped into every local asset URL
 * (/app.js -> /app.js?v=1.2.0) and into a <meta name="app-version"> tag, so a
 * fresh page always loads matching code even behind a CDN that caches scripts.
 */
function sendIndex(res) {
  fs.readFile(path.join(PUBLIC_DIR, 'index.html'), 'utf8', (err, html) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
    res.end(stampVersion(html, VERSION));
  });
}

/** Append ?v=<version> to local src/href attributes and add the app-version meta tag. */
function stampVersion(html, version) {
  const v = encodeURIComponent(version);
  return html
    .replace(/(src|href)="(\/[^"?]+\.(?:js|css|webp|png|svg|ico))"/g, `$1="$2?v=${v}"`)
    .replace('<meta charset="utf-8">', `<meta charset="utf-8">\n  <meta name="app-version" content="${v}">`);
}

function getRoom(code) {
  const room = games.get(code);
  if (!room) throw new GameError('Game not found. Check the code and try again.');
  return room;
}

function createRoom() {
  if (games.size >= MAX_GAMES) throw new GameError('The server is full right now. Please try again in a few minutes.');
  let code;
  do code = newGameCode(); while (games.has(code));
  const room = { game: new Game(code), tokens: new Map(), sockets: new Map(), snap: null };
  games.set(code, room);
  return room;
}

function broadcast(room) {
  const msg = JSON.stringify({ type: 'state', state: room.game.publicState(), version: VERSION });
  for (const set of room.sockets.values()) for (const ws of set) if (ws.readyState === ws.OPEN) ws.send(msg);
  snapshotRoom(room);
  driveBots(room);
}

// ------------------------------------------------------- computer players
/** If a bot has to act in this room, schedule its move (one timer per room). */
function driveBots(room) {
  const game = room.game;
  if (room.botTimer) { clearTimeout(room.botTimer); room.botTimer = null; }
  if (game.phase !== 'playing') return;
  const who = game.pendingActor();
  if (!who) return;
  const p = game.player(who.playerId);
  if (!p || !p.bot) return;
  const seq = game.seq;
  room.botTimer = setTimeout(() => {
    room.botTimer = null;
    if (!games.has(game.code) || game.seq !== seq) return; // something else happened meanwhile
    let action;
    try {
      action = chooseAction(game, p.id);
      if (!action) return;
      game.act(p.id, action);
      game.touch();
    } catch (err) {
      console.error(`bot ${p.name} failed (${action && action.type}): ${err.message}`);
      // Never let a stuck bot freeze a table: fall back to the safest legal move.
      try { game.act(p.id, who.kind === 'roll' && game.turn.rolled ? { type: 'stopRolling' } : who.kind === 'buy' ? { type: 'endTurn' } : who.kind === 'yield' ? { type: 'yield', yes: true } : { type: 'decide', answer: undefined }); }
      catch (e2) { console.error(`bot ${p.name} fallback failed: ${e2.message}`); return; }
    }
    broadcast(room);
  }, botDelayMs(game));
  room.botTimer.unref && room.botTimer.unref();
}

function send(ws, obj) { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); }

function attach(room, playerId, ws) {
  if (room.lobbyTimers && room.lobbyTimers.has(playerId)) { clearTimeout(room.lobbyTimers.get(playerId)); room.lobbyTimers.delete(playerId); }
  if (!room.sockets.has(playerId)) room.sockets.set(playerId, new Set());
  room.sockets.get(playerId).add(ws);
  ws.room = room;
  ws.playerId = playerId;
  room.game.setConnected(playerId, true);
}

function detach(ws) {
  const room = ws.room;
  if (!room) return;
  const set = room.sockets.get(ws.playerId);
  if (set) {
    set.delete(ws);
    if (set.size === 0) {
      room.sockets.delete(ws.playerId);
      room.game.setConnected(ws.playerId, false);
      if (room.game.phase === 'lobby') {
        // Phones drop the connection when the browser is backgrounded (e.g. while sending the
        // invite link). Keep the seat for a while so the player, and the host, can come back.
        const pid = ws.playerId;
        room.lobbyTimers = room.lobbyTimers || new Map();
        clearTimeout(room.lobbyTimers.get(pid));
        const timer = setTimeout(() => {
          room.lobbyTimers.delete(pid);
          if (room.sockets.has(pid) || room.game.phase !== 'lobby' || !games.has(room.game.code)) return;
          room.game.removePlayer(pid);
          room.tokens.delete(pid);
          broadcast(room);
        }, LOBBY_GRACE_MS);
        timer.unref && timer.unref();
        room.lobbyTimers.set(pid, timer);
      }
      broadcast(room);
    }
  }
  ws.room = null;
}

setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [code, room] of games) {
    const idle = now - room.game.updatedAt > GAME_TTL_MS;
    const empty = room.sockets.size === 0 && now - Math.max(room.game.updatedAt, room.restoredAt || 0) > EMPTY_TTL_MS;
    if (idle || empty) { games.delete(code); changed = true; }
  }
  if (changed) markDirty();
}, 60 * 1000).unref();

// ------------------------------------------------------- persistence
let dirty = false;
let saving = false;

/** Remember the latest quiescent state of a room (nothing mid-resolution). */
function snapshotRoom(room) {
  if (!SNAPSHOT_FILE) return;
  if (room.game.isQuiescent()) room.snap = { game: room.game.toJSON(), tokens: [...room.tokens] };
  markDirty();
}

function markDirty() { dirty = true; }

/**
 * Build the snapshot file. Returns the JSON plus an account of every room: which were
 * written and which were skipped and why, so the shutdown log can say exactly what was kept.
 */
function serializeAll() {
  const rooms = [];
  const skipped = [];
  const stale = [];
  for (const [code, room] of games) {
    if (!room.snap) { skipped.push(`${code}: never reached a settled state`); continue; }
    if (room.snap.game.phase === 'ended') { skipped.push(`${code}: finished`); continue; }
    if (!room.game.isQuiescent()) stale.push(code); // saved as of its last settled state
    rooms.push(room.snap);
  }
  return { data: JSON.stringify({ v: 1, savedAt: Date.now(), rooms }), saved: rooms.length, skipped, stale };
}

/** Human-readable account of a serializeAll() result, for the shutdown log. */
function describeSave({ saved, skipped, stale }) {
  let s = `saved ${saved} game(s)`;
  if (stale.length) s += ` (${stale.join(', ')} as of the last settled state)`;
  if (skipped.length) s += `; skipped ${skipped.length} (${skipped.join('; ')})`;
  return s;
}

function saveSnapshot({ sync = false } = {}) {
  if (!SNAPSHOT_FILE) return null;
  dirty = false;
  const result = serializeAll();
  const data = result.data;
  const tmp = SNAPSHOT_FILE + '.tmp';
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (sync) {
      fs.writeFileSync(tmp, data);
      fs.renameSync(tmp, SNAPSHOT_FILE);
      return result;
    }
    if (saving) { dirty = true; return result; }
    saving = true;
    fs.writeFile(tmp, data, (err) => {
      if (err) { saving = false; console.error('snapshot write failed:', err.message); return; }
      fs.rename(tmp, SNAPSHOT_FILE, (e2) => { saving = false; if (e2) console.error('snapshot rename failed:', e2.message); });
    });
  } catch (err) {
    console.error('snapshot failed:', err.message);
  }
  return result;
}

function loadSnapshot() {
  if (!SNAPSHOT_FILE || !fs.existsSync(SNAPSHOT_FILE)) return 0;
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8')); } catch (err) { console.error('snapshot unreadable, starting empty:', err.message); return 0; }
  let n = 0;
  for (const snap of parsed.rooms || []) {
    try {
      const game = Game.fromJSON(snap.game);
      if (game.phase === 'ended') { console.log(`snapshot: ${game.code} not restored (finished)`); continue; }
      if (Date.now() - game.updatedAt > GAME_TTL_MS) { console.log(`snapshot: ${game.code} not restored (idle longer than the game TTL)`); continue; }
      games.set(game.code, { game, tokens: new Map(snap.tokens || []), sockets: new Map(), snap, restoredAt: Date.now() });
      n++;
    } catch (err) {
      console.error(`could not restore game ${snap.game && snap.game.code}:`, err.message);
    }
  }
  return n;
}

setInterval(() => { if (dirty) saveSnapshot(); }, 5000).unref();

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  let account = 'persistence off, nothing saved';
  try { const r = saveSnapshot({ sync: true }); if (r) account = describeSave(r); } catch (err) { console.error('final snapshot failed:', err.message); account = 'final snapshot FAILED'; }
  console.log(`${signal} received: ${games.size} room(s) in memory, ${account}; closing.`);
  for (const ws of wss.clients) { try { ws.close(1012, 'Server restarting'); } catch {} }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ------------------------------------------------------------ WebSocket
const wss = new WebSocketServer({ server, maxPayload: MAX_MESSAGE_BYTES });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.tokens = RATE_BURST;
  ws.lastRefill = Date.now();
  ws.on('pong', () => { ws.isAlive = true; });
  // Tell the page which build is running so a page from an older deploy can reload itself.
  send(ws, { type: 'hello', version: VERSION });

  ws.on('message', (raw) => {
    // Token bucket: humans click a few times a second at most.
    const now = Date.now();
    ws.tokens = Math.min(RATE_BURST, ws.tokens + (now - ws.lastRefill) / 1000 * RATE_PER_SEC);
    ws.lastRefill = now;
    if (ws.tokens < 1) { send(ws, { type: 'error', message: 'Slow down a little.' }); return; }
    ws.tokens -= 1;

    let msg;
    try { msg = JSON.parse(raw); } catch { return send(ws, { type: 'error', message: 'Bad message.' }); }
    if (!msg || typeof msg !== 'object') return send(ws, { type: 'error', message: 'Bad message.' });
    try {
      handle(ws, msg);
    } catch (err) {
      if (err instanceof GameError) send(ws, { type: 'error', message: err.message });
      else { console.error(err); send(ws, { type: 'error', message: 'Server error: ' + err.message }); }
    }
  });

  ws.on('close', () => detach(ws));
  ws.on('error', () => {});
});

function handle(ws, msg) {
  switch (msg.type) {
    case 'create': {
      if (ws.room) detach(ws);
      const room = createRoom();
      const playerId = crypto.randomUUID();
      const token = crypto.randomBytes(16).toString('hex');
      room.game.addPlayer(playerId, msg.name, msg.monster);
      room.tokens.set(playerId, token);
      attach(room, playerId, ws);
      send(ws, { type: 'joined', code: room.game.code, playerId, token });
      broadcast(room);
      return;
    }
    case 'join': {
      if (ws.room) detach(ws);
      const code = String(msg.code || '').trim().toUpperCase();
      const room = getRoom(code);
      const playerId = crypto.randomUUID();
      const token = crypto.randomBytes(16).toString('hex');
      room.game.addPlayer(playerId, msg.name, msg.monster);
      room.tokens.set(playerId, token);
      attach(room, playerId, ws);
      send(ws, { type: 'joined', code, playerId, token });
      broadcast(room);
      return;
    }
    case 'rejoin': {
      const code = String(msg.code || '').trim().toUpperCase();
      const room = games.get(code);
      if (!room || room.tokens.get(msg.playerId) !== msg.token || !room.game.player(msg.playerId)) {
        send(ws, { type: 'rejoinFailed' });
        return;
      }
      if (ws.room) detach(ws);
      attach(room, msg.playerId, ws);
      send(ws, { type: 'joined', code, playerId: msg.playerId, token: msg.token });
      broadcast(room);
      return;
    }
    case 'lobbyInfo': {
      const code = String(msg.code || '').trim().toUpperCase();
      const room = games.get(code);
      if (!room) throw new GameError('Game not found. Check the code and try again.');
      if (room.game.phase !== 'lobby') throw new GameError('That game has already started.');
      send(ws, { type: 'lobbyInfo', code, taken: room.game.players.map(p => p.monster), players: room.game.players.map(p => p.name) });
      return;
    }
    case 'leave': {
      if (ws.room) {
        const room = ws.room;
        room.game.removePlayer(ws.playerId);
        room.tokens.delete(ws.playerId);
        detach(ws);
        broadcast(room);
      }
      send(ws, { type: 'left' });
      return;
    }
    case 'start': {
      if (!ws.room) throw new GameError('You are not in a game.');
      ws.room.game.start(ws.playerId);
      broadcast(ws.room);
      return;
    }
    case 'setOptions': {
      if (!ws.room) throw new GameError('You are not in a game.');
      ws.room.game.setOptions(ws.playerId, msg.options || {});
      broadcast(ws.room);
      return;
    }
    case 'addBot': {
      if (!ws.room) throw new GameError('You are not in a game.');
      ws.room.game.addBot(ws.playerId);
      broadcast(ws.room);
      return;
    }
    case 'removeBot': {
      if (!ws.room) throw new GameError('You are not in a game.');
      ws.room.game.removeBot(ws.playerId, msg.botId);
      broadcast(ws.room);
      return;
    }
    case 'action': {
      if (!ws.room) throw new GameError('You are not in a game.');
      ws.room.game.act(ws.playerId, msg.action);
      ws.room.game.touch();
      broadcast(ws.room);
      return;
    }
    case 'ping':
      send(ws, { type: 'pong' });
      return;
    default:
      throw new GameError('Unknown message type.');
  }
}

// Heartbeat: drop dead sockets so disconnects are noticed.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30 * 1000).unref();

const restored = loadSnapshot();
for (const room of games.values()) driveBots(room); // bots resume after a restart
console.log(SNAPSHOT_FILE ? `Persistence: ${SNAPSHOT_FILE} (${restored} game(s) restored)` : 'Persistence: off');
console.log(`Monsters: ${MONSTERS.map(m => m.name).join(', ')}`);
server.listen(PORT, () => {
  console.log(`King of Tokyo Online v${VERSION} listening on http://localhost:${PORT}`);
});
