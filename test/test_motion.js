/*
 * Unit tests for motion.js — runs in plain Node, no browser needed.
 * Run:  node test/test_motion.js
 */
'use strict';

var MotionDetector = require('../motion.js');

var W = 90, H = 60; // 3x2 grid -> each zone is 30x30 px
var pass = 0, fail = 0;

function ok(cond, msg) {
  if (cond) { pass++; console.log('  ok  - ' + msg); }
  else { fail++; console.log('  FAIL- ' + msg); }
}

function quiet(v) {
  var f = new Float32Array(W * H);
  f.fill(v == null ? 50 : v);
  return f;
}

// A frame identical to "quiet" except the bottom-left zone is bright.
function handInBottomLeft(base) {
  var f = quiet(base);
  for (var y = 30; y < 60; y++) {
    for (var x = 0; x < 30; x++) f[y * W + x] = 200;
  }
  return f;
}

console.log('motion.js tests');

// --- 1. First frame never fires, a still scene never fires -------------
(function () {
  var d = new MotionDetector({ cols: 3, rows: 2, threshold: 14 });
  var a = quiet(50);
  ok(d.process(a, W, H, 0).length === 0, 'first frame is a no-op (seeds the baseline)');
  ok(d.process(a, W, H, 16).length === 0, 'unchanged frame produces no hit');
  ok(d.process(a, W, H, 32).length === 0, 'still scene stays silent');
})();

// --- 2. A hand entering a zone fires exactly that zone -----------------
(function () {
  var d = new MotionDetector({ cols: 3, rows: 2, threshold: 14 });
  var a = quiet(50), b = handInBottomLeft(50);
  d.process(a, W, H, 0);             // seed
  d.process(a, W, H, 16);            // still
  var hits = d.process(b, W, H, 32); // hand appears bottom-left
  ok(hits.length === 1, 'one sharp movement -> exactly one hit');
  ok(hits[0] && hits[0].cell === 3, 'hit lands in the bottom-left zone (cell 3)');
  ok(hits[0] && hits[0].row === 1 && hits[0].col === 0, 'reported row/col are correct');
})();

// --- 3. Small / slow changes are ignored (no false triggers) -----------
(function () {
  var d = new MotionDetector({ cols: 3, rows: 2, threshold: 14 });
  var a = quiet(50), small = quiet(56); // only +6 brightness, below threshold
  d.process(a, W, H, 0);
  d.process(a, W, H, 16);
  ok(d.process(small, W, H, 32).length === 0, 'a tiny change does not trigger');
})();

// --- 4. A quick strike (hand in AND out fast) fires only once ----------
(function () {
  var d = new MotionDetector({ cols: 3, rows: 2, threshold: 14, rearmMs: 100 });
  var a = quiet(50), b = handInBottomLeft(50);
  d.process(a, W, H, 0);
  d.process(a, W, H, 16);
  var in1 = d.process(b, W, H, 32);   // strike in
  var out1 = d.process(a, W, H, 60);  // pulled back 28ms later (inside re-arm window)
  ok(in1.length === 1, 'the strike fires on the way in');
  ok(out1.length === 0, 'pulling the hand back does NOT double-trigger');
})();

// --- 5. Holding a pose does not machine-gun ----------------------------
(function () {
  var d = new MotionDetector({ cols: 3, rows: 2, threshold: 14 });
  var a = quiet(50), b = handInBottomLeft(50);
  d.process(a, W, H, 0);
  d.process(a, W, H, 16);
  var first = d.process(b, W, H, 32);
  ok(first.length === 1, 'first strike fires');
  ok(d.process(b, W, H, 48).length === 0, 'holding the same pose does not re-fire');
})();

// --- 6. Two clearly separated strikes fire twice ----------------------
(function () {
  var d = new MotionDetector({ cols: 3, rows: 2, threshold: 14, rearmMs: 100 });
  var a = quiet(50), b = handInBottomLeft(50);
  d.process(a, W, H, 0);
  d.process(a, W, H, 16);
  var h1 = d.process(b, W, H, 1000);   // strike 1
  d.process(b, W, H, 1010);            // settle (identical frame)
  d.process(b, W, H, 1130);            // still quiet > rearmMs -> re-armed
  var h2 = d.process(a, W, H, 1160);   // strike 2 (hand moves again)
  ok(h1.length === 1 && h2.length === 1, 'two separated strikes fire two hits');
})();

// --- 7. Refractory period blocks too-fast repeat hits -----------------
(function () {
  var d = new MotionDetector({ cols: 3, rows: 2, threshold: 14, refractoryMs: 90, rearmMs: 0 });
  var a = quiet(50), b = handInBottomLeft(50);
  d.process(a, W, H, 0);
  d.process(a, W, H, 10);
  var h1 = d.process(b, W, H, 1000);   // hit, lastHit = 1000
  d.process(b, W, H, 1005);            // settle -> re-arm (rearmMs = 0)
  var h2 = d.process(a, W, H, 1015);   // only 15ms later -> blocked
  d.process(a, W, H, 1020);            // settle -> re-arm
  var h3 = d.process(b, W, H, 1100);   // 100ms later -> allowed
  ok(h1.length === 1, 'first hit fires');
  ok(h2.length === 0, 'a hit inside the refractory window is blocked');
  ok(h3.length === 1, 'a hit after the refractory window is allowed');
})();

// --- 8. Threshold is adjustable at runtime ----------------------------
(function () {
  var d = new MotionDetector({ cols: 3, rows: 2, threshold: 300 });
  var a = quiet(50), b = handInBottomLeft(50);
  d.process(a, W, H, 0);
  d.process(a, W, H, 16);
  ok(d.process(b, W, H, 32).length === 0, 'a very high threshold suppresses hits');
  d.process(b, W, H, 48);              // settle
  d.setThreshold(14);
  ok(d.process(a, W, H, 80).length === 1, 'lowering the threshold re-enables hits');
})();

// --- 9. Grayscale conversion ------------------------------------------
(function () {
  var rgba = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255]);
  var g = MotionDetector.rgbaToGray(rgba, 3, 1, null);
  ok(Math.abs(g[0] - 76.245) < 0.01, 'red -> luma 76.2');
  ok(Math.abs(g[1] - 149.685) < 0.01, 'green -> luma 149.7');
  ok(Math.abs(g[2] - 29.07) < 0.01, 'blue -> luma 29.1');
})();

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
