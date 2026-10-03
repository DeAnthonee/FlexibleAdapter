// Integration tests for server.js: spawn the real server, talk to it over
// WebSocket, kill it mid-game, restart it, and check the game came back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

async function startServer(env) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(port), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  for (let i = 0; i < 100; i++) {
    if (out.includes('listening')) break;
    await new Promise(r => setTimeout(r, 50));
  }
  if (!out.includes('listening')) throw new Error('server did not start: ' + out);
  return { child, port, log: () => out };
}

async function stopServer(s) {
  if (s.child.exitCode !== null) return;
  s.child.kill('SIGTERM');
  await once(s.child, 'exit');
}

class Client {
  constructor(port) { this.ws = new WebSocket(`ws://127.0.0.1:${port}`); this.queue = []; this.waiters = []; this.state = null;
    this.ws.on('message', (raw) => { const m = JSON.parse(raw); if (m.type === 'state') this.state = m.state; const w = this.waiters.shift(); if (w) w(m); else this.queue.push(m); });
  }
  async open() { await once(this.ws, 'open'); return this; }
  send(obj) { this.ws.send(JSON.stringify(obj)); }
  next(type) {
    return new Promise((resolve) => {
      const pick = (m) => { if (!type || m.type === type) resolve(m); else this.waiters.unshift(pick); };
      const i = this.queue.findIndex(m => !type || m.type === type);
      if (i >= 0) resolve(this.queue.splice(i, 1)[0]); else this.waiters.push(pick);
    });
  }
  async waitState(pred) {
    for (let i = 0; i < 50; i++) { if (this.state && pred(this.state)) return this.state; await this.next('state'); }
    throw new Error('state condition not met');
  }
  close() { this.ws.close(); }
}

test('health endpoint reports counts', async () => {
  const s = await startServer({ DATA_DIR: 'none' });
  try {
    const res = await fetch(`http://127.0.0.1:${s.port}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.games, 0);
    assert.equal(typeof body.uptimeSec, 'number');
    assert.equal(body.persistence, false);
  } finally { await stopServer(s); }
});

test('a running game survives a server restart and players rejoin with their tokens', async () => {
  const dataDir = fs.mkdtemp ? await fs.promises.mkdtemp(path.join(os.tmpdir(), 'kot-')) : os.tmpdir();
  let s = await startServer({ DATA_DIR: dataDir });
  let a, b, code, aJoined, bJoined, diceBefore;
  try {
    a = await new Client(s.port).open();
    a.send({ type: 'create', name: 'Ann', monster: 'king' });
    aJoined = await a.next('joined');
    code = aJoined.code;
    b = await new Client(s.port).open();
    b.send({ type: 'join', code, name: 'Bob', monster: 'kraken' });
    bJoined = await b.next('joined');
    await a.waitState(st => st.players.length === 2);
    a.send({ type: 'start' });
    const st = await a.waitState(x => x.phase === 'playing');
    const roller = st.turn.playerId === aJoined.playerId ? a : b;
    roller.send({ type: 'action', action: { type: 'roll' } });
    const rolled = await roller.waitState(x => x.turn.rolled);
    diceBefore = rolled.turn.dice.map(d => d.face);
    // give the 5 s snapshot timer no chance: SIGTERM saves synchronously
    a.close(); b.close();
  } finally { await stopServer(s); }
  assert.ok(fs.existsSync(path.join(dataDir, 'games.json')), 'snapshot file written on shutdown');

  s = await startServer({ DATA_DIR: dataDir });
  try {
    assert.match(s.log(), /1 game\(s\) restored/);
    const a2 = await new Client(s.port).open();
    a2.send({ type: 'rejoin', code, playerId: aJoined.playerId, token: aJoined.token });
    const j = await a2.next();
    assert.equal(j.type, 'joined', 'rejoin accepted after restart');
    const st = await a2.waitState(x => x.phase === 'playing');
    assert.deepEqual(st.turn.dice.map(d => d.face), diceBefore, 'dice came back exactly as rolled');
    assert.equal(st.players.find(p => p.id === bJoined.playerId).connected, false, 'absent player shows as disconnected');
    // a bad token is still refused
    const x = await new Client(s.port).open();
    x.send({ type: 'rejoin', code, playerId: bJoined.playerId, token: 'nope' });
    assert.equal((await x.next()).type, 'rejoinFailed');
    x.close(); a2.close();
  } finally { await stopServer(s); fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('oversized and flooding messages are rejected without crashing the server', async () => {
  const s = await startServer({ DATA_DIR: 'none' });
  try {
    const c = await new Client(s.port).open();
    for (let i = 0; i < 40; i++) c.send({ type: 'ping' });
    let slowed = false;
    for (let i = 0; i < 40; i++) { const m = await c.next(); if (m.type === 'error' && /Slow down/.test(m.message)) { slowed = true; break; } }
    assert.ok(slowed, 'rate limiter kicked in');
    const big = await new Client(s.port).open();
    big.ws.send('x'.repeat(64 * 1024));
    await once(big.ws, 'close');
    const res = await fetch(`http://127.0.0.1:${s.port}/health`);
    assert.equal((await res.json()).ok, true, 'server still healthy');
    c.close();
  } finally { await stopServer(s); }
});
