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
  c.until = async (pred, limitMs = 15000) => {
    const deadline = Date.now() + limitMs;
    while (Date.now() < deadline) {
      if (c.state && pred(c.state)) return c.state;
      const m = await Promise.race([c.next(), new Promise(r => setTimeout(() => r(null), deadline - Date.now()))]);
      if (m === null) break;
    }
    throw new Error('timed out waiting for state');
  };
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
  // Clients receive broadcasts at slightly different moments; always act on the newest state.
  const latest = () => (a.state && b.state && b.state.seq > a.state.seq) ? b.state : a.state;
  // Answer every prompt (Wings, Opportunist, yield) until nobody is asked anything.
  const settle = async () => {
    for (let i = 0; i < 12; i++) {
      const s = latest();
      if (s.phase !== 'playing') return;
      if (s.decision) {
        const c = me[s.decision.playerId]; const id = s.decision.id;
        await c.act({ type: 'decide', answer: false }, x => !x.decision || x.decision.id !== id);
        continue;
      }
      if (s.turn.step === 'yield' && s.turn.pendingYield.length) {
        const pid = s.turn.pendingYield[0]; const c = me[pid];
        await c.act({ type: 'yield', yes: Math.random() < 0.5 }, x => x.phase !== 'playing' || !x.turn.pendingYield.includes(pid));
        continue;
      }
      return;
    }
  };
  for (let turn = 0; turn < TURNS; turn++) {
    const st = latest();
    if (st.phase !== 'playing') break;
    const cur = me[st.turn.playerId];
    if (st.turn.step === 'roll') {
      if (!st.turn.rolled) { const seq = st.seq; await cur.act({ type: 'roll' }, s => s.seq > seq && s.turn.rolled); }
      await cur.act({ type: 'stopRolling' }, s => s.phase !== 'playing' || s.turn.step !== 'roll');
    }
    await settle();
    const s2 = latest();
    if (s2.phase === 'playing' && s2.turn.step === 'buy') {
      const c = me[s2.turn.playerId]; const pid = c.joined.playerId; const seq = s2.seq;
      await c.act({ type: 'endTurn' }, s => s.phase !== 'playing' || (s.seq > seq && (s.turn.playerId !== pid || !s.turn.rolled)));
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
