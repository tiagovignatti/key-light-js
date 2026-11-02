'use strict';

const K_MIN = 2500;
const K_MAX = 9000;
const STORAGE_KEY = 'key-light';
const DEFAULTS = {
  mode: 'white', kelvin: 4500, hue: 210, sat: 60, brightness: 100, softbox: false,
  djPattern: 'spectrum', djSensitivity: 60,
  camEffect: 'none', recCrop: '9:16', recQuality: 1080, recSound: true,
};
// Recording shapes as width / height; 0 means the window's own shape.
const CROPS = { '9:16': 9 / 16, '4:5': 4 / 5, '1:1': 1, '16:9': 16 / 9, screen: 0 };
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
    camEffect: s.camEffect in EFFECTS ? s.camEffect : DEFAULTS.camEffect,
    recCrop: s.recCrop in CROPS ? s.recCrop : DEFAULTS.recCrop,
    recQuality: +s.recQuality === 2160 ? 2160 : 1080,
    recSound: s.recSound !== false,
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
const mirrorCanvas = $('#mirror-canvas');
const camSection = $('#cam-section');
const camSwitchBtn = $('#cam-switch');
const fxBody = $('#fx-body');
const effectButtons = $$('[data-effect]');
const cropGuide = $('#crop-guide');
const recToggle = $('#rec-toggle');
const recBody = $('#rec-body');
const cropButtons = $$('[data-crop]');
const qualityButtons = $$('[data-quality]');
const screenShape = $('#screen-shape');
const recSoundBtn = $('#rec-sound');
const recStartBtn = $('#rec-start');
const recStartLabel = $('#rec-start-label');
const recBar = $('#rec-bar');
const recTime = $('#rec-time');
const recStopBtn = $('#rec-stop');
const savedEl = $('#saved');
const savedInfo = $('#saved-info');
const saveBtn = $('#save-btn');
const shareBtn = $('#share-btn');
const discardBtn = $('#discard-btn');
const installSheet = $('#install');
const sliders = {
  brightness: $('#brightness'), kelvin: $('#kelvin'), hue: $('#hue'), sat: $('#sat'),
  djSensitivity: $('#dj-sensitivity'),
};
const outputs = {
  brightness: $('#brightness-out'), kelvin: $('#kelvin-out'), hue: $('#hue-out'), sat: $('#sat-out'),
  djSensitivity: $('#dj-sensitivity-out'),
};

// The light's current color, also read by the recorder.
let lightNow = [0, 0, 0];
function paint(rgb) {
  lightNow = rgb;
  root.style.setProperty('--light', rgbCss(rgb));
}

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

  for (const btn of effectButtons) btn.setAttribute('aria-pressed', btn.dataset.effect === state.camEffect);
  for (const btn of cropButtons) btn.setAttribute('aria-pressed', btn.dataset.crop === state.recCrop);
  for (const btn of qualityButtons) btn.setAttribute('aria-pressed', +btn.dataset.quality === state.recQuality);
  recSoundBtn.setAttribute('aria-checked', state.recSound);
  syncCropGuide();

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
  syncCropGuide();
}

function hidePanel() {
  clearTimeout(hideTimer);
  if (panel.contains(document.activeElement)) document.activeElement.blur();
  panel.classList.remove('visible');
  syncCropGuide();
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

for (const btn of effectButtons) {
  btn.addEventListener('click', () => setState({ camEffect: btn.dataset.effect }));
}
for (const btn of cropButtons) {
  btn.addEventListener('click', () => setState({ recCrop: btn.dataset.crop }));
}
for (const btn of qualityButtons) {
  btn.addEventListener('click', () => setState({ recQuality: btn.dataset.quality }));
}

recToggle.addEventListener('click', () => {
  const open = recToggle.getAttribute('aria-expanded') !== 'true';
  recToggle.setAttribute('aria-expanded', open);
  recBody.hidden = !open;
  syncCropGuide();
});
recSoundBtn.addEventListener('click', () => setState({ recSound: !state.recSound }));
recStartBtn.addEventListener('click', () => (rec.recorder ? stopRecording() : startRecording()));
recStopBtn.addEventListener('click', stopRecording);
saveBtn.addEventListener('click', saveVideo);
shareBtn.addEventListener('click', shareVideo);
discardBtn.addEventListener('click', discardVideo);

djBtn.addEventListener('click', () => setDj(!dj.on));
softboxBtn.addEventListener('click', () => setState({ softbox: !state.softbox }));
mirrorBtn.addEventListener('click', () => setMirror(!stream));
camSwitchBtn.addEventListener('click', switchCamera);
linkBtn.addEventListener('click', shareLink);
fsBtn.addEventListener('click', toggleFullscreen);

/* ---------- Fullscreen ---------- */

const fullscreenEnabled = document.fullscreenEnabled || document.webkitFullscreenEnabled;
const fullscreenElement = () => document.fullscreenElement || document.webkitFullscreenElement;
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const iPhone = /iPhone|iPod/.test(navigator.userAgent);

function toggleFullscreen() {
  if (fullscreenElement()) {
    const exit = document.exitFullscreen || document.webkitExitFullscreen;
    Promise.resolve(exit.call(document)).catch(() => {});
  } else if (fullscreenEnabled) {
    const request = root.requestFullscreen || root.webkitRequestFullscreen;
    Promise.resolve(request.call(root, { navigationUI: 'hide' })).catch(() => {});
  } else if (iPhone) {
    // iPhone browsers have no Fullscreen API; a Home Screen web app opens without browser bars.
    hidePanel();
    installSheet.showModal();
  } else {
    hud("This browser can't go fullscreen.", 3000);
  }
}

$('#install-close').addEventListener('click', () => installSheet.close());
// A click on the dimmed backdrop lands on the dialog itself, outside its card.
installSheet.addEventListener('click', (e) => {
  if (e.target === installSheet) installSheet.close();
});

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
// microphone down too, so they aren't left running in a background tab, and
// finish any recording, since hidden pages stop drawing.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    keepAwake();
  } else {
    stopRecording();
    if (stream) setMirror(false);
    setDj(false);
  }
});
addEventListener('pointerdown', keepAwake);

/* ---------- Camera mirror ---------- */

let stream = null;
let mirrorPending = false;
// The camera to open: the front one, until another is picked.
let camera = { facingMode: 'user' };
let cameras = [];
let mirrored = true;

// Ask for HD, so recordings stay sharp; browsers fall back to what the camera has.
const openCamera = (video) => navigator.mediaDevices.getUserMedia({
  video: { ...video, width: { ideal: 1920 }, height: { ideal: 1080 } },
  audio: false,
});

function useCamera(newStream) {
  stream = newStream;
  mirrorVideo.srcObject = stream;
  const { facingMode, deviceId } = stream.getVideoTracks()[0].getSettings();
  camera = facingMode ? { deviceId, facingMode } : { deviceId };
  // A mirror for cameras that face you; the back camera shows the world as it is.
  mirrored = facingMode !== 'environment';
  mirrorEl.classList.toggle('rear', !mirrored);
}

async function setMirror(on) {
  if (mirrorPending) return;
  if (!on) {
    cancelAnimationFrame(fxRaf);
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    mirrorVideo.srcObject = null;
  } else if (!navigator.mediaDevices?.getUserMedia) {
    hud('The camera mirror needs HTTPS or localhost.', 3000);
  } else {
    mirrorPending = true;
    try {
      useCamera(await openCamera(camera));
      if (renderEffect) {
        fxLast = 0;
        fxRaf = requestAnimationFrame(effectFrame);
      }
      listCameras();
    } catch (err) {
      const message = {
        NotAllowedError: 'Camera access is blocked. Allow it in the site settings to use the mirror.',
        NotFoundError: 'No camera found.',
      }[err.name] || 'The camera is unavailable. Another app may be using it.';
      hud(message, 3500);
    }
    mirrorPending = false;
  }
  syncCamera();
}

function syncCamera() {
  const canSwitch = cameras.length > 1;
  mirrorEl.hidden = !stream;
  mirrorBtn.setAttribute('aria-pressed', !!stream);
  camSection.hidden = !stream || (!renderEffect && !canSwitch);
  camSwitchBtn.hidden = !canSwitch;
  fxBody.hidden = !renderEffect;
}

// Browsers only list every camera once one is allowed, so ask after opening it.
async function listCameras() {
  try {
    cameras = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === 'videoinput');
  } catch {
    cameras = [];
  }
  syncCamera();
}

navigator.mediaDevices?.addEventListener('devicechange', () => {
  if (stream) listCameras();
});

async function switchCamera() {
  if (!stream || mirrorPending || cameras.length < 2) return;
  mirrorPending = true;
  const { facingMode, deviceId } = stream.getVideoTracks()[0].getSettings();
  const next = cameras[(cameras.findIndex((c) => c.deviceId === deviceId) + 1) % cameras.length];
  const choices = [
    // Phones list several back cameras, so flip between front and back
    // rather than step through all of them.
    (facingMode === 'user' || facingMode === 'environment') &&
      { facingMode: { exact: facingMode === 'user' ? 'environment' : 'user' } },
    { deviceId: { exact: next.deviceId } },
    { deviceId: { exact: deviceId } }, // The camera we had.
  ].filter(Boolean);

  // Phones can only open one camera at a time.
  stream.getTracks().forEach((track) => track.stop());
  let newStream = null;
  for (const video of choices) {
    try {
      newStream = await openCamera(video);
      break;
    } catch {
      // Try the next one.
    }
  }
  mirrorPending = false;
  if (!newStream) {
    hud('The camera is unavailable. Another app may be using it.', 3500);
    setMirror(false);
    return;
  }
  useCamera(newStream);
  const { facingMode: facing, deviceId: id } = newStream.getVideoTracks()[0].getSettings();
  const label = cameras.find((c) => c.deviceId === id)?.label.replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)$/i, '');
  hud({ user: 'Front camera', environment: 'Back camera' }[facing] || label || 'Camera switched');
}

/* ---------- Camera effects ---------- */

let renderEffect = null;
try {
  renderEffect = createEffectRenderer(mirrorCanvas);
} catch (err) {
  console.warn('Camera effects are unavailable:', err);
}
mirrorCanvas.hidden = !renderEffect;
let fxRaf = 0;
let fxLast = 0;
let fxPhase = 0;

function effectFrame(now) {
  fxRaf = requestAnimationFrame(effectFrame);
  const dt = fxLast ? Math.min(0.1, (now - fxLast) / 1000) : 0;
  fxLast = now;
  const beat = dj.on ? dj.env : 0;
  // Animations run faster on beats, so the effects jump with the music.
  fxPhase += dt * (1 + 3 * beat);
  try {
    renderEffect(mirrorVideo, state.camEffect, { time: fxPhase, beat, beats: dj.on ? dj.beats : Math.floor(fxPhase / 2), mirrored });
  } catch (err) {
    // A shader this GPU can't compile: fall back to the plain camera.
    console.error(err);
    cancelAnimationFrame(fxRaf);
    renderEffect = null;
    mirrorCanvas.hidden = true;
    syncCamera();
  }
}

function nextEffect() {
  if (!stream || !renderEffect) return;
  const names = Object.keys(EFFECTS);
  const name = names[(names.indexOf(state.camEffect) + 1) % names.length];
  setState({ camEffect: name });
  hud($(`[data-effect="${name}"]`).textContent);
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
      env: 0, hue: 0, hopHue: 0, bpm: 0, beats: 0, intervals: [], lastBeat: 0,
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
  dj.beats++;
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

/* ---------- Recording ---------- */

// Recordings aren't screen captures: every frame, the light, softbox and camera are
// redrawn into an offscreen canvas at the output size. That keeps them sharp at any
// resolution, works on phones, and leaves the controls out.
const rec = { recorder: null, pending: false, result: null };

// The part of the window that gets recorded: the largest rectangle of the given
// shape, centered on the camera mirror as far as the window allows.
function cropRect(aspect = CROPS[state.recCrop] || innerWidth / innerHeight) {
  const w = Math.min(innerWidth, innerHeight * aspect);
  const h = w / aspect;
  return { x: (innerWidth - w) / 2, y: clamp(innerHeight * 0.45 - h / 2, 0, innerHeight - h), w, h };
}

// The short side is the quality setting; the long side is capped at 3840 pixels,
// the most H.264 encoders accept.
function outputSize(aspect) {
  const even = (n) => Math.round(n / 2) * 2;
  const ratio = Math.max(aspect, 1 / aspect);
  const short = Math.min(state.recQuality, 3840 / ratio);
  return aspect < 1 ? [even(short), even(short * ratio)] : [even(short * ratio), even(short)];
}

function syncCropGuide() {
  const recording = !!rec.recorder;
  const choosing = recToggle.getAttribute('aria-expanded') === 'true' && panel.classList.contains('visible');
  const crop = cropRect(recording ? rec.aspect : undefined);
  cropGuide.hidden = !(recording || choosing) || (crop.w >= innerWidth - 1 && crop.h >= innerHeight - 1);
  cropGuide.classList.toggle('recording', recording);
  Object.assign(cropGuide.style, { left: `${crop.x}px`, top: `${crop.y}px`, width: `${crop.w}px`, height: `${crop.h}px` });

  // The Screen chip's icon takes the window's shape.
  const scale = Math.min(20 / innerWidth, 16 / innerHeight);
  Object.assign(screenShape.style, { width: `${Math.round(innerWidth * scale)}px`, height: `${Math.round(innerHeight * scale)}px` });

  recStartLabel.textContent = recording ? 'Stop recording' : 'Start recording';
}

addEventListener('resize', syncCropGuide);

// Draws what the window shows, in window coordinates, scaled into the crop.
function drawScene(ctx, crop, scale) {
  const W = innerWidth;
  const H = innerHeight;
  ctx.setTransform(scale, 0, 0, scale, -crop.x * scale, -crop.y * scale);
  ctx.fillStyle = rgbCss(lightNow);
  ctx.fillRect(crop.x, crop.y, crop.w, crop.h);

  if (state.softbox) {
    // Same as .softbox: an ellipse through the farthest corner, centered at 50% 45%.
    const cx = W / 2;
    const cy = H * 0.45;
    const rx = Math.SQRT2 * cx;
    const ry = Math.SQRT2 * Math.max(cy, H - cy);
    const falloff = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
    falloff.addColorStop(0.18, 'rgba(0, 0, 0, 0)');
    falloff.addColorStop(0.55, 'rgba(0, 0, 0, 0.22)');
    falloff.addColorStop(1, 'rgba(0, 0, 0, 0.62)');
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(rx, ry);
    ctx.fillStyle = falloff;
    ctx.fillRect(-cx / rx, -cy / ry, W / rx, H / ry);
    ctx.restore();
  }

  if (stream && mirrorVideo.videoWidth) {
    const r = mirrorEl.getBoundingClientRect();
    ctx.save();
    ctx.beginPath();
    ctx.arc(r.x + r.width / 2, r.y + r.height / 2, r.width / 2, 0, 2 * Math.PI);
    ctx.clip();
    if (renderEffect) {
      ctx.drawImage(mirrorCanvas, r.x, r.y, r.width, r.height);
    } else {
      // No WebGL: crop the video to a square and mirror it, like the CSS does.
      const { videoWidth: vw, videoHeight: vh } = mirrorVideo;
      const side = Math.min(vw, vh);
      ctx.translate(r.x, r.y);
      if (mirrored) {
        ctx.translate(r.width, 0);
        ctx.scale(-1, 1);
      }
      ctx.drawImage(mirrorVideo, (vw - side) / 2, (vh - side) / 2, side, side, 0, 0, r.width, r.height);
    }
    ctx.restore();
  }
}

// MP4 (H.264) plays everywhere, so prefer it; Firefox only records WebM.
function pickMimeType(withAudio) {
  const candidates = withAudio
    ? ['video/mp4;codecs=avc1.640033,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm']
    : ['video/mp4;codecs=avc1.640033', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || '';
}

async function startRecording() {
  if (rec.recorder || rec.pending) return;
  if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) {
    hud("This browser can't record video.", 3000);
    return;
  }
  rec.pending = true;

  let audio = null;
  if (state.recSound) {
    try {
      // Share DJ sync's microphone when it's on; otherwise ask for one tuned for voices.
      audio = dj.on
        ? dj.stream.getAudioTracks()[0].clone()
        : (await navigator.mediaDevices.getUserMedia({ audio: true })).getAudioTracks()[0];
    } catch {
      hud('Recording without sound: the microphone is unavailable.', 3000);
    }
  }

  const aspect = CROPS[state.recCrop] || innerWidth / innerHeight;
  const [width, height] = outputSize(aspect);
  const canvas = Object.assign(document.createElement('canvas'), { width, height });
  const ctx = canvas.getContext('2d', { alpha: false });
  const crop = cropRect(aspect);
  drawScene(ctx, crop, width / crop.w);

  const output = canvas.captureStream(30);
  if (audio) output.addTrack(audio);
  const mimeType = pickMimeType(!!audio);
  const chunks = [];
  let recorder;
  try {
    recorder = new MediaRecorder(output, {
      ...(mimeType && { mimeType }),
      // About 0.2 bits per pixel: 12 Mbps at 1080p, 50 Mbps at 4K.
      videoBitsPerSecond: Math.round(width * height * 30 * 0.2),
      audioBitsPerSecond: 192000,
    });
    recorder.addEventListener('dataavailable', (e) => {
      if (e.data.size) chunks.push(e.data);
    });
    recorder.addEventListener('stop', () => finishRecording(chunks, recorder.mimeType || mimeType, width, height));
    recorder.start(1000);
  } catch (err) {
    console.error(err);
    output.getTracks().forEach((track) => track.stop());
    hud(`This browser can't record at ${width} × ${height}. Try 1080p.`, 3500);
    rec.pending = false;
    return;
  }

  Object.assign(rec, {
    recorder, output, ctx, aspect, width, height,
    pending: false, started: performance.now(), lastDraw: 0,
    raf: requestAnimationFrame(recordFrame),
    timer: setInterval(updateRecTime, 250),
  });
  discardVideo();
  updateRecTime();
  recBar.hidden = false;
  hidePanel();
}

function recordFrame(now) {
  rec.raf = requestAnimationFrame(recordFrame);
  // About 30 frames a second, whatever the display's refresh rate.
  if (now - rec.lastDraw < 30) return;
  rec.lastDraw = now;
  const crop = cropRect(rec.aspect);
  drawScene(rec.ctx, crop, rec.width / crop.w);
}

const formatTime = (seconds) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

function updateRecTime() {
  recTime.textContent = formatTime((performance.now() - rec.started) / 1000);
}

function stopRecording() {
  if (!rec.recorder) return;
  cancelAnimationFrame(rec.raf);
  clearInterval(rec.timer);
  rec.duration = (performance.now() - rec.started) / 1000;
  rec.recorder.stop();
  rec.output.getTracks().forEach((track) => track.stop());
  rec.recorder = null;
  recBar.hidden = true;
  syncCropGuide();
}

function finishRecording(chunks, mimeType, width, height) {
  const type = mimeType.split(';')[0] || 'video/webm';
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const file = new File(chunks, `key-light-${stamp}.${type === 'video/mp4' ? 'mp4' : 'webm'}`, { type });
  rec.result = file;

  const megabytes = file.size / 1e6;
  savedInfo.textContent = `${formatTime(rec.duration)}, ${width} × ${height}, ${megabytes < 10 ? megabytes.toFixed(1) : Math.round(megabytes)} MB`;
  shareBtn.hidden = !navigator.canShare?.({ files: [file] });
  savedEl.hidden = false;
}

function saveVideo() {
  const url = URL.createObjectURL(rec.result);
  const link = Object.assign(document.createElement('a'), { href: url, download: rec.result.name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

async function shareVideo() {
  try {
    await navigator.share({ files: [rec.result], title: 'Key Light video' });
  } catch {
    // Share sheet dismissed.
  }
}

function discardVideo() {
  rec.result = null;
  savedEl.hidden = true;
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
  if (e.metaKey || e.ctrlKey || e.altKey || installSheet.open) return;
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
      v: switchCamera,
      d: () => setDj(!dj.on),
      p: nextPattern,
      e: nextEffect,
      r: () => (rec.recorder ? stopRecording() : startRecording()),
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
