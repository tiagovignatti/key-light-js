'use strict';

const K_MIN = 2500;
const K_MAX = 9000;
const STORAGE_KEY = 'key-light';
const DEFAULTS = {
  mode: 'white', kelvin: 4500, hue: 210, sat: 60, brightness: 100, softbox: false,
  djPattern: 'spectrum', djSensitivity: 60,
};
// Size of one nudge step (fine adjustment); a coarse step is five of these.
const STEP = { brightness: 1, kelvin: 50, hue: 1 };
// Beats closer than this are ignored, so DJ sync never flashes more than three
// times a second (the WCAG 2.3.1 limit for photosensitive seizures).
const MIN_BEAT_MS = 334;

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const toNumber = (value, fallback) => {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
};

/* ---------- Color ---------- */

// Tanner Helland's fit of the black-body curve, accurate enough for 1000–40000K.
function kelvinToRgb(kelvin) {
  const t = kelvin / 100;
  const r = t <= 66 ? 255 : 329.698727446 * (t - 60) ** -0.1332047592;
  const g = t <= 66
    ? 99.4708025861 * Math.log(t) - 161.1195681661
    : 288.1221695283 * (t - 60) ** -0.0755148492;
  const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  return [r, g, b].map((c) => clamp(Math.round(c), 0, 255));
}

function hsvToRgb(hue, sat) {
  const channel = (n) => {
    const k = (n + hue / 60) % 6;
    return 1 - sat * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return [channel(5), channel(3), channel(1)].map((c) => Math.round(c * 255));
}

const rgbCss = ([r, g, b]) => `rgb(${r} ${g} ${b})`;
const rgbHex = (rgb) => `#${rgb.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
const isPale = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b > 150;

// A "look" is everything a preset stores: mode, kelvin, hue, sat and brightness.
const baseRgb = (look) => (look.mode === 'color' ? hsvToRgb(look.hue, look.sat / 100) : kelvinToRgb(look.kelvin));
const lightRgb = (look) => baseRgb(look).map((c) => Math.round((c * look.brightness) / 100));
const lookOf = ({ mode, kelvin, hue, sat, brightness }) => ({ mode, kelvin, hue, sat, brightness });
const describe = (look) => (look.mode === 'color' ? `${look.hue}°` : `${look.kelvin}K`);

function sameLook(a, b) {
  if (a.mode !== b.mode || a.brightness !== b.brightness) return false;
  return a.mode === 'white' ? a.kelvin === b.kelvin : a.hue === b.hue && a.sat === b.sat;
}

/* ---------- DJ patterns ---------- */

// Each frame returns a color at full scale and a level from 0 to 1, which DJ sync
// scales by the brightness setting. dj.env jumps to 1 on a beat and decays with the
// pattern's time constant; dj.loud and dj.bands (bass, mids, highs) are auto-gained
// to 0..1.
const PATTERNS = {
  spectrum: {
    decay: 0.25,
    note: 'Bass glows red, mids green and highs blue.',
    frame: () => {
      const [bass, mid, high] = dj.bands.map((band) => band.value);
      const mix = [
        255 * bass + 40 * mid + 30 * high,
        30 * bass + 230 * mid + 80 * high,
        20 * bass + 30 * mid + 255 * high,
      ];
      const peak = Math.max(...mix, 1);
      return { rgb: mix.map((c) => Math.round((c / peak) * 255)), level: 0.2 + 0.8 * Math.max(bass, mid, high) };
    },
  },
  hop: {
    decay: 0.35,
    note: 'A new color on every beat.',
    frame: () => ({ rgb: hsvToRgb(dj.hopHue, 1), level: 0.3 + 0.7 * dj.env }),
  },
  pulse: {
    decay: 0.22,
    note: 'Your light kicks on every beat.',
    frame: () => ({ rgb: baseRgb(state), level: 0.35 + 0.65 * dj.env }),
  },
  flow: {
    decay: 0.25,
    note: 'Colors drift and swell with the music.',
    frame: (dt) => {
      // About 12° of hue per beat, faster when it's loud.
      dj.hue = (dj.hue + dt * ((dj.bpm || 100) / 60) * 12 * (0.5 + dj.loud.value)) % 360;
      return { rgb: hsvToRgb(dj.hue, 0.85), level: 0.25 + 0.75 * dj.loud.value };
    },
  },
  strobe: {
    decay: 0.06,
    note: 'Your light flashes on the beat.',
    warning: 'Flashing light can affect people with photosensitive epilepsy.',
    frame: () => ({ rgb: baseRgb(state), level: dj.env }),
  },
};

/* ---------- State, storage and URL ---------- */

function sanitize(s) {
  return {
    mode: s.mode === 'color' ? 'color' : 'white',
    kelvin: clamp(Math.round(toNumber(s.kelvin, DEFAULTS.kelvin) / 50) * 50, K_MIN, K_MAX),
    hue: ((Math.round(toNumber(s.hue, DEFAULTS.hue)) % 360) + 360) % 360,
    sat: clamp(Math.round(toNumber(s.sat, DEFAULTS.sat)), 0, 100),
    brightness: clamp(Math.round(toNumber(s.brightness, DEFAULTS.brightness)), 1, 100),
    softbox: s.softbox === true,
    djPattern: s.djPattern in PATTERNS ? s.djPattern : DEFAULTS.djPattern,
    djSensitivity: clamp(Math.round(toNumber(s.djSensitivity, DEFAULTS.djSensitivity)), 0, 100),
  };
}

// White light: #k=4500&b=80. Colored light: #h=210&s=60&b=80. Either may add &soft=1.
function hashFor(s) {
  const params = s.mode === 'color' ? { h: s.hue, s: s.sat, b: s.brightness } : { k: s.kelvin, b: s.brightness };
  if (s.softbox) params.soft = 1;
  return new URLSearchParams(params).toString();
}

function readHash() {
  const params = new URLSearchParams(location.hash.slice(1));
  const s = {};
  if (params.has('k')) Object.assign(s, { mode: 'white', kelvin: params.get('k') });
  if (params.has('h')) Object.assign(s, { mode: 'color', hue: params.get('h') });
  if (params.has('s')) s.sat = params.get('s');
  if (params.has('b')) s.brightness = params.get('b');
  if (Object.keys(s).length) s.softbox = params.get('soft') === '1';
  return s;
}

function load() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
  } catch {
    // Storage blocked or corrupt: start from defaults.
  }
  return {
    state: sanitize({ ...DEFAULTS, ...saved.state, ...readHash() }),
    slots: [0, 1, 2].map((i) => (saved.slots?.[i] ? lookOf(sanitize(saved.slots[i])) : null)),
  };
}

let { state, slots } = load();
let persistTimer = 0;

// Writes are debounced: gestures change the state every frame, and Safari
// throttles history.replaceState.
function persist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(flush, 300);
}

function flush() {
  clearTimeout(persistTimer);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ state, slots }));
  } catch {
    // Private mode or quota: the URL still carries the settings.
  }
  history.replaceState(null, '', `#${hashFor(state)}`);
}

function setState(patch, animate = false) {
  state = sanitize({ ...state, ...patch });
  render(animate);
  persist();
}

/* ---------- Rendering ---------- */

const root = document.documentElement;
const stage = $('#stage');
const panel = $('#panel');
const hudEl = $('#hud');
const softboxEl = $('#softbox');
const mirrorEl = $('#mirror');
const mirrorVideo = $('#mirror-video');
const themeColor = $('meta[name="theme-color"]');
const softboxBtn = $('#softbox-btn');
const mirrorBtn = $('#mirror-btn');
const linkBtn = $('#link-btn');
const fsBtn = $('#fs-btn');
const modeButtons = $$('[data-mode]');
const modeOnly = $$('[data-mode-only]');
const hintAxis = $$('.hint-axis');
const presetButtons = $$('[data-kelvin]');
const slotButtons = $$('[data-slot]');
const djBtn = $('#dj-btn');
const djBody = $('#dj-body');
const djStatus = $('#dj-status');
const djBpm = $('#dj-bpm');
const djBeat = $('#dj-beat');
const djNote = $('#dj-note');
const djWarning = $('#dj-warning');
const patternButtons = $$('[data-pattern]');
const sliders = {
  brightness: $('#brightness'), kelvin: $('#kelvin'), hue: $('#hue'), sat: $('#sat'),
  djSensitivity: $('#dj-sensitivity'),
};
const outputs = {
  brightness: $('#brightness-out'), kelvin: $('#kelvin-out'), hue: $('#hue-out'), sat: $('#sat-out'),
  djSensitivity: $('#dj-sensitivity-out'),
};

const paint = (rgb) => root.style.setProperty('--light', rgbCss(rgb));

function setSlider(name, value, label, thumb, track) {
  const slider = sliders[name];
  slider.value = value;
  slider.setAttribute('aria-valuetext', label);
  slider.style.setProperty('--thumb', rgbCss(thumb));
  if (track) slider.style.setProperty('--track', track);
  outputs[name].textContent = label;
}

function render(animate = false) {
  const base = baseRgb(state);
  const light = lightRgb(state);
  const pureHue = hsvToRgb(state.hue, 1);

  // While DJ sync runs, its frame loop paints the light.
  if (!dj.on) {
    root.style.setProperty('--fade', animate ? '450ms' : '0ms');
    paint(light);
    themeColor.content = rgbHex(light);
  }
  root.style.setProperty('--accent', rgbCss(base));
  root.style.setProperty('--on-accent', isPale(base) ? '#1f1d1a' : '#f4f0e8');
  softboxEl.classList.toggle('on', state.softbox);

  setSlider('brightness', state.brightness, `${state.brightness}%`, light, `linear-gradient(to right, #000, ${rgbCss(base)})`);
  setSlider('kelvin', state.kelvin, `${state.kelvin}K`, kelvinToRgb(state.kelvin));
  setSlider('hue', state.hue, `${state.hue}°`, pureHue);
  setSlider('sat', state.sat, `${state.sat}%`, base, `linear-gradient(to right, #fff, ${rgbCss(pureHue)})`);
  setSlider('djSensitivity', state.djSensitivity, `${state.djSensitivity}%`, [255, 255, 255]);

  const pattern = PATTERNS[state.djPattern];
  for (const btn of patternButtons) btn.setAttribute('aria-pressed', btn.dataset.pattern === state.djPattern);
  djNote.textContent = pattern.note;
  djWarning.textContent = pattern.warning || '';
  djWarning.hidden = !pattern.warning;

  for (const el of modeOnly) el.hidden = el.dataset.modeOnly !== state.mode;
  for (const el of hintAxis) el.textContent = state.mode === 'white' ? 'temperature' : 'hue';
  for (const btn of modeButtons) btn.setAttribute('aria-pressed', btn.dataset.mode === state.mode);
  for (const btn of presetButtons) btn.setAttribute('aria-pressed', state.mode === 'white' && state.kelvin === +btn.dataset.kelvin);
  slotButtons.forEach((btn, i) => btn.setAttribute('aria-pressed', !!slots[i] && sameLook(slots[i], state)));
  softboxBtn.setAttribute('aria-pressed', state.softbox);
}

function renderSlots() {
  slotButtons.forEach((btn, i) => {
    const look = slots[i];
    btn.classList.toggle('filled', !!look);
    btn.querySelector('.swatch').style.setProperty('--swatch', look ? rgbCss(baseRgb(look)) : 'transparent');
    btn.querySelector('.preset-label').textContent = look ? describe(look) : 'Save';
    btn.title = look ? `Use this light (${i + 4}). Hold to replace it.` : 'Save the current light here';
    btn.setAttribute('aria-label', look
      ? `Saved light ${i + 1}: ${describe(look)} at ${look.brightness}%`
      : `Save the current light to slot ${i + 1}`);
  });
}

// Readout at the top of the screen, also used for short messages.
let hudTimer = 0;
function hud(text, ms = 1200) {
  hudEl.textContent = text;
  hudEl.classList.add('visible');
  clearTimeout(hudTimer);
  hudTimer = setTimeout(() => hudEl.classList.remove('visible'), ms);
}

function showReadout(axis) {
  if (axis === 'y') hud(`Brightness ${state.brightness}%`);
  else if (state.mode === 'white') hud(`Temperature ${state.kelvin}K`);
  else hud(`Hue ${state.hue}°`);
}

// y is brightness; x is temperature in white mode and hue in color mode.
function nudge(axis, steps) {
  const key = axis === 'y' ? 'brightness' : state.mode === 'white' ? 'kelvin' : 'hue';
  setState({ [key]: state[key] + steps * STEP[key] });
  showReadout(axis);
}

/* ---------- Panel visibility ---------- */

let hideTimer = 0;
let panelHovered = false;
let panelHeld = false;

function keyboardFocusInPanel() {
  try {
    return !!panel.querySelector(':focus-visible');
  } catch {
    return false;
  }
}

function scheduleHide(ms = 4000) {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    if (panelHovered || panelHeld || keyboardFocusInPanel()) scheduleHide();
    else hidePanel();
  }, ms);
}

function showPanel(ms) {
  panel.classList.add('visible');
  scheduleHide(ms);
}

function hidePanel() {
  clearTimeout(hideTimer);
  if (panel.contains(document.activeElement)) document.activeElement.blur();
  panel.classList.remove('visible');
}

function togglePanel() {
  if (panel.classList.contains('visible')) hidePanel();
  else showPanel();
}

panel.addEventListener('pointerenter', (e) => {
  if (e.pointerType === 'mouse') panelHovered = true;
});
panel.addEventListener('pointerleave', () => {
  panelHovered = false;
});
panel.addEventListener('pointerdown', () => {
  panelHeld = true;
  scheduleHide();
});
addEventListener('pointerup', () => {
  panelHeld = false;
});
addEventListener('pointercancel', () => {
  panelHeld = false;
});
panel.addEventListener('input', () => scheduleHide());
panel.addEventListener('focusin', () => showPanel());

/* ---------- Gestures on the light ---------- */

const gesture = { id: null };

stage.addEventListener('pointerdown', (e) => {
  if (gesture.id !== null || e.button > 0) return;
  Object.assign(gesture, { id: e.pointerId, x: e.clientX, y: e.clientY, axis: null, from: null });
  stage.setPointerCapture(e.pointerId);
});

stage.addEventListener('pointermove', (e) => {
  if (e.pointerId !== gesture.id) return;
  const dx = e.clientX - gesture.x;
  const dy = e.clientY - gesture.y;

  if (!gesture.axis) {
    if (Math.hypot(dx, dy) < 10) return;
    // Lock to the dominant direction and measure from here, so the value doesn't jump.
    Object.assign(gesture, {
      axis: Math.abs(dy) > Math.abs(dx) ? 'y' : 'x',
      x: e.clientX,
      y: e.clientY,
      from: { ...state },
    });
    hidePanel();
    return;
  }

  const { from } = gesture;
  if (gesture.axis === 'y') setState({ brightness: from.brightness - (dy / innerHeight) * 125 });
  else if (state.mode === 'white') setState({ kelvin: from.kelvin + (dx / innerWidth) * (K_MAX - K_MIN) });
  else setState({ hue: from.hue + (dx / innerWidth) * 360 });
  showReadout(gesture.axis);
});

function endGesture(e) {
  if (e.pointerId !== gesture.id) return;
  if (e.type === 'pointerup' && !gesture.axis) togglePanel();
  gesture.id = null;
}

stage.addEventListener('pointerup', endGesture);
stage.addEventListener('pointercancel', endGesture);
stage.addEventListener('dblclick', () => toggleFullscreen());

let wheelDelta = 0;
stage.addEventListener('wheel', (e) => {
  if (e.ctrlKey) return; // Pinch-zoom and browser zoom.
  e.preventDefault();
  const scale = e.deltaMode === 1 ? 32 : e.deltaMode === 2 ? innerHeight : 1;
  const sideways = e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY);
  wheelDelta += (sideways ? e.deltaX || e.deltaY : -e.deltaY) * scale;
  const steps = Math.trunc(wheelDelta / 25);
  if (steps) {
    wheelDelta -= steps * 25;
    nudge(sideways ? 'x' : 'y', steps);
  }
}, { passive: false });

// Hide the cursor over the light once the mouse rests.
let idleTimer = 0;
addEventListener('pointermove', (e) => {
  if (e.pointerType !== 'mouse') return;
  document.body.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => document.body.classList.add('idle'), 2500);
});

/* ---------- Presets ---------- */

for (const btn of presetButtons) {
  btn.addEventListener('click', () => setState({ mode: 'white', kelvin: btn.dataset.kelvin }, true));
}

function saveSlot(i) {
  slots[i] = lookOf(state);
  renderSlots();
  render();
  flush();
  navigator.vibrate?.(12);
  hud(`Saved to slot ${i + 1}. Hold it to replace.`, 2200);
}

slotButtons.forEach((btn, i) => {
  let holdTimer = 0;
  const cancelHold = () => clearTimeout(holdTimer);
  btn.addEventListener('pointerdown', () => {
    holdTimer = setTimeout(() => saveSlot(i), 600);
  });
  btn.addEventListener('pointerup', cancelHold);
  btn.addEventListener('pointerleave', cancelHold);
  btn.addEventListener('pointercancel', cancelHold);
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
  // The click that ends a hold recalls the light just saved, which changes nothing.
  btn.addEventListener('click', (e) => {
    if (!slots[i] || e.shiftKey) saveSlot(i);
    else setState(slots[i], true);
  });
});

/* ---------- Controls ---------- */

for (const [name, slider] of Object.entries(sliders)) {
  slider.addEventListener('input', () => setState({ [name]: slider.value }));
}

for (const btn of modeButtons) {
  btn.addEventListener('click', () => setState({ mode: btn.dataset.mode }, true));
}

for (const btn of patternButtons) {
  btn.addEventListener('click', () => setState({ djPattern: btn.dataset.pattern }));
}

djBtn.addEventListener('click', () => setDj(!dj.on));
softboxBtn.addEventListener('click', () => setState({ softbox: !state.softbox }));
mirrorBtn.addEventListener('click', () => setMirror(!stream));
linkBtn.addEventListener('click', shareLink);
fsBtn.addEventListener('click', toggleFullscreen);

/* ---------- Fullscreen ---------- */

const fullscreenEnabled = document.fullscreenEnabled || document.webkitFullscreenEnabled;
const fullscreenElement = () => document.fullscreenElement || document.webkitFullscreenElement;
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

function toggleFullscreen() {
  if (fullscreenElement()) {
    const exit = document.exitFullscreen || document.webkitExitFullscreen;
    Promise.resolve(exit.call(document)).catch(() => {});
  } else if (fullscreenEnabled) {
    const request = root.requestFullscreen || root.webkitRequestFullscreen;
    Promise.resolve(request.call(root, { navigationUI: 'hide' })).catch(() => {});
  } else {
    // iPhone Safari has no Fullscreen API; an installed web app opens without browser bars.
    hud('For fullscreen on iPhone, tap Share, then Add to Home Screen.', 4000);
  }
}

function syncFullscreen() {
  const on = !!fullscreenElement();
  fsBtn.querySelector('.icon-enter').hidden = on;
  fsBtn.querySelector('.icon-exit').hidden = !on;
  fsBtn.setAttribute('aria-label', on ? 'Exit fullscreen' : 'Fullscreen');
  fsBtn.title = on ? 'Exit fullscreen (F)' : 'Fullscreen (F)';
}

document.addEventListener('fullscreenchange', syncFullscreen);
document.addEventListener('webkitfullscreenchange', syncFullscreen);
fsBtn.hidden = matchMedia('(display-mode: fullscreen)').matches || (standalone && !fullscreenEnabled);

/* ---------- Keep the screen on ---------- */

let wakeLock = null;

async function keepAwake() {
  if (!('wakeLock' in navigator) || wakeLock || document.visibilityState !== 'visible') return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => {
      wakeLock = null;
    });
  } catch {
    // Refused, e.g. in battery saver mode.
  }
}

// The lock is dropped whenever the page is hidden. Take the camera and the
// microphone down too, so they aren't left running in a background tab.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    keepAwake();
  } else {
    if (stream) setMirror(false);
    setDj(false);
  }
});
addEventListener('pointerdown', keepAwake);

/* ---------- Camera mirror ---------- */

let stream = null;
let mirrorPending = false;

async function setMirror(on) {
  if (mirrorPending) return;
  if (!on) {
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    mirrorVideo.srcObject = null;
  } else if (!navigator.mediaDevices?.getUserMedia) {
    hud('The camera mirror needs HTTPS or localhost.', 3000);
  } else {
    mirrorPending = true;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false });
      mirrorVideo.srcObject = stream;
    } catch (err) {
      const message = {
        NotAllowedError: 'Camera access is blocked. Allow it in the site settings to use the mirror.',
        NotFoundError: 'No camera found.',
      }[err.name] || 'The camera is unavailable. Another app may be using it.';
      hud(message, 3500);
    }
    mirrorPending = false;
  }
  mirrorEl.hidden = !stream;
  mirrorBtn.setAttribute('aria-pressed', !!stream);
}

/* ---------- DJ sync ---------- */

// Listens through the microphone, finds beats in the bass and drives the light
// with the chosen pattern.
const dj = { on: false, pending: false };

const makeFollower = () => ({ lo: 1, hi: 0, value: 0 });

// Rescales a dB-scaled 0..1 signal against its recent floor and peak (a slow
// auto gain), then smooths it with a fast attack and a slower release.
function follow(f, x, dt) {
  f.hi = Math.max(x, f.hi - dt * 0.02);
  f.lo = Math.min(x, f.lo + dt * 0.01);
  const norm = clamp((x - f.lo) / Math.max(0.12, f.hi - f.lo), 0, 1);
  const tau = norm > f.value ? 0.04 : 0.3;
  f.value += (norm - f.value) * (1 - Math.exp(-dt / tau));
}

async function setDj(on) {
  if (dj.pending || on === dj.on) return;
  if (!on) {
    cancelAnimationFrame(dj.raf);
    dj.stream.getTracks().forEach((track) => track.stop());
    dj.ctx.close();
    Object.assign(dj, { on: false, stream: null, ctx: null, analyser: null });
    syncDj();
    render(true);
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia || !window.AudioContext) {
    hud('DJ sync needs HTTPS or localhost.', 3000);
    return;
  }

  dj.pending = true;
  // Created and resumed inside the click, or browsers keep it suspended.
  const ctx = new AudioContext();
  const resumed = ctx.resume();
  try {
    // Echo cancellation would subtract music playing from this very device.
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    await resumed;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0;
    analyser.minDecibels = -90;
    analyser.maxDecibels = -10;
    // Some browsers only process nodes that lead to the speakers, so end in silence.
    const mute = ctx.createGain();
    mute.gain.value = 0;
    ctx.createMediaStreamSource(stream).connect(analyser).connect(mute).connect(ctx.destination);

    const bins = new Uint8Array(analyser.frequencyBinCount);
    Object.assign(dj, {
      on: true, stream, ctx, analyser, bins,
      prev: new Uint8Array(bins.length),
      binHz: ctx.sampleRate / analyser.fftSize,
      env: 0, hue: 0, hopHue: 0, bpm: 0, intervals: [], lastBeat: 0,
      fluxMean: 0, fluxVar: 0,
      loud: makeFollower(), bands: [makeFollower(), makeFollower(), makeFollower()],
      lastFrame: 0, lastAnalysis: 0, lastTheme: 0, status: '',
    });
    root.style.setProperty('--fade', '0ms');
    dj.raf = requestAnimationFrame(djFrame);
  } catch (err) {
    ctx.close();
    const message = {
      NotAllowedError: 'Microphone access is blocked. Allow it in the site settings to use DJ sync.',
      NotFoundError: 'No microphone found.',
    }[err.name] || 'The microphone is unavailable. Another app may be using it.';
    hud(message, 3500);
  }
  dj.pending = false;
  syncDj();
}

function syncDj() {
  djBtn.setAttribute('aria-checked', dj.on);
  djBody.hidden = !dj.on;
  djStatus.hidden = !dj.on;
}

function analyse(now, dt) {
  const { analyser, bins, prev, binHz } = dj;
  analyser.getByteFrequencyData(bins);
  const bin = (hz) => Math.max(1, Math.round(hz / binHz));
  const band = (lo, hi) => {
    let sum = 0;
    for (let i = bin(lo); i <= bin(hi); i++) sum += bins[i];
    return sum / (bin(hi) - bin(lo) + 1) / 255;
  };

  // Onset strength: how much the bass rose since the last look.
  let flux = 0;
  for (let i = bin(40); i <= bin(160); i++) flux += Math.max(0, bins[i] - prev[i]);
  flux /= (bin(160) - bin(40) + 1) * 255;
  prev.set(bins);

  // A beat is a rise well above the recent average; higher sensitivity lowers the bar.
  const s = state.djSensitivity / 100;
  const threshold = Math.max(dj.fluxMean + (2.4 - 1.8 * s) * Math.sqrt(dj.fluxVar), 0.05 - 0.035 * s);
  if (flux > threshold && band(40, 160) > 0.38 - 0.18 * s && now - dj.lastBeat >= MIN_BEAT_MS) onBeat(now);

  // Exponentially weighted mean and variance over about a second.
  const a = 1 - Math.exp(-dt);
  const diff = flux - dj.fluxMean;
  dj.fluxMean += a * diff;
  dj.fluxVar = (1 - a) * (dj.fluxVar + a * diff * diff);

  follow(dj.loud, band(40, 8000), dt);
  follow(dj.bands[0], band(40, 250), dt);
  follow(dj.bands[1], band(250, 2000), dt);
  follow(dj.bands[2], band(2000, 8000), dt);
}

function onBeat(now) {
  const interval = (now - dj.lastBeat) / 1000;
  dj.lastBeat = now;
  dj.env = 1;
  dj.hopHue = (dj.hopHue + 137.5) % 360; // The golden angle keeps consecutive colors far apart.
  if (interval > 2) {
    dj.intervals = [];
    return;
  }
  // Fold into 80–180 BPM, so a missed beat still counts toward the tempo.
  let beat = interval;
  while (beat > 0.75) beat /= 2;
  dj.intervals = [...dj.intervals.slice(-11), beat];
  if (dj.intervals.length >= 4) {
    // Average the middle half, ignoring stray detections at either end.
    const sorted = [...dj.intervals].sort((x, y) => x - y);
    const middle = sorted.slice(sorted.length >> 2, sorted.length - (sorted.length >> 2));
    dj.bpm = 60 / (middle.reduce((sum, x) => sum + x, 0) / middle.length);
  }
}

function djFrame(now) {
  dj.raf = requestAnimationFrame(djFrame);
  const dt = dj.lastFrame ? Math.min(0.1, (now - dj.lastFrame) / 1000) : 0;
  dj.lastFrame = now;

  // Analyse at most about 60 times a second, so onset strength doesn't depend on
  // the display's refresh rate.
  if (now - dj.lastAnalysis >= 15) {
    analyse(now, Math.min(0.1, (now - dj.lastAnalysis) / 1000));
    dj.lastAnalysis = now;
  }
  if (now - dj.lastBeat > 3000) {
    dj.bpm = 0;
    dj.intervals = [];
  }

  const pattern = PATTERNS[state.djPattern];
  dj.env *= Math.exp(-dt / pattern.decay);
  const { rgb, level } = pattern.frame(dt);
  const light = rgb.map((c) => Math.round((c * clamp(level, 0, 1) * state.brightness) / 100));
  paint(light);
  // Browser toolbars repaint slowly; don't retint them every frame.
  if (now - dj.lastTheme > 150) {
    themeColor.content = rgbHex(light);
    dj.lastTheme = now;
  }

  djBeat.style.opacity = 0.2 + 0.8 * dj.env;
  const status = dj.bpm ? `${Math.round(dj.bpm)} BPM` : 'Listening…';
  if (status !== dj.status) djBpm.textContent = dj.status = status;
}

function nextPattern() {
  const names = Object.keys(PATTERNS);
  const name = names[(names.indexOf(state.djPattern) + 1) % names.length];
  setState({ djPattern: name });
  const label = $(`[data-pattern="${name}"]`).textContent;
  hud(PATTERNS[name].warning ? `${label}. ${PATTERNS[name].warning}` : label, PATTERNS[name].warning ? 3500 : 1200);
}

/* ---------- Sharing ---------- */

async function shareLink() {
  flush();
  const url = location.href;
  if (navigator.share && matchMedia('(pointer: coarse)').matches) {
    try {
      await navigator.share({ title: document.title, url });
    } catch {
      // Share sheet dismissed.
    }
    return;
  }
  try {
    await navigator.clipboard.writeText(url);
    hud('Link copied');
  } catch {
    hud('Copy the link from the address bar.', 3000);
  }
}

addEventListener('hashchange', () => setState(readHash(), true));

/* ---------- Keyboard ---------- */

addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const steps = e.shiftKey ? 1 : 5;
  const arrow = { ArrowUp: ['y', 1], ArrowDown: ['y', -1], ArrowRight: ['x', 1], ArrowLeft: ['x', -1] }[e.key];

  if (arrow) {
    if (e.target instanceof HTMLInputElement) return; // A focused slider handles its own arrows.
    nudge(arrow[0], arrow[1] * steps);
  } else if (e.key === 'Escape') {
    hidePanel(); // Leave the default alone so Escape still exits fullscreen.
    return;
  } else if (e.key === 'Tab') {
    showPanel();
    return;
  } else if (/^Digit[1-6]$/.test(e.code)) {
    const n = Number(e.code.slice(5)) - 1;
    if (n < 3) presetButtons[n].click();
    else if (e.shiftKey) saveSlot(n - 3);
    else slotButtons[n - 3].click();
  } else {
    const action = {
      f: toggleFullscreen,
      c: () => setState({ mode: state.mode === 'white' ? 'color' : 'white' }, true),
      s: () => setState({ softbox: !state.softbox }),
      m: () => setMirror(!stream),
      d: () => setDj(!dj.on),
      p: nextPattern,
    }[e.key.toLowerCase()];
    if (!action) return;
    action();
  }
  e.preventDefault();
});

/* ---------- Start ---------- */

const kelvinStops = [];
for (let k = K_MIN; k <= K_MAX; k += 500) {
  kelvinStops.push(`${rgbCss(kelvinToRgb(k))} ${(((k - K_MIN) / (K_MAX - K_MIN)) * 100).toFixed(1)}%`);
}
sliders.kelvin.style.setProperty('--track', `linear-gradient(to right, ${kelvinStops.join(', ')})`);
sliders.hue.style.setProperty('--track',
  `linear-gradient(to right, ${[0, 60, 120, 180, 240, 300, 360].map((h) => rgbCss(hsvToRgb(h, 1))).join(', ')})`);
for (const btn of presetButtons) {
  btn.querySelector('.swatch').style.setProperty('--swatch', rgbCss(kelvinToRgb(+btn.dataset.kelvin)));
}

renderSlots();
render();
syncFullscreen();
showPanel(5000);
keepAwake();

if ('serviceWorker' in navigator && isSecureContext) {
  addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
