/* Piano 88 — full-range sampled piano (A0–C8) */
(() => {
  'use strict';

  /* ------------------------------------------------------------------ *
   * 1. Tuning / layout constants
   * ------------------------------------------------------------------ */

  const MIDI_LOW = 21;   // A0
  const MIDI_HIGH = 108; // C8
  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const BLACK_PC = new Set([1, 3, 6, 8, 10]);

  const isBlack = (m) => BLACK_PC.has(m % 12);
  const noteName = (m) => NOTE_NAMES[m % 12] + (Math.floor(m / 12) - 1);

  /* Sample anchors shipped in ./samples — every minor third plus the ends. */
  const ANCHORS = [
    { name: 'C1', midi: 24 }, { name: 'A1', midi: 33 },
    { name: 'C2', midi: 36 }, { name: 'A2', midi: 45 },
    { name: 'C3', midi: 48 }, { name: 'A3', midi: 57 },
    { name: 'C4', midi: 60 }, { name: 'A4', midi: 69 },
    { name: 'C5', midi: 72 }, { name: 'A5', midi: 81 },
    { name: 'C6', midi: 84 }, { name: 'A6', midi: 93 },
    { name: 'C7', midi: 96 }, { name: 'A7', midi: 105 },
    { name: 'C8', midi: 108 },
  ];

  /* ------------------------------------------------------------------ *
   * 2. DOM
   * ------------------------------------------------------------------ */

  const keysEl    = document.getElementById('keys');
  const pedalBtn  = document.getElementById('pedalBtn');
  const volumeEl  = document.getElementById('volume');
  const octaveTag = document.getElementById('octaveTag');
  const statusEl  = document.getElementById('status');
  const loader    = document.getElementById('loader');
  const barEl     = document.getElementById('progressBar');
  const loadTxt   = document.getElementById('loaderText');

  /* ------------------------------------------------------------------ *
   * 3. Build the 88 keys
   * ------------------------------------------------------------------ */

  const whites = [];
  for (let m = MIDI_LOW; m <= MIDI_HIGH; m++) if (!isBlack(m)) whites.push(m);
  const WHITE_COUNT = whites.length;             // 52
  const keyEls = new Map();                      // midi -> element

  function buildKeyboard() {
    const frag = document.createDocumentFragment();

    whites.forEach((midi) => {
      const el = document.createElement('div');
      el.className = 'wk';
      el.dataset.midi = String(midi);
      el.setAttribute('role', 'button');
      el.setAttribute('aria-label', noteName(midi));
      el.setAttribute('aria-pressed', 'false');
      if (midi % 12 === 0) {
        const lbl = document.createElement('span');
        lbl.className = 'lbl';
        lbl.textContent = noteName(midi);
        el.appendChild(lbl);
      }
      keyEls.set(midi, el);
      frag.appendChild(el);
    });

    for (let m = MIDI_LOW; m <= MIDI_HIGH; m++) {
      if (!isBlack(m)) continue;
      const el = document.createElement('div');
      el.className = 'bk';
      el.dataset.midi = String(m);
      el.setAttribute('role', 'button');
      el.setAttribute('aria-label', noteName(m));
      el.setAttribute('aria-pressed', 'false');

      // how many white keys start before this black key
      let before = 0;
      for (let w = MIDI_LOW; w < m; w++) if (!isBlack(w)) before++;
      el.style.left = ((before) * (100 / WHITE_COUNT)) + '%';

      keyEls.set(m, el);
      frag.appendChild(el);
    }

    keysEl.appendChild(frag);
  }

  buildKeyboard();

  /* ------------------------------------------------------------------ *
   * 3b. Horizontal scrolling (narrow screens)
   * ------------------------------------------------------------------ */

  const pianoEl = document.getElementById('keyscroll');

  function updateScrollHint() {
    const scrollable = pianoEl.scrollWidth - pianoEl.clientWidth > 4;
    pianoEl.classList.toggle('is-scrollable', scrollable);
    return scrollable;
  }

  function centerOnMidi(midi) {
    const el = keyEls.get(midi);
    if (!el) return;
    if (pianoEl.scrollWidth - pianoEl.clientWidth <= 4) return;
    const left = el.offsetLeft + el.offsetWidth / 2 - pianoEl.clientWidth / 2;
    pianoEl.scrollTo({ left: Math.max(0, left), behavior: 'smooth' });
  }

  window.addEventListener('resize', updateScrollHint);
  updateScrollHint();

  /* ------------------------------------------------------------------ *
   * 4. Audio engine
   * ------------------------------------------------------------------ */

  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const ctx = AudioCtx ? new AudioCtx({ latencyHint: 'interactive' }) : null;

  const buffers = new Map();   // anchor midi -> AudioBuffer
  let ready = false;

  let outGain, noteBus, reverbSend, compressor, lowShelf, convolver, rumble, limiter;
  const voices = new Map();    // midi -> { src, gain, started }
  const sustained = new Set(); // notes held by pedal after release
  const MAX_SUSTAINED = 18;    // keeps a latched pedal from turning into mud
  const MAX_VOICES = 44;
  let pedalDown = false;
  let latchPedal = false;      // click = permanent sustain
  let holdPedal = false;       // space / touch = momentary sustain
  let volume = 0.85;

  function makeImpulse(seconds, decay) {
    const rate = ctx.sampleRate;
    const len = Math.floor(rate * seconds);
    const buf = ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const data = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay);
      }
    }
    return buf;
  }

  function buildGraph() {
    outGain = ctx.createGain();
    outGain.gain.value = volume;

    compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -16;
    compressor.knee.value = 26;
    compressor.ratio.value = 3;
    compressor.attack.value = 0.004;
    compressor.release.value = 0.28;

    // Jolted low end toward the Klavins character: deep body, restrained highs.
    lowShelf = ctx.createBiquadFilter();
    lowShelf.type = 'lowshelf';
    lowShelf.frequency.value = 140;
    lowShelf.gain.value = 3.5;

    noteBus = ctx.createGain();
    noteBus.gain.value = 1;

    convolver = ctx.createConvolver();
    convolver.buffer = makeImpulse(2.6, 3.1);

    reverbSend = ctx.createGain();
    reverbSend.gain.value = 0.17;

    noteBus.connect(compressor);
    reverbSend.connect(convolver);
    convolver.connect(compressor);

    // Clean the very low end so stacked pedal notes stay defined.
    rumble = ctx.createBiquadFilter();
    rumble.type = 'highpass';
    rumble.frequency.value = 34;
    rumble.Q.value = 0.7;

    // Brick-wall-ish limiter: many ringing voices must not pump or clip.
    limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -3;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.12;

    compressor.connect(lowShelf);
    lowShelf.connect(rumble);
    rumble.connect(limiter);
    limiter.connect(outGain);
    outGain.connect(ctx.destination);
  }

  if (ctx) buildGraph();

  function nearestAnchor(midi) {
    let best = ANCHORS[0];
    let bestDist = Infinity;
    for (const a of ANCHORS) {
      const d = Math.abs(a.midi - midi);
      if (d < bestDist) { bestDist = d; best = a; }
    }
    return best;
  }

  function releaseVoice(midi, rel = 0.26) {
    const v = voices.get(midi);
    if (!v) return;
    voices.delete(midi);
    const t = ctx.currentTime;
    const g = v.gain;
    try {
      const current = Math.max(g.gain.value, 0.0001);
      g.gain.cancelScheduledValues(t);
      g.gain.setValueAtTime(current, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + rel);
      v.src.stop(t + rel + 0.03);
    } catch (e) { /* already stopped */ }
    updateReverb();
  }

  function updateReverb() {
    if (!reverbSend) return;
    const load = Math.min(1, voices.size / 36);
    reverbSend.gain.setTargetAtTime(0.17 * (1 - 0.62 * load), ctx.currentTime, 0.2);
  }

  function playNote(midi, velocity) {
    if (!ready || !ctx) return;
    if (ctx.state === 'suspended') ctx.resume();

    if (voices.has(midi)) releaseVoice(midi, 0.03);
    sustained.delete(midi);

    if (voices.size >= MAX_VOICES) {
      const oldest = voices.keys().next().value;
      if (oldest !== undefined) releaseVoice(oldest, 0.05);
    }

    const anchor = nearestAnchor(midi);
    const buffer = buffers.get(anchor.midi);
    if (!buffer) return;

    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = Math.pow(2, (midi - anchor.midi) / 12);

    // Louder = brighter, like a real hammer strike.
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 900 + velocity * 9000;
    lp.Q.value = 0.4;

    const gain = ctx.createGain();
    const peak = 0.14 + velocity * 0.72;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(peak, t + 0.007);

    src.connect(lp);
    lp.connect(gain);
    gain.connect(noteBus);
    gain.connect(reverbSend);

    src.start(t);
    src.onended = () => { try { gain.disconnect(); lp.disconnect(); } catch (e) {} };

    voices.set(midi, { src, gain, started: t });
    updateReverb();
  }

  /* Pedal-down release: keep the string ringing, but let it settle instead of
     sitting at full level forever. Prevents the "washed out" build-up. */
  function dampSustained(midi) {
    const v = voices.get(midi);
    if (!v) return;
    const t = ctx.currentTime;
    const level = Math.max(v.gain.gain.value, 0.0001);
    v.gain.gain.cancelScheduledValues(t);
    v.gain.gain.setValueAtTime(level, t);
    v.gain.gain.exponentialRampToValueAtTime(Math.max(level * 0.4, 0.0002), t + 6.5);
  }

  function noteOff(midi) {
    if (!ready) return;
    if (!pedalDown) { releaseVoice(midi); return; }
    if (!voices.has(midi)) return;

    // Oldest ringing note gives way once the pedal has stacked too many.
    if (sustained.size >= MAX_SUSTAINED) {
      const oldest = sustained.values().next().value;
      sustained.delete(oldest);
      releaseVoice(oldest, 0.5);
    }

    sustained.delete(midi);
    sustained.add(midi);
    dampSustained(midi);
    updateReverb();
  }

  function refreshPedal() {
    const next = latchPedal || holdPedal;

    if (next === pedalDown) {
      pedalBtn.classList.toggle('is-latched', latchPedal);
      pedalBtn.setAttribute('aria-label',
        latchPedal ? 'Sustain permanen aktif — klik untuk mematikan' : 'Sustain pedal');
      return;
    }

    pedalDown = next;
    pedalBtn.setAttribute('aria-pressed', String(next));
    pedalBtn.classList.toggle('is-latched', latchPedal);
    pedalBtn.setAttribute('aria-label',
      latchPedal ? 'Sustain permanen aktif — klik untuk mematikan' : 'Sustain pedal');

    if (!next) {
      for (const midi of sustained) releaseVoice(midi, 0.34);
      sustained.clear();
    }
    updateReverb();
  }

  /* ------------------------------------------------------------------ *
   * 5. Load samples
   * ------------------------------------------------------------------ */

  async function loadSamples() {
    if (!ctx) {
      loadTxt.textContent = 'Browser ini tidak mendukung Web Audio.';
      loadTxt.classList.add('is-error');
      return;
    }

    const total = ANCHORS.length;
    let done = 0;

    try {
      await Promise.all(ANCHORS.map(async (a) => {
        const res = await fetch('samples/' + a.name + '.mp3');
        if (!res.ok) throw new Error(a.name + ' (' + res.status + ')');
        const bytes = await res.arrayBuffer();
        const buf = await ctx.decodeAudioData(bytes);
        buffers.set(a.midi, buf);
        done++;
        const pct = Math.round((done / total) * 100);
        barEl.style.width = pct + '%';
        loadTxt.textContent = 'memuat sample… ' + pct + '%';
      }));

      ready = true;
      statusEl.textContent = 'siap · ' + total + ' sample';
      loader.classList.add('is-done');
      updateScrollHint();
      centerOnMidi(60);
      // Warm up: a silent tick unlocks iOS/Safari audio on first interaction.
      ctx.resume().catch(() => {});
    } catch (err) {
      loadTxt.classList.add('is-error');
      loadTxt.innerHTML =
        'Gagal memuat sample.<br>Jalankan lewat server lokal:<br><b>node server.js</b><br><span style="opacity:.6">' +
        String(err.message || err) + '</span>';
    }
  }

  loadSamples();

  /* ------------------------------------------------------------------ *
   * 6. Pointer input (mouse, touch, pen) + glissando
   * ------------------------------------------------------------------ */

  const activePointers = new Map(); // pointerId -> midi

  function velocityAt(el, clientY) {
    const r = el.getBoundingClientRect();
    const rel = (clientY - r.top) / Math.max(r.height, 1);
    return Math.min(1, Math.max(0.25, 0.25 + rel * 0.75));
  }

  function pressVisual(midi) {
    const el = keyEls.get(midi);
    if (!el) return;
    el.classList.add('is-down');
    el.setAttribute('aria-pressed', 'true');
  }

  function releaseVisual(midi) {
    const el = keyEls.get(midi);
    if (!el) return;
    el.classList.remove('is-down');
    el.setAttribute('aria-pressed', 'false');
  }

  function midiAtPoint(x, y) {
    const el = document.elementFromPoint(x, y);
    const key = el && el.closest ? el.closest('[data-midi]') : null;
    return key ? Number(key.dataset.midi) : null;
  }

  keysEl.addEventListener('pointerdown', (e) => {
    const el = e.target.closest('[data-midi]');
    if (!el) return;
    e.preventDefault();
    if (ctx && ctx.state === 'suspended') ctx.resume();

    const midi = Number(el.dataset.midi);
    activePointers.set(e.pointerId, midi);
    pressVisual(midi);
    playNote(midi, velocityAt(el, e.clientY));
  });

  window.addEventListener('pointermove', (e) => {
    if (!activePointers.has(e.pointerId)) return;
    const prev = activePointers.get(e.pointerId);
    const next = midiAtPoint(e.clientX, e.clientY);
    if (next === prev) return;

    if (prev !== null) { releaseVisual(prev); noteOff(prev); }
    activePointers.set(e.pointerId, next);
    if (next !== null) {
      pressVisual(next);
      const el = keyEls.get(next);
      playNote(next, el ? velocityAt(el, e.clientY) : 0.7);
    }
  }, { passive: true });

  function endPointer(e) {
    if (!activePointers.has(e.pointerId)) return;
    const midi = activePointers.get(e.pointerId);
    activePointers.delete(e.pointerId);
    if (midi !== null) { releaseVisual(midi); noteOff(midi); }
  }

  window.addEventListener('pointerup', endPointer);
  window.addEventListener('pointercancel', endPointer);

  /* ------------------------------------------------------------------ *
   * 7. Computer keyboard
   * ------------------------------------------------------------------ */

  // Two chromatic rows: lower octave on Z..M, upper on Q..I.
  const KEY_MAP = {
    z: 0, s: 1, x: 2, d: 3, c: 4, v: 5, g: 6, b: 7, h: 8, n: 9, j: 10, m: 11,
    q: 12, '2': 13, w: 14, '3': 15, e: 16, r: 17, '5': 18, t: 19, '6': 20, y: 21, '7': 22, u: 23, i: 24,
  };

  let baseNote = 48; // C3
  const heldKeys = new Map(); // KeyboardEvent.code -> midi

  function updateOctaveTag() {
    octaveTag.textContent = noteName(baseNote) + ' – ' + noteName(Math.min(baseNote + 24, MIDI_HIGH));
  }
  updateOctaveTag();

  function isTypingTarget(t) {
    if (!t) return false;
    const tag = t.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
  }

  window.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    if (e.code === 'Space') {
      if (isTypingTarget(e.target)) return;
      e.preventDefault();
      if (!e.repeat) { holdPedal = true; refreshPedal(); }
      return;
    }

    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      if (isTypingTarget(e.target)) return;
      e.preventDefault();
      baseNote = Math.min(84, Math.max(24, baseNote + (e.key === 'ArrowRight' ? 12 : -12)));
      updateOctaveTag();
      centerOnMidi(baseNote + 12);
      return;
    }

    if (e.repeat) return;
    const offset = KEY_MAP[e.key.toLowerCase()];
    if (offset === undefined) return;

    const midi = baseNote + offset;
    if (midi < MIDI_LOW || midi > MIDI_HIGH) return;
    if (heldKeys.has(e.code)) return;

    e.preventDefault();
    if (ctx && ctx.state === 'suspended') ctx.resume();
    heldKeys.set(e.code, midi);
    pressVisual(midi);
    playNote(midi, 0.68);
  });

  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space') {
      if (isTypingTarget(e.target)) return;
      holdPedal = false;
      refreshPedal();
      return;
    }
    const midi = heldKeys.get(e.code);
    if (midi === undefined) return;
    heldKeys.delete(e.code);
    releaseVisual(midi);
    noteOff(midi);
  });

  window.addEventListener('blur', () => {
    heldKeys.forEach((midi) => { releaseVisual(midi); noteOff(midi); });
    heldKeys.clear();
    activePointers.forEach((midi) => { if (midi !== null) { releaseVisual(midi); noteOff(midi); } });
    activePointers.clear();
    holdPedal = false;
    refreshPedal();
  });

  /* ------------------------------------------------------------------ *
   * 8. Controls
   * ------------------------------------------------------------------ */

  // Click = latch (permanent sustain). Space = momentary hold.
  pedalBtn.addEventListener('click', (e) => {
    latchPedal = !latchPedal;
    refreshPedal();
    // Drop focus after a pointer click so Space stays "momentary".
    if (e.detail) pedalBtn.blur();
    if (ctx && ctx.state === 'suspended') ctx.resume();
  });

  volumeEl.addEventListener('input', () => {
    volume = Number(volumeEl.value);
    if (outGain) outGain.gain.setTargetAtTime(volume, ctx.currentTime, 0.02);
  });

  // Prevent double-tap zoom / text selection while playing.
  document.addEventListener('gesturestart', (e) => e.preventDefault());
  keysEl.addEventListener('contextmenu', (e) => e.preventDefault());

  refreshPedal();

  /* Debug hook — inspect the engine from the console. */
  window.piano88 = {
    get ready() { return ready; },
    get voices() { return voices.size; },
    get samples() { return buffers.size; },
    get reverb() { return reverbSend ? +reverbSend.gain.value.toFixed(3) : 0; },
    get pedal() { return pedalDown; },
    get latched() { return latchPedal; },
    ctx,
  };
})();
