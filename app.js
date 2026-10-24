/* Air Drums — application logic.
 *
 * Camera -> MediaPipe hand tracking -> gesture logic (hands.js) -> Web Audio drums.
 * If the hand-tracking model can't load, it falls back to motion sensing
 * (motion.js) so the kit still plays.
 *
 * Plain classic script (no bundler). Loaded after motion.js and hands.js.
 */
(function () {
  'use strict';

  var W = 960, H = 720;
  var COLS = 3, ROWS = 2;

  var PADS = [
    { key: 'hihat', label: 'HI-HAT',    accent: '#39e6d0', key2: '1' },
    { key: 'crash', label: 'CRASH',     accent: '#ffb24d', key2: '2' },
    { key: 'ride',  label: 'RIDE',      accent: '#b18cff', key2: '3' },
    { key: 'snare', label: 'SNARE',     accent: '#ff5f92', key2: '4' },
    { key: 'kick',  label: 'KICK',      accent: '#5dff9f', key2: '5' },
    { key: 'tom',   label: 'FLOOR TOM', accent: '#4db8ff', key2: '6' }
  ];

  var BUNDLE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs';
  var WASM   = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
  var MODEL  = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

  var display = document.getElementById('display');
  var dctx = display.getContext('2d');
  var video = document.getElementById('cam');
  var pill = document.getElementById('pill');
  var curtain = document.getElementById('curtain');
  var curtainFine = document.getElementById('curtainFine');
  var startBtn = document.getElementById('startBtn');
  var sensEl = document.getElementById('sens');
  var volEl = document.getElementById('vol');
  var calibBtn = document.getElementById('calibBtn');
  var hudHands = document.getElementById('hudHands');
  var hudGesture = document.getElementById('hudGesture');
  var hudHits = document.getElementById('hudHits');
  var hudStreak = document.getElementById('hudStreak');

  // motion-mode scratch buffers
  var detCanvas = document.createElement('canvas');
  detCanvas.width = 200; detCanvas.height = 150;
  var sctx = detCanvas.getContext('2d', { willReadFrequently: true });

  var mode = 'none';           // 'hand' | 'motion' | 'none'
  var running = false;
  var landmarker = null;
  var detector = null;         // MotionDetector (fallback)
  var gray = null;

  var liveHands = [];
  var handState = {};          // handedness -> { det, lastSeen }
  var flash = new Float64Array(PADS.length);
  var counts = new Int32Array(PADS.length);
  var ripples = [];
  var bursts = [];
  var lastHitTime = 0;
  var streak = 0;
  var totalHits = 0;
  var lastDetect = 0;
  var frozen = false;
  var hudCache = {};

  // ---------------------------------------------------------------- audio
  var actx = null, master = null, noiseBuf = null;

  function makeNoiseBuffer(ctx) {
    var len = Math.floor(ctx.sampleRate * 2);
    var buf = ctx.createBuffer(1, len, ctx.sampleRate);
    var d = buf.getChannelData(0);
    for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }
  function noiseSource() { var s = actx.createBufferSource(); s.buffer = noiseBuf; return s; }

  function initAudio() {
    if (actx) return;
    var Ctx = window.AudioContext || window.webkitAudioContext;
    actx = new Ctx();
    master = actx.createGain();
    master.gain.value = volEl.value / 100 * 0.9;
    var comp = actx.createDynamicsCompressor();
    comp.threshold.value = -12; comp.ratio.value = 6;
    master.connect(comp); comp.connect(actx.destination);
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
  function hexToRgba(hex, a) {
    var n = parseInt(hex.slice(1), 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }
  function currentDownThreshold() {
    // Slider 0..100 -> 0.0038 (hard) .. 0.0004 (easy), normalised y per ms.
    return 0.0038 - (sensEl.value / 100) * 0.0034;
  }
  function currentMotionThreshold() {
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
    var cw = W / COLS, ch = H / ROWS;
    var r = Math.floor(cell / COLS), c = cell % COLS;
    var m = 16;
    return { x: c * cw + m, y: r * ch + m, w: cw - 2 * m, h: ch - 2 * m };
  }
  function cellAt(x, y) {
    if (x < 0 || y < 0 || x >= W || y >= H) return -1;
    return Math.floor(y / (H / ROWS)) * COLS + Math.floor(x / (W / COLS));
  }
  function gestureName(ext) {
    if (ext >= 4) return 'OPEN';
    if (ext === 0) return 'FIST';
    return ext + (ext === 1 ? ' FINGER' : ' FINGERS');
  }
  function handDetector() {
    return new Hands.StrikeDetector({ downThreshold: currentDownThreshold() });
  }
  function stateFor(name) {
    if (!handState[name]) handState[name] = { det: handDetector(), lastSeen: 0 };
    return handState[name];
  }

  // ---------------------------------------------------------------- strikes
  function strike(cell, velocity) {
    if (cell < 0 || cell >= PADS.length) return;
    var now = performance.now();
    counts[cell]++;
    totalHits++;
    flash[cell] = now + 220;
    ripples.push({ cell: cell, t0: now });
    streak = (now - lastHitTime < 900) ? streak + 1 : 1;
    lastHitTime = now;
    playPad(cell, velocity);
  }

  function handleResults(res, now) {
    var seen = {};
    var list = [];
    if (res && res.landmarks) {
      for (var i = 0; i < res.landmarks.length; i++) {
        var lm = res.landmarks[i];
        var hd = res.handedness && res.handedness[i] && res.handedness[i][0];
        var name = hd ? hd.categoryName : ('H' + i);
        var palm = Hands.palmCenter(lm);
        var ext = Hands.extendedCount(lm);
        var st = stateFor(name);
        st.lastSeen = now;
        st.det.downThreshold = currentDownThreshold();
        var reason = st.det.update(palm.y, ext, now);
        var pad = Hands.padFromPoint(palm.x, palm.y, COLS, ROWS);
        if (reason) {
          strike(pad, reason === 'down' ? 0.9 : 0.8);
          bursts.push({ x: (1 - palm.x) * W, y: palm.y * H, t0: now });
        }
        list.push({ lm: lm, palm: palm, ext: ext, name: name, pad: pad, reason: reason });
        seen[name] = true;
      }
    }
    for (var k in handState) if (!seen[k]) handState[k].det.reset();
    liveHands = list;
  }

  // --------------------------------------------------------------- rendering
  function drawPads(now) {
    dctx.save();
    dctx.textAlign = 'center';
    dctx.textBaseline = 'middle';
    for (var i = 0; i < PADS.length; i++) {
      var p = padRect(i);
      var accent = PADS[i].accent;
      var cx = p.x + p.w / 2, cy = p.y + p.h / 2;
      var active = flash[i] > now;
      var t = active ? Math.max(0, (flash[i] - now) / 220) : 0;
      var hover = false;
      for (var h = 0; h < liveHands.length; h++) if (liveHands[h].pad === i) hover = true;

      // body
      roundRect(dctx, p.x, p.y, p.w, p.h, 22);
      dctx.fillStyle = 'rgba(6, 11, 20, 0.74)';
      dctx.fill();

      // coloured head
      var g = dctx.createRadialGradient(cx, cy, 6, cx, cy, Math.max(p.w, p.h) * 0.62);
      g.addColorStop(0, hexToRgba(accent, active ? 0.5 : (hover ? 0.24 : 0.11)));
      g.addColorStop(1, hexToRgba(accent, 0.02));
      dctx.fillStyle = g;
      roundRect(dctx, p.x, p.y, p.w, p.h, 22);
      dctx.fill();

      // inner ring
      roundRect(dctx, p.x + 15, p.y + 15, p.w - 30, p.h - 30, 16);
      dctx.lineWidth = 1;
      dctx.strokeStyle = hexToRgba(accent, active ? 0.45 : 0.16);
      dctx.stroke();

      // rim
      dctx.lineWidth = active ? 3 : (hover ? 2.2 : 1.4);
      dctx.strokeStyle = hexToRgba(accent, active ? 1 : (hover ? 0.8 : 0.38));
      if (active || hover) { dctx.shadowColor = accent; dctx.shadowBlur = active ? 30 * t + 6 : 12; }
      roundRect(dctx, p.x, p.y, p.w, p.h, 22);
      dctx.stroke();
      dctx.shadowBlur = 0;

      // label
      dctx.font = '400 ' + Math.round(Math.min(52, p.h * 0.34)) + 'px "Bebas Neue", "Space Grotesk", sans-serif';
      dctx.fillStyle = active ? '#ffffff' : 'rgba(234,244,255,0.9)';
      dctx.fillText(PADS[i].label, cx, cy - 6);

      // key hint
      dctx.font = '600 12px "Space Grotesk", system-ui, sans-serif';
      dctx.fillStyle = active ? hexToRgba(accent, 0.95) : 'rgba(127,151,179,0.85)';
      dctx.fillText('KEY ' + PADS[i].key2, cx, p.y + p.h - 24);

      // hit count
      if (counts[i] > 0) {
        dctx.textAlign = 'right';
        dctx.font = '700 13px "Space Grotesk", system-ui, sans-serif';
        dctx.fillStyle = active ? hexToRgba(accent, 0.95) : 'rgba(127,151,179,0.7)';
        dctx.fillText('x' + counts[i], p.x + p.w - 20, p.y + 24);
        dctx.textAlign = 'center';
      }
    }
    dctx.restore();
  }

  function drawRipples(now) {
    for (var i = ripples.length - 1; i >= 0; i--) {
      var rp = ripples[i];
      var t = (now - rp.t0) / 460;
      if (t >= 1) { ripples.splice(i, 1); continue; }
      var p = padRect(rp.cell);
      var accent = PADS[rp.cell].accent;
      var grow = 18 * t;
      dctx.save();
      dctx.globalAlpha = (1 - t) * 0.7;
      dctx.lineWidth = 3 * (1 - t) + 0.5;
      dctx.strokeStyle = accent;
      roundRect(dctx, p.x - grow, p.y - grow, p.w + grow * 2, p.h + grow * 2, 22 + grow);
      dctx.stroke();
      dctx.restore();
    }
  }

  function drawBursts(now) {
    for (var i = bursts.length - 1; i >= 0; i--) {
      var b = bursts[i];
      var t = (now - b.t0) / 380;
      if (t >= 1) { bursts.splice(i, 1); continue; }
      dctx.save();
      dctx.globalAlpha = (1 - t) * 0.9;
      dctx.strokeStyle = '#ffffff';
      dctx.lineWidth = 3 * (1 - t) + 0.5;
      dctx.beginPath();
      dctx.arc(b.x, b.y, 8 + 46 * t, 0, Math.PI * 2);
      dctx.stroke();
      dctx.restore();
    }
  }

  function drawHands() {
    var conn = Hands.HAND_CONNECTIONS;
    for (var i = 0; i < liveHands.length; i++) {
      var hand = liveHands[i];
      var lm = hand.lm;
      var accent = PADS[hand.pad] ? PADS[hand.pad].accent : '#39e6d0';

      // bones
      dctx.save();
      dctx.lineCap = 'round';
      dctx.lineWidth = 3;
      dctx.strokeStyle = hexToRgba(accent, 0.85);
      dctx.shadowColor = accent;
      dctx.shadowBlur = 10;
      for (var c = 0; c < conn.length; c++) {
        var a = lm[conn[c][0]], b = lm[conn[c][1]];
        dctx.beginPath();
        dctx.moveTo((1 - a.x) * W, a.y * H);
        dctx.lineTo((1 - b.x) * W, b.y * H);
        dctx.stroke();
      }
      dctx.restore();

      // joints
      dctx.save();
      dctx.fillStyle = 'rgba(234,244,255,0.95)';
      for (var j = 0; j < lm.length; j++) {
        dctx.beginPath();
        dctx.arc((1 - lm[j].x) * W, lm[j].y * H, 3.2, 0, Math.PI * 2);
        dctx.fill();
      }
      dctx.restore();

      // palm marker
      var px = (1 - hand.palm.x) * W, py = hand.palm.y * H;
      dctx.save();
      dctx.strokeStyle = accent;
      dctx.lineWidth = 2;
      dctx.shadowColor = accent;
      dctx.shadowBlur = 16;
      dctx.beginPath();
      dctx.arc(px, py, 13, 0, Math.PI * 2);
      dctx.stroke();
      dctx.restore();

      // gesture tag
      dctx.save();
      dctx.font = '700 13px "Space Grotesk", system-ui, sans-serif';
      dctx.textAlign = 'left';
      dctx.textBaseline = 'middle';
      var tag = gestureName(hand.ext);
      var tw = dctx.measureText(tag).width;
      dctx.fillStyle = 'rgba(4,8,16,0.8)';
      roundRect(dctx, px + 20, py - 12, tw + 18, 24, 12);
      dctx.fill();
      dctx.fillStyle = accent;
      dctx.fillText(tag, px + 29, py + 1);
      dctx.restore();
    }
  }

  function setHud(el, key, value, hot) {
    if (hudCache[key] === value) return;
    hudCache[key] = value;
    el.textContent = value;
    if (hot !== undefined) el.classList.toggle('hot', !!hot);
  }

  function updateHud() {
    setHud(hudHands, 'hands', String(liveHands.length), liveHands.length > 0);
    setHud(hudHits, 'hits', String(totalHits));
    setHud(hudStreak, 'streak', String(streak), streak >= 4);
    var g = '—';
    if (liveHands.length) {
      g = gestureName(liveHands[0].ext);
      if (liveHands.length > 1) g += ' +1';
    }
    setHud(hudGesture, 'gesture', g, liveHands.length > 0);
  }

  function drawScene(now) {
    dctx.fillStyle = '#04060c';
    dctx.fillRect(0, 0, W, H);

    if (running && video.readyState >= 2) {
      dctx.save();
      dctx.globalAlpha = 0.42;
      dctx.translate(W, 0); dctx.scale(-1, 1);
      dctx.drawImage(video, 0, 0, W, H);
      dctx.restore();
    }

    var vg = dctx.createRadialGradient(W / 2, H * 0.4, H * 0.12, W / 2, H * 0.5, H * 0.92);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(2,4,9,0.86)');
    dctx.fillStyle = vg;
    dctx.fillRect(0, 0, W, H);

    drawPads(now);
    drawRipples(now);
    if (mode === 'hand') drawHands();
    drawBursts(now);
  }

  // ------------------------------------------------------------------ loop
  function loop() {
    requestAnimationFrame(loop);
    var now = performance.now();

    if (running && video.readyState >= 2) {
      if (mode === 'hand' && landmarker && !frozen && (now - lastDetect) > 33) {
        lastDetect = now;
        try {
          handleResults(landmarker.detectForVideo(video, now), now);
        } catch (e) { /* transient: skip this frame */ }
      } else if (mode === 'motion' && detector && (now - lastDetect) > 33) {
        lastDetect = now;
        sctx.save();
        sctx.translate(detCanvas.width, 0); sctx.scale(-1, 1);
        sctx.drawImage(video, 0, 0, detCanvas.width, detCanvas.height);
        sctx.restore();
        var img = sctx.getImageData(0, 0, detCanvas.width, detCanvas.height);
        gray = MotionDetector.rgbaToGray(img.data, detCanvas.width, detCanvas.height, gray);
        var hits = detector.process(gray, detCanvas.width, detCanvas.height, now);
        for (var i = 0; i < hits.length; i++) {
          strike(hits[i].cell, 0.45 + Math.min(1, hits[i].strength / 60) * 0.55);
        }
      }
    } else {
      liveHands = [];
    }

    drawScene(now);
    updateHud();
  }

  // ----------------------------------------------------------------- start
  function createLandmarker() {
    return import(/* webpackIgnore: true */ BUNDLE).then(function (mod) {
      return mod.FilesetResolver.forVisionTasks(WASM).then(function (fileset) {
        var opts = {
          baseOptions: { modelAssetPath: MODEL, delegate: 'GPU' },
          numHands: 2,
          runningMode: 'VIDEO',
          minHandDetectionConfidence: 0.5,
          minHandPresenceConfidence: 0.5,
          minTrackingConfidence: 0.5
        };
        return mod.HandLandmarker.createFromOptions(fileset, opts).catch(function () {
          opts.baseOptions.delegate = 'CPU';
          return mod.HandLandmarker.createFromOptions(fileset, opts);
        });
      });
    });
  }

  function getCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return Promise.reject(new Error('no-camera-api'));
    }
    return navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
      audio: false
    }).then(function (stream) {
      video.srcObject = stream;
      return video.play();
    });
  }

  function finish(statusText, isLive) {
    running = true;
    pill.textContent = statusText;
    pill.classList.toggle('live', !!isLive);
    curtain.classList.add('hidden');
  }

  function start() {
    initAudio();
    if (actx.state === 'suspended') actx.resume();
    startBtn.disabled = true;
    curtainFine.innerHTML = '<span class="spinner"></span>Starting camera…';

    getCamera().then(function () {
      curtainFine.innerHTML = '<span class="spinner"></span>Loading hand tracking…';
      return createLandmarker();
    }).then(function (lm) {
      landmarker = lm;
      mode = 'hand';
      finish('Hand tracking live — hold a hand over a drum and strike', true);
    }).catch(function (err) {
      // Hand model unavailable: fall back to motion sensing.
      return getCamera().then(function () {
        detector = new MotionDetector({ cols: COLS, rows: ROWS, threshold: currentMotionThreshold() });
        mode = 'motion';
        finish('Hand model unavailable — using motion sensing. Wave over a drum.', true);
      }).catch(function () {
        mode = 'none';
        running = false;
        curtain.classList.add('hidden');
        pill.textContent = 'Camera unavailable — press 1–6 or click a pad to play';
        pill.classList.remove('live');
        if (err && err.name === 'NotAllowedError') {
          pill.textContent = 'Camera permission denied — press 1–6 or click a pad';
        }
      });
    });
  }

  // ----------------------------------------------------------------- wiring
  startBtn.addEventListener('click', start);

  sensEl.addEventListener('input', function () {
    if (detector) detector.setThreshold(currentMotionThreshold());
  });
  volEl.addEventListener('input', function () {
    if (master) master.gain.value = volEl.value / 100 * 0.9;
  });
  calibBtn.addEventListener('click', function () {
    if (detector) detector.reset();
    for (var k in handState) handState[k].det.reset();
    pill.textContent = 'Recalibrated — hold your hands still for a moment';
  });

  display.addEventListener('click', function (e) {
    var rect = display.getBoundingClientRect();
    strike(cellAt((e.clientX - rect.left) / rect.width * W, (e.clientY - rect.top) / rect.height * H), 0.9);
  });
  window.addEventListener('keydown', function (e) {
    var n = parseInt(e.key, 10);
    if (n >= 1 && n <= PADS.length) strike(n - 1, 0.9);
  });

  // Read-only hook (used by the automated browser test).
  window.__airDrums = {
    isRunning: function () { return running; },
    mode: function () { return mode; },
    counts: counts,
    strike: strike,
    setHands: function (list) { liveHands = list; frozen = true; },
    resume: function () { frozen = false; },
    handleResults: handleResults,
    Hands: Hands
  };

  loop();
})();
