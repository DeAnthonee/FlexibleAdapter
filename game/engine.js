// King of Tokyo rules engine. Pure game logic, no networking.
//
// A Game instance is driven by `act(playerId, action)` calls. All mutations
// go through here so the server can simply broadcast `publicState()` after
// every action.
//
// Some effects need an answer from a player in the middle of resolving
// (Wings: "spend 2 energy to negate this damage?", Opportunist: "buy the card
// that was just revealed?"). To support that, resolution is broken into a
// queue of small steps. A step may `ask()` a player a question; the queue
// pauses until that player answers with a `decide` action, then resumes.

import { CARDS, CARD_BY_ID, cardView } from './cards.js';

export const FACES = ['1', '2', '3', 'heart', 'energy', 'claw'];
// Each monster's `power` only applies when the host turns on the "Game Plus"
// option in the waiting room. In the base game every monster is identical.
export const MONSTERS = [
  { id: 'king', image: '/img/king.webp', thumb: '/img/king-thumb.webp', name: 'The King', emoji: '🦍', color: '#d08a3c',
    power: { name: 'King of the Hill', text: 'Gain 1 extra ★ whenever you start your turn in Tokyo.' } },
  { id: 'gigazaur', image: '/img/gigazaur.webp', thumb: '/img/gigazaur-thumb.webp', name: 'Gigazaur', emoji: '🦖', color: '#5cb85c',
    power: { name: 'Regenerating Scales', text: 'At the end of your turn, heal 1 if you are outside Tokyo.' } },
  { id: 'cyber_bunny', image: '/img/cyber_bunny.webp', thumb: '/img/cyber_bunny-thumb.webp', name: 'Cyber Bunny', emoji: '🐰', color: '#ff5fa2',
    power: { name: 'Overclocked', text: 'You get one extra reroll every turn.' } },
  { id: 'kraken', image: '/img/kraken.webp', thumb: '/img/kraken-thumb.webp', name: 'Kraken', emoji: '🐙', color: '#5b7cff',
    power: { name: 'Ink Cloud', text: 'The first attack that hits you each turn deals 1 less damage.' } },
  { id: 'alienoid', image: '/img/alienoid.webp', thumb: '/img/alienoid-thumb.webp', name: 'Alienoid', emoji: '👽', color: '#9ad53a',
    power: { name: 'Energy Siphon', text: 'Gain 1 ⚡ at the end of each of your turns.' } },
  { id: 'meka_dragon', image: '/img/meka_dragon.webp', thumb: '/img/meka_dragon-thumb.webp', name: 'Meka Dragon', emoji: '🐉', color: '#b45cff',
    power: { name: 'Rocket Punch', text: 'Deal 1 extra damage when you attack from outside Tokyo.' } },
];
export const DEFAULT_OPTIONS = { powers: false };

export const MAX_PLAYERS = 6;
export const MIN_PLAYERS = 2;
export const WIN_VP = 20;
export const BASE_HP = 10;
const EXTRA_HEADS = ['extra_head_1', 'extra_head_2'];

export class GameError extends Error {}

function shuffle(arr, rng = Math.random) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export class Game {
  constructor(code, { rng = Math.random } = {}) {
    this.code = code;
    this.rng = rng;
    this.phase = 'lobby'; // lobby | playing | ended
    this.players = [];
    this.hostId = null;
    this.tokyo = { city: null, bay: null };
    this.bayActive = false;
    this.deck = [];
    this.discard = [];
    this.shop = [];
    this.turn = null;
    this.winner = null;
    this.endedBy = null;      // 'host' when the host ended the game early
    this.options = { ...DEFAULT_OPTIONS };
    this.events = [];         // what happened during the latest action (for client animations)
    this.seq = 0;             // bumps on every action so clients play each batch of events once
    this.logs = [];
    this.steps = [];          // queued resolution steps (functions)
    this.cursor = 0;          // insertion point for newly enqueued steps
    this.decisions = [];      // pending questions, first one is active
    this.resumers = new Map();// decision id -> callback(answer)
    this.nextDecisionId = 1;
    this.createdAt = Date.now();
    this.updatedAt = Date.now();
  }

  // ------------------------------------------------------------ helpers
  log(text) {
    this.logs.push({ t: Date.now(), text });
    if (this.logs.length > 200) this.logs.shift();
  }

  touch() { this.updatedAt = Date.now(); }

  /** Start a new action: clear last action's events. */
  beginAction() { this.events = []; this.seq++; }
  emit(event) { this.events.push(event); }

  player(id) { return this.players.find(p => p.id === id); }
  alivePlayers() { return this.players.filter(p => p.alive); }
  others(p) { return this.alivePlayers().filter(o => o.id !== p.id); }
  /** Does p have this card's power (owning it, or copying it with Mimic)? */
  has(p, cardId) {
    return p.cards.includes(cardId) || (p.mimicTarget === cardId && p.cards.includes('mimic'));
  }
  inTokyo(p) { return this.tokyo.city === p.id || this.tokyo.bay === p.id; }
  tokyoOccupants() {
    return [this.tokyo.city, this.tokyo.bay].filter(Boolean).map(id => this.player(id)).filter(p => p && p.alive);
  }
  currentPlayer() { return this.turn ? this.player(this.turn.playerId) : null; }
  roll() { return FACES[Math.floor(this.rng() * 6)]; }
  monsterName(p) { return MONSTERS.find(m => m.id === p.monster).name; }
  /** Does p's monster power apply? Only in Game Plus mode. */
  power(p, monsterId) { return this.options.powers && p.monster === monsterId; }
  powerName(p) { return MONSTERS.find(m => m.id === p.monster).power.name; }

  /** Players in clockwise order starting after `from`. */
  clockwiseFrom(from) {
    const i = this.players.findIndex(x => x.id === from.id);
    const out = [];
    for (let k = 1; k < this.players.length; k++) out.push(this.players[(i + k) % this.players.length]);
    return out;
  }

  // ----------------------------------------------------- step queue
  enqueue(...fns) {
    this.steps.splice(this.cursor, 0, ...fns);
    this.cursor += fns.length;
  }

  drain() {
    while (this.decisions.length === 0 && this.steps.length) {
      const f = this.steps.shift();
      this.cursor = 0;
      f();
    }
    if (this.decisions.length === 0) this.cursor = 0;
  }

  /** Ask `p` a question. `resume(answer)` runs when they answer. */
  ask(p, kind, data, resume) {
    if (!p.connected || !p.alive) { resume(undefined); return; } // nobody there to answer: take the default
    const id = this.nextDecisionId++;
    this.decisions.push({ id, kind, playerId: p.id, data });
    this.resumers.set(id, resume);
  }

  resolveDecision(id, answer) {
    const idx = this.decisions.findIndex(d => d.id === id);
    if (idx === -1) return;
    this.decisions.splice(idx, 1);
    const resume = this.resumers.get(id);
    this.resumers.delete(id);
    this.cursor = 0;
    if (resume) resume(answer);
  }

  /** Answer (with the default) every pending question addressed to `p`. */
  dropDecisionsFor(p) {
    for (const d of this.decisions.filter(d => d.playerId === p.id)) this.resolveDecision(d.id, undefined);
  }

  // -------------------------------------------------------------- lobby
  addPlayer(id, name, monsterId, { bot = false } = {}) {
    if (this.phase !== 'lobby') throw new GameError('Game already started.');
    if (this.players.length >= MAX_PLAYERS) throw new GameError('Game is full.');
    name = String(name || '').trim().slice(0, 20) || `Player ${this.players.length + 1}`;
    if (!MONSTERS.some(m => m.id === monsterId)) throw new GameError('Unknown monster.');
    if (this.players.some(p => p.monster === monsterId)) throw new GameError('That monster is already taken.');
    const p = {
      id, name, monster: monsterId,
      hp: BASE_HP, maxHp: BASE_HP, vp: 0, energy: 0,
      cards: [], mimicTarget: null, alive: true, poison: 0, shrink: 0, connected: true, left: false, bot,
    };
    this.players.push(p);
    if (!this.hostId && !bot) this.hostId = id;
    this.log(bot ? `🤖 ${name} (computer) joins as ${this.monsterName(p)}.` : `${name} joined as ${this.monsterName(p)}.`);
    this.touch();
    return p;
  }

  /** Host adds a computer player on the first free monster. Returns the new player. */
  addBot(byId) {
    if (this.phase !== 'lobby') throw new GameError('Computer players can only be added before the game starts.');
    if (byId !== this.hostId) throw new GameError('Only the host can add computer players.');
    const free = MONSTERS.find(m => !this.players.some(p => p.monster === m.id));
    if (!free) throw new GameError('Every monster is taken.');
    const id = 'bot-' + Math.random().toString(36).slice(2, 10);
    return this.addPlayer(id, `Bot ${free.name}`, free.id, { bot: true });
  }

  /** Host removes a computer player from the lobby. */
  removeBot(byId, botId) {
    if (this.phase !== 'lobby') throw new GameError('Computer players can only be removed before the game starts.');
    if (byId !== this.hostId) throw new GameError('Only the host can remove computer players.');
    const p = this.player(botId);
    if (!p || !p.bot) throw new GameError('No such computer player.');
    this.removePlayer(botId);
  }

  /** Who needs to act right now: { playerId, kind } or null. Used to drive computer players. */
  pendingActor() {
    if (this.phase !== 'playing') return null;
    if (this.decisions.length) return { playerId: this.decisions[0].playerId, kind: 'decide' };
    const t = this.turn;
    if (t.step === 'yield' && t.pendingYield.length) return { playerId: t.pendingYield[0], kind: 'yield' };
    return { playerId: t.playerId, kind: t.step };
  }

  /** A player leaves. In the lobby they vanish; in a running game they are out. */
  removePlayer(id) {
    const p = this.player(id);
    if (!p) return;
    this.beginAction();
    if (this.phase === 'lobby') {
      this.players = this.players.filter(x => x.id !== id);
      this.log(`${p.name} left.`);
      if (this.hostId === id) this.hostId = this.players[0]?.id || null;
    } else {
      p.connected = false;
      p.left = true;
      if (this.phase === 'playing' && p.alive) this.removeFromPlay(p, `${p.name} left the game.`);
      if (this.hostId === id) this.transferHost();
    }
    this.touch();
  }

  transferHost() {
    const next = this.players.find(p => p.connected && !p.left && p.id !== this.hostId)
      || this.players.find(p => !p.left && p.id !== this.hostId);
    if (next) { this.hostId = next.id; this.log(`${next.name} is now the host.`); }
  }

  setConnected(id, connected) {
    const p = this.player(id);
    if (p && !p.bot) p.connected = connected;
  }

  /** Host changes game options while in the lobby. */
  setOptions(byId, opts) {
    if (this.phase !== 'lobby') throw new GameError('Options can only be changed before the game starts.');
    if (byId !== this.hostId) throw new GameError('Only the host can change game options.');
    this.beginAction();
    if (opts && typeof opts.powers === 'boolean' && opts.powers !== this.options.powers) {
      this.options.powers = opts.powers;
      this.log(opts.powers ? '✨ Game Plus is on: every monster has a unique power.' : 'Game Plus is off: classic rules.');
    }
    this.touch();
  }

  start(byId) {
    if (this.phase !== 'lobby') throw new GameError('Game already started.');
    if (byId !== this.hostId) throw new GameError('Only the host can start the game.');
    if (this.players.length < MIN_PLAYERS) throw new GameError(`Need at least ${MIN_PLAYERS} players.`);
    this.beginAction();
    this.phase = 'playing';
    if (this.options.powers) this.log('✨ Game Plus: monster powers are active.');
    this.bayActive = this.players.length >= 5;
    this.deck = shuffle(CARDS.map(c => c.id), this.rng);
    this.shop = [];
    this.refillShop();
    shuffle(this.players, this.rng);
    let best = -1, first = 0;
    this.players.forEach((p, i) => {
      let claws = 0;
      for (let d = 0; d < 6; d++) if (this.roll() === 'claw') claws++;
      this.log(`${p.name} rolls ${claws} claw${claws === 1 ? '' : 's'} for turn order.`);
      if (claws > best) { best = claws; first = i; }
    });
    this.log(`${this.players[first].name} goes first!${this.bayActive ? ' Tokyo Bay is in play.' : ''}`);
    this.startTurn(this.players[first].id);
    this.touch();
  }

  /** Host ends the game early for everyone. */
  endGame(byId) {
    if (byId !== this.hostId) throw new GameError('Only the host can end the game.');
    if (this.phase === 'ended') return;
    this.beginAction();
    this.phase = 'ended';
    this.endedBy = 'host';
    this.winner = null;
    this.steps = []; this.decisions = []; this.resumers.clear();
    const host = this.player(byId);
    this.log(`${host ? host.name : 'The host'} ended the game.`);
    this.touch();
  }

  refillShop() {
    const revealed = [];
    while (this.shop.length < 3) {
      if (this.deck.length === 0) {
        if (this.discard.length === 0) break;
        this.deck = shuffle(this.discard.splice(0), this.rng);
        this.log('The deck is reshuffled.');
      }
      const id = this.deck.pop();
      this.shop.push(id);
      revealed.push(id);
    }
    if (revealed.length && this.phase === 'playing' && this.turn) this.offerOpportunists(revealed);
  }

  // ------------------------------------------------------------- turns
  startTurn(playerId, { diceAdjust = 0 } = {}) {
    const p = this.player(playerId);
    const extraDice = EXTRA_HEADS.filter(id => this.has(p, id)).length;
    this.turn = {
      playerId,
      step: 'roll',            // roll | yield | buy
      dice: [],
      diceCount: Math.max(1, 6 + extraDice - p.shrink + diceAdjust),
      rollsLeft: 3 + (this.has(p, 'giant_brain') ? 1 : 0) + (this.power(p, 'cyber_bunny') ? 1 : 0),
      rolled: false,
      inkUsed: {},             // playerId -> true once Kraken's Ink Cloud absorbed a hit this turn
      pendingYield: [],
      yieldDamage: {},         // targetId -> damage taken this attack (for Jets)
      attacked: false,
      dealtDamage: false,
      extraTurn: false,
      freezeTime: false,
      usedHerdCuller: false,
      probed: [],              // ids of players who used Psychic Probe this turn
      labCard: null,
    };
    this.log(`— ${p.name}'s turn —`);
    if (this.inTokyo(p)) {
      const bonus = 2 + (this.has(p, 'urbavore') ? 1 : 0);
      this.gainVp(p, bonus, 'for starting the turn in Tokyo');
      if (this.power(p, 'king')) this.gainVp(p, 1, '(King of the Hill)');
      this.checkWin();
    }
    if (this.has(p, 'made_in_a_lab') && this.deck.length) this.turn.labCard = this.deck[this.deck.length - 1];
  }

  endTurn() {
    const p = this.currentPlayer();
    const t = this.turn;
    this.enqueue(
      () => {
        if (!p.alive) return;
        if (this.has(p, 'herbivore') && !t.dealtDamage) this.gainVp(p, 1, '(Herbivore)');
        if (this.has(p, 'energy_hoarder') && p.energy >= 6) this.gainVp(p, Math.floor(p.energy / 6), '(Energy Hoarder)');
        if (this.has(p, 'solar_powered') && p.energy === 0) this.gainEnergy(p, 1, '(Solar Powered)');
        if (this.has(p, 'rooting_for_the_underdog') && this.others(p).every(o => o.vp > p.vp)) this.gainVp(p, 1, '(Rooting for the Underdog)');
        if (this.power(p, 'alienoid')) this.gainEnergy(p, 1, '(Energy Siphon)');
        if (this.power(p, 'gigazaur') && !this.inTokyo(p) && p.hp < p.maxHp) { this.log(`${p.name}'s Regenerating Scales:`); this.heal(p, 1); }
        if (p.poison > 0) {
          this.log(`${p.name} suffers ${p.poison} Poison damage.`);
          this.damage(p, p.poison, { attack: false, source: null, via: 'poison' });
        }
      },
      () => {
        if (this.checkWin()) return;
        const extra = t.extraTurn && p.alive;
        const freeze = t.freezeTime && p.alive;
        if (extra || freeze) {
          this.log(`${p.name} takes another turn${freeze && !extra ? ' with one less die (Freeze Time)' : ''}.`);
          this.startTurn(p.id, { diceAdjust: freeze && !extra ? -1 : 0 });
          return;
        }
        const idx = this.players.findIndex(x => x.id === p.id);
        for (let i = 1; i <= this.players.length; i++) {
          const next = this.players[(idx + i) % this.players.length];
          if (next.alive) { this.startTurn(next.id); return; }
        }
      },
    );
  }

  checkWin() {
    if (this.phase === 'ended') return true;
    const alive = this.alivePlayers();
    let winner = null;
    if (alive.length === 1) winner = alive[0];
    else if (alive.length > 1) {
      const cur = this.currentPlayer();
      const twenty = alive.filter(p => p.vp >= WIN_VP);
      if (twenty.length) winner = twenty.includes(cur) ? cur : twenty.sort((a, b) => b.vp - a.vp)[0];
    }
    if (alive.length <= 1 || winner) {
      this.phase = 'ended';
      this.winner = winner ? winner.id : null;
      this.steps = []; this.decisions = []; this.resumers.clear();
      this.log(winner ? `🏆 ${winner.name} is the King of Tokyo!` : 'All monsters have been destroyed. Nobody wins!');
      return true;
    }
    return false;
  }

  checkWinLastStanding() {
    if (this.alivePlayers().length <= 1) return this.checkWin();
    return false;
  }

  // ----------------------------------------------------------- scoring
  gainVp(p, n, why = '') {
    if (n <= 0) return;
    p.vp += n;
    this.log(`${p.name} gains ${n} ★ ${why}`.trim() + '.');
  }
  loseVp(p, n) {
    const lost = Math.min(p.vp, n);
    if (lost <= 0) return;
    p.vp -= lost;
    this.log(`${p.name} loses ${lost} ★.`);
  }
  gainEnergy(p, n, why = '') {
    if (n <= 0) return;
    if (this.has(p, 'friend_of_children')) n += 1;
    p.energy += n;
    this.log(`${p.name} gains ${n} ⚡ ${why}`.trim() + '.');
  }
  loseEnergy(p, n) {
    const lost = Math.min(p.energy, n);
    if (lost <= 0) return;
    p.energy -= lost;
    this.log(`${p.name} loses ${lost} ⚡.`);
  }
  heal(p, n, { card = false } = {}) {
    if (n <= 0 || !p.alive) return 0;
    if (this.inTokyo(p) && !card) { this.log(`${p.name} cannot heal in Tokyo.`); return 0; }
    if (this.has(p, 'regeneration')) n += 1;
    const healed = Math.min(n, p.maxHp - p.hp);
    if (healed > 0) {
      p.hp += healed;
      this.log(`${p.name} heals ${healed} ♥.`);
    }
    return healed;
  }

  /**
   * Deal damage to p. Because Wings may ask p a question, the result is
   * delivered through `after(taken)` (called synchronously when no question
   * is needed). Callers that enqueue follow-up steps should do so from
   * `after`, or enqueue them after calling damage().
   */
  damage(p, n, { source = null, attack = true, via = null } = {}, after = () => {}) {
    if (n <= 0 || !p.alive) return after(0);
    via = via || (attack ? 'claw' : source ? 'card' : 'poison');
    const from = source ? source.id : null;
    const blocked = (by) => { this.emit({ type: 'blocked', from, to: p.id, by }); return after(0); };
    if (attack && this.power(p, 'kraken') && this.turn && !this.turn.inkUsed[p.id]) {
      this.turn.inkUsed[p.id] = true;
      n -= 1;
      this.log(`${p.name}'s Ink Cloud absorbs 1 damage.`);
      if (n <= 0) return blocked('ink');
    }
    if (this.has(p, 'armor_plating') && n === 1) {
      this.log(`${p.name}'s Armor Plating ignores 1 damage.`);
      return blocked('armor');
    }
    if (this.has(p, 'camouflage')) {
      let saved = 0;
      for (let i = 0; i < n; i++) if (this.roll() === 'heart') saved++;
      if (saved) { n -= saved; this.log(`${p.name}'s Camouflage cancels ${saved} damage.`); }
      if (n <= 0) return blocked('camouflage');
    }
    if (this.has(p, 'wings') && p.energy >= 2) {
      const amount = n;
      this.ask(p, 'wings', { amount, from: source ? source.name : null }, (use) => {
        if (use) {
          p.energy -= 2;
          this.log(`${p.name} spends 2 ⚡ on Wings and takes no damage.`);
          blocked('wings');
        } else {
          after(this.applyDamage(p, amount, source, via));
        }
      });
      return;
    }
    return after(this.applyDamage(p, n, source, via));
  }

  applyDamage(p, n, source, via = 'card') {
    p.hp = Math.max(0, p.hp - n);
    this.log(`${p.name} takes ${n} damage (${p.hp} ♥ left).`);
    this.emit({ type: 'damage', from: source ? source.id : null, to: p.id, amount: n, via });
    if (source && source.id !== p.id) {
      if (this.has(source, 'poison_spit')) { p.poison++; this.log(`${p.name} gets a Poison counter.`); }
      if (this.has(source, 'shrink_ray')) { p.shrink++; this.log(`${p.name} gets a Shrink counter.`); }
    }
    if (n >= 2 && this.has(p, 'making_it_stronger')) this.gainEnergy(p, 1, "(We're Only Making It Stronger)");
    if (p.hp === 0) this.eliminate(p);
    return n;
  }

  /** Damage several targets one after another (each may pause for Wings). */
  damageAll(entries, opts, afterAll = () => {}) {
    const taken = {};
    this.enqueue(
      ...entries.map(e => () => this.damage(e.p, e.n, opts, (d) => { taken[e.p.id] = d; })),
      () => afterAll(taken),
    );
  }

  eliminate(p) {
    this.alivePlayers().filter(o => o.id !== p.id && this.has(o, 'eater_of_the_dead'))
      .forEach(o => this.gainVp(o, 3, '(Eater of the Dead)'));
    this.leaveTokyo(p);
    if (this.has(p, 'it_has_a_child')) {
      this.log(`${p.name} is destroyed... but It Has a Child! ${p.name} starts over.`);
      for (const id of p.cards.splice(0)) { this.discard.push(id); this.cardLeftPlay(id); }
      p.mimicTarget = null;
      p.vp = 0; p.energy = 0; p.hp = BASE_HP; p.maxHp = BASE_HP; p.poison = 0; p.shrink = 0;
      return;
    }
    p.alive = false;
    p.hp = 0;
    this.log(`💀 ${p.name} has been eliminated!`);
    this.emit({ type: 'ko', to: p.id });
    for (const id of p.cards.splice(0)) { this.discard.push(id); this.cardLeftPlay(id); }
    p.mimicTarget = null;
    this.closeBayIfNeeded();
  }

  closeBayIfNeeded() {
    if (this.bayActive && this.alivePlayers().length < 5) {
      this.bayActive = false;
      const bayP = this.tokyo.bay ? this.player(this.tokyo.bay) : null;
      this.tokyo.bay = null;
      this.log(`Tokyo Bay closes.${bayP ? ` ${bayP.name} leaves Tokyo.` : ''}`);
    }
  }

  /** A player is out of the game (eliminated by the host, or left). */
  removeFromPlay(p, why) {
    this.log(why);
    this.leaveTokyo(p);
    p.alive = false; p.hp = 0;
    for (const id of p.cards.splice(0)) { this.discard.push(id); this.cardLeftPlay(id); }
    p.mimicTarget = null;
    this.dropDecisionsFor(p);
    this.closeBayIfNeeded();
    const t = this.turn;
    if (t && t.pendingYield.includes(p.id)) t.pendingYield = t.pendingYield.filter(id => id !== p.id);
    if (this.checkWin()) return;
    if (t.playerId === p.id) {
      t.pendingYield = [];
      this.endTurn();
    } else if (t.step === 'yield' && t.pendingYield.length === 0) {
      this.enqueue(() => this.finishAttack(this.currentPlayer()));
    }
    this.drain();
  }

  // ------------------------------------------------------------- cards
  /** Remove a card from p's play area (sold, used up, discarded). */
  loseCard(p, cardId) {
    if (p.cards.includes(cardId)) {
      p.cards = p.cards.filter(c => c !== cardId);
      this.discard.push(cardId);
      if (cardId === 'even_bigger') { p.maxHp -= 2; p.hp = Math.min(p.hp, p.maxHp); }
      if (cardId === 'mimic') this.setMimicTarget(p, null);
      this.cardLeftPlay(cardId);
    } else if (p.mimicTarget === cardId) {
      this.setMimicTarget(p, null);
    }
  }

  /** The copied card left play: every Mimic pointing at it takes its counter back. */
  cardLeftPlay(cardId) {
    for (const o of this.players) {
      if (o.mimicTarget === cardId) {
        this.setMimicTarget(o, null);
        this.log(`${o.name}'s Mimic counter returns (${CARD_BY_ID[cardId].name} left play).`);
      }
    }
  }

  setMimicTarget(p, cardId) {
    if (p.mimicTarget === 'even_bigger' && cardId !== 'even_bigger') { p.maxHp -= 2; p.hp = Math.min(p.hp, p.maxHp); }
    if (cardId === 'even_bigger' && p.mimicTarget !== 'even_bigger') { p.maxHp += 2; p.hp += 2; }
    p.mimicTarget = cardId;
  }

  /** Give a Keep card to p (bought, or taken with Parasitic Tentacles). */
  giveKeepCard(p, cardId) {
    p.cards.push(cardId);
    if (cardId === 'even_bigger') { p.maxHp += 2; p.hp += 2; this.log(`${p.name} grows to ${p.hp}/${p.maxHp} ♥.`); }
    if (cardId === 'made_in_a_lab' && this.turn && this.turn.playerId === p.id && this.deck.length) {
      this.turn.labCard = this.deck[this.deck.length - 1];
    }
  }

  // ------------------------------------------------------------- tokyo
  enterTokyo(p) {
    if (this.inTokyo(p)) return;
    if (!this.tokyo.city) this.tokyo.city = p.id;
    else if (this.bayActive && !this.tokyo.bay) this.tokyo.bay = p.id;
    else return;
    this.log(`${p.name} enters ${this.tokyo.city === p.id ? 'Tokyo City' : 'Tokyo Bay'}!`);
    this.gainVp(p, 1, 'for taking control of Tokyo');
  }

  leaveTokyo(p) {
    if (this.tokyo.city === p.id) this.tokyo.city = null;
    if (this.tokyo.bay === p.id) this.tokyo.bay = null;
  }

  hasFreeTokyoSpot() {
    return !this.tokyo.city || (this.bayActive && !this.tokyo.bay);
  }

  seizeTokyoCity(p) {
    if (this.inTokyo(p)) return;
    const occ = this.tokyo.city ? this.player(this.tokyo.city) : null;
    if (occ) { this.tokyo.city = null; this.log(`${occ.name} is forced out of Tokyo City.`); }
    this.tokyo.city = p.id;
    this.log(`${p.name} drops into Tokyo City!`);
    this.gainVp(p, 1, 'for taking control of Tokyo');
  }

  // ----------------------------------------------------------- actions
  act(playerId, action) {
    if (this.phase !== 'playing') throw new GameError('The game is not in progress.');
    const p = this.player(playerId);
    if (!p) throw new GameError('You are not in this game.');
    const t = this.turn;
    const type = action && action.type;
    this.cursor = 0;
    this.beginAction();

    // Always allowed.
    if (type === 'endGame') { this.endGame(playerId); return; }
    if (type === 'kick') { this.actKick(p, action.targetId); return; }

    // While a question is pending, only its addressee may act (by answering).
    if (this.decisions.length) {
      const d = this.decisions[0];
      if (type === 'decide' && d.playerId === playerId) {
        this.resolveDecision(d.id, action.answer);
        this.drain();
        return;
      }
      throw new GameError(`Waiting for ${this.player(d.playerId).name} to decide.`);
    }
    if (type === 'decide') throw new GameError('Nothing to decide right now.');

    // Actions available to non-current players.
    if (type === 'yield') { this.actYield(p, !!action.yes); this.drain(); return; }
    if (type === 'probe') { this.actProbe(p, action.index); this.drain(); return; }

    if (t.playerId !== playerId) throw new GameError("It's not your turn.");
    if (!p.alive) throw new GameError('You have been eliminated.');

    switch (type) {
      case 'roll': this.actRoll(p, action.keep || []); break;
      case 'stopRolling': this.actStopRolling(p); break;
      case 'setDie': this.actSetDie(p, action.index, action.face, action.via); break;
      case 'rapidHeal': this.actRapidHeal(p); break;
      case 'mimic': this.actMimic(p, action.cardId); break;
      case 'buy': this.actBuy(p, action.index); break;
      case 'buyLab': this.actBuyLab(p); break;
      case 'buyFrom': this.actBuyFrom(p, action.playerId, action.cardId); break;
      case 'sweep': this.actSweep(p); break;
      case 'sell': this.actSell(p, action.cardId); break;
      case 'endTurn': this.actEndTurn(p); break;
      default: throw new GameError(`Unknown action: ${type}`);
    }
    this.drain();
  }

  actRoll(p, keep) {
    const t = this.turn;
    if (t.step !== 'roll') throw new GameError('You are not rolling right now.');
    if (!t.rolled) {
      t.dice = Array.from({ length: t.diceCount }, () => ({ face: this.roll(), kept: false }));
      t.rolled = true;
      t.rollsLeft--;
      this.log(`${p.name} rolls: ${this.diceSummary(t.dice)}`);
      return;
    }
    const keepSet = new Set(keep.map(Number));
    const toReroll = t.dice.map((d, i) => i).filter(i => !keepSet.has(i));
    if (toReroll.length === 0) throw new GameError('Select at least one die to reroll, or stop rolling.');
    if (t.rollsLeft <= 0) {
      const onlyThrees = toReroll.every(i => t.dice[i].face === '3');
      if (!(this.has(p, 'background_dweller') && onlyThrees)) throw new GameError('No rerolls left.');
      this.log(`${p.name} rerolls 3s with Background Dweller.`);
    } else {
      t.rollsLeft--;
    }
    toReroll.forEach(i => { t.dice[i].face = this.roll(); });
    t.dice.forEach((d, i) => { d.kept = keepSet.has(i); });
    this.log(`${p.name} rerolls ${toReroll.length} dice: ${this.diceSummary(t.dice)}`);
  }

  diceSummary(dice) {
    const sym = { '1': '1', '2': '2', '3': '3', heart: '♥', energy: '⚡', claw: '🐾' };
    return dice.map(d => sym[d.face]).join(' ');
  }

  actSetDie(p, index, face, via) {
    const t = this.turn;
    if (t.step !== 'roll' || !t.rolled) throw new GameError('You can only change dice after rolling.');
    if (!(index >= 0 && index < t.dice.length)) throw new GameError('Bad die index.');
    if (!FACES.includes(face)) throw new GameError('Bad die face.');
    if (via === 'herd_culler') {
      if (!this.has(p, 'herd_culler')) throw new GameError('You do not have Herd Culler.');
      if (t.usedHerdCuller) throw new GameError('Herd Culler already used this turn.');
      if (face !== '1') throw new GameError('Herd Culler can only change a die to 1.');
      t.usedHerdCuller = true;
    } else if (via === 'stretchy') {
      if (!this.has(p, 'stretchy')) throw new GameError('You do not have Stretchy.');
      if (p.energy < 2) throw new GameError('Stretchy costs 2 Energy.');
      p.energy -= 2;
    } else if (via === 'plot_twist') {
      if (!this.has(p, 'plot_twist')) throw new GameError('You do not have Plot Twist.');
      this.loseCard(p, 'plot_twist');
    } else throw new GameError('Unknown die-changing card.');
    t.dice[index].face = face;
    t.dice[index].kept = true;
    this.log(`${p.name} changes a die to ${face} (${CARD_BY_ID[via].name}).`);
  }

  /** Psychic Probe: another player forces one of the current player's dice to be rerolled. */
  actProbe(p, index) {
    const t = this.turn;
    if (!p.alive) throw new GameError('You have been eliminated.');
    if (t.playerId === p.id) throw new GameError('Psychic Probe works on other monsters\' dice.');
    if (!this.has(p, 'psychic_probe')) throw new GameError('You do not have Psychic Probe.');
    if (t.step !== 'roll' || !t.rolled) throw new GameError('There are no dice to probe right now.');
    if (t.probed.includes(p.id)) throw new GameError('You already used Psychic Probe this turn.');
    if (!(index >= 0 && index < t.dice.length)) throw new GameError('Bad die index.');
    const cur = this.currentPlayer();
    const before = t.dice[index].face;
    t.dice[index].face = this.roll();
    t.probed.push(p.id);
    this.log(`${p.name} uses Psychic Probe: ${cur.name}'s ${before} becomes ${t.dice[index].face}.`);
    if (t.dice[index].face === 'heart') {
      this.log(`${p.name}'s Psychic Probe rolled a ♥ and is discarded.`);
      this.loseCard(p, 'psychic_probe');
    }
  }

  actRapidHeal(p) {
    if (!this.has(p, 'rapid_healing')) throw new GameError('You do not have Rapid Healing.');
    if (p.energy < 2) throw new GameError('Rapid Healing costs 2 Energy.');
    if (p.hp >= p.maxHp) throw new GameError('You are already at full Life.');
    p.energy -= 2;
    this.heal(p, 1, { card: true });
  }

  /** Mimic: copy a Keep card another monster has in play. */
  actMimic(p, cardId) {
    const t = this.turn;
    if (!p.cards.includes('mimic')) throw new GameError('You do not have Mimic.');
    if (!((t.step === 'roll' && !t.rolled) || t.step === 'buy')) throw new GameError('Mimic can be moved at the start of your turn or while buying cards.');
    const owner = this.players.find(o => o.alive && o.id !== p.id && o.cards.includes(cardId));
    if (!owner || cardId === 'mimic') throw new GameError('Choose a Keep card another monster has in play.');
    if (CARD_BY_ID[cardId].type !== 'keep') throw new GameError('Mimic can only copy Keep cards.');
    if (p.mimicTarget === cardId) throw new GameError('Mimic is already copying that card.');
    if (p.mimicTarget) {
      if (p.energy < 1) throw new GameError('Moving the Mimic counter costs 1 Energy.');
      p.energy -= 1;
    }
    this.setMimicTarget(p, cardId);
    this.log(`${p.name}'s Mimic now copies ${owner.name}'s ${CARD_BY_ID[cardId].name}.`);
  }

  actStopRolling(p) {
    const t = this.turn;
    if (t.step !== 'roll') throw new GameError('You are not rolling right now.');
    if (!t.rolled) throw new GameError('Roll the dice first.');
    this.resolveDice(p);
  }

  resolveDice(p) {
    const t = this.turn;
    const count = Object.fromEntries(FACES.map(f => [f, 0]));
    t.dice.forEach(d => count[d.face]++);

    if (this.has(p, 'omnivore') && count['1'] && count['2'] && count['3']) this.gainVp(p, 2, '(Omnivore)');
    if (this.has(p, 'complete_destruction') && FACES.every(f => count[f] > 0)) this.gainVp(p, 9, '(Complete Destruction)');
    let bonusDamage = 0;
    for (const n of ['1', '2', '3']) {
      if (count[n] >= 3) {
        this.gainVp(p, Number(n) + (count[n] - 3), `for ${count[n]} × ${n}`);
        if (n === '1' && this.has(p, 'gourmet')) this.gainVp(p, 2, '(Gourmet)');
        if (n === '1' && this.has(p, 'freeze_time')) t.freezeTime = true;
        if (n === '2' && this.has(p, 'poison_quills')) bonusDamage += 2;
      }
    }
    if (count.energy) this.gainEnergy(p, count.energy);
    if (count.heart) {
      let hearts = count.heart;
      if (!this.inTokyo(p)) {
        const used = Math.min(hearts, Math.max(0, p.maxHp - p.hp));
        if (used > 0) this.heal(p, used);
        hearts -= used;
      } else this.log(`${p.name} cannot heal in Tokyo.`);
      while (hearts > 0 && (p.shrink > 0 || p.poison > 0)) {
        if (p.shrink > 0) { p.shrink--; this.log(`${p.name} removes a Shrink counter.`); }
        else { p.poison--; this.log(`${p.name} removes a Poison counter.`); }
        hearts--;
      }
    }
    this.resolveAttack(p, count.claw, bonusDamage);
  }

  resolveAttack(p, claws, bonusDamage) {
    const t = this.turn;
    const attacking = claws > 0;
    let dmg = claws + bonusDamage;
    if (attacking) {
      t.attacked = true;
      if (this.has(p, 'spiked_tail')) dmg += 1;
      if (this.power(p, 'meka_dragon') && !this.inTokyo(p)) { dmg += 1; this.log(`${p.name}'s Rocket Punch adds 1 damage.`); }
      if (this.has(p, 'alpha_monster')) this.gainVp(p, 1, '(Alpha Monster)');
    }
    if (this.has(p, 'acid_attack')) dmg += 1;
    if (dmg > 0 && this.inTokyo(p)) {
      if (this.has(p, 'urbavore')) dmg += 1;
      if (this.has(p, 'burrowing')) dmg += 1;
    }
    if (dmg <= 0) { this.enqueue(() => this.finishAttack(p)); return; }

    let targets;
    if (this.has(p, 'nova_breath')) targets = this.others(p);
    else if (this.inTokyo(p)) targets = this.others(p).filter(o => !this.inTokyo(o));
    else targets = this.tokyoOccupants();

    const fire = this.has(p, 'fire_breathing') ? this.neighbors(p) : [];
    if (targets.length === 0 && fire.length === 0) {
      this.log(`${p.name} attacks but nobody is there to hit.`);
      this.enqueue(() => this.finishAttack(p));
      return;
    }
    this.log(`${p.name} attacks for ${dmg} damage!`);
    t.dealtDamage = true;
    const wasInTokyo = targets.filter(o => this.inTokyo(o)).map(o => o.id);
    const scorched = fire.filter(o => !targets.includes(o));

    this.damageAll(targets.map(o => ({ p: o, n: dmg + (fire.includes(o) ? 1 : 0) })), { source: p, attack: attacking, via: attacking ? 'claw' : 'acid' }, (taken) => {
      for (const id of wasInTokyo) t.yieldDamage[id] = taken[id] || 0;
    });
    if (scorched.length) {
      this.enqueue(() => this.log(`${scorched.map(o => o.name).join(' and ')} ${scorched.length > 1 ? 'are' : 'is'} scorched by Fire Breathing.`));
      this.damageAll(scorched.map(o => ({ p: o, n: 1 })), { source: p, attack: false, via: 'fire' });
    }
    this.enqueue(() => {
      if (this.phase === 'ended' || this.checkWinLastStanding()) return;
      if (attacking && !this.inTokyo(p)) {
        const yielders = wasInTokyo.map(id => this.player(id)).filter(o => o.alive && this.inTokyo(o) && t.yieldDamage[o.id] > 0);
        if (yielders.length) {
          t.pendingYield = yielders.map(o => o.id);
          t.step = 'yield';
          this.log(`${yielders.map(o => o.name).join(' and ')} must decide whether to yield Tokyo.`);
          return;
        }
      }
      this.finishAttack(p);
    });
  }

  neighbors(p) {
    const alive = this.alivePlayers();
    if (alive.length <= 1) return [];
    const i = alive.findIndex(x => x.id === p.id);
    const before = alive[(i - 1 + alive.length) % alive.length];
    const after = alive[(i + 1) % alive.length];
    const set = new Set([before, after]);
    set.delete(p);
    return [...set];
  }

  actYield(p, yes) {
    const t = this.turn;
    if (t.step !== 'yield' || !t.pendingYield.includes(p.id)) throw new GameError('You have nothing to decide right now.');
    t.pendingYield = t.pendingYield.filter(id => id !== p.id);
    const attacker = this.currentPlayer();
    if (yes) {
      this.log(`${p.name} yields Tokyo to ${attacker.name}.`);
      if (this.has(p, 'jets') && t.yieldDamage[p.id] > 0) {
        p.hp = Math.min(p.maxHp, p.hp + t.yieldDamage[p.id]);
        this.log(`${p.name}'s Jets cancel the damage taken (${p.hp} ♥).`);
      }
      this.leaveTokyo(p);
      if (this.has(p, 'burrowing')) {
        this.log(`${p.name}'s Burrowing bites back.`);
        this.enqueue(() => this.damage(attacker, 1, { source: p, attack: false, via: 'bite' }));
      }
    } else {
      this.log(`${p.name} stays in Tokyo.`);
    }
    this.enqueue(() => {
      if (t.pendingYield.length === 0 && this.phase === 'playing') this.finishAttack(attacker);
    });
  }

  /** After damage and yield decisions: place the attacker, then move to buying. */
  finishAttack(p) {
    const t = this.turn;
    if (p.alive && t.attacked && !this.inTokyo(p) && this.hasFreeTokyoSpot()) this.enterTokyo(p);
    if (this.checkWinLastStanding()) return;
    if (!p.alive) { this.endTurn(); return; }
    t.step = 'buy';
  }

  // ------------------------------------------------------------ buying
  cardCost(p, card) {
    return Math.max(0, card.cost - (this.has(p, 'alien_metabolism') ? 1 : 0));
  }

  actBuy(p, index) {
    const t = this.turn;
    if (t.step !== 'buy') throw new GameError('You can only buy cards after resolving your dice.');
    if (!(index >= 0 && index < this.shop.length)) throw new GameError('No such card.');
    const card = CARD_BY_ID[this.shop[index]];
    this.purchase(p, card, () => { this.shop.splice(index, 1); this.refillShop(); });
  }

  actBuyLab(p) {
    const t = this.turn;
    if (t.step !== 'buy') throw new GameError('You can only buy cards after resolving your dice.');
    if (!this.has(p, 'made_in_a_lab')) throw new GameError('You do not have Made in a Lab.');
    if (!t.labCard || this.deck[this.deck.length - 1] !== t.labCard) throw new GameError('No card available from the deck.');
    const card = CARD_BY_ID[t.labCard];
    this.purchase(p, card, () => { this.deck.pop(); t.labCard = this.deck.length ? this.deck[this.deck.length - 1] : null; });
  }

  /** Parasitic Tentacles: buy a Keep card from another monster, paying them. */
  actBuyFrom(p, ownerId, cardId) {
    const t = this.turn;
    if (t.step !== 'buy') throw new GameError('You can only buy cards after resolving your dice.');
    if (!this.has(p, 'parasitic_tentacles')) throw new GameError('You do not have Parasitic Tentacles.');
    const owner = this.player(ownerId);
    if (!owner || !owner.alive || owner.id === p.id || !owner.cards.includes(cardId)) throw new GameError('That monster does not have that card.');
    const card = CARD_BY_ID[cardId];
    if (card.type !== 'keep') throw new GameError('Only Keep cards can be bought.');
    const cost = this.cardCost(p, card);
    if (p.energy < cost) throw new GameError(`${card.name} costs ${cost} Energy; you have ${p.energy}.`);
    p.energy -= cost;
    owner.energy += cost;
    owner.cards = owner.cards.filter(c => c !== cardId);
    if (cardId === 'even_bigger') { owner.maxHp -= 2; owner.hp = Math.min(owner.hp, owner.maxHp); }
    if (cardId === 'mimic') this.setMimicTarget(owner, null);
    if (owner.mimicTarget && !owner.cards.includes('mimic')) owner.mimicTarget = null;
    this.giveKeepCard(p, cardId);
    this.log(`${p.name} buys ${card.name} from ${owner.name} for ${cost} ⚡ (Parasitic Tentacles).`);
    if (this.has(p, 'dedicated_news_team')) this.gainVp(p, 1, '(Dedicated News Team)');
  }

  purchase(p, card, remove) {
    const cost = this.cardCost(p, card);
    if (p.energy < cost) throw new GameError(`${card.name} costs ${cost} Energy; you have ${p.energy}.`);
    p.energy -= cost;
    this.log(`${p.name} buys ${card.name} for ${cost} ⚡.`);
    if (this.has(p, 'dedicated_news_team')) this.gainVp(p, 1, '(Dedicated News Team)');
    if (card.type === 'keep') {
      remove();
      this.giveKeepCard(p, card.id);
    } else {
      card.effect(this, p);
      this.discard.push(card.id);
      remove();
    }
    this.enqueue(() => {
      if (this.checkWinLastStanding()) return;
      if (!p.alive && this.turn.playerId === p.id) this.endTurn();
    });
  }

  /** Opportunist: offer freshly revealed cards to each Opportunist, clockwise from the current player. */
  offerOpportunists(cardIds) {
    const cur = this.currentPlayer();
    const opportunists = this.clockwiseFrom(cur).filter(o => o.alive && this.has(o, 'opportunist'));
    for (const o of opportunists) {
      this.enqueue(() => {
        const available = cardIds.filter(id => this.shop.includes(id));
        if (!available.length) return;
        this.ask(o, 'opportunist', { cards: available.map(cardView) }, (answer) => {
          const pick = answer && answer.buy;
          if (!pick || !this.shop.includes(pick)) { this.log(`${o.name} passes (Opportunist).`); return; }
          const card = CARD_BY_ID[pick];
          if (o.energy < this.cardCost(o, card)) { this.log(`${o.name} cannot afford ${card.name}.`); return; }
          this.log(`${o.name} jumps on ${card.name} (Opportunist).`);
          this.purchase(o, card, () => { this.shop.splice(this.shop.indexOf(pick), 1); this.refillShop(); });
        });
      });
    }
  }

  actSweep(p) {
    if (this.turn.step !== 'buy') throw new GameError('You can only sweep cards during the buy step.');
    if (p.energy < 2) throw new GameError('Sweeping costs 2 Energy.');
    p.energy -= 2;
    this.discard.push(...this.shop.splice(0));
    this.log(`${p.name} pays 2 ⚡ to sweep the shop.`);
    this.refillShop();
  }

  actSell(p, cardId) {
    if (this.turn.step !== 'buy') throw new GameError('You can only sell cards during the buy step.');
    if (!this.has(p, 'metamorph')) throw new GameError('You do not have Metamorph.');
    if (!p.cards.includes(cardId)) throw new GameError('You do not own that card.');
    const card = CARD_BY_ID[cardId];
    this.loseCard(p, cardId);
    p.energy += card.cost;
    this.log(`${p.name} sells ${card.name} for ${card.cost} ⚡ (Metamorph).`);
  }

  actEndTurn(p) {
    const t = this.turn;
    if (t.step === 'roll' && !t.rolled) throw new GameError('Roll the dice first.');
    if (t.step === 'roll') { this.resolveDice(p); this.enqueue(() => { if (this.phase === 'playing' && t.step === 'buy') this.endTurn(); }); return; }
    if (t.step !== 'buy') throw new GameError('Waiting on other players.');
    this.endTurn();
  }

  /** Host may remove a disconnected player from a running game. */
  actKick(p, targetId) {
    if (p.id !== this.hostId) throw new GameError('Only the host can remove players.');
    const target = this.player(targetId);
    if (!target || !target.alive) throw new GameError('No such player.');
    if (target.connected) throw new GameError('You can only remove disconnected players.');
    target.left = true;
    this.removeFromPlay(target, `${target.name} is removed from the game by the host.`);
  }

  // ------------------------------------------------------- persistence
  /** True when nothing is mid-resolution: safe to snapshot. */
  isQuiescent() { return this.steps.length === 0 && this.decisions.length === 0; }

  /** Plain-data snapshot of the whole game (only meaningful when quiescent). */
  toJSON() {
    return {
      v: 1,
      code: this.code, phase: this.phase, hostId: this.hostId, winner: this.winner, endedBy: this.endedBy,
      options: { ...this.options }, bayActive: this.bayActive, tokyo: { ...this.tokyo },
      deck: [...this.deck], discard: [...this.discard], shop: [...this.shop],
      players: this.players.map(p => ({ ...p })),
      turn: this.turn ? JSON.parse(JSON.stringify(this.turn)) : null,
      logs: this.logs.slice(-200), seq: this.seq, nextDecisionId: this.nextDecisionId,
      createdAt: this.createdAt, updatedAt: this.updatedAt,
    };
  }

  /** Rebuild a game from toJSON() output. Players come back marked disconnected. */
  static fromJSON(d, opts = {}) {
    const g = new Game(d.code, opts);
    g.phase = d.phase; g.hostId = d.hostId; g.winner = d.winner; g.endedBy = d.endedBy || null;
    g.options = { ...DEFAULT_OPTIONS, ...(d.options || {}) };
    g.bayActive = !!d.bayActive; g.tokyo = { city: null, bay: null, ...(d.tokyo || {}) };
    g.deck = [...(d.deck || [])]; g.discard = [...(d.discard || [])]; g.shop = [...(d.shop || [])];
    g.players = (d.players || []).map(p => ({ ...p, connected: !!p.bot }));
    g.turn = d.turn ? JSON.parse(JSON.stringify(d.turn)) : null;
    g.logs = [...(d.logs || [])]; g.seq = d.seq || 0; g.nextDecisionId = d.nextDecisionId || 1;
    g.createdAt = d.createdAt || Date.now(); g.updatedAt = d.updatedAt || Date.now();
    return g;
  }

  // ------------------------------------------------------------- state
  publicState() {
    return {
      code: this.code,
      phase: this.phase,
      hostId: this.hostId,
      winner: this.winner,
      endedBy: this.endedBy,
      options: { ...this.options },
      bayActive: this.bayActive,
      tokyo: { ...this.tokyo },
      deckSize: this.deck.length,
      shop: this.shop.map(cardView),
      players: this.players.map(p => ({ ...p, cards: p.cards.map(cardView), mimicTarget: p.mimicTarget ? cardView(p.mimicTarget) : null })),
      turn: this.turn ? { ...this.turn, labCard: this.turn.labCard ? cardView(this.turn.labCard) : null } : null,
      decision: this.decisions.length ? this.decisions[0] : null,
      logs: this.logs.slice(-80),
      seq: this.seq,
      events: this.events,
      monsters: MONSTERS,
    };
  }
}

export function newGameCode(rng = Math.random) {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let s = '';
  for (let i = 0; i < 4; i++) s += letters[Math.floor(rng() * letters.length)];
  return s;
}
