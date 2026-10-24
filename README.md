# Air Drums 🥁

Play a drum kit in mid-air with your hands. A webcam watches for hand movement;
when your hand strikes a drum zone, that drum sounds. No app install, no
machine-learning model to download, no build step — just open the page.

This is a **clean rewrite**: the earlier AI/gesture-classification layer is gone.
It is plain frame-difference motion sensing plus the Web Audio API, so it is
simple, fast and works offline once loaded.

## Run it

Camera access needs a real origin (`https://` or `http://localhost`), so serve
the folder rather than double-clicking the file:

```bash
# from inside this folder
python3 -m http.server 8000
# then open http://localhost:8000
```

Or, on GitHub, turn on **Settings → Pages** and use the published URL.

Click **Start camera**, allow the webcam, then move your hand over a drum.

## The kit

| Zone | Drum | Key |
|------|------|-----|
| top-left | Hi-hat | `1` |
| top-middle | Crash | `2` |
| top-right | Ride | `3` |
| bottom-left | Snare | `4` |
| bottom-middle | Kick | `5` |
| bottom-right | Floor tom | `6` |

No camera, or just testing? Press keys **1–6**, or click a pad with the mouse.

## Controls

- **Sensitivity** – how much movement counts as a hit. Too many phantom hits →
  lower it. Missing your strikes → raise it.
- **Volume** – output level.
- **Calibrate** – re-learns the "quiet" background (do this after the lighting
  changes, or if you moved the camera). Keep your hands still for a moment.

## How it works

1. Each camera frame is drawn, mirrored, to a small 200×150 canvas and turned
   into grayscale.
2. The screen is split into six zones. For each zone the app measures how much
   that zone changed since the previous frame.
3. Every zone keeps a slowly-updating **noise floor** of what "still" looks like
   there, so a motionless hand, camera grain or a shifting background does not
   trigger. A hit is a spike well above that floor.
4. To stop one strike from firing twice (in *and* out), a zone locks after it
   fires and only re-arms once it has been still for a short moment. A refractory
   period also caps how fast a single zone can repeat.
5. Each hit plays a drum synthesised live with the Web Audio API (kick, snare,
   toms and cymbals are built from oscillators + filtered noise) — nothing to
   download.

## Files

```
index.html            the page and styling
app.js                camera, rendering, hit handling, drum synthesis
motion.js             MotionDetector — the movement-detection engine
test/test_motion.js   unit tests for the detector (plain Node)
test/browser_test.js  end-to-end test: serves the app, opens it in headless
                      Chromium with a synthetic webcam, checks hits fire
```

## Tests

```bash
node test/test_motion.js      # 20 assertions, no browser needed
node test/browser_test.js     # needs Chromium + puppeteer-core
```

`test/browser_test.js` expects a Chromium binary; override with
`CHROME_PATH=/path/to/chrome node test/browser_test.js`.
