# Key Light

A fullscreen key light for video calls that runs in the browser. Put a spare phone, tablet or monitor next to your camera and use its screen as a light, with adjustable brightness, color temperature (2500–9000K) and color.

Plain HTML, CSS and JavaScript with no build step and no dependencies.

## Run it

Serve the folder over HTTP:

```sh
python3 -m http.server 8000
```

Then open <http://localhost:8000>. To use it on other devices, host the folder on any HTTPS static host, such as GitHub Pages.

The camera mirror, keep-awake and offline install need a secure context (HTTPS or `localhost`). Opening `index.html` straight from disk works, but without those.

## Fullscreen

- **Desktop, Android, iPad:** the fullscreen button, <kbd>F</kbd>, or double-click the light.
- **iPhone:** browsers on iPhone can't make a page fullscreen, so add Key Light to the Home Screen and open it from there. It opens without browser bars, and works offline. The fullscreen button shows these steps:
  1. Tap Share. In Safari on iOS 26, it may be behind the ⋯ button next to the address.
  2. Tap Add to Home Screen. If it isn't listed, scroll down or tap View More.
  3. Leave Open as Web App on, and tap Add.

  The iPhone status bar stays visible at the top, since iOS doesn't let web apps hide it. Some iOS 26 and 27 versions also draw a band behind it that a web page can't paint over ([WebKit bug 301994](https://bugs.webkit.org/show_bug.cgi?id=301994)).

For the most light, turn the device's own brightness all the way up. A web page can only dim pixels; it can't raise the backlight.

## Controls

| | Touch | Mouse and keyboard |
|---|---|---|
| Show or hide controls | Tap the light | Click the light, <kbd>Esc</kbd> to hide |
| Brightness | Swipe up or down | Drag up or down, scroll wheel, <kbd>↑</kbd> <kbd>↓</kbd> |
| Temperature (white) or hue (color) | Swipe sideways | Drag sideways, <kbd>Shift</kbd> + scroll, <kbd>←</kbd> <kbd>→</kbd> |
| Switch white / color | White and Color buttons | <kbd>C</kbd> |
| Softbox falloff | Softbox button | <kbd>S</kbd> |
| Camera mirror | Camera button | <kbd>M</kbd> |
| Presets 3200K, 4500K, 5600K | Tap | <kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> |
| Saved lights | Tap an empty slot to save, tap to use, hold to replace | <kbd>4</kbd> <kbd>5</kbd> <kbd>6</kbd>, <kbd>Shift</kbd> + number to save |
| Switch camera | Switch, under Camera | <kbd>V</kbd> |
| DJ sync on or off | DJ sync switch | <kbd>D</kbd> |
| Next DJ pattern | Pattern buttons | <kbd>P</kbd> |
| Next camera effect | Effect buttons | <kbd>E</kbd> |
| Start or stop recording | Record video | <kbd>R</kbd> |

Hold <kbd>Shift</kbd> with the arrow keys for fine steps.

## DJ sync

Turn on DJ sync and play music nearby. The light listens through the microphone, finds the beat in the bass, shows the tempo, and moves with the music:

| Pattern | What it does |
|---|---|
| Spectrum | A color organ: bass glows red, mids green and highs blue. |
| Hop | A new color on every beat. |
| Pulse | Your light kicks on every beat and settles back. |
| Flow | Colors drift around the wheel and swell with the volume. |
| Strobe | Your light flashes on the beat, dark in between. |

Brightness stays the master level, and Pulse and Strobe use the current white or color light. Raise the sensitivity if beats are missed, lower it if the light reacts to everything.

The light never flashes more than three times a second, the limit WCAG sets for photosensitive seizures. Even so, Strobe and Hop are flashing effects. Don't use them around people with photosensitive epilepsy.

Echo cancellation is turned off, so music playing from the same computer should be picked up too. On phones, turning on the microphone may pause music playing in other apps; playing the music from another device avoids that. DJ sync stops when you leave the page, and the audio never leaves your device.

The screen stays on while the light is open, and the last setup is remembered.

## Camera

With the camera mirror on, pick an effect. They run as WebGL shaders, on the camera's full resolution.

- **Smooth** evens out skin while keeping eyes, brows and hair sharp, and adds a little brightness and warmth.
- **Glow** works like a mist filter on a film lens: highlights bloom into a soft haze, contrast eases and the tones warm.
- **Pop art, Thermal, Comic, Glitch and 8-bit** are for fun, and move with the beat while DJ sync is on.

When there's more than one camera, Switch appears next to the Camera heading. On phones it flips between the front and back cameras; on computers it steps through the connected cameras. Cameras that face you are mirrored, and the back camera shows the world as it is, in the light and in recordings.

## Recording

Open Record video, pick a shape and a quality, and press Start recording:

- **Shapes:** 9:16 (Reels, TikTok, Shorts), 4:5, 1:1, 16:9 (YouTube), or Screen for the window's own shape. A frame on screen shows what will be recorded.
- **Quality:** 1080p or 4K (the short side; the long side is capped at 3840 pixels).
- **Sound:** records the microphone. With DJ sync on, it records the same microphone DJ sync listens to.

Recordings aren't screen captures. Every frame, the light, softbox and camera are drawn again into an offscreen canvas at the output size, so the video is sharp at 4K even on a small screen, works on phones, and never shows the controls. You can open the controls and change the light, DJ pattern or effect while recording.

When you stop, Save video downloads the file (MP4 where the browser supports it, otherwise WebM), and Share opens the share sheet where available, for example to save to Photos on iPhone. Recordings stop when you leave the page.

## Links

The address always reflects the current light, so you can bookmark or share a setup:

- `#k=4500&b=80`: white light at 4500K, 80% brightness
- `#h=210&s=60&b=80`: color light at hue 210°, 60% saturation, 80% brightness
- The softbox falloff is on by default; add `&soft=0` to turn it off

## Files

- `index.html`, `style.css`, `app.js`: the app
- `effects.js`: the camera effect shaders
- `manifest.webmanifest`, `sw.js`, `icons/`: install and offline support. The service worker is network-first, so edits show up on the next load. Bump `CACHE` in `sw.js` when you add or rename files.
