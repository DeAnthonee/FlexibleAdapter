/*
 * Sound for King of Tokyo Online.
 *
 * One AudioContext, created on the first tap because browsers refuse to play audio
 * before a user gesture. The background track (/audio/music.mp3) is decoded into memory
 * and looped through the Web Audio graph, which loops seamlessly where a plain <audio>
 * tag would click at the loop point. Volume and mute are remembered per device.
 *
 * API (window.KotAudio): music(on), setMusicVolume(0..1), setMuted(bool), toggleMuted(),
 * state(), onChange(fn), preload().
 */
(() => {
  const PREFS_KEY = 'kot.audio';
  const POS_KEY = 'kot.musicPos';   // where the track was, so a reload (e.g. an auto-update) resumes in place
  const TRACK = '/audio/music.mp3';
  const DEFAULT_MUSIC = 0.10;       // quiet by default; players turn it up in the sound panel
  const PREFS_V = 2;                // bump when a default changes so saved settings pick it up once
  const prefs = { music: DEFAULT_MUSIC, muted: false, v: PREFS_V };
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
    if (saved && saved.v === PREFS_V) Object.assign(prefs, saved);
    else if (saved && typeof saved.muted === 'boolean') prefs.muted = saved.muted; // keep mute, take the new default volume
  } catch {}
  const meta = document.querySelector('meta[name="app-version"]');
  const version = meta && meta.content ? meta.content : '';
  const AC = window.AudioContext || window.webkitAudioContext;

  let ctx = null, master = null, musicGain = null, fade = null;
  let buffer = null, loading = null, source = null;
  let startedAt = 0, startOffset = 0; // for remembering the playback position across reloads
  let wanted = true;            // music plays on every screen, from the first tap onward
  let unlocked = false;         // a user gesture has happened
  let track = 'unknown';        // unknown | loading | ready | missing | error
  const listeners = new Set();
  const notify = () => { const s = state(); for (const f of listeners) { try { f(s); } catch {} } };

  function save() { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch {} }

  function ensure() {
    if (ctx || !AC) return ctx;
    ctx = new AC();
    master = ctx.createGain(); master.connect(ctx.destination);
    musicGain = ctx.createGain(); musicGain.connect(master);
    fade = ctx.createGain(); fade.gain.value = 0; fade.connect(musicGain);
    applyPrefs();
    return ctx;
  }
  function applyPrefs() {
    if (!ctx) return;
    master.gain.value = prefs.muted ? 0 : 1;
    musicGain.gain.value = prefs.music;
  }

  function loadTrack() {
    if (buffer || loading) return loading;
    if (track === 'missing' || track === 'error') return Promise.resolve(null); // do not hammer the server
    if (!ensure()) { track = 'error'; notify(); return Promise.resolve(null); }
    track = 'loading'; notify();
    loading = (async () => {
      try {
        const res = await fetch(`${TRACK}${version ? `?v=${encodeURIComponent(version)}` : ''}`);
        if (res.status === 404) { track = 'missing'; notify(); return null; }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        buffer = await ctx.decodeAudioData(await res.arrayBuffer());
        track = 'ready'; notify();
        return buffer;
      } catch (err) {
        console.warn('music track could not be loaded:', err);
        track = 'error'; notify();
        return null;
      } finally { loading = null; }
    })();
    return loading;
  }

  function savedPosition() {
    try {
      const p = JSON.parse(sessionStorage.getItem(POS_KEY) || 'null');
      if (p && buffer && Date.now() - p.at < 10 * 60 * 1000 && p.pos >= 0 && p.pos < buffer.duration) return p.pos;
    } catch {}
    return 0;
  }
  function position() {
    if (!ctx || !buffer || !source) return 0;
    return (startOffset + (ctx.currentTime - startedAt)) % buffer.duration;
  }
  function rememberPosition() { if (source) { try { sessionStorage.setItem(POS_KEY, JSON.stringify({ pos: position(), at: Date.now() })); } catch {} } }
  window.addEventListener('pagehide', rememberPosition);
  setInterval(rememberPosition, 5000);

  function startSource() {
    if (!ctx || !buffer || source) return;
    source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.connect(fade);
    startOffset = savedPosition();
    startedAt = ctx.currentTime;
    source.start(0, startOffset);
    const t = ctx.currentTime;
    fade.gain.cancelScheduledValues(t);
    fade.gain.setValueAtTime(0, t);
    fade.gain.linearRampToValueAtTime(1, t + 1.5);
  }
  function stopSource() {
    if (!ctx || !source) return;
    rememberPosition();
    const s = source;
    source = null;
    const t = ctx.currentTime;
    fade.gain.cancelScheduledValues(t);
    fade.gain.setValueAtTime(fade.gain.value, t);
    fade.gain.linearRampToValueAtTime(0, t + 0.8);
    setTimeout(() => { try { s.stop(); } catch {} }, 900);
  }

  /** Bring playback in line with what is wanted, allowed (gesture) and visible. */
  async function sync() {
    const shouldPlay = wanted && unlocked && !document.hidden;
    if (!shouldPlay) { stopSource(); notify(); return; }
    if (!ensure()) { notify(); return; }
    if (ctx.state === 'suspended') { try { await ctx.resume(); } catch {} }
    if (!buffer) await loadTrack();
    if (buffer && wanted && unlocked && !document.hidden) startSource();
    notify();
  }

  function unlock() {
    if (unlocked) return;
    unlocked = true;
    if (ensure()) ctx.resume().catch(() => {});
    sync();
  }
  for (const evt of ['pointerdown', 'keydown', 'touchend']) document.addEventListener(evt, unlock, { capture: true, passive: true });
  document.addEventListener('visibilitychange', () => { sync(); });

  function state() {
    return { music: prefs.music, muted: prefs.muted, playing: !!source, track, wanted, unlocked, supported: !!AC, position: position() };
  }

  window.KotAudio = {
    /** Turn the music on or off (it is on by default, on every screen). */
    music(on) { wanted = !!on; if (wanted && !buffer) loadTrack(); sync(); },
    setMusicVolume(v) { prefs.music = Math.max(0, Math.min(1, Number(v) || 0)); applyPrefs(); save(); notify(); },
    setMuted(m) { prefs.muted = !!m; applyPrefs(); save(); notify(); },
    toggleMuted() { this.setMuted(!prefs.muted); },
    state,
    onChange(f) { listeners.add(f); return () => listeners.delete(f); },
    preload() { loadTrack(); },
  };
})();
