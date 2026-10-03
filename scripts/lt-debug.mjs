import { WebSocket } from 'ws';
const url = 'ws://127.0.0.1:3312';
const log = [];
function client(tag) {
  const ws = new WebSocket(url); const c = { ws, state: null, queue: [], waiters: [], joined: null, tag };
  ws.on('message', (raw) => { const m = JSON.parse(raw); if (m.type === 'state') c.state = m.state; if (m.type === 'joined') c.joined = m; if (m.type === 'error') log.push(`${tag} error: ${m.message}`); const w = c.waiters.shift(); if (w) w(m); else c.queue.push(m); });
  c.open = () => new Promise((res) => ws.once('open', () => res(c)));
  c.send = (o) => ws.send(JSON.stringify(o));
  c.next = () => new Promise(r => { if (c.queue.length) r(c.queue.shift()); else c.waiters.push(r); });
  c.until = async (pred, what) => { const t = Date.now(); for (let i = 0; i < 200; i++) { if (c.state && pred(c.state)) { log.push(`${tag} ${what} ok ${Date.now()-t}ms`); return c.state; } await c.next(); } throw new Error('timeout ' + what); };
  return c;
}
const a = await client('A').open(); a.send({ type: 'create', name: 'A', monster: 'king' }); await a.until(() => a.joined, 'create');
const b = await client('B').open(); b.send({ type: 'join', code: a.joined.code, name: 'B', monster: 'kraken' }); await b.until(() => b.joined, 'join');
await a.until(s => s.players.length === 2, 'both in');
a.send({ type: 'start' }); await a.until(s => s.phase === 'playing', 'start');
const me = { [a.joined.playerId]: a, [b.joined.playerId]: b };
const cur = me[a.state.turn.playerId];
const seq = a.state.seq;
cur.send({ type: 'action', action: { type: 'roll' } }); await cur.until(s => s.turn.rolled && s.seq > seq, 'roll');
cur.send({ type: 'action', action: { type: 'stopRolling' } }); await cur.until(s => s.turn.step !== 'roll', 'stop');
log.push('step now: ' + cur.state.turn.step + ' | decision: ' + JSON.stringify(cur.state.decision));
console.log(log.join('\n'));
a.ws.close(); b.ws.close();
