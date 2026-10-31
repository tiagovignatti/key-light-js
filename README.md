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
- **iPhone:** Safari can't make web pages fullscreen. Tap Share → Add to Home Screen, then open Key Light from the home screen icon. It also works offline from there.

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

Hold <kbd>Shift</kbd> with the arrow keys for fine steps.

The screen stays on while the light is open, and the last setup is remembered.

## Links

The address always reflects the current light, so you can bookmark or share a setup:

- `#k=4500&b=80`: white light at 4500K, 80% brightness
- `#h=210&s=60&b=80`: color light at hue 210°, 60% saturation, 80% brightness
- Add `&soft=1` to turn on the softbox falloff

## Files

- `index.html`, `style.css`, `app.js`: the app
- `manifest.webmanifest`, `sw.js`, `icons/`: install and offline support. The service worker is network-first, so edits show up on the next load. Bump `CACHE` in `sw.js` when you add or rename files.
