/* King of Tokyo Online — browser client (vanilla JS, no build step). */
(() => {
  'use strict';

  const FACE = { '1': '1', '2': '2', '3': '3', heart: '♥', energy: '⚡', claw: '🐾' };
  const FACES = ['1', '2', '3', 'heart', 'energy', 'claw'];
  const SESSION_KEY = 'kot.session';

  // ---- Dice roll animation. Tune these to taste. ----
  // Each die enters one after another: it slides in, flips through random faces,
  // then lands on its real value with a small bounce.
  const DICE_ANIM = {
    totalMs: 2000,   // how long a full roll of 6 dice takes; each die gets totalMs / 6
    slideMs: 140,    // the slide-in before a die starts tumbling
    flips: 7,        // random faces shown before landing
    landMs: 180,     // settle bounce at the end
    rerollTotalMs: null, // set a number to give rerolls their own total; null = same per-die pace as a full roll
  };

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
  let lastDiceMeta = null;  // { playerId, rollsLeft, faces[] } of the dice last shown, to pick which dice animate
  let diceAnimating = false;
  let diceAnimToken = 0;
  let dismissedGameOver = false;
  let reconnectDelay = 1000;
  let reconnectTimer = null;
  let autoModal = null;     // which automatic modal is open: 'yield' | 'decision:<id>' | 'gameover' | null
  let lastSeq = -1;         // last batch of engine events we animated
  let botsToAdd = 0;        // "Practice vs computers": bots to add once the game is created
  let lastTurnPlayer = null; // to scroll the monster row when the turn passes
  let appVersion = null;    // version of the server this page was loaded against (shown on every screen)
  let lastBuyKey = '';      // detects the moment my buy step starts (auto-open the shop sheet on phones)
  const isMobile = () => window.matchMedia('(max-width: 720px), (max-height: 540px)').matches;

  // Mirrors MONSTERS in game/engine.js so the home screen works before the first server message.
  const FALLBACK_MONSTERS = [
    { id: 'king', image: '/img/king.webp', thumb: '/img/king-thumb.webp', name: 'The King', emoji: '🦍', color: '#d08a3c', power: { name: 'King of the Hill', text: 'Gain 1 extra ★ whenever you start your turn in Tokyo.' } },
    { id: 'gigazaur', image: '/img/gigazaur.webp', thumb: '/img/gigazaur-thumb.webp', name: 'Gigazaur', emoji: '🦖', color: '#5cb85c', power: { name: 'Regenerating Scales', text: 'At the end of your turn, heal 1 if you are outside Tokyo.' } },
    { id: 'cyber_bunny', image: '/img/cyber_bunny.webp', thumb: '/img/cyber_bunny-thumb.webp', name: 'Cyber Bunny', emoji: '🐰', color: '#ff5fa2', power: { name: 'Overclocked', text: 'You get one extra reroll every turn.' } },
    { id: 'kraken', image: '/img/kraken.webp', thumb: '/img/kraken-thumb.webp', name: 'Kraken', emoji: '🐙', color: '#5b7cff', power: { name: 'Ink Cloud', text: 'The first attack that hits you each turn deals 1 less damage.' } },
    { id: 'alienoid', image: '/img/alienoid.webp', thumb: '/img/alienoid-thumb.webp', name: 'Alienoid', emoji: '👽', color: '#9ad53a', power: { name: 'Energy Siphon', text: 'Gain 1 ⚡ at the end of each of your turns.' } },
    { id: 'meka_dragon', image: '/img/meka_dragon.webp', thumb: '/img/meka_dragon-thumb.webp', name: 'Meka Dragon', emoji: '🐉', color: '#b45cff', power: { name: 'Rocket Punch', text: 'Deal 1 extra damage when you attack from outside Tokyo.' } },
    { id: 'cybertooth', image: '/img/cybertooth.webp', thumb: '/img/cybertooth-thumb.webp', name: 'Cybertooth', emoji: '🐯', color: '#ff6a3d', power: { name: 'Bite Back', text: 'The first monster to hit you each turn takes 1 damage.' } },
    { id: 'boogie_woogie', image: '/img/boogie_woogie.webp', thumb: '/img/boogie_woogie-thumb.webp', name: 'Boogie Woogie', emoji: '👻', color: '#c45cff', power: { name: 'Showstopper', text: 'Gain 1 ★ the first time each turn you damage a monster in Tokyo.' } },
    { id: 'sheriff', image: '/img/sheriff.webp', thumb: '/img/sheriff-thumb.webp', name: 'Sheriff', emoji: '🤠', color: '#c98a4b', power: { name: 'New Sheriff in Town', text: 'Gain 2 ★ instead of 1 when you enter Tokyo.' } },
    { id: 'cthulhu', image: '/img/cthulhu.webp', thumb: '/img/cthulhu-thumb.webp', name: 'Cthulhu', emoji: '🦑', color: '#3fae8a', power: { name: 'Dreaming Deep', text: 'End your turn in Tokyo: gain 2 ⚡, then 3, then 4 for each turn in a row you stay. Resets when you leave.' } },
    { id: 'space_penguin', image: '/img/space_penguin.webp', thumb: '/img/space_penguin-thumb.webp', name: 'Space Penguin', emoji: '🐧', color: '#8fd8ff', power: { name: 'Ice Slide', text: 'Heal 1 whenever you yield Tokyo.' } },
    { id: 'anubis', image: '/img/anubis.webp', thumb: '/img/anubis-thumb.webp', name: 'Anubis', emoji: '🐺', color: '#f2c230', power: { name: 'Judgement', text: 'Each triple of numbers scores 1 extra ★.' } },
    { id: 'cyber_kitty', image: '/img/cyber_kitty.webp', thumb: '/img/cyber_kitty-thumb.webp', name: 'Cyber Kitty', emoji: '🐱', color: '#4fc3ff', power: { name: 'Purr-charged', text: 'Rolling 3 or more ⚡ gives 1 extra ⚡.' } },
    { id: 'pumpkin_jack', image: '/img/pumpkin_jack.webp', thumb: '/img/pumpkin_jack-thumb.webp', name: 'Pumpkin Jack', emoji: '🎃', color: '#ff7a1a', power: { name: 'Trick or Treat', text: 'Cards cost 2 ⚡ less, minimum 2.' } },
    { id: 'pandakai', image: '/img/pandakai.webp', thumb: '/img/pandakai-thumb.webp', name: 'Pandakaï', emoji: '🐼', color: '#8fd14f', power: { name: 'Bamboo Bulk', text: 'Start with 13 Life instead of 10.' } },
    { id: 'kookie', image: '/img/kookie.webp', thumb: '/img/kookie-thumb.webp', name: 'Kookie', emoji: '🍪', color: '#e0a24a', power: { name: 'Snack Time', text: 'While in Tokyo, each ♥ you roll gives 1 ⚡ instead of nothing.' } },
  ];
  monsters = FALLBACK_MONSTERS;
  const monster = (id) => monsters.find(m => m.id === id) || { name: '?', emoji: '❓', color: '#888' };
  const hasPower = (p, id) => p.cards.some(c => c.id === id) || (p.mimicTarget && p.mimicTarget.id === id && p.cards.some(c => c.id === 'mimic'));
  const byId = (id) => state.players.find(p => p.id === id);
  /** Monster artwork; falls back to the emoji if the image is missing or fails to load. */
  function art(m, cls = 'art', { thumb = false } = {}) {
    const src = thumb ? m.thumb : m.image;
    if (!src) return el('span', { class: cls + ' emoji' }, m.emoji);
    const img = el('img', { class: cls, src: versioned(src), alt: m.name, draggable: 'false' });
    img.addEventListener('error', () => img.replaceWith(el('span', { class: cls + ' emoji' }, m.emoji)));
    return img;
  }

  // ------------------------------------------------------------ version
  function paintVersion(v) {
    for (const e of document.querySelectorAll('.version')) e.textContent = v ? `v${v}` : '';
  }
  // The server stamps its version into the page (and into every asset URL) so the code and
  // the page always match; /health is only a fallback for a page served some other way.
  const stamped = document.querySelector('meta[name="app-version"]');
  if (stamped && stamped.content) { appVersion = stamped.content; paintVersion(appVersion); }
  else fetch('/health', { cache: 'no-store' }).then(r => r.json()).then(h => { appVersion = h.version; paintVersion(h.version); }).catch(() => {});
  /** Local asset URL with the version stamped in, so CDN/browser caches never hand out an old file. */
  const versioned = (src) => (appVersion && src.startsWith('/') ? `${src}?v=${encodeURIComponent(appVersion)}` : src);
  /** After a deploy the server is newer than this page: offer a reload (seats survive it). */
  function noticeServerVersion(v) {
    if (!v || !appVersion || v === appVersion) return;
    const chip = $('#update-chip');
    chip.textContent = `⬆️ New version v${v} is live. Tap to reload.`;
    chip.hidden = false;
  }
  $('#update-chip').addEventListener('click', () => location.reload());

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
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 10000);
    });
  }
  // Phones suspend the page while another app is in front; reconnect the moment we are back.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    clearTimeout(reconnectTimer);
    reconnectDelay = 1000;
    connect();
  });

  function send(obj) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); else toast('Not connected to the server yet.'); }
  const act = (action) => send({ type: 'action', action });

  function onMessage(msg) {
    switch (msg.type) {
      case 'joined':
        me = { code: msg.code, playerId: msg.playerId, token: msg.token };
        saveSession(me);
        while (botsToAdd > 0) { send({ type: 'addBot' }); botsToAdd--; }
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
        $('#invite-banner').hidden = true; $('#btn-create').hidden = false; $('#btn-practice').hidden = false; $('#btn-join').classList.remove('primary'); $('#join-code').value = '';
        show('screen-home');
        takenMonsters = [];
        renderMonsterPicker();
        break;
      case 'lobbyInfo':
        takenMonsters = msg.taken;
        renderMonsterPicker();
        showInvite(msg);
        break;
      case 'state':
        noticeServerVersion(msg.version);
        prevState = state;
        state = msg.state;
        diceAnimating = false; diceAnimToken++;
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
      }, art(m, 'art pick-art'), el('span', { class: 'name' }, m.name)));
    }
    const sel = selectedMonster ? monster(selectedMonster) : null;
    const pv = $('#power-preview');
    pv.innerHTML = '';
    if (sel && sel.power) pv.append('✨ ', el('b', {}, sel.power.name), ' — ', sel.power.text);
    else pv.textContent = 'Every monster has a unique power in Game Plus. Tap one to see it.';
  }

  /** A friend opened an invite link: lock the code in and make joining the obvious next step. */
  function showInvite(info) {
    const box = $('#invite-banner');
    box.innerHTML = '';
    const host = info.players[0];
    box.append(
      el('div', {}, '🎟️ You\'re invited to ', el('b', {}, host ? `${host}'s game` : 'a game'), ` (code ${info.code})`),
      el('div', { class: 'who' }, info.players.length ? `Already in: ${info.players.join(', ')}. Enter your name, pick a monster, and press Join.` : 'Enter your name, pick a monster, and press Join.'),
    );
    box.hidden = false;
    $('#join-code').value = info.code;
    $('#btn-create').hidden = true;
    $('#btn-practice').hidden = true;
    $('#btn-join').classList.add('primary');
    $('#name').focus();
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
  $('#btn-practice').addEventListener('click', () => {
    const name = homeValid(); if (!name) return;
    botsToAdd = 2;
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
  $('#btn-add-bot').addEventListener('click', () => send({ type: 'addBot' }));
  $('#opt-powers').addEventListener('change', (e) => send({ type: 'setOptions', options: { powers: e.target.checked } }));
  $('#btn-leave').addEventListener('click', () => send({ type: 'leave' }));
  const inviteLink = () => `${location.origin}/${me.code}`;
  async function copyInvite() {
    const link = inviteLink();
    try { await navigator.clipboard.writeText(link); toast('Invite link copied!', 'info'); }
    catch { const i = $('#invite-link'); i.focus(); i.select(); toast('Select the link and copy it.', 'info'); }
  }
  $('#btn-copy-link').addEventListener('click', copyInvite);
  $('#btn-share').addEventListener('click', async () => {
    const link = inviteLink();
    if (navigator.share) {
      try { await navigator.share({ title: 'King of Tokyo', text: `Join my King of Tokyo game! Code ${me.code}`, url: link }); return; }
      catch (e) { if (e && e.name === 'AbortError') return; }
    }
    copyInvite();
  });

  function renderLobby() {
    $('#lobby-code').textContent = state.code;
    $('#invite-link').value = inviteLink();
    $('#btn-share').textContent = navigator.share ? '📤 Invite friends' : '📤 Copy invite link';
    const list = $('#lobby-players');
    list.innerHTML = '';
    const powersOn = !!(state.options && state.options.powers);
    for (const p of state.players) {
      const m = monster(p.monster);
      list.append(el('li', { style: `--mc:${m.color}` },
        art(m, 'art lobby-art', { thumb: true }),
        el('span', { class: 'who' },
          el('span', { class: 'who-top' },
            el('b', {}, p.name),
            p.bot ? el('span', { class: 'tag' }, '🤖 bot') : null,
            !p.connected && !p.bot ? el('span', { class: 'tag', style: 'color:var(--fg-muted)' }, 'reconnecting…') : null,
            p.id === state.hostId ? el('span', { class: 'tag' }, 'host') : null,
            p.id === me.playerId ? el('span', { class: 'tag' }, 'you') : null,
            p.bot && state.hostId === me.playerId ? el('button', { class: 'btn tiny remove-bot', title: 'Remove this computer player', onclick: () => send({ type: 'removeBot', botId: p.id }) }, '✕') : null),
          powersOn && m.power ? el('small', { class: 'power-line' }, el('b', {}, m.power.name), ' · ', m.power.text) : null),
      ));
    }
    const isHost = state.hostId === me.playerId;
    $('#bot-row').hidden = !isHost;
    $('#btn-add-bot').disabled = state.players.length >= 6;
    const chk = $('#opt-powers');
    chk.checked = powersOn;
    chk.disabled = !isHost;
    $('.toggle').title = isHost ? '' : 'Only the host can change this.';
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
  $('#btn-menu').addEventListener('click', () => {
    const isHost = state && state.hostId === me.playerId && state.phase === 'playing';
    openModal('pick', el('h2', {}, 'Menu'),
      el('div', { class: 'pick-list' },
        el('button', { class: 'btn big', onclick: () => { closeModal(); $('#rules').hidden = false; } }, '📖 How to play'),
        el('button', { class: 'btn big', onclick: () => { closeModal(); $('#btn-leave-game').click(); } }, '🚪 Leave game'),
        isHost ? el('button', { class: 'btn big danger-outline', onclick: () => { closeModal(); $('#btn-end-game').click(); } }, '🛑 End game for everyone') : null),
      el('div', { class: 'action-row' }, el('button', { class: 'btn', onclick: closeModal }, 'Close')));
  });
  const closeSheets = () => document.body.classList.remove('shop-open', 'log-open');
  $('#btn-shop').addEventListener('click', () => { const open = document.body.classList.contains('shop-open'); closeSheets(); if (!open) document.body.classList.add('shop-open'); });
  $('#btn-log').addEventListener('click', () => { const open = document.body.classList.contains('log-open'); closeSheets(); if (!open) { document.body.classList.add('log-open'); const l = $('#log'); l.scrollTop = l.scrollHeight; } });
  $('#sheet-backdrop').addEventListener('click', closeSheets);
  document.querySelector('.log-col .sheet-close').addEventListener('click', closeSheets);

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
    if (t.playerId !== lastTurnPlayer) { lastTurnPlayer = t.playerId; scrollToCurrentPlayer(); }
    renderActionPanel(t, cur, mine, self, d);
    renderShop(t, cur, mine, self, d);
    renderLog();
    renderModal(t, cur, self, d);
    syncSheets(t, mine, self, d);
    playEvents();
  }

  /** Phone sheets: open the shop when my buy step starts, close it when it ends. */
  function syncSheets(t, mine, self, d) {
    const myBuy = mine && t.step === 'buy' && state.phase === 'playing' && !d;
    const shopBtn = $('#btn-shop');
    shopBtn.textContent = myBuy ? `🛒 Buy cards (${self.energy}⚡)` : '🛒 Shop';
    shopBtn.classList.toggle('primary', myBuy);
    if (isMobile()) {
      if (myBuy && !lastBuyKey) document.body.classList.add('shop-open');
      if (!myBuy && lastBuyKey) document.body.classList.remove('shop-open');
    }
    lastBuyKey = myBuy ? 'buy' : '';
    if (state.phase === 'ended') closeSheets();
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
      const s = el('div', { class: 'tokyo-slot' + (p ? ' occupied' : ''), 'data-pid': p ? p.id : null }, el('h4', {}, title));
      if (p) {
        s.append(art(monster(p.monster), 'art tokyo-art'), el('div', { class: 'who' }, p.name));
        if (p.id === me.playerId) s.append(el('div', { class: 'you-tag' }, 'that\'s you'));
      }
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
      const card = el('div', {
        class: 'pcard' + (p.id === t.playerId ? ' current' : '') + (p.alive ? '' : ' dead'),
        style: `--mc:${m.color}`,
        'data-pid': p.id,
      });
      if (p.id === me.playerId) card.append(el('span', { class: 'you-tag' }, 'YOU'));
      card.append(el('div', { class: 'head' },
        el('span', { class: 'avatar' }, art(m, 'art avatar-art', { thumb: true })),
        el('div', { class: 'names' }, el('div', { class: 'name', title: m.name }, p.name)),
        el('div', { class: 'badges' },
          inTokyo ? el('span', { class: 'badge' }, 'Tokyo') : null,
          p.bot ? el('span', { class: 'badge bot' }, '🤖 bot') : null,
          p.id === state.hostId && p.id !== me.playerId ? el('span', { class: 'badge host' }, 'host') : null,
          !p.connected && p.alive && !p.bot ? el('span', { class: 'badge off' }, 'offline') : null,
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

  /** On phones the monster boards scroll sideways: bring the active player's board into view. */
  function scrollToCurrentPlayer() {
    const row = $('#players');
    const card = row.querySelector('.pcard.current');
    if (!card || row.scrollWidth <= row.clientWidth + 1) return; // nothing to scroll (desktop grid)
    const left = card.offsetLeft - (row.clientWidth - card.offsetWidth) / 2;
    row.scrollTo({ left: Math.max(0, left), behavior: reducedMotion() ? 'auto' : 'smooth' });
  }

  function diceEl(dice, { interactive, animateKey, probe }) {
    const changed = animateKey !== lastDiceKey;
    const t = state.turn;
    // Which dice should animate? A fresh roll or reroll: every die that was not kept.
    // A single changed die (Psychic Probe, Herd Culler, Stretchy, Plot Twist): just that one.
    let toAnimate = [];
    if (changed) {
      const meta = lastDiceMeta;
      const freshRoll = !meta || meta.playerId !== t.playerId || meta.rollsLeft !== t.rollsLeft || meta.faces.length !== dice.length;
      toAnimate = dice.map((d, i) => i).filter(i => freshRoll ? !dice[i].kept : dice[i].face !== meta.faces[i]);
    }
    const row = el('div', { class: 'dice' });
    dice.forEach((d, i) => {
      const isKept = interactive ? kept.has(i) : d.kept;
      row.append(el('div', {
        class: `die ${d.face} ${isKept ? 'kept' : ''} ${interactive ? '' : 'static'} ${probe ? 'probe' : ''}`,
        'data-face': d.face,
        role: interactive || probe ? 'button' : null,
        title: probe ? 'Psychic Probe: force a reroll of this die' : null,
        onclick: interactive ? () => onDieClick(i) : probe ? () => { if (!diceAnimating) confirmModal(`Use Psychic Probe to reroll this ${FACE[d.face]}?`, () => act({ type: 'probe', index: i }), 'Reroll it'); } : null,
      }, FACE[d.face]));
    });
    lastDiceKey = animateKey;
    lastDiceMeta = { playerId: t.playerId, rollsLeft: t.rollsLeft, faces: dice.map(d => d.face) };
    if (toAnimate.length) animateDice(row, toAnimate, toAnimate.length === dice.length);
    return row;
  }

  const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /** Roll the given dice one after another: slide in, tumble through random faces, land. */
  function animateDice(row, indices, fullRoll) {
    if (reducedMotion()) return;
    const token = ++diceAnimToken;
    diceAnimating = true;
    const dies = [...row.children];
    const perDie = (fullRoll || !DICE_ANIM.rerollTotalMs) ? DICE_ANIM.totalMs / 6 : DICE_ANIM.rerollTotalMs / Math.max(1, indices.length);
    const flipMs = Math.max(30, (perDie - DICE_ANIM.slideMs - DICE_ANIM.landMs) / DICE_ANIM.flips);
    const setFace = (die, face) => { die.className = die.className.replace(/\b(1|2|3|heart|energy|claw)\b/g, '').replace(/\s+/g, ' ') + ' ' + face; die.textContent = FACE[face]; };
    const alive = () => token === diceAnimToken && row.isConnected;
    indices.forEach(i => { dies[i].classList.add('pending'); dies[i].textContent = ''; });
    indices.forEach((i, k) => {
      const die = dies[i];
      const final = die.dataset.face;
      const start = k * perDie;
      setTimeout(() => {
        if (!alive()) return;
        die.classList.remove('pending');
        die.classList.add('sliding');
        setTimeout(() => {
          if (!alive()) return;
          die.classList.remove('sliding');
          die.classList.add('tumbling');
          let n = 0;
          const flip = () => {
            if (!alive()) return;
            if (n++ < DICE_ANIM.flips) {
              let f; do { f = FACES[Math.floor(Math.random() * 6)]; } while (f === die.dataset.last);
              die.dataset.last = f;
              setFace(die, f);
              setTimeout(flip, flipMs);
            } else {
              die.classList.remove('tumbling');
              setFace(die, final);
              die.classList.add('landed');
              if (k === indices.length - 1) setTimeout(() => { if (!alive()) return; diceAnimating = false; render(); }, DICE_ANIM.landMs);
            }
          };
          flip();
        }, DICE_ANIM.slideMs);
      }, start);
    });
  }

  function onDieClick(i) {
    if (diceAnimating) return;
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
        box.append(el('p', { class: 'status-line' }, diceAnimating ? 'Rolling…' : tool ? `Click the die to change (${cardName(tool)}).` : 'Click dice to keep them, then reroll the rest.'));
        const allKept = kept.size === t.dice.length;
        const canBgd = hasPower(self, 'background_dweller') && t.dice.some((x, i) => x.face === '3' && !kept.has(i));
        const rerollLabel = t.rollsLeft > 0 ? `Reroll (${t.rollsLeft} left)` : canBgd ? 'Reroll 3s (Background Dweller)' : 'No rerolls left';
        box.append(el('div', { class: 'action-row center' },
          el('button', { class: 'btn big', disabled: diceAnimating || (t.rollsLeft <= 0 && !canBgd) || allKept, onclick: () => act({ type: 'roll', keep: [...kept] }) }, rerollLabel),
          el('button', { class: 'btn primary big', disabled: diceAnimating, onclick: () => { kept.clear(); act({ type: 'stopRolling' }); } }, 'Stop & resolve ✔'),
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
  const toolBtn = (id, label) => el('button', { class: 'btn small' + (tool === id ? ' primary' : ''), disabled: diceAnimating, onclick: () => { tool = tool === id ? null : id; render(); } }, label);

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
    box.append(el('div', { class: 'sheet-head' }, el('h3', {}, `Cards for sale · ${state.deckSize} in deck`),
      el('button', { class: 'btn small mobile-only sheet-close', onclick: closeSheets }, 'Close')));
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
    const ticker = $('#ticker');
    ticker.innerHTML = '';
    for (const l of state.logs.slice(-3)) ticker.append(el('div', {}, l.text));
  }

  // ------------------------------------------------------------ attack effects
  const VIA_ICON = { claw: '🐾', fire: '🔥', card: '💥', acid: '🧪', poison: '☠️', bite: '🦷' };
  const BLOCK_ICON = { wings: '🪽', armor: '🛡️', camouflage: '🌫️', ink: '🌊' };

  /** Play the engine's events for this state update: lunges, slashes, damage numbers, blocks, KOs. */
  function playEvents() {
    if (!state.events || state.seq === lastSeq) return;
    lastSeq = state.seq;
    const targetsOf = (pid) => [...document.querySelectorAll(`.pcard[data-pid="${pid}"], .tokyo-slot[data-pid="${pid}"]`)];
    let delay = 0;
    for (const ev of state.events) {
      const at = delay;
      setTimeout(() => {
        if (ev.type === 'damage') {
          for (const node of targetsOf(ev.from || '')) if (node.classList.contains('pcard')) node.classList.add('lunge');
          for (const node of targetsOf(ev.to)) {
            node.classList.add('hit', 'flash');
            const fx = el('div', { class: 'fx' });
            if (ev.via === 'claw') fx.append(el('div', { class: 'fx-slash' }), el('div', { class: 'fx-slash second' }));
            fx.append(el('div', { class: 'fx-icon' }, VIA_ICON[ev.via] || '💥'));
            if (node.classList.contains('pcard')) fx.append(el('div', { class: 'fx-num' }, `-${ev.amount}`));
            node.append(fx);
            setTimeout(() => { fx.remove(); node.classList.remove('hit', 'flash'); }, 1200);
          }
          for (const node of targetsOf(ev.from || '')) setTimeout(() => node.classList.remove('lunge'), 700);
        } else if (ev.type === 'blocked') {
          for (const node of targetsOf(ev.to)) {
            if (!node.classList.contains('pcard')) continue;
            const fx = el('div', { class: 'fx' }, el('div', { class: 'fx-shield' }, el('span', { class: 'big' }, BLOCK_ICON[ev.by] || '🛡️'), 'BLOCKED'));
            node.append(fx);
            setTimeout(() => fx.remove(), 1000);
          }
        } else if (ev.type === 'ko') {
          for (const node of targetsOf(ev.to)) {
            if (!node.classList.contains('pcard')) continue;
            const fx = el('div', { class: 'fx' }, el('div', { class: 'fx-ko' }, 'K.O.'));
            node.append(fx);
            setTimeout(() => fx.remove(), 1500);
          }
        }
      }, at);
      delay += ev.type === 'damage' ? 160 : 60;
    }
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
      art(monster(p.monster), 'art standing-art', { thumb: true }), el('b', {}, p.name), p.alive ? null : el('small', { class: 'hint', style: 'margin:0' }, 'out'),
      el('span', { class: 'pts' }, `${p.vp} ★`))));
  }

  function renderModal(t, cur, self, d) {
    if (state.phase === 'ended') {
      if (dismissedGameOver || autoModal === 'gameover') return;
      const w = state.players.find(p => p.id === state.winner);
      const hostEnded = state.endedBy === 'host';
      openModal('gameover',
        el('div', { class: 'winner-art' }, w ? art(monster(w.monster), 'art winner-img') : el('span', { class: 'winner-emoji' }, hostEnded ? '🛑' : '💀')),
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
