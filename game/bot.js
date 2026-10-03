// Computer players for practice games. Pure decision logic: given a game and a
// bot's player id, return the next action for the engine's act(), or null.
//
// The strategy is deliberately simple and readable. It plays legally and
// reasonably; it is for testing the game, not for winning tournaments.

import { CARD_BY_ID } from './cards.js';

const LOW_HP = 4;

export function chooseAction(game, botId) {
  const who = game.pendingActor();
  if (!who || who.playerId !== botId) return null;
  const me = game.player(botId);
  if (!me || !me.alive) return null;

  if (who.kind === 'decide') {
    const d = game.decisions[0];
    if (d.kind === 'wings') return { type: 'decide', answer: me.hp <= LOW_HP + 2 || d.data.amount >= 3 };
    if (d.kind === 'opportunist') {
      const pick = (d.data.cards || []).find(c => c.type === 'keep' && game.cardCost(me, CARD_BY_ID[c.id]) <= me.energy - 1);
      return { type: 'decide', answer: pick ? { buy: pick.id } : { pass: true } };
    }
    return { type: 'decide', answer: undefined };
  }

  if (who.kind === 'yield') {
    // Leave Tokyo when hurt; stay when healthy or when ahead on points.
    const stay = me.hp > LOW_HP || me.vp >= 17;
    return { type: 'yield', yes: !stay };
  }

  const t = game.turn;
  if (who.kind === 'roll') {
    if (!t.rolled) return { type: 'roll' };
    const keep = diceToKeep(game, me, t.dice);
    const canReroll = t.rollsLeft > 0 && keep.length < t.dice.length;
    if (!canReroll) return { type: 'stopRolling' };
    // Stop early when every die is already worth keeping.
    return { type: 'roll', keep };
  }

  if (who.kind === 'buy') {
    const affordable = game.shop
      .map((id, index) => ({ card: CARD_BY_ID[id], index }))
      .filter(({ card }) => game.cardCost(me, card) <= me.energy)
      .sort((a, b) => b.card.cost - a.card.cost); // best card we can afford first
    const pick = affordable.find(({ card }) => card.type === 'keep') || affordable[0];
    if (pick && me.energy >= 3) return { type: 'buy', index: pick.index };
    return { type: 'endTurn' };
  }
  return null;
}

/** Indices of the dice worth keeping before a reroll. */
export function diceToKeep(game, me, dice) {
  const inTokyo = game.inTokyo(me);
  const someoneInTokyo = game.tokyoOccupants().some(p => p.id !== me.id);
  const hurt = me.hp <= LOW_HP + 1;
  const counts = {};
  for (const d of dice) counts[d.face] = (counts[d.face] || 0) + 1;
  const keep = [];
  dice.forEach((d, i) => {
    const f = d.face;
    if (f === 'heart') { if (!inTokyo && (hurt || me.hp < me.maxHp && counts.heart >= 2)) keep.push(i); return; }
    if (f === 'claw') { if (inTokyo || someoneInTokyo || !hurt) keep.push(i); return; }
    if (f === 'energy') { if (counts.energy >= 2 || me.energy < 2) keep.push(i); return; }
    // numbers: chase triples; 3s are worth the most
    if (counts[f] >= 2 || (f === '3' && !hurt)) keep.push(i);
  });
  return keep;
}

/** How long a bot waits before its next action, so people can follow along. */
export function botDelayMs(game, env = process.env) {
  const base = Number(env.BOT_DELAY_MS) || 900;
  const afterRoll = Number(env.BOT_ROLL_DELAY_MS) || 2400; // lets the dice animation finish
  const t = game.turn;
  const justRolled = game.phase === 'playing' && t && t.step === 'roll' && t.rolled && !game.decisions.length;
  return justRolled ? afterRoll : base;
}
