/*
 * End-to-end browser test for Air Drums.
 *
 * Serves the app over http://localhost, opens it in headless Chromium with a
 * synthetic webcam, then checks the whole hand-tracking pipeline:
 *   1. scripts load and the app initialises
 *   2. the pure gesture logic works inside the browser
 *   3. MediaPipe loads and the app reports hand-tracking mode
 *   4. a REAL hand photo is detected -> 21 landmarks -> classified as an open hand
 *   5. feeding those real landmarks into the app as open -> fist fires a drum
 *
 * Run:  node test/browser_test.js
 */
'use strict';

var http = require('http');
var fs = require('fs');
var path = require('path');
var puppeteer = require('puppeteer-core');

var ROOT = path.resolve(__dirname, '..');
var PORT = 8137;
var CHROME = process.env.CHROME_PATH || '/usr/local/bin/chromium';

var MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.jpg': 'image/jpeg', '.png': 'image/png' };

function serve() {
  return new Promise(function (resolve) {
    var server = http.createServer(function (req, res) {
      var file = req.url === '/' ? '/index.html' : req.url.split('?')[0];
      var full = path.join(ROOT, decodeURIComponent(file));
      if (full.indexOf(ROOT) !== 0) { res.writeHead(403); return res.end(); }
      fs.readFile(full, function (err, data) {
        if (err) { res.writeHead(404); return res.end('not found'); }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
        res.end(data);
      });
    });
    server.listen(PORT, '127.0.0.1', function () { resolve(server); });
  });
}

var pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ok  - ' + msg); }
  else { fail++; console.log('  FAIL- ' + msg); }
}
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

async function waitFor(fn, timeoutMs) {
  var end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(250);
  }
  return false;
}

(async function () {
  var server = await serve();
  var browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      '--enable-unsafe-swiftshader',
      '--window-size=1000,900'
    ]
  });

  var page = await browser.newPage();
  var pageErrors = [];
  var consoleErrors = [];
  page.on('pageerror', function (e) { pageErrors.push(String(e)); });
  page.on('console', function (m) {
    if (m.type() !== 'error') return;
    var t = m.text();
    // MediaPipe's wasm runtime logs INFO lines via console.error; ignore them.
    if (/^INFO:|XNNPACK|TensorFlow Lite|Created TensorFlow/i.test(t)) return;
    consoleErrors.push(t);
  });

  try { await browser.defaultBrowserContext().overridePermissions('http://localhost:' + PORT, ['camera']); } catch (e) {}

  console.log('browser smoke test');
  await page.goto('http://localhost:' + PORT + '/index.html', { waitUntil: 'load' });

  // --- A. scripts load -------------------------------------------------
  ok(await page.evaluate(function () { return typeof window.Hands; }) === 'object', 'hands.js loads and exposes Hands');
  ok(await page.evaluate(function () { return typeof window.MotionDetector; }) === 'function', 'motion.js loads (offline fallback)');
  ok(await page.evaluate(function () { return !!window.__airDrums; }) === true, 'app.js initialises');
  ok(await page.evaluate(function () { return !!document.getElementById('display'); }) === true, 'display canvas is present');

  // --- B. gesture logic works in the browser ---------------------------
  var logic = await page.evaluate(function () {
    function fist() {
      var lm = new Array(21);
      for (var i = 0; i < 21; i++) lm[i] = { x: 0.5, y: 0.9 };
      lm[0] = { x: 0.5, y: 0.92 };
      var mcps = [5, 9, 13, 17], pips = [6, 10, 14, 18], tips = [8, 12, 16, 20];
      for (var k = 0; k < 4; k++) {
        lm[mcps[k]] = { x: 0.42 + k * 0.06, y: 0.66 };
        lm[pips[k]] = { x: 0.42 + k * 0.06, y: 0.54 };
        lm[tips[k]] = { x: 0.44 + k * 0.06, y: 0.62 }; // curled back
      }
      return lm;
    }
    var open = fist(); open[8] = { x: 0.42, y: 0.38 }; open[12] = { x: 0.48, y: 0.32 };
    open[16] = { x: 0.54, y: 0.37 }; open[20] = { x: 0.60, y: 0.46 };
    return { openExt: window.Hands.extendedCount(open), fistExt: window.Hands.extendedCount(fist()) };
  });
  ok(logic.openExt === 4, 'open hand -> 4 extended in-browser');
  ok(logic.fistExt === 0, 'fist -> 0 extended in-browser');

  // --- C. start camera + hand tracking ---------------------------------
  await page.evaluate(function () { document.getElementById('startBtn').click(); });
  var becameHand = await waitFor(async function () {
    return await page.evaluate(function () { return window.__airDrums.mode() === 'hand'; });
  }, 45000);
  var modeNow = await page.evaluate(function () { return window.__airDrums.mode(); });
  ok(becameHand, 'MediaPipe loads and app enters hand-tracking mode (mode: "' + modeNow + '")');
  ok(pageErrors.length === 0, 'no page errors during startup');

  if (!becameHand) {
    console.log('  (hand model unavailable — skipping live-hand checks)');
  } else {
    // --- D. detect a REAL hand photo ----------------------------------
    var det = await page.evaluate(async function () {
      var BUNDLE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs';
      var WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
      var MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
      var mod = await import(BUNDLE);
      var fileset = await mod.FilesetResolver.forVisionTasks(WASM);
      var lm = await mod.HandLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL, delegate: 'CPU' },
        numHands: 1, runningMode: 'IMAGE'
      });
      var img = new Image();
      img.src = '/test/fixtures/hand.jpg';
      await img.decode();
      var res = lm.detect(img);
      if (!res.landmarks.length) return { hands: 0 };
      return { hands: res.landmarks.length, count: res.landmarks[0].length, ext: window.Hands.extendedCount(res.landmarks[0]) };
    });
    ok(det.hands === 1, 'MediaPipe detects exactly one hand in the photo');
    ok(det.count === 21, 'the hand has 21 landmarks');
    ok(det.ext >= 3, 'real open hand classified as extended (fingers extended: ' + det.ext + ')');

    // --- E. real landmarks drive a strike end-to-end -------------------
    var flow = await page.evaluate(async function () {
      var BUNDLE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs';
      var WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
      var MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
      var mod = await import(BUNDLE);
      var fileset = await mod.FilesetResolver.forVisionTasks(WASM);
      var lm = await mod.HandLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL, delegate: 'CPU' },
        numHands: 1, runningMode: 'IMAGE'
      });
      var img = new Image(); img.src = '/test/fixtures/hand.jpg'; await img.decode();
      var real = lm.detect(img).landmarks[0];

      function total() { return Array.prototype.reduce.call(window.__airDrums.counts, function (a, b) { return a + b; }, 0); }

      var t = performance.now();
      window.__airDrums.handleResults({ landmarks: [real], handedness: [[{ categoryName: 'Test' }]] }, t);
      var before = total();

      // Simulate the same hand closing into a fist.
      var fist = real.map(function (p) { return { x: p.x, y: p.y, z: p.z || 0 }; });
      var wrist = real[0];
      [[6, 8], [10, 12], [14, 16], [18, 20]].forEach(function (pair) {
        var pip = real[pair[0]];
        fist[pair[1]] = { x: pip.x + (wrist.x - pip.x) * 0.6, y: pip.y + (wrist.y - pip.y) * 0.6, z: 0 };
      });
      var fistExt = window.Hands.extendedCount(fist);

      window.__airDrums.handleResults({ landmarks: [fist], handedness: [[{ categoryName: 'Test' }]] }, t + 150);
      var after = total();
      return { before: before, after: after, fistExt: fistExt };
    });
    ok(flow.fistExt <= 1, 'the simulated fist reads as closed (extended: ' + flow.fistExt + ')');
    ok(flow.after > flow.before, 'open -> fist on real landmarks fires a drum (hits ' + flow.before + ' -> ' + flow.after + ')');
  }

  // --- F. clean console ------------------------------------------------
  ok(consoleErrors.length === 0, 'no console errors' + (consoleErrors.length ? ': ' + consoleErrors.join(' | ') : ''));
  if (pageErrors.length) console.log('  page errors: ' + pageErrors.join(' | '));

  await browser.close();
  server.close();

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(function (e) {
  console.error('test crashed:', e);
  process.exit(1);
});
