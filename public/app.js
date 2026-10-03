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
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'style') n.style.cssText = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (v === true) n.setAttribute(k, '');
      else n.setAttribute(k, v);
    }
    for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) n.append(c.nodeType ? c : document.createTextNode(String(c)));
    return n;
  };

  // ------------------------------------------------------------ state
  let ws = null;
  let me = null;            // { code, playerId, token }
  let state = null;         // last server state
  let prevState = null;
  let monsters = [];
  let selectedMonster = null;
  let takenMonsters = [];
  let kept = new Set();     // dice indices kept locally during rolling
  let tool = null;          // active die-changing card id
  let lastDiceKey = '';
  let dismissedGameOver = false;
  let reconnectDelay = 1000;
  let autoModal = null;     // which automatic modal is open: 'yield' | 'decision:<id>' | 'gameover' | null

  const FALLBACK_MONSTERS = [
    { id: 'king', name: 'The King', emoji: '🦍', color: '#d08a3c' },
    { id: 'gigazaur', name: 'Gigazaur', emoji: '🦖', color: '#5cb85c' },
    { id: 'cyber_bunny', name: 'Cyber Bunny', emoji: '🐰', color: '#ff5fa2' },
    { id: 'kraken', name: 'Kraken', emoji: '🐙', color: '#5b7cff' },
    { id: 'alienoid', name: 'Alienoid', emoji: '👽', color: '#9ad53a' },
    { id: 'meka_dragon', name: 'Meka Dragon', emoji: '🐉', color: '#b45cff' },
  ];
  monsters = FALLBACK_MONSTERS;
  const monster = (id) => monsters.find(m => m.id === id) || { name: '?', emoji: '❓', color: '#888' };
  const hasPower = (p, id) => p.cards.some(c => c.id === id) || (p.mimicTarget && p.mimicTarget.id === id && p.cards.some(c => c.id === 'mimic'));
  const byId = (id) => state.players.find(p => p.id === id);

  // ------------------------------------------------------------ toast
  let toastTimer = null;
  function toast(msg, kind = 'error') {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast ' + kind;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
  }

  // ------------------------------------------------------------ screens
  function show(id) {
    for (const s of document.querySelectorAll('.screen')) s.hidden = s.id !== id;
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
        dismissedGameOver = false;
        $('#toast').hidden = true;
        $('#home-error').hidden = true;
        history.replaceState(null, '', '/' + msg.code);
        break;
      case 'rejoinFailed':
        clearSession();
        me = null;
        show('screen-home');
        break;
      case 'left':
        clearSession(); me = null; state = null; prevState = null; autoModal = null;
        closeModal();
        history.replaceState(null, '', '/');
        show('screen-home');
        takenMonsters = [];
        renderMonsterPicker();
        break;
      case 'lobbyInfo':
        takenMonsters = msg.taken;
        renderMonsterPicker();
        if (msg.players.length) toast(`Game ${msg.code}: ${msg.players.join(', ')} waiting. Pick a monster and join!`, 'info');
        break;
      case 'state':
        prevState = state;
        state = msg.state;
        if (state.monsters) monsters = state.monsters;
        render();
        break;
      case 'error':
        toast(msg.message);
        if (!$('#screen-home').hidden) { $('#home-error').textContent = msg.message; $('#home-error').hidden = false; }
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
      box.append(el('button', {
        type: 'button', role: 'radio', 'aria-checked': selectedMonster === m.id ? 'true' : 'false',
        class: 'monster-opt' + (selectedMonster === m.id ? ' selected' : '') + (taken ? ' taken' : ''),
        style: `--mc:${m.color}`,
        title: m.power ? `Game Plus power — ${m.power.name}: ${m.power.text}` : null,
        onclick: () => { if (taken) return; selectedMonster = m.id; renderMonsterPicker(); },
      }, el('span', { class: 'emoji' }, m.emoji), el('span', { class: 'name' }, m.name)));
    }
  }

  function homeValid() {
    const name = $('#name').value.trim();
    if (!name) { toast('Enter your name first.'); $('#name').focus(); return null; }
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
    if (code.length !== 4) { toast('Enter the 4-letter game code.'); $('#join-code').focus(); return; }
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
  $('#opt-powers').addEventListener('change', (e) => send({ type: 'setOptions', options: { powers: e.target.checked } }));
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
      list.append(el('li', { style: `--mc:${m.color}` },
        el('span', { class: 'emoji' }, m.emoji),
        el('span', {}, el('b', {}, p.name), ' ', el('span', { class: 'hint', style: 'margin:0' }, m.name)),
        p.id === state.hostId ? el('span', { class: 'tag' }, 'host') : null,
        p.id === me.playerId ? el('span', { class: 'tag' }, 'you') : null,
      ));
    }
    const isHost = state.hostId === me.playerId;
    const powersOn = !!(state.options && state.options.powers);
    const chk = $('#opt-powers');
    chk.checked = powersOn;
    chk.disabled = !isHost;
    $('.toggle').title = isHost ? '' : 'Only the host can change this.';
    const pl = $('#powers-list');
    pl.hidden = !powersOn;
    pl.innerHTML = '';
    if (powersOn) for (const m of monsters) pl.append(el('li', {}, el('span', {}, m.emoji), el('span', { class: 'pname' }, `${m.name}: ${m.power.name}.`), el('span', { class: 'ptext' }, m.power.text)));
    $('#btn-start').hidden = !isHost;
    $('#btn-start').disabled = state.players.length < 2;
    $('#lobby-hint').textContent = state.players.length < 2
      ? 'Waiting for at least one more player…'
      : isHost ? `${state.players.length} monsters ready. Start when everyone is in (max 6).` : 'Waiting for the host to start the game…';
  }

  // ------------------------------------------------------------ game
  $('#btn-rules').addEventListener('click', () => { $('#rules').hidden = false; });
  $('#btn-rules-close').addEventListener('click', () => { $('#rules').hidden = true; });
  $('#btn-leave-game').addEventListener('click', () => {
    const playing = state && state.phase === 'playing';
    confirmModal(playing ? 'Leave the game? Your monster will be out and the others keep playing.' : 'Leave this game?', () => send({ type: 'leave' }), 'Leave game');
  });
  $('#btn-end-game').addEventListener('click', () => {
    confirmModal('End the game for everyone? This cannot be undone.', () => act({ type: 'endGame' }), 'End game');
  });

  function render() {
    if (!state || !me) return;
    if (state.phase === 'lobby') { show('screen-lobby'); renderLobby(); return; }
    show('screen-game');
    const t = state.turn;
    const cur = byId(t.playerId);
    const mine = cur && cur.id === me.playerId;
    const self = byId(me.playerId);
    const d = state.decision;

    $('#game-code').textContent = state.code + (state.options && state.options.powers ? ' ✨' : '');
    $('#btn-end-game').hidden = !(state.hostId === me.playerId && state.phase === 'playing');
    renderBanner(t, cur, mine, self, d);
    renderTokyo();
    renderPlayers(self, t, d);
    renderActionPanel(t, cur, mine, self, d);
    renderShop(t, cur, mine, self, d);
    renderLog();
    renderModal(t, cur, self, d);
  }

  function renderBanner(t, cur, mine, self, d) {
    const b = $('#turn-banner');
    b.classList.toggle('mine', mine && state.phase === 'playing' && !d);
    if (state.phase === 'ended') {
      const w = state.players.find(p => p.id === state.winner);
      b.textContent = state.endedBy === 'host' ? 'The host ended the game.' : w ? `🏆 ${w.name} is the King of Tokyo!` : 'Everyone was destroyed. No winner!';
      return;
    }
    if (!self.alive) { b.textContent = `You are out. ${cur.name} is playing.`; return; }
    if (d) {
      const who = byId(d.playerId);
      const what = d.kind === 'wings' ? 'Wings' : 'Opportunist';
      b.textContent = d.playerId === me.playerId ? `🪽 Your call: ${what}` : `Waiting for ${who.name} (${what})…`;
      return;
    }
    if (t.step === 'yield') {
      const names = t.pendingYield.map(id => byId(id).name).join(' & ');
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
      const p = pid ? byId(pid) : null;
      const s = el('div', { class: 'tokyo-slot' + (p ? ' occupied' : '') }, el('h4', {}, title));
      if (p) s.append(el('div', { class: 'emoji' }, monster(p.monster).emoji), el('div', { class: 'who' }, p.name), p.id === me.playerId ? el('div', { class: 'you-tag' }, 'that\'s you') : null);
      else s.append(el('div', { class: 'empty' }, 'Empty. Roll a 🐾 to move in.'));
      return s;
    };
    box.append(slot('Tokyo City', state.tokyo.city));
    if (state.bayActive) box.append(slot('Tokyo Bay', state.tokyo.bay));
  }

  function renderPlayers(self, t, d) {
    const box = $('#players');
    box.innerHTML = '';
    const myBuyStep = self && self.alive && t.playerId === self.id && t.step === 'buy' && state.phase === 'playing' && !d;
    const canSell = myBuyStep && hasPower(self, 'metamorph');
    const canTentacle = myBuyStep && hasPower(self, 'parasitic_tentacles');
    const discount = self && hasPower(self, 'alien_metabolism') ? 1 : 0;
    for (const p of state.players) {
      const m = monster(p.monster);
      const inTokyo = state.tokyo.city === p.id || state.tokyo.bay === p.id;
      const prev = prevState && prevState.players.find(x => x.id === p.id);
      const hit = prev && prev.hp > p.hp;
      const card = el('div', {
        class: 'pcard' + (p.id === t.playerId ? ' current' : '') + (p.alive ? '' : ' dead') + (hit ? ' hit' : ''),
        style: `--mc:${m.color}`,
      });
      if (p.id === me.playerId) card.append(el('span', { class: 'you-tag' }, 'YOU'));
      card.append(el('div', { class: 'head' },
        el('span', { class: 'avatar' }, m.emoji),
        el('div', { class: 'names' }, el('div', { class: 'name' }, p.name), el('div', { class: 'sub' }, m.name)),
        el('div', { class: 'badges' },
          inTokyo ? el('span', { class: 'badge' }, 'Tokyo') : null,
          p.id === state.hostId && p.id !== me.playerId ? el('span', { class: 'badge host' }, 'host') : null,
          !p.connected && p.alive ? el('span', { class: 'badge off' }, 'offline') : null,
          p.left ? el('span', { class: 'badge off' }, 'left') : null,
        ),
      ));
      card.append(el('div', { class: 'stats' },
        el('span', { class: 'stat hp' }, `♥ ${p.hp}/${p.maxHp}`),
        el('span', { class: 'stat vp' }, `★ ${p.vp}`),
        el('span', { class: 'stat en' }, `⚡ ${p.energy}`),
        p.poison ? el('span', { class: 'stat ctr' }, `☠ ${p.poison} poison`) : null,
        p.shrink ? el('span', { class: 'stat ctr' }, `🔻 ${p.shrink} shrink`) : null,
      ));
      card.append(el('div', { class: 'hpbar' }, el('div', { style: `width:${(100 * p.hp / Math.max(1, p.maxHp)).toFixed(0)}%` })));
      if (state.options && state.options.powers && m.power) {
        card.append(el('div', { class: 'power-chip', title: m.power.text }, '✨', el('span', {}, m.power.name)));
      }
      if (p.cards.length) {
        const sellable = canSell && p.id === self.id;
        const buyable = canTentacle && p.id !== self.id && p.alive;
        card.append(el('div', { class: 'pcards' }, p.cards.map(c => {
          const isMimic = c.id === 'mimic';
          const label = isMimic && p.mimicTarget ? `Mimic → ${p.mimicTarget.name}` : c.name;
          const cost = Math.max(0, c.cost - discount);
          let title = `${c.name} (${c.cost}⚡): ${c.text}`;
          if (sellable) title += ' · Click to sell (Metamorph)';
          if (buyable) title += ` · Click to buy for ${cost}⚡ (Parasitic Tentacles)`;
          return el('span', {
            class: 'mini-card' + (sellable ? ' sell' : '') + (buyable ? ' buyable' : '') + (isMimic ? ' mimic' : ''),
            title,
            onclick: sellable ? () => confirmModal(`Sell ${c.name} for ${c.cost} ⚡?`, () => act({ type: 'sell', cardId: c.id }), 'Sell')
              : buyable ? () => confirmModal(`Buy ${c.name} from ${p.name} for ${cost} ⚡? They get the Energy.`, () => act({ type: 'buyFrom', playerId: p.id, cardId: c.id }), 'Buy')
              : null,
          }, label);
        })));
      }
      if (state.phase === 'playing' && state.hostId === me.playerId && !p.connected && p.alive && p.id !== me.playerId) {
        card.append(el('div', { style: 'margin-top:8px' }, el('button', { class: 'btn tiny danger', onclick: () => confirmModal(`Remove ${p.name} from the game? They will count as eliminated.`, () => act({ type: 'kick', targetId: p.id }), 'Remove') }, 'Remove player')));
      }
      box.append(card);
    }
  }

  function diceEl(dice, { interactive, animateKey, probe }) {
    const changed = animateKey !== lastDiceKey;
    const row = el('div', { class: 'dice' });
    dice.forEach((d, i) => {
      const isKept = interactive ? kept.has(i) : d.kept;
      row.append(el('div', {
        class: `die ${d.face} ${isKept ? 'kept' : ''} ${interactive ? '' : 'static'} ${probe ? 'probe' : ''} ${changed && !isKept ? 'rolling' : ''}`,
        role: interactive || probe ? 'button' : null,
        title: probe ? 'Psychic Probe: force a reroll of this die' : null,
        onclick: interactive ? () => onDieClick(i) : probe ? () => confirmModal(`Use Psychic Probe to reroll this ${FACE[d.face]}?`, () => act({ type: 'probe', index: i }), 'Reroll it') : null,
      }, FACE[d.face]));
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

  function renderActionPanel(t, cur, mine, self, d) {
    const box = $('#action-panel');
    box.innerHTML = '';
    if (state.phase === 'ended') {
      box.append(el('h3', {}, 'Game over'), el('div', { class: 'action-row center' },
        el('button', { class: 'btn primary', onclick: () => send({ type: 'leave' }) }, 'Back to home')));
      return;
    }
    const diceKey = t.dice.map(x => x.face).join('') + '|' + t.rollsLeft + '|' + t.playerId + '|' + (t.probed || []).length;
    if (d) {
      const who = byId(d.playerId);
      box.append(el('h3', {}, d.kind === 'wings' ? 'Wings' : 'Opportunist'));
      if (t.rolled) box.append(diceEl(t.dice, { interactive: false, animateKey: diceKey }));
      box.append(el('div', { class: 'waiting' }, el('span', { class: 'dot' }), d.playerId === me.playerId ? 'Answer the question to continue.' : `${who.name} is deciding…`));
      return;
    }
    if (!mine) {
      box.append(el('h3', {}, `${cur.name}'s dice`));
      const canProbe = self.alive && hasPower(self, 'psychic_probe') && t.step === 'roll' && t.rolled && !(t.probed || []).includes(self.id);
      if (t.rolled) box.append(diceEl(t.dice, { interactive: false, animateKey: diceKey, probe: canProbe }));
      else box.append(el('div', { class: 'waiting' }, el('span', { class: 'dot' }), 'Not rolled yet…'));
      if (canProbe) box.append(el('p', { class: 'status-line' }, '🔮 Psychic Probe: click one of their dice to force a reroll.'));
      return;
    }
    if (t.step === 'roll') {
      box.append(el('div', { class: 'dice-row-head' }, el('h3', {}, 'Your dice'), el('span', { class: 'rolls-left' }, t.rolled ? `${t.rollsLeft} reroll${t.rollsLeft === 1 ? '' : 's'} left` : `${t.diceCount} dice`)));
      if (!t.rolled) {
        kept.clear();
        box.append(el('p', { class: 'status-line' }, `Roll ${t.diceCount} dice. You get ${t.rollsLeft} rolls in total.`));
        box.append(el('div', { class: 'action-row center' }, el('button', { class: 'btn gold big', onclick: () => act({ type: 'roll' }) }, '🎲 Roll!')));
        if (self.cards.some(c => c.id === 'mimic')) box.append(mimicTool(self));
      } else {
        box.append(diceEl(t.dice, { interactive: true, animateKey: diceKey }));
        box.append(el('p', { class: 'status-line' }, tool ? `Click the die to change (${cardName(tool)}).` : 'Click dice to keep them, then reroll the rest.'));
        const allKept = kept.size === t.dice.length;
        const canBgd = hasPower(self, 'background_dweller') && t.dice.some((x, i) => x.face === '3' && !kept.has(i));
        const rerollLabel = t.rollsLeft > 0 ? `Reroll (${t.rollsLeft} left)` : canBgd ? 'Reroll 3s (Background Dweller)' : 'No rerolls left';
        box.append(el('div', { class: 'action-row center' },
          el('button', { class: 'btn big', disabled: (t.rollsLeft <= 0 && !canBgd) || allKept, onclick: () => act({ type: 'roll', keep: [...kept] }) }, rerollLabel),
          el('button', { class: 'btn primary big', onclick: () => { kept.clear(); act({ type: 'stopRolling' }); } }, 'Stop & resolve ✔'),
        ));
        const tools = [];
        if (hasPower(self, 'herd_culler') && !t.usedHerdCuller) tools.push(toolBtn('herd_culler', 'Herd Culler: set a die to 1'));
        if (hasPower(self, 'stretchy') && self.energy >= 2) tools.push(toolBtn('stretchy', 'Stretchy (2⚡): change a die'));
        if (hasPower(self, 'plot_twist')) tools.push(toolBtn('plot_twist', 'Plot Twist: change a die'));
        if (tools.length) box.append(el('div', { class: 'tool-row' }, 'Card powers:', tools, tool ? el('button', { class: 'btn tiny', onclick: () => { tool = null; render(); } }, 'cancel') : null));
      }
    } else if (t.step === 'yield') {
      box.append(el('h3', {}, 'Your dice'), diceEl(t.dice, { interactive: false, animateKey: diceKey }),
        el('div', { class: 'waiting' }, el('span', { class: 'dot' }), 'Waiting for the monsters in Tokyo to decide…'));
    } else {
      box.append(el('h3', {}, 'Your dice'), diceEl(t.dice, { interactive: false, animateKey: diceKey }));
      box.append(el('div', { class: 'action-row center' },
        el('button', { class: 'btn primary big', onclick: () => act({ type: 'endTurn' }) }, 'End turn ➜')));
      if (self.cards.some(c => c.id === 'mimic')) box.append(mimicTool(self));
    }
    if (hasPower(self, 'rapid_healing') && self.energy >= 2 && self.hp < self.maxHp && t.step !== 'yield') {
      box.append(el('div', { class: 'tool-row' }, el('button', { class: 'btn small', onclick: () => act({ type: 'rapidHeal' }) }, 'Rapid Healing: 2⚡ → heal 1')));
    }
  }

  const cardName = (id) => ({ herd_culler: 'Herd Culler', stretchy: 'Stretchy', plot_twist: 'Plot Twist' })[id] || id;
  const toolBtn = (id, label) => el('button', { class: 'btn small' + (tool === id ? ' primary' : ''), onclick: () => { tool = tool === id ? null : id; render(); } }, label);

  function mimicTool(self) {
    const current = self.mimicTarget ? `Mimic is copying ${self.mimicTarget.name}.` : 'Mimic is not copying anything yet.';
    const cost = self.mimicTarget ? ' (1⚡)' : '';
    return el('div', { class: 'tool-row' }, current, el('button', { class: 'btn small', onclick: mimicPicker }, `Choose a card to copy${cost}`));
  }

  function mimicPicker() {
    const options = [];
    for (const p of state.players) {
      if (p.id === me.playerId || !p.alive) continue;
      for (const c of p.cards) if (c.type === 'keep' && c.id !== 'mimic') options.push({ p, c });
    }
    if (!options.length) { toast('No other monster has a Keep card to copy yet.', 'info'); return; }
    openModal('pick', el('h2', {}, 'Mimic'), el('p', {}, 'Pick a Keep card to copy.'),
      el('div', { class: 'pick-list' }, options.map(({ p, c }) => el('button', { class: 'btn', onclick: () => { closeModal(); act({ type: 'mimic', cardId: c.id }); } },
        el('span', {}, el('b', {}, c.name), ' ', el('small', {}, `from ${p.name}`)), el('small', {}, c.text.slice(0, 60) + (c.text.length > 60 ? '…' : ''))))),
      el('div', { class: 'action-row' }, el('button', { class: 'btn', onclick: closeModal }, 'Cancel')));
  }

  function renderShop(t, cur, mine, self, d) {
    const box = $('#shop-panel');
    box.innerHTML = '';
    box.append(el('h3', {}, `Cards for sale · ${state.deckSize} in deck`));
    const canBuy = mine && t.step === 'buy' && state.phase === 'playing' && !d;
    const discount = hasPower(self, 'alien_metabolism') ? 1 : 0;
    const grid = el('div', { class: 'shop' });
    state.shop.forEach((c, i) => grid.append(cardEl(c, canBuy, self, discount, () => act({ type: 'buy', index: i }))));
    if (t.labCard && hasPower(cur, 'made_in_a_lab')) {
      grid.append(cardEl({ ...t.labCard, name: t.labCard.name + ' (top of deck)' }, canBuy, self, discount, () => act({ type: 'buyLab' })));
    }
    box.append(grid);
    if (canBuy) {
      box.append(el('div', { class: 'shop-actions' },
        el('button', { class: 'btn', disabled: self.energy < 2, onclick: () => act({ type: 'sweep' }) }, 'Sweep all 3 (2⚡)'),
        hasPower(self, 'metamorph') ? el('span', { class: 'hint', style: 'margin:0' }, 'Metamorph: click one of your cards to sell it.') : null,
        hasPower(self, 'parasitic_tentacles') ? el('span', { class: 'hint', style: 'margin:0' }, 'Parasitic Tentacles: click another monster\'s card to buy it.') : null,
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
    if (canBuy) node.append(el('button', { class: 'btn small primary', disabled: self.energy < cost, onclick: onBuy }, `Buy for ${cost}⚡`));
    return node;
  }

  function renderLog() {
    const box = $('#log');
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    box.innerHTML = '';
    for (const l of state.logs) {
      const cls = l.text.startsWith('—') ? 'turn' : /takes \d+ damage|eliminated|destroyed/.test(l.text) ? 'hurt' : /gains \d+ ★|King of Tokyo/.test(l.text) ? 'good' : '';
      box.append(el('div', { class: cls }, l.text));
    }
    if (atBottom) box.scrollTop = box.scrollHeight;
  }

  // ------------------------------------------------------------ modals
  function openModal(kind, ...children) {
    const box = $('#modal-box');
    box.innerHTML = '';
    box.append(...children);
    $('#modal').hidden = false;
    autoModal = kind;
  }
  function closeModal() { $('#modal').hidden = true; autoModal = null; }

  function confirmModal(text, onYes, yesLabel = 'Yes') {
    openModal('confirm', el('h2', {}, 'Are you sure?'), el('p', {}, text), el('div', { class: 'action-row' },
      el('button', { class: 'btn primary', onclick: () => { closeModal(); onYes(); } }, yesLabel),
      el('button', { class: 'btn', onclick: closeModal }, 'Cancel')));
  }

  function facePicker(title, onPick) {
    openModal('pick', el('h2', {}, title), el('div', { class: 'face-picker' }, FACES.map(f =>
      el('div', { class: `die ${f}`, role: 'button', onclick: () => { closeModal(); onPick(f); } }, FACE[f]))),
      el('div', { class: 'action-row' }, el('button', { class: 'btn', onclick: closeModal }, 'Cancel')));
  }

  function standings() {
    const sorted = [...state.players].sort((a, b) => (b.alive - a.alive) || (b.vp - a.vp) || (b.hp - a.hp));
    return el('ul', { class: 'standings' }, sorted.map(p => el('li', {},
      el('span', {}, monster(p.monster).emoji), el('b', {}, p.name), p.alive ? null : el('small', { class: 'hint', style: 'margin:0' }, 'out'),
      el('span', { class: 'pts' }, `${p.vp} ★`))));
  }

  function renderModal(t, cur, self, d) {
    if (state.phase === 'ended') {
      if (dismissedGameOver || autoModal === 'gameover') return;
      const w = state.players.find(p => p.id === state.winner);
      const hostEnded = state.endedBy === 'host';
      openModal('gameover',
        el('div', { class: 'winner-emoji' }, w ? monster(w.monster).emoji : hostEnded ? '🛑' : '💀'),
        el('h2', {}, hostEnded ? 'Game over' : w ? `${w.name} is the King of Tokyo!` : 'Everyone was destroyed!'),
        el('p', {}, hostEnded ? 'The host ended the game. Final standings:' : w && w.id === me.playerId ? 'You win! 🎉' : (w ? `${w.name} finished with ${w.vp} ★.` : 'No monster survived.')),
        standings(),
        el('div', { class: 'action-row' },
          el('button', { class: 'btn primary', onclick: () => { closeModal(); send({ type: 'leave' }); } }, 'Back to home'),
          el('button', { class: 'btn', onclick: () => { dismissedGameOver = true; closeModal(); } }, 'Look at the board')),
      );
      return;
    }
    if (d && d.playerId === me.playerId) {
      const key = 'decision:' + d.id;
      if (autoModal === key) return;
      if (d.kind === 'wings') {
        openModal(key,
          el('h2', {}, '🪽 Wings'),
          el('p', {}, `${d.data.from ? d.data.from + ' is about to deal' : 'You are about to take'} ${d.data.amount} damage${d.data.from ? ' to you' : ''}. You have ${self.hp} ♥ and ${self.energy} ⚡.`),
          el('p', { class: 'hint' }, 'Spend 2 ⚡ to take no damage at all?'),
          el('div', { class: 'action-row' },
            el('button', { class: 'btn primary big', onclick: () => { closeModal(); act({ type: 'decide', answer: true }); } }, 'Use Wings (2⚡)'),
            el('button', { class: 'btn big', onclick: () => { closeModal(); act({ type: 'decide', answer: false }); } }, `Take ${d.data.amount} damage`)),
        );
      } else if (d.kind === 'opportunist') {
        const discount = hasPower(self, 'alien_metabolism') ? 1 : 0;
        openModal(key,
          el('h2', {}, '👀 Opportunist'),
          el('p', {}, `A new card was revealed. Buy it now? You have ${self.energy} ⚡.`),
          el('div', { class: 'shop', style: 'margin-top:12px' }, d.data.cards.map(c => cardEl(c, true, self, discount, () => { closeModal(); act({ type: 'decide', answer: { buy: c.id } }); }))),
          el('div', { class: 'action-row' }, el('button', { class: 'btn big', onclick: () => { closeModal(); act({ type: 'decide', answer: { pass: true } }); } }, 'Pass')),
        );
      }
      return;
    }
    if (!d && t.step === 'yield' && t.pendingYield.includes(me.playerId)) {
      if (autoModal === 'yield') return;
      const dmg = t.yieldDamage[me.playerId] || 0;
      const hasJets = hasPower(self, 'jets');
      openModal('yield',
        el('h2', {}, '🏙️ You were attacked in Tokyo!'),
        el('p', {}, `${cur.name} hit you for ${dmg} damage. You have ${self.hp} ♥ left.`),
        el('p', { class: 'hint' }, hasJets ? 'Jets: if you yield, you take no damage from this attack.' : 'If you stay you keep scoring ★ but cannot heal. If you yield, ' + cur.name + ' takes your place.'),
        el('div', { class: 'action-row' },
          el('button', { class: 'btn danger big', onclick: () => { closeModal(); act({ type: 'yield', yes: true }); } }, 'Yield Tokyo'),
          el('button', { class: 'btn gold big', onclick: () => { closeModal(); act({ type: 'yield', yes: false }); } }, 'Stay and fight!')),
      );
      return;
    }
    // Close automatic modals that no longer apply (keep confirms and pickers open).
    if (autoModal && autoModal !== 'confirm' && autoModal !== 'pick') closeModal();
  }

  // ------------------------------------------------------------ boot
  renderMonsterPicker();
  show('screen-home');
  connect();
})();
