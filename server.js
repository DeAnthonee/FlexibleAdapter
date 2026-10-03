// King of Tokyo Online — HTTP static server + WebSocket game server.
//
//   npm install
//   npm start            (PORT env var optional, default 3000)
//
// Game state lives in memory. Players reconnect with a token stored in
// their browser, so a page refresh does not lose their seat.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Game, GameError, newGameCode, MONSTERS } from './game/engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT) || 3000;
const GAME_TTL_MS = 6 * 60 * 60 * 1000; // drop idle games after 6 hours

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

// ------------------------------------------------------------ HTTP
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, games: games.size }));
    return;
  }
  let file = url.pathname === '/' ? '/index.html' : url.pathname;
  file = path.normalize(file).replace(/^(\.\.[/\\])+/, '');
  const full = path.join(PUBLIC_DIR, file);
  if (!full.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end(); return; }
  fs.readFile(full, (err, data) => {
    if (err) {
      // Single-page app: unknown paths fall back to index.html (e.g. /ABCD join links).
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, html) => {
        if (e2) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(html);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

// ------------------------------------------------------- game registry
/** code -> { game, tokens: Map<playerId, token>, sockets: Map<playerId, Set<ws>> } */
const games = new Map();

function getRoom(code) {
  const room = games.get(code);
  if (!room) throw new GameError('Game not found. Check the code and try again.');
  return room;
}

function createRoom() {
  let code;
  do code = newGameCode(); while (games.has(code));
  const room = { game: new Game(code), tokens: new Map(), sockets: new Map() };
  games.set(code, room);
  return room;
}

function broadcast(room) {
  const msg = JSON.stringify({ type: 'state', state: room.game.publicState() });
  for (const set of room.sockets.values()) for (const ws of set) if (ws.readyState === ws.OPEN) ws.send(msg);
}

function send(ws, obj) { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); }

function attach(room, playerId, ws) {
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
      if (room.game.phase === 'lobby') {
        room.game.removePlayer(ws.playerId);
        room.tokens.delete(ws.playerId);
      } else {
        room.game.setConnected(ws.playerId, false);
      }
      broadcast(room);
    }
  }
  ws.room = null;
}

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of games) {
    const idle = now - room.game.updatedAt > GAME_TTL_MS;
    const empty = room.sockets.size === 0 && now - room.game.updatedAt > 10 * 60 * 1000;
    if (idle || empty) games.delete(code);
  }
}, 60 * 1000).unref();

// ------------------------------------------------------------ WebSocket
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return send(ws, { type: 'error', message: 'Bad message.' }); }
    try {
      handle(ws, msg);
    } catch (err) {
      if (err instanceof GameError) send(ws, { type: 'error', message: err.message });
      else { console.error(err); send(ws, { type: 'error', message: 'Server error: ' + err.message }); }
    }
  });

  ws.on('close', () => detach(ws));
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

server.listen(PORT, () => {
  console.log(`King of Tokyo Online listening on http://localhost:${PORT}`);
  console.log(`Monsters: ${MONSTERS.map(m => m.name).join(', ')}`);
});
