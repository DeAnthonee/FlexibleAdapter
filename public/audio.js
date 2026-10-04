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
  const TRACK = '/audio/music.mp3';
  const prefs = { music: 0.35, muted: false };
  try { Object.assign(prefs, JSON.parse(localStorage.getItem(PREFS_KEY) || '{}')); } catch {}
  const meta = document.querySelector('meta[name="app-version"]');
  const version = meta && meta.content ? meta.content : '';
  const AC = window.AudioContext || window.webkitAudioContext;

  let ctx = null, master = null, musicGain = null, fade = null;
  let buffer = null, loading = null, source = null;
  let wanted = false;           // the current screen wants music
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

  function startSource() {
    if (!ctx || !buffer || source) return;
    source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.connect(fade);
    source.start();
    const t = ctx.currentTime;
    fade.gain.cancelScheduledValues(t);
    fade.gain.setValueAtTime(0, t);
    fade.gain.linearRampToValueAtTime(1, t + 1.5);
  }
  function stopSource() {
    if (!ctx || !source) return;
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
    return { music: prefs.music, muted: prefs.muted, playing: !!source, track, wanted, unlocked, supported: !!AC };
  }

  window.KotAudio = {
    /** Tell the player whether the current screen wants music. */
    music(on) { wanted = !!on; if (wanted && !buffer) loadTrack(); sync(); },
    setMusicVolume(v) { prefs.music = Math.max(0, Math.min(1, Number(v) || 0)); applyPrefs(); save(); notify(); },
    setMuted(m) { prefs.muted = !!m; applyPrefs(); save(); notify(); },
    toggleMuted() { this.setMuted(!prefs.muted); },
    state,
    onChange(f) { listeners.add(f); return () => listeners.delete(f); },
    preload() { loadTrack(); },
  };
})();
