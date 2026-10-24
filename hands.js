/*
 * Hands — hand-gesture logic for Air Drums.
 *
 * Pure, dependency-free helpers that turn MediaPipe's 21 hand landmarks into
 * decisions: which finger is extended, where the palm is, which drum pad the
 * hand is over, and whether the hand just struck (fist close or downward flick).
 *
 * Keeping this logic separate from MediaPipe means it can be unit-tested in
 * plain Node with synthetic landmarks — no camera, no model, no browser.
 *
 * Works in the browser (window.Hands) and in Node (module.exports).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Hands = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Landmark indices (MediaPipe hand model).
  var MCP = [5, 9, 13, 17];   // base knuckles: index, middle, ring, pinky
  var PIP = [6, 10, 14, 18];  // middle joints
  var TIP = [8, 12, 16, 20];  // fingertips
  var PALM = [0, 5, 9, 13, 17];

  var HAND_CONNECTIONS = [
    [0, 1], [1, 2], [2, 3], [3, 4],
    [0, 5], [5, 6], [6, 7], [7, 8],
    [5, 9], [9, 10], [10, 11], [11, 12],
    [9, 13], [13, 14], [14, 15], [15, 16],
    [13, 17], [17, 18], [18, 19], [19, 20],
    [0, 17]
  ];

  /*
   * Is one finger straight? Compares the direction of the base->middle segment
   * with the middle->tip segment. When the finger is straight the two point the
   * same way (cosine near 1); when it curls they fold back on each other
   * (cosine near -1). This is scale- and rotation-invariant, so it works at any
   * distance from the camera.
   */
  function fingerExtended(lm, mcp, pip, tip) {
    var a = lm[mcp], b = lm[pip], c = lm[tip];
    var v1x = b.x - a.x, v1y = b.y - a.y;
    var v2x = c.x - b.x, v2y = c.y - b.y;
    var n1 = Math.sqrt(v1x * v1x + v1y * v1y);
    var n2 = Math.sqrt(v2x * v2x + v2y * v2y);
    if (n1 === 0 || n2 === 0) return false;
    return ((v1x * v2x + v1y * v2y) / (n1 * n2)) > 0.55;
  }

  // How many of the four fingers are extended (0 = fist, 4 = open hand).
  function extendedCount(lm) {
    var n = 0;
    for (var i = 0; i < 4; i++) {
      if (fingerExtended(lm, MCP[i], PIP[i], TIP[i])) n++;
    }
    return n;
  }

  // Average of the wrist and the four base knuckles — a stable hand centre.
  function palmCenter(lm) {
    var x = 0, y = 0, z = 0;
    for (var i = 0; i < PALM.length; i++) {
      var p = lm[PALM[i]];
      x += p.x; y += p.y; z += (p.z || 0);
    }
    return { x: x / PALM.length, y: y / PALM.length, z: z / PALM.length };
  }

  /*
   * Which grid pad a normalised point (0..1, video space) falls over.
   * The on-screen preview is mirrored, so x is flipped here to match what the
   * player sees.
   */
  function padFromPoint(x, y, cols, rows) {
    var xm = 1 - x;
    var c = Math.floor(xm * cols);
    var r = Math.floor(y * rows);
    if (c < 0) c = 0; else if (c >= cols) c = cols - 1;
    if (r < 0) r = 0; else if (r >= rows) r = rows - 1;
    return r * cols + c;
  }

  /*
   * Turns a stream of per-frame hand readings into discrete "strike" events.
   * A strike is either:
   *   - 'fist' : the hand closes from open (>=3 fingers) to a fist (<=1), or
   *   - 'down' : the palm moves downward faster than `downThreshold`
   *              (normalised y per millisecond).
   * A cooldown stops one strike from firing twice.
   */
  function StrikeDetector(opts) {
    opts = opts || {};
    this.cooldownMs = opts.cooldownMs != null ? opts.cooldownMs : 130;
    this.downThreshold = opts.downThreshold != null ? opts.downThreshold : 0.0016;
    this.reset();
  }

  StrikeDetector.prototype.reset = function () {
    this.lastStrike = -1e12;
    this.prevY = null;
    this.prevT = 0;
    this.prevExt = null;
  };

  // palmY: normalised y (0 top .. 1 bottom). extended: finger count. nowMs: clock.
  // Returns 'fist' | 'down' | null.
  StrikeDetector.prototype.update = function (palmY, extended, nowMs) {
    var reason = null;

    if (this.prevExt != null && this.prevExt >= 3 && extended <= 1) {
      reason = 'fist';
    }

    if (this.prevY != null) {
      var dt = nowMs - this.prevT;
      if (dt > 0) {
        var vy = (palmY - this.prevY) / dt; // +y is downward
        if (vy > this.downThreshold && !reason) reason = 'down';
      }
    }

    this.prevY = palmY;
    this.prevT = nowMs;
    this.prevExt = extended;

    if (reason && (nowMs - this.lastStrike) > this.cooldownMs) {
      this.lastStrike = nowMs;
      return reason;
    }
    return null;
  };

  return {
    fingerExtended: fingerExtended,
    extendedCount: extendedCount,
    palmCenter: palmCenter,
    padFromPoint: padFromPoint,
    StrikeDetector: StrikeDetector,
    HAND_CONNECTIONS: HAND_CONNECTIONS
  };
}));
