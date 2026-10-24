/*
 * Unit tests for hands.js — plain Node, no browser or model needed.
 * Run:  node test/test_hands.js
 */
'use strict';

var Hands = require('../hands.js');

var pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ok  - ' + msg); }
  else { fail++; console.log('  FAIL- ' + msg); }
}

// Build a synthetic 21-point hand. y grows downward, as in image space.
function makeHand(kind) {
  var lm = new Array(21);
  lm[0] = { x: 0.50, y: 0.92 };                       // wrist
  lm[1] = { x: 0.42, y: 0.88 };                       // thumb
  lm[2] = { x: 0.36, y: 0.82 };
  lm[3] = { x: 0.31, y: 0.78 };
  lm[4] = { x: 0.27, y: 0.74 };

  if (kind === 'open') {
    lm[5] = { x: 0.44, y: 0.66 }; lm[6] = { x: 0.43, y: 0.54 }; lm[7] = { x: 0.43, y: 0.46 }; lm[8] = { x: 0.43, y: 0.38 };
    lm[9] = { x: 0.50, y: 0.64 }; lm[10] = { x: 0.50, y: 0.50 }; lm[11] = { x: 0.50, y: 0.41 }; lm[12] = { x: 0.50, y: 0.32 };
    lm[13] = { x: 0.56, y: 0.66 }; lm[14] = { x: 0.57, y: 0.53 }; lm[15] = { x: 0.57, y: 0.45 }; lm[16] = { x: 0.57, y: 0.37 };
    lm[17] = { x: 0.62, y: 0.70 }; lm[18] = { x: 0.64, y: 0.60 }; lm[19] = { x: 0.65, y: 0.53 }; lm[20] = { x: 0.66, y: 0.46 };
  } else { // fist: fingertips fold back toward the palm
    lm[5] = { x: 0.44, y: 0.66 }; lm[6] = { x: 0.43, y: 0.54 }; lm[7] = { x: 0.45, y: 0.60 }; lm[8] = { x: 0.47, y: 0.66 };
    lm[9] = { x: 0.50, y: 0.64 }; lm[10] = { x: 0.50, y: 0.50 }; lm[11] = { x: 0.50, y: 0.57 }; lm[12] = { x: 0.50, y: 0.63 };
    lm[13] = { x: 0.56, y: 0.66 }; lm[14] = { x: 0.57, y: 0.53 }; lm[15] = { x: 0.57, y: 0.60 }; lm[16] = { x: 0.56, y: 0.66 };
    lm[17] = { x: 0.62, y: 0.70 }; lm[18] = { x: 0.64, y: 0.60 }; lm[19] = { x: 0.64, y: 0.66 }; lm[20] = { x: 0.63, y: 0.71 };
  }
  return lm;
}

console.log('hands.js tests');

// --- finger counting --------------------------------------------------
(function () {
  ok(Hands.extendedCount(makeHand('open')) === 4, 'open hand -> 4 fingers extended');
  ok(Hands.extendedCount(makeHand('fist')) === 0, 'closed fist -> 0 fingers extended');
})();

// --- palm centre ------------------------------------------------------
(function () {
  var c = Hands.palmCenter(makeHand('open'));
  ok(Math.abs(c.x - 0.524) < 0.001, 'palm x is the average of wrist + knuckles');
  ok(Math.abs(c.y - 0.716) < 0.001, 'palm y is the average of wrist + knuckles');
})();

// --- pad from point (with mirroring) ---------------------------------
(function () {
  ok(Hands.padFromPoint(0.5, 0.5, 3, 2) === 4, 'centre-ish point -> middle-bottom pad (4)');
  // x = 0.1 in video space is on the RIGHT after mirroring -> last column
  ok(Hands.padFromPoint(0.1, 0.2, 3, 2) === 2, 'x=0.1 mirrors to the right column (2)');
  ok(Hands.padFromPoint(0.9, 0.2, 3, 2) === 0, 'x=0.9 mirrors to the left column (0)');
  ok(Hands.padFromPoint(0.5, 0.9, 3, 2) === 4, 'low y -> bottom row');
  ok(Hands.padFromPoint(-1, -1, 3, 2) === 2, 'out-of-range point clamps into the grid (mirrored)');
  ok(Hands.padFromPoint(2, 2, 3, 2) === 3, 'out-of-range point clamps into the grid');
})();

// --- strike: fist close ----------------------------------------------
(function () {
  var d = new Hands.StrikeDetector();
  ok(d.update(0.70, 4, 1000) === null, 'first reading never strikes (nothing to compare)');
  ok(d.update(0.70, 0, 1016) === 'fist', 'open -> fist fires a fist strike');
  ok(d.update(0.70, 0, 1030) === null, 'staying in a fist does not re-fire');
})();

// --- strike: downward flick ------------------------------------------
(function () {
  var d = new Hands.StrikeDetector();
  d.update(0.50, 4, 1000);
  ok(d.update(0.60, 4, 1016) === 'down', 'fast downward move fires a down strike');
})();

// --- no false strikes -------------------------------------------------
(function () {
  var up = new Hands.StrikeDetector();
  up.update(0.60, 4, 1000);
  ok(up.update(0.50, 4, 1016) === null, 'moving the hand UP does not strike');

  var slow = new Hands.StrikeDetector();
  slow.update(0.50, 4, 1000);
  ok(slow.update(0.51, 4, 1016) === null, 'a slow drift does not strike');

  var still = new Hands.StrikeDetector();
  still.update(0.50, 4, 1000);
  ok(still.update(0.50, 4, 1016) === null, 'a motionless hand does not strike');
})();

// --- cooldown blocks double-fire -------------------------------------
(function () {
  var d = new Hands.StrikeDetector({ cooldownMs: 130 });
  d.update(0.70, 4, 1000);
  ok(d.update(0.70, 0, 1010) === 'fist', 'first fist strike fires');
  d.update(0.70, 4, 1020);           // reopen
  ok(d.update(0.70, 0, 1030) === null, 'a second strike inside the cooldown is blocked');
  d.update(0.70, 4, 1160);           // reopen
  ok(d.update(0.70, 0, 1180) === 'fist', 'a strike after the cooldown fires again');
})();

// --- threshold is tunable (used by the sensitivity slider) ------------
(function () {
  var d = new Hands.StrikeDetector({ downThreshold: 0.01 });
  d.update(0.50, 4, 1000);
  ok(d.update(0.60, 4, 1016) === null, 'a high threshold ignores a moderate flick');
  d.downThreshold = 0.001;
  d.update(0.60, 4, 2000);
  ok(d.update(0.70, 4, 2016) === 'down', 'lowering the threshold lets a flick through');
})();

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
