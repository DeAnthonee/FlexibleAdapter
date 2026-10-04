import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game, GameError, FACES, MONSTERS } from '../game/engine.js';
import { CARD_BY_ID } from '../game/cards.js';

/** Deterministic rng that returns the queued values (as a fraction of 6 faces), then 0. */
function makeGame(n = 2, { rng } = {}) {
  const g = new Game('TEST', { rng: rng || (() => 0) });
  const monsters = ['king', 'gigazaur', 'cyber_bunny', 'kraken', 'alienoid', 'meka_dragon'];
  for (let i = 0; i < n; i++) g.addPlayer(`p${i}`, `P${i}`, monsters[i]);
  g.setOptions('p0', { powers: false }); // rules tests run under classic rules
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

// ------------------------------------------------------------ new cards & flows

test('Wings: the defender is asked before taking damage and may negate it for 2 energy', () => {
  const g = makeGame(2);
  const a = cur(g);
  const b = g.players.find(x => x.id !== a.id);
  forceDice(g, ['claw', '1', '1', '2', '2', '3']); // a enters Tokyo
  g.act(a.id, { type: 'endTurn' });
  a.cards.push('wings'); a.energy = 3;
  forceDice(g, ['claw', 'claw', '1', '2', '3', 'energy']); // b attacks a
  assert.ok(g.publicState().decision, 'a decision is pending');
  assert.equal(g.publicState().decision.kind, 'wings');
  assert.equal(g.publicState().decision.playerId, a.id);
  assert.equal(a.hp, 10, 'damage waits for the answer');
  assert.throws(() => g.act(b.id, { type: 'endTurn' }), /Waiting for/);
  g.act(a.id, { type: 'decide', answer: true });
  assert.equal(a.hp, 10);
  assert.equal(a.energy, 1);
  assert.equal(g.turn.step, 'buy', 'no yield prompt because no damage was taken');
  assert.equal(g.tokyo.city, a.id);
});

test('Wings: declining takes the damage and the yield prompt follows', () => {
  const g = makeGame(2);
  const a = cur(g);
  const b = g.players.find(x => x.id !== a.id);
  forceDice(g, ['claw', '1', '1', '2', '2', '3']);
  g.act(a.id, { type: 'endTurn' });
  a.cards.push('wings'); a.energy = 2;
  forceDice(g, ['claw', 'claw', '1', '2', '3', 'energy']);
  g.act(a.id, { type: 'decide', answer: false });
  assert.equal(a.hp, 8);
  assert.equal(a.energy, 2);
  assert.equal(g.turn.step, 'yield');
  g.act(a.id, { type: 'yield', yes: true });
  assert.equal(g.tokyo.city, b.id);
});

test('Wings with Discard-card damage (Flame Thrower) asks each defender in turn', () => {
  const g = makeGame(3);
  const p = cur(g);
  const [x, y] = g.players.filter(o => o.id !== p.id);
  x.cards.push('wings'); x.energy = 2;
  g.shop = ['flame_thrower', 'corner_store', 'heal'];
  forceDice(g, ['1', '2', '3', '1', '2', '3']);
  p.energy = 3;
  g.act(p.id, { type: 'buy', index: 0 });
  assert.equal(g.publicState().decision.playerId, x.id);
  assert.equal(y.hp, 10, 'the second target waits');
  g.act(x.id, { type: 'decide', answer: true });
  assert.equal(x.hp, 10);
  assert.equal(y.hp, 8);
  assert.equal(g.turn.step, 'buy');
});

test('Opportunist: another monster is offered the newly revealed card and can buy it', () => {
  const g = makeGame(3);
  const p = cur(g);
  const opp = g.clockwiseFrom(p)[0];
  opp.cards.push('opportunist'); opp.energy = 10;
  g.shop = ['corner_store', 'heal', 'tanks'];
  g.deck.push('skyscraper'); // next reveal
  forceDice(g, ['1', '2', '3', '1', '2', '3']);
  p.energy = 3;
  g.act(p.id, { type: 'buy', index: 0 });
  const d = g.publicState().decision;
  assert.equal(d.kind, 'opportunist');
  assert.equal(d.playerId, opp.id);
  assert.deepEqual(d.data.cards.map(c => c.id), ['skyscraper']);
  assert.throws(() => g.act(p.id, { type: 'endTurn' }), /Waiting for/);
  g.act(opp.id, { type: 'decide', answer: { buy: 'skyscraper' } });
  assert.equal(opp.vp, 4);
  assert.equal(opp.energy, 4);
  assert.ok(!g.shop.includes('skyscraper'));
  // the card revealed to replace Skyscraper is offered too; pass on it
  assert.equal(g.publicState().decision && g.publicState().decision.kind, 'opportunist');
  g.act(opp.id, { type: 'decide', answer: { pass: true } });
  assert.equal(g.publicState().decision, null);
  g.act(p.id, { type: 'endTurn' });
});

test('Mimic copies a Keep card in play and loses the copy when that card leaves play', () => {
  const g = makeGame(2);
  const p = cur(g);
  const o = g.players.find(x => x.id !== p.id);
  p.cards.push('mimic');
  o.cards.push('even_bigger'); o.maxHp = 12; o.hp = 12;
  assert.throws(() => g.act(p.id, { type: 'mimic', cardId: 'nova_breath' }), /another monster has in play/);
  g.act(p.id, { type: 'mimic', cardId: 'even_bigger' });
  assert.equal(p.maxHp, 12);
  assert.equal(p.hp, 12);
  assert.ok(g.has(p, 'even_bigger'));
  // o sells Even Bigger with Metamorph on their turn -> mimic counter comes back
  forceDice(g, ['1', '2', '3', '1', '2', '3']);
  g.act(p.id, { type: 'endTurn' });
  o.cards.push('metamorph');
  forceDice(g, ['1', '2', '3', '1', '2', '3']);
  g.act(o.id, { type: 'sell', cardId: 'even_bigger' });
  assert.equal(p.mimicTarget, null);
  assert.equal(p.maxHp, 10);
  assert.equal(p.hp, 10);
});

test('Parasitic Tentacles: buy a Keep card from another monster, paying them', () => {
  const g = makeGame(2);
  const p = cur(g);
  const o = g.players.find(x => x.id !== p.id);
  p.cards.push('parasitic_tentacles'); p.energy = 7;
  o.cards.push('extra_head_1');
  forceDice(g, ['1', '2', '3', '1', '2', '3']);
  g.act(p.id, { type: 'buyFrom', playerId: o.id, cardId: 'extra_head_1' });
  assert.deepEqual(o.cards, []);
  assert.ok(p.cards.includes('extra_head_1'));
  assert.equal(p.energy, 0);
  assert.equal(o.energy, 7);
});

test('Psychic Probe: a non-current player rerolls one die of the roller, once per turn', () => {
  const g = makeGame(2);
  const p = cur(g);
  const o = g.players.find(x => x.id !== p.id);
  o.cards.push('psychic_probe');
  assert.throws(() => g.act(o.id, { type: 'probe', index: 0 }), /no dice/);
  g.act(p.id, { type: 'roll' });
  g.act(o.id, { type: 'probe', index: 0 });
  assert.deepEqual(g.turn.probed, [o.id]);
  assert.throws(() => g.act(o.id, { type: 'probe', index: 1 }), /already used/);
  // rng=0 always rolls '1', never a heart, so the card stays
  assert.ok(o.cards.includes('psychic_probe'));
});

test('Psychic Probe is discarded when the reroll is a Heart', () => {
  const g = makeGame(2, { rng: () => 3 / 6 }); // every roll is a heart
  const p = cur(g);
  const o = g.players.find(x => x.id !== p.id);
  o.cards.push('psychic_probe');
  g.act(p.id, { type: 'roll' });
  g.act(o.id, { type: 'probe', index: 0 });
  assert.ok(!o.cards.includes('psychic_probe'));
  assert.ok(g.discard.includes('psychic_probe'));
});

test('a player leaving mid-game is out; the turn passes if it was theirs', () => {
  const g = makeGame(3);
  const p = cur(g);
  g.removePlayer(p.id);
  assert.equal(p.alive, false);
  assert.equal(p.left, true);
  assert.notEqual(g.turn.playerId, p.id);
  assert.equal(g.phase, 'playing');
  // host moves on if the host left
  if (g.hostId === p.id) assert.fail('host should have been transferred');
});

test('a leaving player with a pending Wings question does not block the game', () => {
  const g = makeGame(3);
  const p = cur(g);
  const [x, y] = g.players.filter(o => o.id !== p.id);
  x.cards.push('wings'); x.energy = 2;
  g.shop = ['flame_thrower', 'corner_store', 'heal'];
  forceDice(g, ['1', '2', '3', '1', '2', '3']);
  p.energy = 3;
  g.act(p.id, { type: 'buy', index: 0 });
  assert.equal(g.publicState().decision.playerId, x.id);
  g.removePlayer(x.id);
  assert.equal(g.publicState().decision, null);
  assert.equal(y.hp, 8, 'the queued damage to the other target still resolves');
  assert.equal(g.turn.step, 'buy');
});

test('host can end the game early; others cannot', () => {
  const g = makeGame(3);
  const notHost = g.players.find(p => p.id !== g.hostId);
  assert.throws(() => g.act(notHost.id, { type: 'endGame' }), /Only the host/);
  g.act(g.hostId, { type: 'endGame' });
  assert.equal(g.phase, 'ended');
  assert.equal(g.endedBy, 'host');
  assert.equal(g.winner, null);
});

// ------------------------------------------------------------ Game Plus: monster powers

function plusGame(n = 6) {
  const g = new Game('PLUS', { rng: () => 0 });
  const monsters = ['king', 'gigazaur', 'cyber_bunny', 'kraken', 'alienoid', 'meka_dragon'];
  for (let i = 0; i < n; i++) g.addPlayer(`p${i}`, `P${i}`, monsters[i]);
  g.setOptions('p0', { powers: true });
  g.start('p0');
  return g;
}
const byMonster = (g, id) => g.players.find(p => p.monster === id);

test('Game Plus option: on by default, host only, lobby only', () => {
  const g = new Game('OPTS');
  g.addPlayer('a', 'Ann', 'king');
  g.addPlayer('b', 'Bob', 'kraken');
  assert.equal(g.options.powers, true, 'Game Plus is the default');
  assert.throws(() => g.setOptions('b', { powers: false }), /Only the host/);
  g.setOptions('a', { powers: false });
  assert.equal(g.publicState().options.powers, false);
  g.start('a');
  assert.throws(() => g.setOptions('a', { powers: true }), /before the game starts/);
  // an old snapshot that saved powers:false stays classic
  const r = Game.fromJSON({ code: 'OLD', phase: 'lobby', options: { powers: false }, players: [] });
  assert.equal(r.options.powers, false);
});

test('powers do nothing when Game Plus is off', () => {
  const g = makeGame(3);
  const bunny = byMonster(g, 'cyber_bunny');
  g.startTurn(bunny.id);
  assert.equal(g.turn.rollsLeft, 3);
});

test('Cyber Bunny: one extra reroll', () => {
  const g = plusGame();
  g.startTurn(byMonster(g, 'cyber_bunny').id);
  assert.equal(g.turn.rollsLeft, 4);
  g.startTurn(byMonster(g, 'king').id);
  assert.equal(g.turn.rollsLeft, 3);
});

test('The King: extra star when starting the turn in Tokyo', () => {
  const g = plusGame();
  const king = byMonster(g, 'king');
  g.tokyo.city = king.id;
  g.startTurn(king.id);
  assert.equal(king.vp, 3);
});

test('Alienoid gains energy and Gigazaur heals at end of turn', () => {
  const g = plusGame();
  const alien = byMonster(g, 'alienoid');
  g.startTurn(alien.id);
  forceDice(g, ['1', '2', '3', '1', '2', '3']);
  g.act(alien.id, { type: 'endTurn' });
  assert.equal(alien.energy, 1);
  const giga = byMonster(g, 'gigazaur');
  giga.hp = 7;
  g.startTurn(giga.id);
  forceDice(g, ['1', '2', '3', '1', '2', '3']);
  g.act(giga.id, { type: 'endTurn' });
  assert.equal(giga.hp, 8);
  // not while in Tokyo
  g.tokyo.city = giga.id;
  g.startTurn(giga.id);
  forceDice(g, ['1', '2', '3', '1', '2', '3']);
  g.act(giga.id, { type: 'endTurn' });
  assert.equal(giga.hp, 8);
});

test('Kraken: Ink Cloud soaks 1 damage from the first attack each turn', () => {
  const g = plusGame();
  const kraken = byMonster(g, 'kraken');
  const king = byMonster(g, 'king');
  g.tokyo.city = kraken.id;
  g.startTurn(king.id);
  forceDice(g, ['claw', 'claw', 'claw', '1', '2', '3']);
  assert.equal(kraken.hp, 8, '3 claws minus 1 for Ink Cloud');
  g.act(kraken.id, { type: 'yield', yes: false });
  // card damage is not an attack, so no Ink Cloud
  g.shop = ['flame_thrower', 'heal', 'corner_store'];
  king.energy = 3;
  g.act(king.id, { type: 'buy', index: 0 });
  assert.equal(kraken.hp, 6);
});

test('Meka Dragon: +1 damage when attacking from outside Tokyo only', () => {
  const g = plusGame();
  const meka = byMonster(g, 'meka_dragon');
  const king = byMonster(g, 'king');
  g.tokyo.city = king.id;
  g.startTurn(meka.id);
  forceDice(g, ['claw', '1', '2', '3', '1', '2']);
  assert.equal(king.hp, 8);
  g.act(king.id, { type: 'yield', yes: true });
  assert.equal(g.tokyo.city, meka.id);
  g.act(meka.id, { type: 'endTurn' });
  // now attacking from inside Tokyo: no bonus
  king.hp = 10;
  g.startTurn(meka.id);
  forceDice(g, ['claw', '1', '2', '3', '1', '2']);
  assert.equal(king.hp, 9);
});

// ------------------------------------------------------------ events for client animations

test('events: each action starts a fresh batch with a new seq', () => {
  const g = makeGame(2);
  const s0 = g.publicState().seq;
  g.act(cur(g).id, { type: 'roll' });
  const s1 = g.publicState().seq;
  assert.ok(s1 > s0);
  assert.deepEqual(g.publicState().events, []);
});

test('events: a claw attack reports attacker, target, amount and kind', () => {
  const g = makeGame(2);
  const a = cur(g);
  const b = g.players.find(x => x.id !== a.id);
  forceDice(g, ['claw', '1', '1', '2', '2', '3']); // a enters Tokyo
  g.act(a.id, { type: 'endTurn' });
  forceDice(g, ['claw', 'claw', '1', '2', '3', 'energy']); // b hits a
  const ev = g.publicState().events;
  assert.deepEqual(ev, [{ type: 'damage', from: b.id, to: a.id, amount: 2, via: 'claw' }]);
});

test('events: card damage, blocks and knockouts are reported', () => {
  const g = makeGame(3);
  const p = cur(g);
  const [x, y] = g.players.filter(o => o.id !== p.id);
  x.cards.push('armor_plating');
  y.hp = 2;
  g.shop = ['flame_thrower', 'corner_store', 'heal'];
  forceDice(g, ['1', '2', '3', '1', '2', '3']);
  p.energy = 3;
  g.act(p.id, { type: 'buy', index: 0 });
  const ev = g.publicState().events;
  assert.deepEqual(ev.map(e => e.type), ['damage', 'damage', 'ko']);
  assert.equal(ev[0].via, 'card');
  assert.equal(ev[2].to, y.id);
  // Armor Plating only blocks damage of exactly 1
  x.hp = 10;
  g.act(p.id, { type: 'endTurn' });
  const q = cur(g);
  if (q.id === x.id) { forceDice(g, ['1', '2', '3', '1', '2', '3']); g.act(x.id, { type: 'endTurn' }); }
  const atk = cur(g);
  g.tokyo.city = x.id;
  forceDice(g, ['claw', '1', '2', '3', '1', '2']);
  assert.deepEqual(g.publicState().events, [{ type: 'blocked', from: atk.id, to: x.id, by: 'armor' }]);
});

// ------------------------------------------------------- Game Plus: the ten newer monsters

/** A Game Plus table seating exactly these monsters (host first). */
function plusTable(ids, { powers = true } = {}) {
  const g = new Game('PLUS2', { rng: () => 0 });
  ids.forEach((id, i) => g.addPlayer(`p${i}`, `P${i}`, id));
  g.setOptions('p0', { powers });
  g.start('p0');
  return g;
}

test('sixteen monsters, each with a distinct power', () => {
  assert.equal(MONSTERS.length, 16);
  assert.equal(new Set(MONSTERS.map(m => m.id)).size, 16);
  assert.equal(new Set(MONSTERS.map(m => m.power.name)).size, 16);
  for (const m of MONSTERS) assert.ok(m.image && m.thumb && m.emoji && m.color, `${m.id} has art`);
});

test('Cybertooth: Bite Back hits the first attacker each turn, not card damage', () => {
  const g = plusTable(['king', 'cybertooth']);
  const king = byMonster(g, 'king'), tooth = byMonster(g, 'cybertooth');
  g.tokyo.city = tooth.id;
  g.startTurn(king.id);
  forceDice(g, ['claw', 'claw', '1', '2', '3', '1']);
  assert.equal(tooth.hp, 8);
  assert.equal(king.hp, 9, 'attacker bitten once');
  g.act(tooth.id, { type: 'yield', yes: false });
  g.shop = ['flame_thrower', 'heal', 'corner_store'];
  king.energy = 3;
  g.act(king.id, { type: 'buy', index: 0 });
  assert.equal(tooth.hp, 6);
  assert.equal(king.hp, 9, 'card damage is not bitten');
  // classic rules: no bite
  const c = plusTable(['king', 'cybertooth'], { powers: false });
  c.tokyo.city = byMonster(c, 'cybertooth').id;
  c.startTurn(byMonster(c, 'king').id);
  forceDice(c, ['claw', '1', '2', '3', '1', '2']);
  assert.equal(byMonster(c, 'king').hp, 10);
});

test('Boogie Woogie: Showstopper scores once per turn for hitting Tokyo', () => {
  const g = plusTable(['boogie_woogie', 'king', 'kraken']);
  const boogie = byMonster(g, 'boogie_woogie'), king = byMonster(g, 'king');
  g.tokyo.city = king.id;
  g.startTurn(boogie.id);
  forceDice(g, ['claw', '1', '2', '3', '1', '2']);
  assert.equal(boogie.vp, 1, 'one star for damaging the monster in Tokyo');
  g.act(king.id, { type: 'yield', yes: false });
  // attacking from inside Tokyo hits monsters outside: no Showstopper
  const h = plusTable(['boogie_woogie', 'king']);
  const b2 = byMonster(h, 'boogie_woogie');
  h.tokyo.city = b2.id;
  h.startTurn(b2.id);
  const before = b2.vp;
  forceDice(h, ['claw', '1', '2', '3', '1', '2']);
  assert.equal(b2.vp, before);
});

test('Sheriff: New Sheriff in Town pays 2 stars for entering Tokyo', () => {
  const g = plusTable(['sheriff', 'king']);
  const sheriff = byMonster(g, 'sheriff');
  g.startTurn(sheriff.id);
  forceDice(g, ['claw', '1', '2', '3', '1', '2']);
  assert.equal(g.tokyo.city, sheriff.id);
  assert.equal(sheriff.vp, 2);
  const c = plusTable(['sheriff', 'king'], { powers: false });
  const s2 = byMonster(c, 'sheriff');
  c.startTurn(s2.id);
  forceDice(c, ['claw', '1', '2', '3', '1', '2']);
  assert.equal(s2.vp, 1);
});

test('Cthulhu: Dreaming Deep escalates 2, 3, 4, 4 and resets on leaving Tokyo', () => {
  const g = plusTable(['cthulhu', 'king']);
  const c = byMonster(g, 'cthulhu');
  g.tokyo.city = c.id;
  const quiet = ['1', '2', '3', '1', '2', '3'];
  const gains = [];
  for (let i = 0; i < 4; i++) {
    g.startTurn(c.id);
    const before = c.energy;
    forceDice(g, quiet);
    g.act(c.id, { type: 'endTurn' });
    gains.push(c.energy - before);
  }
  assert.deepEqual(gains, [2, 3, 4, 4]);
  g.leaveTokyo(c);
  assert.equal(c.tokyoStreak, 0);
  g.startTurn(c.id);
  const before = c.energy;
  forceDice(g, quiet);
  g.act(c.id, { type: 'endTurn' });
  assert.equal(c.energy - before, 0, 'nothing outside Tokyo');
});

test('Space Penguin: Ice Slide heals 1 on yielding', () => {
  const g = plusTable(['king', 'space_penguin']);
  const king = byMonster(g, 'king'), pen = byMonster(g, 'space_penguin');
  g.tokyo.city = pen.id;
  g.startTurn(king.id);
  forceDice(g, ['claw', 'claw', '1', '2', '3', '1']);
  assert.equal(pen.hp, 8);
  g.act(pen.id, { type: 'yield', yes: true });
  assert.equal(pen.hp, 9);
  assert.equal(g.tokyo.city, king.id);
});

test('Anubis: Judgement adds a star to every number triple', () => {
  const g = plusTable(['anubis', 'king']);
  const a = byMonster(g, 'anubis');
  g.startTurn(a.id);
  forceDice(g, ['1', '1', '1', '2', '2', '2']);
  assert.equal(a.vp, 1 + 1 + 2 + 1);
});

test('Cyber Kitty: Purr-charged gives a bonus energy on 3+ energy dice', () => {
  const g = plusTable(['cyber_kitty', 'king']);
  const k = byMonster(g, 'cyber_kitty');
  g.startTurn(k.id);
  forceDice(g, ['energy', 'energy', '1', '2', '3', '1']);
  assert.equal(k.energy, 2);
  g.startTurn(k.id);
  forceDice(g, ['energy', 'energy', 'energy', '2', '3', '1']);
  assert.equal(k.energy, 6);
});

test('Pumpkin Jack: Trick or Treat makes cards 2 cheaper, never below 2', () => {
  const g = plusTable(['pumpkin_jack', 'king']);
  const j = byMonster(g, 'pumpkin_jack');
  assert.equal(g.cardCost(j, CARD_BY_ID.heal), 2, '3 -> 2');
  assert.equal(g.cardCost(j, CARD_BY_ID.extra_head_1), 5, '7 -> 5');
  j.cards.push('alien_metabolism');
  assert.equal(g.cardCost(j, CARD_BY_ID.heal), 1, 'Alien Metabolism still stacks');
  assert.equal(g.cardCost(byMonster(g, 'king'), CARD_BY_ID.heal), 3);
});

test('Pandakaï: Bamboo Bulk starts at 13 Life only in Game Plus', () => {
  const g = plusTable(['pandakai', 'king']);
  const p = byMonster(g, 'pandakai');
  assert.equal(p.hp, 13); assert.equal(p.maxHp, 13);
  assert.equal(byMonster(g, 'king').hp, 10);
  const c = plusTable(['pandakai', 'king'], { powers: false });
  assert.equal(byMonster(c, 'pandakai').hp, 10);
});

test('Kookie: Snack Time turns hearts into energy while in Tokyo', () => {
  const g = plusTable(['kookie', 'king']);
  const k = byMonster(g, 'kookie');
  g.tokyo.city = k.id;
  k.hp = 8;
  g.startTurn(k.id);
  forceDice(g, ['heart', 'heart', '1', '2', '3', '1']);
  assert.equal(k.energy, 2);
  assert.equal(k.hp, 8, 'still no healing in Tokyo');
  g.leaveTokyo(k);
  g.startTurn(k.id);
  forceDice(g, ['heart', 'heart', '1', '2', '3', '1']);
  assert.equal(k.energy, 2, 'outside Tokyo hearts heal as usual');
  assert.equal(k.hp, 10);
});

test('new monsters survive a save and restore mid-game', () => {
  const g = plusTable(['cthulhu', 'pandakai']);
  const c = byMonster(g, 'cthulhu');
  g.tokyo.city = c.id;
  g.startTurn(c.id);
  forceDice(g, ['1', '2', '3', '1', '2', '3']);
  g.act(c.id, { type: 'endTurn' });
  const r = Game.fromJSON(JSON.parse(JSON.stringify(g.toJSON())));
  assert.equal(r.player(c.id).tokyoStreak, 1);
  assert.equal(byMonster(r, 'pandakai').maxHp, 13);
});
