# Air Drums 🥁

Play a drum kit in mid-air. A webcam finds your hands, and a strike — closing
your fist or flicking down — plays the drum your hand is over. No install, no
build step, no account.

Hand tracking is done by [MediaPipe Hands](https://developers.google.com/mediapipe)
running in the browser; the drum sounds are synthesised live with the Web Audio
API. Nothing to download but the page itself (and a one-time model fetch).

## Run it

The camera needs a real origin (`https://` or `http://localhost`), so serve the
folder rather than opening the file directly:

```bash
# from inside this folder
python3 -m http.server 8000
# then open http://localhost:8000
```

Or turn on **Settings → Pages** on the GitHub repo and use the published URL.

## How to play

1. Press **Start** and allow the camera.
2. Move your hand over a drum — the drum lights up under it.
3. **Close your fist**, or **flick your hand downward**, to strike it.

Both hands work at once, so you can play two drums together. No camera handy?
Press keys **1**–**6** or click a pad.

| Zone | Drum | Key |
|------|------|-----|
| top-left | Hi-hat | `1` |
| top-middle | Crash | `2` |
| top-right | Ride | `3` |
| bottom-left | Snare | `4` |
| bottom-middle | Kick | `5` |
| bottom-right | Floor tom | `6` |

## Controls

- **Sensitivity** – how fast a downward flick has to be to count as a strike.
  Too many accidental hits → lower it; missing your strikes → raise it. Fist
  strikes are not affected by this.
- **Volume** – output level.
- **Recalibrate** – resets the strike trackers (useful if a hand gets stuck).

## How it works

1. Each camera frame goes to **MediaPipe HandLandmarker**, which returns up to
   two hands as 21 points each (normalised 0..1), plus a left/right label.
2. `hands.js` turns those points into decisions:
   - **Which drum** — the palm centre (average of the wrist and the four base
     knuckles) mapped onto the 3×2 pad grid, with x mirrored to match the
     on-screen preview.
   - **Fist or open** — a finger counts as extended when the base→middle and
     middle→tip segments point the same way. This is scale- and
     rotation-invariant, so it works at any distance or hand angle.
   - **A strike** — either the hand closing from open (≥3 fingers) to a fist
     (≤1), or the palm moving down faster than the sensitivity threshold. A
     short cooldown stops one strike firing twice.
3. The hit plays a drum built from oscillators and filtered noise, and the pad
   flashes, ripples and counts up.

If the hand model can't load (offline, blocked CDN), the app falls back to
frame-difference **motion sensing** (`motion.js`) so the kit still plays.

## Files

```
index.html            the page and styling
app.js                camera, MediaPipe, rendering, hit handling, drum synthesis
hands.js              gesture logic: finger counting, palm, pad mapping, strikes
motion.js             MotionDetector — offline motion-sensing fallback
test/test_hands.js    unit tests for the gesture logic (plain Node)
test/test_motion.js   unit tests for the motion fallback (plain Node)
test/browser_test.js  end-to-end test in headless Chromium
test/fixtures/hand.jpg  a real hand photo used by the end-to-end test
```

## Tests

```bash
node test/test_hands.js      # 22 assertions — gesture + strike logic
node test/test_motion.js     # 20 assertions — motion fallback
node test/browser_test.js    # needs Chromium + puppeteer-core
```

`test/browser_test.js` serves the app, opens it in headless Chromium with a
synthetic webcam, confirms MediaPipe loads, then detects a **real hand photo**
(21 landmarks, classified as an open hand) and drives a strike through the app.
Point it at your own browser with `CHROME_PATH=/path/to/chrome node test/browser_test.js`.

## Credits

Test hand photo: "Linke-hand.jpg" by MartinThoma, Wikimedia Commons, **CC0**
(public domain).
