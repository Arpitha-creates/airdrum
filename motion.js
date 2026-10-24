/*
 * MotionDetector — dependency-free frame-difference motion sensing for air drums.
 *
 * No machine learning, no external libraries. It compares the current camera
 * frame with the previous one, measures how much each screen zone changed, and
 * fires a "hit" when a zone sees a sharp spike in movement (i.e. your hand
 * striking that drum). A per-zone noise floor is learned on the fly, so a still
 * hand, a moving background or small camera noise does not trigger anything.
 *
 * A strike re-arms only after its zone has been still for `rearmMs`, so the
 * motion of pulling your hand back off a drum does not double-trigger it.
 *
 * Works in the browser (window.MotionDetector) and in Node (module.exports)
 * so the exact same logic can be unit-tested outside the browser.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MotionDetector = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function MotionDetector(opts) {
    opts = opts || {};
    this.cols = opts.cols || 3;
    this.rows = opts.rows || 2;
    // How much movement above the learned noise floor counts as a hit.
    this.threshold = opts.threshold != null ? opts.threshold : 14;
    // Minimum time between two hits on the same drum (ms).
    this.refractoryMs = opts.refractoryMs != null ? opts.refractoryMs : 90;
    // How long a zone must be still before it can fire again (ms).
    this.rearmMs = opts.rearmMs != null ? opts.rearmMs : 100;
    // How fast the learned noise floor follows the scene (0..1, higher = faster).
    this.decay = opts.decay != null ? opts.decay : 0.9;
    this.reset();
  }

  MotionDetector.prototype.reset = function () {
    var n = this.cols * this.rows;
    this.baseline = new Float32Array(n);   // learned ambient movement per zone
    this.energy = new Float32Array(n);     // raw movement this frame per zone
    this.signal = new Float32Array(n);     // movement above the noise floor
    this.armed = new Uint8Array(n);        // 1 = ready to fire on next spike
    this.lastHit = new Float64Array(n);
    this.quietSince = new Float64Array(n);
    this.armed.fill(1);
    this.lastHit.fill(-1e12);  // never hit yet -> first strike is never blocked
    this.quietSince.fill(-1);  // -1 = not currently quiet
    this.prev = null;
    this.w = 0; this.h = 0;
    this.cellW = 0; this.cellH = 0;
    this._sums = null;
    this._counts = null;
  };

  MotionDetector.prototype.setThreshold = function (t) {
    this.threshold = Math.max(1, t);
  };

  MotionDetector.prototype._layout = function (w, h) {
    this.w = w; this.h = h;
    this.cellW = w / this.cols;
    this.cellH = h / this.rows;
  };

  /*
   * frame : array-like grayscale values (0..255), length w*h
   * nowMs : current timestamp in ms
   * returns: array of hits [{cell,row,col,strength}]
   */
  MotionDetector.prototype.process = function (frame, w, h, nowMs) {
    nowMs = nowMs || 0;

    // First frame (or size change): just remember it, nothing to compare yet.
    if (!this.prev || this.w !== w || this.h !== h) {
      this._layout(w, h);
      this.prev = Float32Array.from(frame);
      this.energy.fill(0);
      this.signal.fill(0);
      return [];
    }

    var cols = this.cols, rows = this.rows;
    var cw = this.cellW, ch = this.cellH;
    var nCells = cols * rows;
    var sums = this._sums;
    var counts = this._counts;
    if (!sums || sums.length !== nCells) {
      sums = this._sums = new Float64Array(nCells);
      counts = this._counts = new Float64Array(nCells);
    }
    sums.fill(0); counts.fill(0);

    var prev = this.prev;
    for (var y = 0; y < h; y++) {
      var cy = (y / ch) | 0; if (cy >= rows) cy = rows - 1;
      var rowBase = y * w;
      var cellRowBase = cy * cols;
      for (var x = 0; x < w; x++) {
        var idx = rowBase + x;
        var d = frame[idx] - prev[idx];
        if (d < 0) d = -d;
        var cx = (x / cw) | 0; if (cx >= cols) cx = cols - 1;
        var c = cellRowBase + cx;
        sums[c] += d;
        counts[c]++;
      }
    }

    var hits = [];
    var k = 1 - this.decay;
    var hi = this.threshold;
    var lo = this.threshold * 0.6;

    for (var c2 = 0; c2 < nCells; c2++) {
      var e = counts[c2] ? sums[c2] / counts[c2] : 0;
      this.energy[c2] = e;
      // Slowly track what "quiet" looks like in this zone.
      this.baseline[c2] += (e - this.baseline[c2]) * k;
      var sig = e - this.baseline[c2];
      if (sig < 0) sig = 0;
      this.signal[c2] = sig;

      if (sig > hi && this.armed[c2] && (nowMs - this.lastHit[c2]) > this.refractoryMs) {
        // A clean strike: fire once, then lock the zone.
        this.lastHit[c2] = nowMs;
        this.armed[c2] = 0;
        this.quietSince[c2] = -1;
        hits.push({
          cell: c2,
          row: (c2 / cols) | 0,
          col: c2 % cols,
          strength: sig
        });
      } else if (sig < lo) {
        // Zone is still: once it has been still long enough, allow a new strike.
        if (this.quietSince[c2] < 0) this.quietSince[c2] = nowMs;
        if ((nowMs - this.quietSince[c2]) >= this.rearmMs) this.armed[c2] = 1;
      } else {
        // Some movement, but not enough to strike: keep the zone locked.
        this.quietSince[c2] = -1;
      }
    }

    for (var i = 0; i < frame.length; i++) this.prev[i] = frame[i];
    return hits;
  };

  MotionDetector.prototype.grid = function () {
    return {
      cols: this.cols,
      rows: this.rows,
      signal: this.signal,
      energy: this.energy,
      baseline: this.baseline
    };
  };

  // Convert an RGBA buffer (from canvas getImageData) to a grayscale frame.
  MotionDetector.rgbaToGray = function (rgba, w, h, out) {
    var n = w * h;
    if (!out || out.length !== n) out = new Float32Array(n);
    for (var i = 0, j = 0; i < n; i++, j += 4) {
      out[i] = 0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2];
    }
    return out;
  };

  return MotionDetector;
}));
