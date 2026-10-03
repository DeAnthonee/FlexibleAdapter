// King of Tokyo rules engine. Pure game logic, no networking.
//
// A Game instance is driven by `act(playerId, action)` calls. All mutations
// go through here so the server can simply broadcast `publicState()` after
// every action.

import { CARDS, CARD_BY_ID, cardView } from './cards.js';

export const FACES = ['1', '2', '3', 'heart', 'energy', 'claw'];
export const MONSTERS = [
  { id: 'king', name: 'The King', emoji: '🦍', color: '#c98a3a' },
  { id: 'gigazaur', name: 'Gigazaur', emoji: '🦖', color: '#4caf50' },
  { id: 'cyber_bunny', name: 'Cyber Bunny', emoji: '🐰', color: '#e91e63' },
  { id: 'kraken', name: 'Kraken', emoji: '🐙', color: '#3f51b5' },
  { id: 'alienoid', name: 'Alienoid', emoji: '👽', color: '#8bc34a' },
  { id: 'meka_dragon', name: 'Meka Dragon', emoji: '🐉', color: '#9c27b0' },
];

export const MAX_PLAYERS = 6;
export const MIN_PLAYERS = 2;
export const WIN_VP = 20;
export const BASE_HP = 10;

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
    this.logs = [];
    this.createdAt = Date.now();
    this.updatedAt = Date.now();
  }

  // ------------------------------------------------------------ helpers
  log(text) {
    this.logs.push({ t: Date.now(), text });
    if (this.logs.length > 200) this.logs.shift();
  }

  touch() { this.updatedAt = Date.now(); }

  player(id) { return this.players.find(p => p.id === id); }
  alivePlayers() { return this.players.filter(p => p.alive); }
  others(p) { return this.alivePlayers().filter(o => o.id !== p.id); }
  has(p, cardId) { return p.cards.includes(cardId); }
  inTokyo(p) { return this.tokyo.city === p.id || this.tokyo.bay === p.id; }
  tokyoOccupants() {
    return [this.tokyo.city, this.tokyo.bay].filter(Boolean).map(id => this.player(id)).filter(p => p && p.alive);
  }
  currentPlayer() { return this.turn ? this.player(this.turn.playerId) : null; }
  roll() { return FACES[Math.floor(this.rng() * 6)]; }

  // -------------------------------------------------------------- lobby
  addPlayer(id, name, monsterId) {
    if (this.phase !== 'lobby') throw new GameError('Game already started.');
    if (this.players.length >= MAX_PLAYERS) throw new GameError('Game is full.');
    name = String(name || '').trim().slice(0, 20) || `Player ${this.players.length + 1}`;
    if (!MONSTERS.some(m => m.id === monsterId)) throw new GameError('Unknown monster.');
    if (this.players.some(p => p.monster === monsterId)) throw new GameError('That monster is already taken.');
    const p = {
      id, name, monster: monsterId,
      hp: BASE_HP, maxHp: BASE_HP, vp: 0, energy: 0,
      cards: [], alive: true, poison: 0, shrink: 0, connected: true,
    };
    this.players.push(p);
    if (!this.hostId) this.hostId = id;
    this.log(`${name} joined as ${MONSTERS.find(m => m.id === monsterId).name}.`);
    this.touch();
    return p;
  }

  removePlayer(id) {
    const p = this.player(id);
    if (!p) return;
    if (this.phase === 'lobby') {
      this.players = this.players.filter(x => x.id !== id);
      this.log(`${p.name} left.`);
      if (this.hostId === id) this.hostId = this.players[0]?.id || null;
    } else {
      p.connected = false;
    }
    this.touch();
  }

  setConnected(id, connected) {
    const p = this.player(id);
    if (p) p.connected = connected;
  }

  start(byId) {
    if (this.phase !== 'lobby') throw new GameError('Game already started.');
    if (byId !== this.hostId) throw new GameError('Only the host can start the game.');
    if (this.players.length < MIN_PLAYERS) throw new GameError(`Need at least ${MIN_PLAYERS} players.`);
    this.phase = 'playing';
    this.bayActive = this.players.length >= 5;
    this.deck = shuffle(CARDS.map(c => c.id), this.rng);
    this.shop = [];
    this.refillShop();
    shuffle(this.players, this.rng);
    // Everyone rolls once; most claws goes first (ties broken by shuffle order).
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

  refillShop() {
    while (this.shop.length < 3) {
      if (this.deck.length === 0) {
        if (this.discard.length === 0) break;
        this.deck = shuffle(this.discard.splice(0), this.rng);
        this.log('The deck is reshuffled.');
      }
      this.shop.push(this.deck.pop());
    }
  }

  // ------------------------------------------------------------- turns
  startTurn(playerId, { diceAdjust = 0 } = {}) {
    const p = this.player(playerId);
    const extraDice = p.cards.filter(c => c.startsWith('extra_head')).length;
    this.turn = {
      playerId,
      step: 'roll',            // roll | yield | buy
      dice: [],
      diceCount: Math.max(1, 6 + extraDice - p.shrink + diceAdjust),
      rollsLeft: 3 + (this.has(p, 'giant_brain') ? 1 : 0),
      rolled: false,
      pendingYield: [],
      yieldDamage: {},         // targetId -> damage taken this attack (for Jets)
      attacked: false,
      dealtDamage: false,
      extraTurn: false,
      freezeTime: false,
      usedHerdCuller: false,
      labCard: null,
    };
    this.log(`— ${p.name}'s turn —`);
    if (this.inTokyo(p)) {
      const bonus = 2 + (this.has(p, 'urbavore') ? 1 : 0);
      this.gainVp(p, bonus, 'for starting the turn in Tokyo');
      this.checkWin();
    }
    if (this.has(p, 'made_in_a_lab') && this.deck.length) this.turn.labCard = this.deck[this.deck.length - 1];
  }

  endTurn() {
    const p = this.currentPlayer();
    const t = this.turn;
    if (p.alive) {
      if (this.has(p, 'herbivore') && !t.dealtDamage) this.gainVp(p, 1, '(Herbivore)');
      if (this.has(p, 'energy_hoarder') && p.energy >= 6) this.gainVp(p, Math.floor(p.energy / 6), '(Energy Hoarder)');
      if (this.has(p, 'solar_powered') && p.energy === 0) this.gainEnergy(p, 1, '(Solar Powered)');
      if (this.has(p, 'rooting_for_the_underdog') && this.others(p).every(o => o.vp > p.vp)) this.gainVp(p, 1, '(Rooting for the Underdog)');
      if (p.poison > 0) {
        this.log(`${p.name} suffers ${p.poison} Poison damage.`);
        this.damage(p, p.poison, { attack: false, source: null });
      }
    }
    if (this.checkWin()) return;
    const extra = t.extraTurn && p.alive;
    const freeze = t.freezeTime && p.alive;
    if (extra || freeze) {
      this.log(`${p.name} takes another turn${freeze ? ' with one less die (Freeze Time)' : ''}.`);
      this.startTurn(p.id, { diceAdjust: freeze && !extra ? -1 : 0 });
      return;
    }
    const idx = this.players.findIndex(x => x.id === p.id);
    for (let i = 1; i <= this.players.length; i++) {
      const next = this.players[(idx + i) % this.players.length];
      if (next.alive) { this.startTurn(next.id); return; }
    }
  }

  checkWin() {
    if (this.phase === 'ended') return true;
    const alive = this.alivePlayers();
    let winner = null;
    if (alive.length === 1) winner = alive[0];
    else if (alive.length === 0) winner = null;
    else {
      const cur = this.currentPlayer();
      const twenty = alive.filter(p => p.vp >= WIN_VP);
      if (twenty.length) winner = twenty.includes(cur) ? cur : twenty.sort((a, b) => b.vp - a.vp)[0];
    }
    if (alive.length <= 1 || winner) {
      this.phase = 'ended';
      this.winner = winner ? winner.id : null;
      this.log(winner ? `🏆 ${winner.name} is the King of Tokyo!` : 'All monsters have been destroyed. Nobody wins!');
      return true;
    }
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
    if (n <= 0 || !p.alive) return;
    if (this.inTokyo(p) && !card) { this.log(`${p.name} cannot heal in Tokyo.`); return; }
    if (this.has(p, 'regeneration')) n += 1;
    const healed = Math.min(n, p.maxHp - p.hp);
    if (healed > 0) {
      p.hp += healed;
      this.log(`${p.name} heals ${healed} ♥.`);
    }
    return healed;
  }

  /** Apply damage to p. Returns the damage actually taken. */
  damage(p, n, { source = null, attack = true } = {}) {
    if (n <= 0 || !p.alive) return 0;
    if (this.has(p, 'armor_plating') && n === 1) {
      this.log(`${p.name}'s Armor Plating ignores 1 damage.`);
      return 0;
    }
    if (this.has(p, 'camouflage')) {
      let saved = 0;
      for (let i = 0; i < n; i++) if (this.roll() === 'heart') saved++;
      if (saved) { n -= saved; this.log(`${p.name}'s Camouflage cancels ${saved} damage.`); }
      if (n <= 0) return 0;
    }
    if (this.has(p, 'wings') && p.energy >= 2) {
      p.energy -= 2;
      this.log(`${p.name} spends 2 ⚡ on Wings and takes no damage.`);
      return 0;
    }
    p.hp = Math.max(0, p.hp - n);
    this.log(`${p.name} takes ${n} damage (${p.hp} ♥ left).`);
    if (source && source.id !== p.id) {
      if (this.has(source, 'poison_spit')) { p.poison++; this.log(`${p.name} gets a Poison counter.`); }
      if (this.has(source, 'shrink_ray')) { p.shrink++; this.log(`${p.name} gets a Shrink counter.`); }
    }
    if (n >= 2 && this.has(p, 'making_it_stronger')) this.gainEnergy(p, 1, "(We're Only Making It Stronger)");
    if (p.hp === 0) this.eliminate(p);
    return n;
  }

  eliminate(p) {
    this.alivePlayers().filter(o => o.id !== p.id && this.has(o, 'eater_of_the_dead'))
      .forEach(o => this.gainVp(o, 3, '(Eater of the Dead)'));
    this.leaveTokyo(p);
    if (this.has(p, 'it_has_a_child')) {
      this.log(`${p.name} is destroyed... but It Has a Child! ${p.name} starts over.`);
      p.cards.forEach(id => this.discard.push(id));
      p.cards = [];
      p.vp = 0; p.energy = 0; p.hp = BASE_HP; p.maxHp = BASE_HP; p.poison = 0; p.shrink = 0;
      return;
    }
    p.alive = false;
    p.hp = 0;
    this.log(`💀 ${p.name} has been eliminated!`);
    if (this.bayActive && this.alivePlayers().length < 5) {
      this.bayActive = false;
      const bayP = this.tokyo.bay ? this.player(this.tokyo.bay) : null;
      this.tokyo.bay = null;
      this.log(`Tokyo Bay closes.${bayP ? ` ${bayP.name} leaves Tokyo.` : ''}`);
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

    // Actions available to non-current players.
    if (type === 'yield') return this.actYield(p, !!action.yes);
    if (type === 'kick') return this.actKick(p, action.targetId);

    if (t.playerId !== playerId) throw new GameError("It's not your turn.");
    if (!p.alive) throw new GameError('You have been eliminated.');

    switch (type) {
      case 'roll': return this.actRoll(p, action.keep || []);
      case 'stopRolling': return this.actStopRolling(p);
      case 'setDie': return this.actSetDie(p, action.index, action.face, action.via);
      case 'rapidHeal': return this.actRapidHeal(p);
      case 'buy': return this.actBuy(p, action.index);
      case 'buyLab': return this.actBuyLab(p);
      case 'sweep': return this.actSweep(p);
      case 'sell': return this.actSell(p, action.cardId);
      case 'endTurn': return this.actEndTurn(p);
      default: throw new GameError(`Unknown action: ${type}`);
    }
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
      p.cards = p.cards.filter(c => c !== 'plot_twist');
      this.discard.push('plot_twist');
    } else throw new GameError('Unknown die-changing card.');
    t.dice[index].face = face;
    t.dice[index].kept = true;
    this.log(`${p.name} changes a die to ${face} (${CARD_BY_ID[via].name}).`);
  }

  actRapidHeal(p) {
    if (!this.has(p, 'rapid_healing')) throw new GameError('You do not have Rapid Healing.');
    if (p.energy < 2) throw new GameError('Rapid Healing costs 2 Energy.');
    if (p.hp >= p.maxHp) throw new GameError('You are already at full Life.');
    p.energy -= 2;
    this.heal(p, 1, { card: true });
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

    // Victory points from numbers
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
    // Energy
    if (count.energy) this.gainEnergy(p, count.energy);
    // Hearts: heal first, leftover hearts strip counters.
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
    // Attack
    this.resolveAttack(p, count.claw, bonusDamage);
    if (this.phase === 'ended') return;
    if (t.pendingYield.length === 0) this.finishAttack(p);
  }

  resolveAttack(p, claws, bonusDamage) {
    const t = this.turn;
    const attacking = claws > 0;
    let dmg = claws + bonusDamage;
    if (attacking) {
      t.attacked = true;
      if (this.has(p, 'spiked_tail')) dmg += 1;
      if (this.has(p, 'alpha_monster')) this.gainVp(p, 1, '(Alpha Monster)');
    }
    if (this.has(p, 'acid_attack')) dmg += 1;
    if (dmg > 0 && this.inTokyo(p)) {
      if (this.has(p, 'urbavore')) dmg += 1;
      if (this.has(p, 'burrowing')) dmg += 1;
    }
    if (dmg <= 0) return;

    let targets;
    if (this.has(p, 'nova_breath')) targets = this.others(p);
    else if (this.inTokyo(p)) targets = this.others(p).filter(o => !this.inTokyo(o));
    else targets = this.tokyoOccupants();

    const fire = this.has(p, 'fire_breathing') ? this.neighbors(p) : [];
    if (targets.length === 0 && fire.length === 0) {
      this.log(`${p.name} attacks but nobody is there to hit.`);
      return;
    }
    this.log(`${p.name} attacks for ${dmg} damage!`);
    t.dealtDamage = true;
    const wasInTokyo = targets.filter(o => this.inTokyo(o)).map(o => o.id);
    for (const o of targets) {
      const extra = fire.includes(o) ? 1 : 0;
      const taken = this.damage(o, dmg + extra, { source: p, attack: attacking });
      if (wasInTokyo.includes(o.id)) t.yieldDamage[o.id] = taken;
    }
    for (const o of fire) {
      if (!targets.includes(o) && o.alive) {
        this.log(`${o.name} is scorched by Fire Breathing.`);
        this.damage(o, 1, { source: p, attack: false });
      }
    }
    if (this.phase === 'ended' || this.checkWinLastStanding()) return;
    if (attacking && !this.inTokyo(p)) {
      const yielders = wasInTokyo.map(id => this.player(id)).filter(o => o.alive && this.inTokyo(o) && t.yieldDamage[o.id] > 0);
      if (yielders.length) {
        t.pendingYield = yielders.map(o => o.id);
        t.step = 'yield';
        this.log(`${yielders.map(o => o.name).join(' and ')} must decide whether to yield Tokyo.`);
      }
    }
  }

  checkWinLastStanding() {
    if (this.alivePlayers().length <= 1) return this.checkWin();
    return false;
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
      if (this.has(p, 'burrowing')) {
        this.log(`${p.name}'s Burrowing bites back.`);
        this.damage(attacker, 1, { source: p, attack: false });
      }
      this.leaveTokyo(p);
    } else {
      this.log(`${p.name} stays in Tokyo.`);
    }
    if (t.pendingYield.length === 0 && this.phase === 'playing') this.finishAttack(attacker);
  }

  /** After damage and yield decisions: place the attacker, then move to buying. */
  finishAttack(p) {
    const t = this.turn;
    if (p.alive && t.attacked && !this.inTokyo(p) && this.hasFreeTokyoSpot()) this.enterTokyo(p);
    // Bay occupant moves up to City if City emptied? No: rules keep them where they are.
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

  purchase(p, card, remove) {
    const cost = this.cardCost(p, card);
    if (p.energy < cost) throw new GameError(`${card.name} costs ${cost} Energy; you have ${p.energy}.`);
    p.energy -= cost;
    remove();
    this.log(`${p.name} buys ${card.name} for ${cost} ⚡.`);
    if (this.has(p, 'dedicated_news_team')) this.gainVp(p, 1, '(Dedicated News Team)');
    if (card.type === 'keep') {
      p.cards.push(card.id);
      if (card.id === 'even_bigger') { p.maxHp += 2; p.hp += 2; this.log(`${p.name} grows to ${p.hp}/${p.maxHp} ♥.`); }
      if (card.id === 'made_in_a_lab' && this.deck.length) this.turn.labCard = this.deck[this.deck.length - 1];
    } else {
      card.effect(this, p);
      this.discard.push(card.id);
    }
    if (this.checkWinLastStanding()) return;
    if (!p.alive) this.endTurn();
  }

  actSweep(p) {
    if (this.turn.step !== 'buy') throw new GameError('You can only sweep cards during the buy step.');
    if (p.energy < 2) throw new GameError('Sweeping costs 2 Energy.');
    p.energy -= 2;
    this.discard.push(...this.shop.splice(0));
    this.refillShop();
    this.log(`${p.name} pays 2 ⚡ to sweep the shop.`);
  }

  actSell(p, cardId) {
    if (this.turn.step !== 'buy') throw new GameError('You can only sell cards during the buy step.');
    if (!this.has(p, 'metamorph')) throw new GameError('You do not have Metamorph.');
    if (!this.has(p, cardId)) throw new GameError('You do not own that card.');
    const card = CARD_BY_ID[cardId];
    p.cards = p.cards.filter(c => c !== cardId);
    this.discard.push(cardId);
    if (cardId === 'even_bigger') { p.maxHp -= 2; p.hp = Math.min(p.hp, p.maxHp); }
    p.energy += card.cost;
    this.log(`${p.name} sells ${card.name} for ${card.cost} ⚡ (Metamorph).`);
  }

  actEndTurn(p) {
    const t = this.turn;
    if (t.step === 'roll' && !t.rolled) throw new GameError('Roll the dice first.');
    if (t.step === 'roll') { this.resolveDice(p); if (this.phase !== 'playing' || t.step !== 'buy') return; }
    if (t.step !== 'buy') throw new GameError('Waiting on other players.');
    this.endTurn();
  }

  /** Host may remove a disconnected player from a running game. */
  actKick(p, targetId) {
    if (p.id !== this.hostId) throw new GameError('Only the host can remove players.');
    const target = this.player(targetId);
    if (!target || !target.alive) throw new GameError('No such player.');
    if (target.connected) throw new GameError('You can only remove disconnected players.');
    this.log(`${target.name} is removed from the game by the host.`);
    this.leaveTokyo(target);
    target.alive = false; target.hp = 0;
    if (this.turn.pendingYield.includes(targetId)) {
      this.turn.pendingYield = this.turn.pendingYield.filter(id => id !== targetId);
      if (this.turn.pendingYield.length === 0) this.finishAttack(this.currentPlayer());
    }
    if (this.bayActive && this.alivePlayers().length < 5) {
      this.bayActive = false;
      this.tokyo.bay = null;
    }
    if (this.checkWin()) return;
    if (this.turn.playerId === targetId) this.endTurn();
  }

  // ------------------------------------------------------------- state
  publicState() {
    return {
      code: this.code,
      phase: this.phase,
      hostId: this.hostId,
      winner: this.winner,
      bayActive: this.bayActive,
      tokyo: { ...this.tokyo },
      deckSize: this.deck.length,
      shop: this.shop.map(cardView),
      players: this.players.map(p => ({ ...p, cards: p.cards.map(cardView) })),
      turn: this.turn ? { ...this.turn, labCard: this.turn.labCard ? cardView(this.turn.labCard) : null } : null,
      logs: this.logs.slice(-60),
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
