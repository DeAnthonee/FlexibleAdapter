/* King of Tokyo Online — browser client (vanilla JS, no build step). */
(() => {
  'use strict';

  const FACE = { '1': '1', '2': '2', '3': '3', heart: '♥', energy: '⚡', claw: '🐾' };
  const FACES = ['1', '2', '3', 'heart', 'energy', 'claw'];
  const SESSION_KEY = 'kot.session';

  const $ = (sel) => document.querySelector(sel);
  const el = (tag, attrs = {}, ...children) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') n.className = v;
      else if (k === 'style') n.style.cssText = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (v !== null && v !== undefined) n.setAttribute(k, v);
    }
    for (const c of children.flat()) if (c !== null && c !== undefined) n.append(c.nodeType ? c : document.createTextNode(String(c)));
    return n;
  };

  // ------------------------------------------------------------ state
  let ws = null;
  let me = null;            // { code, playerId, token }
  let state = null;         // last server state
  let monsters = [];        // from server state, or fallback list
  let selectedMonster = null;
  let takenMonsters = [];
  let kept = new Set();     // dice indices kept locally during rolling
  let tool = null;          // active die-changing card id
  let lastDiceKey = '';
  let dismissedGameOver = false;
  let reconnectDelay = 1000;

  const FALLBACK_MONSTERS = [
    { id: 'king', name: 'The King', emoji: '🦍', color: '#c98a3a' },
    { id: 'gigazaur', name: 'Gigazaur', emoji: '🦖', color: '#4caf50' },
    { id: 'cyber_bunny', name: 'Cyber Bunny', emoji: '🐰', color: '#e91e63' },
    { id: 'kraken', name: 'Kraken', emoji: '🐙', color: '#3f51b5' },
    { id: 'alienoid', name: 'Alienoid', emoji: '👽', color: '#8bc34a' },
    { id: 'meka_dragon', name: 'Meka Dragon', emoji: '🐉', color: '#9c27b0' },
  ];
  monsters = FALLBACK_MONSTERS;
  const monster = (id) => monsters.find(m => m.id === id) || { name: '?', emoji: '❓', color: '#888' };

  // ------------------------------------------------------------ toast
  let toastTimer = null;
  function toast(msg, kind = 'error') {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast ' + kind;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), 3500);
  }

  // ------------------------------------------------------------ screens
  function show(id) {
    for (const s of document.querySelectorAll('.screen')) s.classList.toggle('hidden', s.id !== id);
  }

  // ------------------------------------------------------------ websocket
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}`);
    ws.addEventListener('open', () => {
      reconnectDelay = 1000;
      const saved = loadSession();
      if (saved) send({ type: 'rejoin', ...saved });
      else {
        const code = codeFromUrl();
        if (code) { $('#join-code').value = code; send({ type: 'lobbyInfo', code }); }
      }
    });
    ws.addEventListener('message', (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      onMessage(msg);
    });
    ws.addEventListener('close', () => {
      if (me) toast('Connection lost. Reconnecting…', 'info');
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 10000);
    });
  }
  function send(obj) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); else toast('Not connected to the server yet.'); }
  const act = (action) => send({ type: 'action', action });

  function onMessage(msg) {
    switch (msg.type) {
      case 'joined':
        me = { code: msg.code, playerId: msg.playerId, token: msg.token };
        saveSession(me);
        $('#toast').classList.add('hidden');
        $('#home-error').classList.add('hidden');
        dismissedGameOver = false;
        history.replaceState(null, '', '/' + msg.code);
        break;
      case 'rejoinFailed':
        clearSession();
        me = null;
        show('screen-home');
        break;
      case 'left':
        clearSession(); me = null; state = null;
        history.replaceState(null, '', '/');
        show('screen-home');
        renderMonsterPicker();
        break;
      case 'lobbyInfo':
        takenMonsters = msg.taken;
        renderMonsterPicker();
        if (msg.players.length) toast(`Game ${msg.code}: ${msg.players.join(', ')} waiting. Pick a monster and join!`, 'info');
        break;
      case 'state':
        state = msg.state;
        if (state.monsters) monsters = state.monsters;
        render();
        break;
      case 'error':
        toast(msg.message);
        $('#home-error').textContent = msg.message;
        $('#home-error').classList.toggle('hidden', !$('#screen-home').offsetParent);
        break;
    }
  }

  function saveSession(s) { try { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch {} }
  function loadSession() { try { return JSON.parse(localStorage.getItem(SESSION_KEY)); } catch { return null; } }
  function clearSession() { try { localStorage.removeItem(SESSION_KEY); } catch {} }
  function codeFromUrl() {
    const q = new URLSearchParams(location.search).get('code');
    const p = location.pathname.replace(/\//g, '');
    const c = (q || p || '').toUpperCase();
    return /^[A-Z]{4}$/.test(c) ? c : '';
  }

  // ------------------------------------------------------------ home
  function renderMonsterPicker() {
    const box = $('#monster-picker');
    box.innerHTML = '';
    for (const m of monsters) {
      const taken = takenMonsters.includes(m.id);
      const b = el('button', {
        type: 'button',
        class: 'monster-opt' + (selectedMonster === m.id ? ' selected' : '') + (taken ? ' taken' : ''),
        onclick: () => { if (taken) return; selectedMonster = m.id; renderMonsterPicker(); },
      }, el('span', { class: 'emoji' }, m.emoji), el('span', { class: 'name' }, m.name));
      box.append(b);
    }
  }

  function homeValid() {
    const name = $('#name').value.trim();
    if (!name) { toast('Enter your name first.'); return null; }
    if (!selectedMonster) { toast('Pick a monster.'); return null; }
    try { localStorage.setItem('kot.name', name); } catch {}
    return name;
  }

  $('#btn-create').addEventListener('click', () => {
    const name = homeValid(); if (!name) return;
    send({ type: 'create', name, monster: selectedMonster });
  });
  $('#btn-join').addEventListener('click', () => {
    const name = homeValid(); if (!name) return;
    const code = $('#join-code').value.trim().toUpperCase();
    if (code.length !== 4) { toast('Enter the 4-letter game code.'); return; }
    send({ type: 'join', code, name, monster: selectedMonster });
  });
  $('#join-code').addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, '');
    if (e.target.value.length === 4) send({ type: 'lobbyInfo', code: e.target.value });
    else { takenMonsters = []; renderMonsterPicker(); }
  });
  $('#join-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btn-join').click(); });
  $('#name').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btn-create').click(); });
  try { $('#name').value = localStorage.getItem('kot.name') || ''; } catch {}

  // ------------------------------------------------------------ lobby
  $('#btn-start').addEventListener('click', () => send({ type: 'start' }));
  $('#btn-leave').addEventListener('click', () => send({ type: 'leave' }));
  $('#btn-copy-link').addEventListener('click', async () => {
    const link = `${location.origin}/${me.code}`;
    try { await navigator.clipboard.writeText(link); toast('Invite link copied!', 'info'); }
    catch { prompt('Copy this link:', link); }
  });

  function renderLobby() {
    $('#lobby-code').textContent = state.code;
    const list = $('#lobby-players');
    list.innerHTML = '';
    for (const p of state.players) {
      const m = monster(p.monster);
      list.append(el('li', {},
        el('span', { class: 'emoji' }, m.emoji),
        el('span', {}, el('b', {}, p.name), ' ', el('span', { class: 'hint' }, m.name)),
        p.id === state.hostId ? el('span', { class: 'tag' }, 'host') : null,
        p.id === me.playerId ? el('span', { class: 'tag' }, 'you') : null,
      ));
    }
    const isHost = state.hostId === me.playerId;
    $('#btn-start').classList.toggle('hidden', !isHost);
    $('#btn-start').disabled = state.players.length < 2;
    $('#lobby-hint').textContent = state.players.length < 2
      ? 'Waiting for at least one more player…'
      : isHost ? `${state.players.length} players ready. Start when everyone is in (max 6).` : 'Waiting for the host to start the game…';
  }

  // ------------------------------------------------------------ game
  $('#btn-rules').addEventListener('click', () => $('#rules').classList.remove('hidden'));
  $('#btn-rules-close').addEventListener('click', () => $('#rules').classList.add('hidden'));

  function render() {
    if (!state || !me) return;
    if (state.phase === 'lobby') { show('screen-lobby'); renderLobby(); return; }
    show('screen-game');
    const t = state.turn;
    const cur = state.players.find(p => p.id === t.playerId);
    const mine = cur && cur.id === me.playerId;
    const self = state.players.find(p => p.id === me.playerId);

    $('#game-code').textContent = state.code;
    renderBanner(t, cur, mine, self);
    renderTokyo();
    renderPlayers(self, t);
    renderActionPanel(t, cur, mine, self);
    renderShop(t, cur, mine, self);
    renderLog();
    renderModal(t, cur, self);
  }

  function renderBanner(t, cur, mine, self) {
    const b = $('#turn-banner');
    b.classList.toggle('mine', mine);
    if (state.phase === 'ended') {
      const w = state.players.find(p => p.id === state.winner);
      b.textContent = w ? `🏆 ${w.name} is the King of Tokyo!` : 'Everyone was destroyed. No winner!';
      return;
    }
    if (!self.alive) { b.textContent = `You were eliminated. ${cur.name} is playing.`; return; }
    if (t.step === 'yield') {
      const names = t.pendingYield.map(id => state.players.find(p => p.id === id).name).join(' & ');
      b.textContent = t.pendingYield.includes(me.playerId) ? '🏙️ Decide: stay in Tokyo or yield?' : `Waiting for ${names} to decide about Tokyo…`;
      return;
    }
    if (mine) b.textContent = t.step === 'roll' ? (t.rolled ? `🎲 Your turn — reroll or stop (${t.rollsLeft} left)` : '🎲 Your turn — roll the dice!') : '🛒 Your turn — buy cards or end your turn';
    else b.textContent = `${monster(cur.monster).emoji} ${cur.name} is ${t.step === 'roll' ? 'rolling' : 'shopping'}…`;
  }

  function renderTokyo() {
    const box = $('#tokyo');
    box.classList.toggle('with-bay', state.bayActive);
    box.innerHTML = '';
    const slot = (title, pid) => {
      const p = pid ? state.players.find(x => x.id === pid) : null;
      const s = el('div', { class: 'tokyo-slot' + (p ? ' occupied' : '') }, el('h4', {}, title));
      if (p) s.append(el('div', { class: 'emoji' }, monster(p.monster).emoji), el('div', { class: 'who' }, p.name));
      else s.append(el('div', { class: 'empty' }, 'Empty — roll a 🐾 to move in'));
      return s;
    };
    box.append(slot('Tokyo City', state.tokyo.city));
    if (state.bayActive) box.append(slot('Tokyo Bay', state.tokyo.bay));
  }

  function renderPlayers(self, t) {
    const box = $('#players');
    box.innerHTML = '';
    const canSell = self && self.alive && t.playerId === self.id && t.step === 'buy' && self.cards.some(c => c.id === 'metamorph') && state.phase === 'playing';
    for (const p of state.players) {
      const m = monster(p.monster);
      const inTokyo = state.tokyo.city === p.id || state.tokyo.bay === p.id;
      const card = el('div', {
        class: 'pcard' + (p.id === t.playerId ? ' current' : '') + (p.alive ? '' : ' dead') + (p.id === me.playerId ? ' me' : ''),
        style: `--pc:${m.color}`,
      });
      card.append(el('div', { class: 'head' },
        el('span', { class: 'emoji' }, m.emoji),
        el('div', {}, el('div', { class: 'name' }, p.name), el('div', { class: 'sub' }, m.name)),
        inTokyo ? el('span', { class: 'badge' }, 'Tokyo') : null,
        !p.connected && p.alive ? el('span', { class: 'badge off' }, 'offline') : null,
      ));
      card.append(el('div', { class: 'stats' },
        el('span', { class: 'stat hp' }, `♥ ${p.hp}/${p.maxHp}`),
        el('span', { class: 'stat vp' }, `★ ${p.vp}`),
        el('span', { class: 'stat en' }, `⚡ ${p.energy}`),
        p.poison ? el('span', { class: 'stat ctr' }, `☠ ${p.poison} poison`) : null,
        p.shrink ? el('span', { class: 'stat ctr' }, `🔻 ${p.shrink} shrink`) : null,
      ));
      card.append(el('div', { class: 'hpbar' }, el('div', { style: `width:${(100 * p.hp / p.maxHp).toFixed(0)}%` })));
      if (p.cards.length) {
        const sellable = canSell && p.id === self.id;
        card.append(el('div', { class: 'pcards' }, p.cards.map(c => el('span', {
          class: 'mini-card' + (sellable ? ' sell' : ''),
          title: `${c.name} (${c.cost}⚡): ${c.text}${sellable ? ' — click to sell (Metamorph)' : ''}`,
          onclick: sellable ? () => confirmModal(`Sell ${c.name} for ${c.cost} ⚡?`, () => act({ type: 'sell', cardId: c.id })) : null,
        }, c.name))));
      }
      if (state.phase === 'playing' && state.hostId === me.playerId && !p.connected && p.alive && p.id !== me.playerId) {
        card.append(el('div', { style: 'margin-top:8px' }, el('button', { class: 'btn tiny danger', onclick: () => confirmModal(`Remove ${p.name} from the game? They will count as eliminated.`, () => act({ type: 'kick', targetId: p.id })) }, 'Remove player')));
      }
      box.append(card);
    }
  }

  function diceEl(dice, { interactive, animateKey }) {
    const changed = animateKey !== lastDiceKey;
    const row = el('div', { class: 'dice' });
    dice.forEach((d, i) => {
      const isKept = interactive ? kept.has(i) : d.kept;
      const die = el('div', {
        class: `die ${d.face} ${isKept ? 'kept' : ''} ${interactive ? '' : 'static'} ${changed && !isKept ? 'rolling' : ''}`,
        onclick: interactive ? () => onDieClick(i) : null,
      }, FACE[d.face]);
      row.append(die);
    });
    lastDiceKey = animateKey;
    return row;
  }

  function onDieClick(i) {
    if (tool) {
      const via = tool; tool = null;
      if (via === 'herd_culler') act({ type: 'setDie', index: i, face: '1', via });
      else facePicker(`Change die ${i + 1} to…`, (face) => act({ type: 'setDie', index: i, face, via }));
      return;
    }
    if (kept.has(i)) kept.delete(i); else kept.add(i);
    render();
  }

  function renderActionPanel(t, cur, mine, self) {
    const box = $('#action-panel');
    box.innerHTML = '';
    if (state.phase === 'ended') {
      box.append(el('h3', {}, 'Game over'), el('div', { class: 'action-row center' },
        el('button', { class: 'btn primary', onclick: () => { send({ type: 'leave' }); } }, 'Back to home')));
      return;
    }
    const diceKey = t.dice.map(d => d.face).join('') + '|' + t.rollsLeft + '|' + t.playerId;
    if (!mine) {
      box.append(el('h3', {}, `${cur.name}'s dice`));
      if (t.rolled) box.append(diceEl(t.dice, { interactive: false, animateKey: diceKey }));
      else box.append(el('p', { class: 'status-line' }, 'Not rolled yet…'));
      return;
    }
    if (t.step === 'roll') {
      box.append(el('h3', {}, 'Your dice'));
      if (!t.rolled) {
        kept.clear();
        box.append(el('p', { class: 'status-line' }, `Rolling ${t.diceCount} dice. You get ${t.rollsLeft} rolls.`));
        box.append(el('div', { class: 'action-row center' }, el('button', { class: 'btn primary big', onclick: () => act({ type: 'roll' }) }, '🎲 Roll!')));
      } else {
        box.append(diceEl(t.dice, { interactive: true, animateKey: diceKey }));
        box.append(el('p', { class: 'status-line' }, tool ? `Click the die to change (${cardName(tool)}).` : 'Click dice to keep them, then reroll the rest.'));
        const allKept = kept.size === t.dice.length;
        const canBgd = self.cards.some(c => c.id === 'background_dweller') && t.dice.some((d, i) => d.face === '3' && !kept.has(i));
        const rerollLabel = t.rollsLeft > 0 ? `Reroll (${t.rollsLeft} left)` : canBgd ? 'Reroll 3s (Background Dweller)' : 'No rerolls left';
        box.append(el('div', { class: 'action-row center' },
          el('button', { class: 'btn big', disabled: (t.rollsLeft <= 0 && !canBgd) || allKept ? '' : null, onclick: () => act({ type: 'roll', keep: [...kept] }) }, rerollLabel),
          el('button', { class: 'btn primary big', onclick: () => { kept.clear(); act({ type: 'stopRolling' }); } }, 'Stop & resolve ✔'),
        ));
        const tools = [];
        if (self.cards.some(c => c.id === 'herd_culler') && !t.usedHerdCuller) tools.push(toolBtn('herd_culler', 'Herd Culler: set a die to 1'));
        if (self.cards.some(c => c.id === 'stretchy') && self.energy >= 2) tools.push(toolBtn('stretchy', 'Stretchy (2⚡): change a die'));
        if (self.cards.some(c => c.id === 'plot_twist')) tools.push(toolBtn('plot_twist', 'Plot Twist: change a die'));
        if (tools.length) box.append(el('div', { class: 'tool-row' }, 'Card powers:', tools, tool ? el('button', { class: 'btn tiny', onclick: () => { tool = null; render(); } }, 'cancel') : null));
      }
    } else if (t.step === 'yield') {
      box.append(el('h3', {}, 'Your dice'), diceEl(t.dice, { interactive: false, animateKey: diceKey }),
        el('p', { class: 'status-line' }, 'Waiting for the monsters in Tokyo to decide…'));
    } else {
      box.append(el('h3', {}, 'Your dice'), diceEl(t.dice, { interactive: false, animateKey: diceKey }));
      box.append(el('div', { class: 'action-row center' },
        el('button', { class: 'btn primary big', onclick: () => act({ type: 'endTurn' }) }, 'End turn ➜')));
    }
    if (self.cards.some(c => c.id === 'rapid_healing') && self.energy >= 2 && self.hp < self.maxHp && t.step !== 'yield') {
      box.append(el('div', { class: 'tool-row' }, el('button', { class: 'btn small', onclick: () => act({ type: 'rapidHeal' }) }, 'Rapid Healing: 2⚡ → heal 1')));
    }
  }

  const cardName = (id) => ({ herd_culler: 'Herd Culler', stretchy: 'Stretchy', plot_twist: 'Plot Twist' })[id] || id;
  const toolBtn = (id, label) => el('button', { class: 'btn small' + (tool === id ? ' primary' : ''), onclick: () => { tool = tool === id ? null : id; render(); } }, label);

  function renderShop(t, cur, mine, self) {
    const box = $('#shop-panel');
    box.innerHTML = '';
    box.append(el('h3', {}, `Cards for sale · ${state.deckSize} in deck`));
    const canBuy = mine && t.step === 'buy' && state.phase === 'playing';
    const discount = self.cards.some(c => c.id === 'alien_metabolism') ? 1 : 0;
    const grid = el('div', { class: 'shop' });
    state.shop.forEach((c, i) => grid.append(cardEl(c, canBuy, self, discount, () => act({ type: 'buy', index: i }))));
    if (t.labCard && cur.cards.some(c => c.id === 'made_in_a_lab')) {
      grid.append(cardEl({ ...t.labCard, name: t.labCard.name + ' (top of deck)' }, canBuy, self, discount, () => act({ type: 'buyLab' })));
    }
    box.append(grid);
    if (canBuy) {
      box.append(el('div', { class: 'shop-actions' },
        el('button', { class: 'btn', disabled: self.energy < 2 ? '' : null, onclick: () => act({ type: 'sweep' }) }, 'Sweep all 3 (2⚡)'),
        self.cards.some(c => c.id === 'metamorph') ? el('span', { class: 'hint' }, 'Metamorph: click one of your cards to sell it.') : null,
      ));
    }
  }

  function cardEl(c, canBuy, self, discount, onBuy) {
    const cost = Math.max(0, c.cost - discount);
    const node = el('div', { class: 'card ' + (c.type === 'discard' ? 'discard-type' : 'keep-type') },
      el('div', { class: 'cost' }, cost),
      el('div', { class: 'cname' }, c.name),
      el('div', { class: 'ctype' }, c.type === 'keep' ? 'Keep' : 'Discard'),
      el('div', { class: 'ctext' }, c.text),
    );
    if (canBuy) node.append(el('button', { class: 'btn small primary', disabled: self.energy < cost ? '' : null, onclick: onBuy }, `Buy for ${cost}⚡`));
    return node;
  }

  function renderLog() {
    const box = $('#log');
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    box.innerHTML = '';
    for (const l of state.logs) box.append(el('div', { class: l.text.startsWith('—') ? 'turn' : '' }, l.text));
    if (atBottom) box.scrollTop = box.scrollHeight;
  }

  // ------------------------------------------------------------ modals
  function openModal(...children) {
    const box = $('#modal-box');
    box.innerHTML = '';
    box.append(...children);
    $('#modal').classList.remove('hidden');
  }
  function closeModal() { $('#modal').classList.add('hidden'); }

  function confirmModal(text, onYes) {
    openModal(el('h2', {}, 'Are you sure?'), el('p', {}, text), el('div', { class: 'action-row' },
      el('button', { class: 'btn primary', onclick: () => { closeModal(); onYes(); } }, 'Yes'),
      el('button', { class: 'btn', onclick: closeModal }, 'Cancel')));
  }

  function facePicker(title, onPick) {
    openModal(el('h2', {}, title), el('div', { class: 'face-picker' }, FACES.map(f =>
      el('div', { class: `die ${f}`, onclick: () => { closeModal(); onPick(f); } }, FACE[f]))),
      el('div', { class: 'action-row' }, el('button', { class: 'btn', onclick: closeModal }, 'Cancel')));
  }

  function renderModal(t, cur, self) {
    if (state.phase === 'ended') {
      if (dismissedGameOver) return;
      const w = state.players.find(p => p.id === state.winner);
      openModal(
        el('div', { class: 'winner-emoji' }, w ? monster(w.monster).emoji : '💀'),
        el('h2', {}, w ? `${w.name} is the King of Tokyo!` : 'Everyone was destroyed!'),
        el('p', {}, w && w.id === me.playerId ? 'You win! 🎉' : (w ? `${w.name} finished with ${w.vp} ★.` : 'No monster survived.')),
        el('div', { class: 'action-row' },
          el('button', { class: 'btn primary', onclick: () => { closeModal(); send({ type: 'leave' }); } }, 'Back to home'),
          el('button', { class: 'btn', onclick: () => { dismissedGameOver = true; closeModal(); } }, 'Look at the board')),
      );
      return;
    }
    if (t.step === 'yield' && t.pendingYield.includes(me.playerId)) {
      const dmg = t.yieldDamage[me.playerId] || 0;
      const hasJets = self.cards.some(c => c.id === 'jets');
      openModal(
        el('h2', {}, '🏙️ You were attacked in Tokyo!'),
        el('p', {}, `${cur.name} hit you for ${dmg} damage. You have ${self.hp} ♥ left.`),
        el('p', { class: 'hint' }, hasJets ? 'Jets: if you yield, you take no damage from this attack.' : 'If you stay you keep scoring ★ but cannot heal. If you yield, ' + cur.name + ' takes your place.'),
        el('div', { class: 'action-row' },
          el('button', { class: 'btn danger big', onclick: () => { closeModal(); act({ type: 'yield', yes: true }); } }, 'Yield Tokyo'),
          el('button', { class: 'btn primary big', onclick: () => { closeModal(); act({ type: 'yield', yes: false }); } }, 'Stay and fight!')),
      );
      return;
    }
    // Close only modals we opened automatically (yield / game over); keep confirms open.
    const box = $('#modal-box');
    if (!$('#modal').classList.contains('hidden') && box.querySelector('h2') && /attacked in Tokyo|King of Tokyo|destroyed/.test(box.querySelector('h2').textContent)) closeModal();
  }

  // ------------------------------------------------------------ boot
  renderMonsterPicker();
  show('screen-home');
  connect();
})();
