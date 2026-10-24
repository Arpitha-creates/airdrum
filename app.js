/* Air Drums — application logic.
 * Camera preview + motion detection + Web Audio drum synthesis.
 * No frameworks, no build step, no ML. Loaded as a plain script.
 */
(function () {
  'use strict';

  var DISPLAY_W = 800, DISPLAY_H = 600;
  var DET_W = 200, DET_H = 150;
  var COLS = 3, ROWS = 2;

  // Six drums laid out on a 3x2 grid (index = row*3 + col).
  var PADS = [
    { key: 'hihat', label: 'HI-HAT',    key2: '1' },
    { key: 'crash', label: 'CRASH',     key2: '2' },
    { key: 'ride',  label: 'RIDE',      key2: '3' },
    { key: 'snare', label: 'SNARE',     key2: '4' },
    { key: 'kick',  label: 'KICK',      key2: '5' },
    { key: 'tom',   label: 'FLOOR TOM', key2: '6' }
  ];

  var display = document.getElementById('display');
  var dctx = display.getContext('2d');
  var video = document.getElementById('cam');
  var statusEl = document.getElementById('status');
  var startBtn = document.getElementById('startBtn');
  var sensEl = document.getElementById('sens');
  var volEl = document.getElementById('vol');
  var calibBtn = document.getElementById('calibBtn');

  // Offscreen canvas used only for the small, fast detection frames.
  var detCanvas = document.createElement('canvas');
  detCanvas.width = DET_W; detCanvas.height = DET_H;
  var sctx = detCanvas.getContext('2d', { willReadFrequently: true });

  var detector = null;
  var gray = null;
  var running = false;
  var flash = new Float64Array(PADS.length);
  var counts = new Int32Array(PADS.length);
  var mouseMode = false;

  // ---------------------------------------------------------------- audio
  var actx = null, master = null, noiseBuf = null;

  function makeNoiseBuffer(ctx) {
    var len = Math.floor(ctx.sampleRate * 2);
    var buf = ctx.createBuffer(1, len, ctx.sampleRate);
    var d = buf.getChannelData(0);
    for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }
  function noiseSource() {
    var s = actx.createBufferSource();
    s.buffer = noiseBuf;
    return s;
  }

  function initAudio() {
    if (actx) return;
    var Ctx = window.AudioContext || window.webkitAudioContext;
    actx = new Ctx();
    master = actx.createGain();
    master.gain.value = volEl.value / 100 * 0.9;
    var comp = actx.createDynamicsCompressor();
    comp.threshold.value = -12;
    comp.ratio.value = 6;
    master.connect(comp);
    comp.connect(actx.destination);
    noiseBuf = makeNoiseBuffer(actx);
  }

  function kick(t, v) {
    var o = actx.createOscillator(), g = actx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(170, t);
    o.frequency.exponentialRampToValueAtTime(45, t + 0.11);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(1.0 * v, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
    o.connect(g); g.connect(master);
    o.start(t); o.stop(t + 0.5);
  }

  function snare(t, v) {
    var n = noiseSource(), hp = actx.createBiquadFilter(), g = actx.createGain();
    hp.type = 'highpass'; hp.frequency.value = 1400;
    g.gain.setValueAtTime(0.9 * v, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    n.connect(hp); hp.connect(g); g.connect(master);
    n.start(t); n.stop(t + 0.25);

    var o = actx.createOscillator(), g2 = actx.createGain();
    o.type = 'triangle';
    o.frequency.setValueAtTime(190, t);
    o.frequency.exponentialRampToValueAtTime(120, t + 0.1);
    g2.gain.setValueAtTime(0.5 * v, t);
    g2.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    o.connect(g2); g2.connect(master);
    o.start(t); o.stop(t + 0.15);
  }

  function hihat(t, v, open) {
    var n = noiseSource(), hp = actx.createBiquadFilter(), g = actx.createGain();
    hp.type = 'highpass'; hp.frequency.value = 7000;
    var dur = open ? 0.35 : 0.06;
    g.gain.setValueAtTime(0.55 * v, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    n.connect(hp); hp.connect(g); g.connect(master);
    n.start(t); n.stop(t + dur + 0.05);
  }

  function tom(t, v, freq) {
    var o = actx.createOscillator(), g = actx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(freq, t);
    o.frequency.exponentialRampToValueAtTime(freq * 0.5, t + 0.25);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.9 * v, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
    o.connect(g); g.connect(master);
    o.start(t); o.stop(t + 0.45);
  }

  function crash(t, v) {
    var n = noiseSource(), hp = actx.createBiquadFilter(), g = actx.createGain();
    hp.type = 'highpass'; hp.frequency.value = 5000;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.5 * v, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.3);
    n.connect(hp); hp.connect(g); g.connect(master);
    n.start(t); n.stop(t + 1.4);
  }

  function ride(t, v) {
    var n = noiseSource(), bp = actx.createBiquadFilter(), g = actx.createGain();
    bp.type = 'bandpass'; bp.frequency.value = 4500; bp.Q.value = 0.7;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.45 * v, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.0);
    n.connect(bp); bp.connect(g); g.connect(master);
    n.start(t); n.stop(t + 1.1);
  }

  function playPad(index, velocity) {
    if (!actx) return;
    var t = actx.currentTime + 0.001;
    var v = Math.max(0.35, Math.min(1, velocity));
    switch (PADS[index].key) {
      case 'hihat': hihat(t, v, false); break;
      case 'crash': crash(t, v); break;
      case 'ride':  ride(t, v); break;
      case 'snare': snare(t, v); break;
      case 'kick':  kick(t, v); break;
      case 'tom':   tom(t, v, 150); break;
    }
  }

  // --------------------------------------------------------------- helpers
  function currentThreshold() {
    // Slider 0..100 -> threshold 40..4 (higher slider = more sensitive).
    return 40 - (sensEl.value / 100) * 36;
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function padRect(cell) {
    var cw = DISPLAY_W / COLS, ch = DISPLAY_H / ROWS;
    var r = Math.floor(cell / COLS), c = cell % COLS;
    var m = 14;
    return { x: c * cw + m, y: r * ch + m, w: cw - 2 * m, h: ch - 2 * m };
  }

  function cellAt(x, y) {
    if (x < 0 || y < 0 || x >= DISPLAY_W || y >= DISPLAY_H) return -1;
    var c = Math.floor(x / (DISPLAY_W / COLS));
    var r = Math.floor(y / (DISPLAY_H / ROWS));
    return r * COLS + c;
  }

  function hitPad(cell, velocity) {
    if (cell < 0 || cell >= PADS.length) return;
    flash[cell] = performance.now() + 160;
    counts[cell]++;
    playPad(cell, velocity);
  }

  // ---------------------------------------------------------------- render
  function drawPads(now) {
    dctx.save();
    dctx.textAlign = 'center';
    dctx.textBaseline = 'middle';
    for (var i = 0; i < PADS.length; i++) {
      var p = padRect(i);
      var active = flash[i] > now;
      var t = active ? Math.max(0, (flash[i] - now) / 160) : 0;

      dctx.save();
      dctx.fillStyle = active
        ? 'rgba(0,255,213,' + (0.22 + 0.35 * t) + ')'
        : 'rgba(10,16,28,0.42)';
      roundRect(dctx, p.x, p.y, p.w, p.h, 18);
      dctx.fill();

      dctx.lineWidth = active ? 5 : 2;
      dctx.strokeStyle = active ? '#00ffd5' : 'rgba(120,180,220,0.45)';
      if (active) {
        dctx.shadowColor = '#00ffd5';
        dctx.shadowBlur = 24 * t;
      }
      roundRect(dctx, p.x, p.y, p.w, p.h, 18);
      dctx.stroke();
      dctx.restore();

      // label
      dctx.font = '700 26px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
      dctx.fillStyle = active ? '#001014' : 'rgba(225,242,255,0.92)';
      dctx.fillText(PADS[i].label, p.x + p.w / 2, p.y + p.h / 2);

      // key hint + count
      dctx.font = '600 14px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
      dctx.fillStyle = active ? 'rgba(0,32,26,0.9)' : 'rgba(150,190,220,0.75)';
      dctx.fillText('key ' + PADS[i].key2, p.x + p.w / 2, p.y + p.h - 22);

      if (counts[i] > 0) {
        dctx.textAlign = 'right';
        dctx.font = '700 14px system-ui, sans-serif';
        dctx.fillStyle = active ? 'rgba(0,32,26,0.9)' : 'rgba(150,190,220,0.7)';
        dctx.fillText('x' + counts[i], p.x + p.w - 14, p.y + 22);
        dctx.textAlign = 'center';
      }
    }
    dctx.restore();
  }

  function loop() {
    requestAnimationFrame(loop);
    var now = performance.now();

    if (running && video.readyState >= 2) {
      // Mirror the camera so it behaves like a mirror.
      dctx.save();
      dctx.translate(DISPLAY_W, 0); dctx.scale(-1, 1);
      dctx.drawImage(video, 0, 0, DISPLAY_W, DISPLAY_H);
      dctx.restore();

      sctx.save();
      sctx.translate(DET_W, 0); sctx.scale(-1, 1);
      sctx.drawImage(video, 0, 0, DET_W, DET_H);
      sctx.restore();

      var img = sctx.getImageData(0, 0, DET_W, DET_H);
      gray = MotionDetector.rgbaToGray(img.data, DET_W, DET_H, gray);
      var hits = detector.process(gray, DET_W, DET_H, now);
      for (var h = 0; h < hits.length; h++) {
        var vel = 0.45 + Math.min(1, hits[h].strength / 60) * 0.55;
        hitPad(hits[h].cell, vel);
      }
    } else {
      dctx.fillStyle = '#05060a';
      dctx.fillRect(0, 0, DISPLAY_W, DISPLAY_H);
    }

    drawPads(now);
  }

  // ----------------------------------------------------------------- start
  function startCamera() {
    initAudio();
    if (actx.state === 'suspended') actx.resume();

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      mouseMode = true;
      statusEl.textContent = 'This browser has no camera API. Use keys 1-6 or click the pads.';
      return;
    }

    navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
      audio: false
    }).then(function (stream) {
      video.srcObject = stream;
      return video.play();
    }).then(function () {
      detector = new MotionDetector({ cols: COLS, rows: ROWS, threshold: currentThreshold() });
      running = true;
      mouseMode = false;
      startBtn.textContent = 'Camera on';
      startBtn.disabled = true;
      statusEl.textContent = 'Camera live — wave your hand over a drum to play it.';
    }).catch(function (err) {
      mouseMode = true;
      statusEl.textContent = 'Camera not available (' + (err && err.name ? err.name : 'error') +
        '). You can still press keys 1-6 or click a pad.';
    });
  }

  // --------------------------------------------------------------- wiring
  startBtn.addEventListener('click', startCamera);

  sensEl.addEventListener('input', function () {
    if (detector) detector.setThreshold(currentThreshold());
  });

  volEl.addEventListener('input', function () {
    if (master) master.gain.value = volEl.value / 100 * 0.9;
  });

  calibBtn.addEventListener('click', function () {
    if (detector) detector.reset();
    statusEl.textContent = 'Recalibrated — keep your hands still for a moment.';
  });

  display.addEventListener('click', function (e) {
    var rect = display.getBoundingClientRect();
    var x = (e.clientX - rect.left) / rect.width * DISPLAY_W;
    var y = (e.clientY - rect.top) / rect.height * DISPLAY_H;
    hitPad(cellAt(x, y), 0.9);
  });

  window.addEventListener('keydown', function (e) {
    var n = parseInt(e.key, 10);
    if (n >= 1 && n <= PADS.length) {
      hitPad(n - 1, 0.9);
    }
  });

  // Small read-only hook (handy for automated tests; safe to ignore).
  window.__airDrums = {
    isRunning: function () { return running; },
    counts: counts,
    hit: hitPad
  };

  loop();
})();
