'use strict';

const K_MIN = 2500;
const K_MAX = 9000;
const STORAGE_KEY = 'key-light';
const DEFAULTS = { mode: 'white', kelvin: 4500, hue: 210, sat: 60, brightness: 100, softbox: false };
// Size of one nudge step (fine adjustment); a coarse step is five of these.
const STEP = { brightness: 1, kelvin: 50, hue: 1 };

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

/* ---------- State, storage and URL ---------- */

function sanitize(s) {
  return {
    mode: s.mode === 'color' ? 'color' : 'white',
    kelvin: clamp(Math.round(toNumber(s.kelvin, DEFAULTS.kelvin) / 50) * 50, K_MIN, K_MAX),
    hue: ((Math.round(toNumber(s.hue, DEFAULTS.hue)) % 360) + 360) % 360,
    sat: clamp(Math.round(toNumber(s.sat, DEFAULTS.sat)), 0, 100),
    brightness: clamp(Math.round(toNumber(s.brightness, DEFAULTS.brightness)), 1, 100),
    softbox: s.softbox === true,
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
const sliders = { brightness: $('#brightness'), kelvin: $('#kelvin'), hue: $('#hue'), sat: $('#sat') };
const outputs = { brightness: $('#brightness-out'), kelvin: $('#kelvin-out'), hue: $('#hue-out'), sat: $('#sat-out') };

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

  root.style.setProperty('--fade', animate ? '450ms' : '0ms');
  root.style.setProperty('--light', rgbCss(light));
  root.style.setProperty('--accent', rgbCss(base));
  root.style.setProperty('--on-accent', isPale(base) ? '#1f1d1a' : '#f4f0e8');
  themeColor.content = rgbHex(light);
  softboxEl.classList.toggle('on', state.softbox);

  setSlider('brightness', state.brightness, `${state.brightness}%`, light, `linear-gradient(to right, #000, ${rgbCss(base)})`);
  setSlider('kelvin', state.kelvin, `${state.kelvin}K`, kelvinToRgb(state.kelvin));
  setSlider('hue', state.hue, `${state.hue}°`, pureHue);
  setSlider('sat', state.sat, `${state.sat}%`, base, `linear-gradient(to right, #fff, ${rgbCss(pureHue)})`);

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

// The lock is dropped whenever the page is hidden. Take the camera down too,
// so it isn't left running in a background tab.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') keepAwake();
  else if (stream) setMirror(false);
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
