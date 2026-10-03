import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../game/engine.js';
import { chooseAction, diceToKeep, botDelayMs } from '../game/bot.js';

function seeded(seed) {
  // small deterministic PRNG so failures are reproducible
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

/** Let bots act until a human must act or the game ends. Returns number of bot actions. */
function runBots(g, limit = 500) {
  let n = 0;
  while (n < limit) {
    const who = g.pendingActor();
    if (!who) return n;
    const p = g.player(who.playerId);
    if (!p.bot) return n;
    const action = chooseAction(g, p.id);
    assert.ok(action, `bot ${p.name} had no action for ${who.kind}`);
    g.act(p.id, action);
    n++;
  }
  throw new Error('bots looped without reaching a human or the end');
}

test('host adds and removes computer players in the lobby', () => {
  const g = new Game('BOTS');
  g.addPlayer('h', 'Host', 'king');
  const b1 = g.addBot('h');
  assert.equal(b1.bot, true);
  assert.equal(b1.monster, 'gigazaur', 'first free monster');
  assert.equal(b1.connected, true);
  assert.throws(() => g.addBot('nobody'), /Only the host/);
  g.removeBot('h', b1.id);
  assert.equal(g.players.length, 1);
  g.addBot('h'); g.addBot('h');
  assert.equal(g.players.filter(p => p.bot).length, 2);
  assert.equal(g.hostId, 'h', 'a bot never becomes host');
});

test('bots never disconnect and keep answering questions after a restore', () => {
  const g = new Game('KEEP');
  g.addPlayer('h', 'Host', 'king');
  const b = g.addBot('h');
  g.setConnected(b.id, false);
  assert.equal(b.connected, true);
  const r = Game.fromJSON(JSON.parse(JSON.stringify(g.toJSON())));
  assert.equal(r.player(b.id).connected, true);
  assert.equal(r.player('h').connected, false);
});

test('an all-bot table plays complete games without errors (fuzz)', () => {
  let finished = 0, actions = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const g = new Game('FUZZ', { rng: seeded(seed) });
    g.addPlayer('h', 'Host', 'king');
    const n = 2 + (seed % 5); // 3 to 7 requested -> capped at 6 seats
    for (let i = 0; i < n && g.players.length < 6; i++) g.addBot('h');
    if (seed % 2) g.setOptions('h', { powers: true });
    g.start('h');
    g.player('h').bot = true; // the whole table runs itself
    actions += runBots(g, 20000);
    assert.equal(g.phase, 'ended', `seed ${seed}: game did not finish`);
    assert.ok(g.isQuiescent(), 'nothing left mid-resolution');
    finished++;
  }
  assert.equal(finished, 40);
  assert.ok(actions > 2000, `bots took ${actions} actions`);
});

test('dice choices: keep claws when someone is in Tokyo, hearts when hurt, pairs of numbers', () => {
  const g = new Game('DICE', { rng: () => 0 });
  const me = g.addPlayer('h', 'Me', 'king');
  const foe = g.addPlayer('f', 'Foe', 'kraken');
  g.start('h');
  g.tokyo.city = foe.id;
  const dice = (faces) => faces.map(f => ({ face: f, kept: false }));
  assert.deepEqual(diceToKeep(g, me, dice(['claw', '1', 'energy', 'heart', '2', '2'])), [0, 2, 4, 5], 'claw (foe in Tokyo), energy (we have none), the pair of 2s');
  me.hp = 3;
  assert.deepEqual(diceToKeep(g, me, dice(['claw', 'heart', 'heart', '3', '1', '1'])), [0, 1, 2, 4, 5], 'hurt: hearts, plus the claw and the pair of 1s');
});

test('bot pauses longer right after rolling so the dice animation can play', () => {
  const g = new Game('WAIT', { rng: () => 0 });
  g.addPlayer('h', 'Host', 'king');
  g.addBot('h');
  g.start('h');
  const env = { BOT_DELAY_MS: '100', BOT_ROLL_DELAY_MS: '700' };
  assert.equal(botDelayMs(g, env), 100);
  g.act(g.turn.playerId, { type: 'roll' });
  assert.equal(botDelayMs(g, env), 700);
});
