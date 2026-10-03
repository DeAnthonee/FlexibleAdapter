// Load test: many lobbies playing at once.
//
//   node scripts/loadtest.js [url] [games] [turnsPerGame]
//   e.g. node scripts/loadtest.js ws://localhost:3000 200 6
//
// Creates N two-player games, plays a few turns in each concurrently, and
// reports timings plus the server's /health counters. Not part of npm test.

import { WebSocket } from 'ws';

const url = process.argv[2] || 'ws://localhost:3000';
const N = Number(process.argv[3]) || 100;
const TURNS = Number(process.argv[4]) || 4;
const MONSTERS = ['king', 'gigazaur', 'cyber_bunny', 'kraken', 'alienoid', 'meka_dragon'];

function client() {
  const ws = new WebSocket(url);
  const c = { ws, state: null, queue: [], waiters: [], joined: null, latencies: [] };
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.type === 'state') c.state = m.state;
    if (m.type === 'joined') c.joined = m;
    const w = c.waiters.shift(); if (w) w(m); else c.queue.push(m);
  });
  c.open = () => new Promise((res, rej) => { ws.once('open', () => res(c)); ws.once('error', rej); });
  c.send = (o) => ws.send(JSON.stringify(o));
  c.next = () => new Promise(r => { if (c.queue.length) r(c.queue.shift()); else c.waiters.push(r); });
  c.until = async (pred) => { for (let i = 0; i < 200; i++) { if (c.state && pred(c.state)) return c.state; await c.next(); } throw new Error('timeout waiting for state'); };
  c.act = async (action, pred) => { const t = Date.now(); c.send({ type: 'action', action }); const st = await c.until(pred); c.latencies.push(Date.now() - t); return st; };
  return c;
}

async function playGame(i) {
  const a = await client().open();
  a.send({ type: 'create', name: `A${i}`, monster: MONSTERS[i % 6] });
  await a.until(() => a.joined);
  const b = await client().open();
  b.send({ type: 'join', code: a.joined.code, name: `B${i}`, monster: MONSTERS[(i + 1) % 6] });
  await b.until(() => b.joined);
  await a.until(s => s.players.length === 2);
  a.send({ type: 'start' });
  await a.until(s => s.phase === 'playing');
  const me = { [a.joined.playerId]: a, [b.joined.playerId]: b };
  for (let turn = 0; turn < TURNS; turn++) {
    const st = a.state;
    if (st.phase !== 'playing') break;
    const cur = me[st.turn.playerId];
    const seqBefore = st.seq;
    await cur.act({ type: 'roll' }, s => s.turn.rolled && s.seq > seqBefore);
    await cur.act({ type: 'stopRolling' }, s => s.turn.step !== 'roll' || s.phase !== 'playing');
    // answer any yield / wings prompts from the other player
    for (const c of [a, b]) {
      const s = c.state;
      if (s.phase !== 'playing') continue;
      if (s.turn.step === 'yield' && s.turn.pendingYield.includes(c.joined.playerId)) await c.act({ type: 'yield', yes: Math.random() < 0.5 }, x => x.turn.step !== 'yield' || x.phase !== 'playing');
      if (s.decision && s.decision.playerId === c.joined.playerId) await c.act({ type: 'decide', answer: false }, x => !x.decision || x.decision.id !== s.decision.id);
    }
    if (a.state.phase === 'playing' && a.state.turn.step === 'buy') {
      const curNow = me[a.state.turn.playerId];
      await curNow.act({ type: 'endTurn' }, s => s.turn.playerId !== curNow.joined.playerId || s.phase !== 'playing');
    }
  }
  const lat = [...a.latencies, ...b.latencies];
  a.ws.close(); b.ws.close();
  return lat;
}

const t0 = Date.now();
const results = await Promise.allSettled(Array.from({ length: N }, (_, i) => playGame(i)));
const ok = results.filter(r => r.status === 'fulfilled');
const failed = results.filter(r => r.status === 'rejected');
const lat = ok.flatMap(r => r.value).sort((x, y) => x - y);
const pct = (p) => lat[Math.min(lat.length - 1, Math.floor(lat.length * p))];
console.log(`games: ${N} (ok ${ok.length}, failed ${failed.length}) · turns/game: ${TURNS} · wall time: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(`action round-trips: ${lat.length} · p50 ${pct(0.5)} ms · p95 ${pct(0.95)} ms · max ${lat[lat.length - 1]} ms`);
if (failed.length) console.log('first failure:', failed[0].reason && failed[0].reason.message);
try {
  const h = await (await fetch(url.replace(/^ws/, 'http') + '/health')).json();
  console.log('server /health:', JSON.stringify(h));
} catch {}
process.exit(failed.length ? 1 : 0);
