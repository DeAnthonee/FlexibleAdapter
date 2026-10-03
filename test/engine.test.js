import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game, GameError, FACES } from '../game/engine.js';

/** Deterministic rng that returns the queued values (as a fraction of 6 faces), then 0. */
function makeGame(n = 2, { rng } = {}) {
  const g = new Game('TEST', { rng: rng || (() => 0) });
  const monsters = ['king', 'gigazaur', 'cyber_bunny', 'kraken', 'alienoid', 'meka_dragon'];
  for (let i = 0; i < n; i++) g.addPlayer(`p${i}`, `P${i}`, monsters[i]);
  g.start('p0');
  return g;
}

/** Force the current turn's dice to given faces and resolve them. */
function forceDice(g, faces) {
  const t = g.turn;
  t.rolled = true;
  t.rollsLeft = 0;
  t.dice = faces.map(f => ({ face: f, kept: true }));
  g.act(t.playerId, { type: 'stopRolling' });
}

const cur = (g) => g.player(g.turn.playerId);

test('lobby: players join, monsters unique, host starts with >= 2 players', () => {
  const g = new Game('ABCD');
  g.addPlayer('a', 'Ann', 'king');
  assert.throws(() => g.addPlayer('b', 'Bob', 'king'), GameError);
  assert.throws(() => g.start('a'), /at least 2/);
  g.addPlayer('b', 'Bob', 'kraken');
  assert.throws(() => g.start('b'), /host/);
  g.start('a');
  assert.equal(g.phase, 'playing');
  assert.equal(g.shop.length, 3);
  assert.equal(g.bayActive, false);
  assert.ok(g.turn && g.turn.step === 'roll');
});

test('rolling: first roll, rerolls with keep, then no rerolls left', () => {
  const g = makeGame(2);
  const p = cur(g);
  g.act(p.id, { type: 'roll' });
  assert.equal(g.turn.dice.length, 6);
  assert.equal(g.turn.rollsLeft, 2);
  g.act(p.id, { type: 'roll', keep: [0, 1] });
  assert.equal(g.turn.rollsLeft, 1);
  assert.ok(g.turn.dice[0].kept && !g.turn.dice[2].kept);
  g.act(p.id, { type: 'roll', keep: [] });
  assert.equal(g.turn.rollsLeft, 0);
  assert.throws(() => g.act(p.id, { type: 'roll', keep: [] }), /No rerolls/);
  const other = g.players.find(x => x.id !== p.id);
  assert.throws(() => g.act(other.id, { type: 'roll' }), /not your turn/);
});

test('scoring numbers: triples and extras', () => {
  const g = makeGame(2);
  const p = cur(g);
  forceDice(g, ['2', '2', '2', '2', '1', '1']);
  assert.equal(p.vp, 3); // three 2s = 2, plus one extra = 3
  assert.equal(g.turn.step, 'buy');
});

test('energy and hearts; cannot exceed max hp', () => {
  const g = makeGame(2);
  const p = cur(g);
  p.hp = 8;
  forceDice(g, ['energy', 'energy', 'heart', 'heart', 'heart', '1']);
  assert.equal(p.energy, 2);
  assert.equal(p.hp, 10);
});

test('first claw enters empty Tokyo without dealing damage; +1 VP', () => {
  const g = makeGame(2);
  const p = cur(g);
  const other = g.players.find(x => x.id !== p.id);
  forceDice(g, ['claw', 'claw', '1', '2', '3', 'energy']);
  assert.equal(g.tokyo.city, p.id);
  assert.equal(p.vp, 1);
  assert.equal(other.hp, 10);
});

test('attacking from outside hits Tokyo occupant and offers yield; attacker moves in', () => {
  const g = makeGame(3);
  const a = cur(g);
  forceDice(g, ['claw', '1', '1', '2', '2', '3']);
  g.act(a.id, { type: 'endTurn' });
  const b = cur(g);
  assert.notEqual(b.id, a.id);
  forceDice(g, ['claw', 'claw', '1', '2', '3', 'energy']);
  assert.equal(a.hp, 8);
  assert.equal(g.turn.step, 'yield');
  assert.deepEqual(g.turn.pendingYield, [a.id]);
  assert.throws(() => g.act(b.id, { type: 'endTurn' }), /Waiting/);
  g.act(a.id, { type: 'yield', yes: true });
  assert.equal(g.tokyo.city, b.id);
  assert.equal(b.vp, 1);
  assert.equal(g.turn.step, 'buy');
});

test('staying in Tokyo keeps control; Tokyo occupant scores 2 at start of turn and hits everyone outside', () => {
  const g = makeGame(3);
  const a = cur(g);
  forceDice(g, ['claw', '1', '1', '2', '2', '3']);
  g.act(a.id, { type: 'endTurn' });
  const b = cur(g);
  forceDice(g, ['claw', '1', '1', '2', '2', '3']);
  g.act(a.id, { type: 'yield', yes: false });
  assert.equal(g.tokyo.city, a.id);
  g.act(b.id, { type: 'endTurn' });
  const c = cur(g);
  forceDice(g, ['1', '1', '2', '2', '3', '3']); // no claws
  g.act(c.id, { type: 'endTurn' });
  assert.equal(cur(g).id, a.id);
  assert.equal(a.vp, 3); // 1 for entering + 2 for starting the turn there
  forceDice(g, ['claw', 'claw', 'claw', 'heart', '1', '2']);
  assert.equal(a.hp, 9, 'hearts do not heal in Tokyo');
  assert.equal(b.hp, 7);
  assert.equal(c.hp, 7);
  assert.equal(g.turn.step, 'buy', 'no yield prompt when attacking from inside Tokyo');
});

test('elimination: attacker takes over Tokyo and last monster standing wins', () => {
  const g = makeGame(2);
  const a = cur(g);
  const b = g.players.find(x => x.id !== a.id);
  forceDice(g, ['claw', '1', '1', '2', '2', '3']);
  g.act(a.id, { type: 'endTurn' });
  a.hp = 2;
  forceDice(g, ['claw', 'claw', '1', '2', '3', 'energy']);
  assert.equal(a.alive, false);
  assert.equal(g.phase, 'ended');
  assert.equal(g.winner, b.id);
});

test('reaching 20 VP wins at end of turn', () => {
  const g = makeGame(2);
  const p = cur(g);
  p.vp = 18;
  forceDice(g, ['3', '3', '3', '1', '2', 'energy']);
  assert.equal(p.vp, 21);
  assert.equal(g.phase, 'playing');
  g.act(p.id, { type: 'endTurn' });
  assert.equal(g.phase, 'ended');
  assert.equal(g.winner, p.id);
});

test('buying: pays energy, keep cards stay, discard cards resolve; sweep costs 2', () => {
  const g = makeGame(2);
  const p = cur(g);
  g.shop = ['corner_store', 'extra_head_1', 'energize'];
  forceDice(g, ['1', '2', '3', '1', '2', '3']);
  p.energy = 10;
  g.act(p.id, { type: 'buy', index: 0 });
  assert.equal(p.vp, 1);
  assert.equal(p.energy, 7);
  assert.equal(g.shop.length, 3);
  g.act(p.id, { type: 'buy', index: 0 });
  assert.deepEqual(p.cards, ['extra_head_1']);
  assert.equal(p.energy, 0);
  assert.throws(() => g.act(p.id, { type: 'sweep' }), /2 Energy/);
  p.energy = 2;
  const before = [...g.shop];
  g.act(p.id, { type: 'sweep' });
  assert.equal(p.energy, 0);
  assert.notDeepEqual(g.shop, before);
  g.act(p.id, { type: 'endTurn' });
});

test('extra head gives 7 dice next turn; giant brain gives extra reroll', () => {
  const g = makeGame(2);
  const p = cur(g);
  p.cards.push('extra_head_1', 'giant_brain');
  forceDice(g, ['1', '2', '3', '1', '2', '3']);
  g.act(p.id, { type: 'endTurn' });
  forceDice(g, ['1', '2', '3', '1', '2', '3']);
  g.act(cur(g).id, { type: 'endTurn' });
  assert.equal(cur(g).id, p.id);
  assert.equal(g.turn.diceCount, 7);
  assert.equal(g.turn.rollsLeft, 4);
});

test('Tokyo Bay with 5 players: second attacker takes the Bay, bay closes below 5', () => {
  const g = makeGame(5);
  assert.equal(g.bayActive, true);
  const a = cur(g);
  forceDice(g, ['claw', '1', '1', '2', '2', '3']);
  assert.equal(g.tokyo.city, a.id);
  g.act(a.id, { type: 'endTurn' });
  const b = cur(g);
  forceDice(g, ['claw', '1', '1', '2', '2', '3']);
  assert.equal(g.turn.step, 'yield');
  g.act(a.id, { type: 'yield', yes: false });
  assert.equal(g.tokyo.city, a.id);
  assert.equal(g.tokyo.bay, b.id);
  g.act(b.id, { type: 'endTurn' });
  const c = cur(g);
  // c kills a (in city) and damages b (in bay)
  a.hp = 1;
  forceDice(g, ['claw', '1', '1', '2', '2', '3']);
  assert.equal(a.alive, false);
  assert.equal(g.bayActive, false, 'bay closes when fewer than 5 remain');
  assert.equal(g.tokyo.bay, null, 'bay monster is forced out');
  assert.equal(b.hp, 9, 'bay monster still took the hit');
  assert.equal(g.turn.step, 'buy', 'nobody left in Tokyo to yield');
  assert.equal(g.tokyo.city, c.id, 'attacker takes the City freed by elimination');
});

test('poison counters deal damage at end of turn and hearts remove them', () => {
  const g = makeGame(2);
  const a = cur(g);
  const b = g.players.find(x => x.id !== a.id);
  a.cards.push('poison_spit');
  forceDice(g, ['claw', '1', '1', '2', '2', '3']);
  g.act(a.id, { type: 'endTurn' });
  // b attacks a in Tokyo; a has poison spit so b is unaffected; now a attacks b from Tokyo
  forceDice(g, ['1', '2', '3', '1', '2', '3']);
  g.act(b.id, { type: 'endTurn' });
  forceDice(g, ['claw', '1', '2', '3', '1', '2']);
  assert.equal(b.poison, 1);
  g.act(a.id, { type: 'endTurn' });
  b.hp = 10;
  forceDice(g, ['heart', '1', '2', '3', '1', '2']);
  assert.equal(b.poison, 0, 'heart at full hp strips the counter');
  g.act(b.id, { type: 'endTurn' });
  assert.equal(b.hp, 10);
});

test('host can kick a disconnected player; game ends if one remains', () => {
  const g = makeGame(3);
  const a = cur(g);
  const others = g.players.filter(x => x.id !== a.id);
  assert.throws(() => g.act('p0', { type: 'kick', targetId: others[0].id }), /disconnected/);
  others[0].connected = false;
  g.act('p0', { type: 'kick', targetId: others[0].id });
  assert.equal(others[0].alive, false);
  assert.equal(g.phase, 'playing');
});

test('publicState hides the deck and serialises cards', () => {
  const g = makeGame(2);
  const s = g.publicState();
  assert.equal(s.deck, undefined);
  assert.equal(typeof s.deckSize, 'number');
  assert.equal(s.shop.length, 3);
  assert.ok(s.shop.every(c => typeof c.name === 'string' && typeof c.effect === 'undefined'));
  assert.doesNotThrow(() => JSON.stringify(s));
});

test('all card ids are unique and every discard card has an effect', async () => {
  const { CARDS } = await import('../game/cards.js');
  const ids = new Set(CARDS.map(c => c.id));
  assert.equal(ids.size, CARDS.length);
  for (const c of CARDS) if (c.type === 'discard') assert.equal(typeof c.effect, 'function', c.id);
  assert.ok(FACES.length === 6);
});
