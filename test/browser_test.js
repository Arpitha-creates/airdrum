/*
 * End-to-end browser smoke test for Air Drums.
 * Serves the app over http://localhost, opens it in headless Chromium with a
 * synthetic webcam, and checks that the camera pipeline actually fires hits.
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

var MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

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
      '--window-size=1000,900'
    ]
  });

  var page = await browser.newPage();
  var pageErrors = [];
  var consoleErrors = [];
  page.on('pageerror', function (e) { pageErrors.push(String(e)); });
  page.on('console', function (m) { if (m.type() === 'error') consoleErrors.push(m.text()); });

  // Auto-grant camera permission.
  var context = browser.defaultBrowserContext();
  try { await context.overridePermissions('http://localhost:' + PORT, ['camera']); } catch (e) {}

  console.log('browser smoke test');
  await page.goto('http://localhost:' + PORT + '/index.html', { waitUntil: 'load' });

  // --- A. scripts load -------------------------------------------------
  ok(await page.evaluate(function () { return typeof window.MotionDetector; }) === 'function',
    'motion.js loads and exposes MotionDetector');
  ok(await page.evaluate(function () { return !!window.__airDrums; }) === true,
    'app.js initialises');
  ok(await page.evaluate(function () { return !!document.getElementById('display'); }) === true,
    'display canvas is present');

  // --- B. the detector runs inside the browser too ---------------------
  var detHit = await page.evaluate(function () {
    var W = 90, H = 60;
    function frame(bright) { var f = new Float32Array(W * H); f.fill(50); if (bright) { for (var y = 30; y < 60; y++) for (var x = 0; x < 30; x++) f[y * W + x] = 200; } return f; }
    var d = new MotionDetector({ cols: 3, rows: 2, threshold: 14 });
    var a = frame(false), b = frame(true);
    d.process(a, W, H, 0);
    d.process(a, W, H, 16);
    var hits = d.process(b, W, H, 32);
    return hits.length === 1 && hits[0].cell === 3;
  });
  ok(detHit === true, 'detector fires the correct zone in-browser');

  // --- C. keyboard triggers the audio engine without errors ------------
  await page.evaluate(function () { document.getElementById('startBtn').click(); });
  await new Promise(function (r) { setTimeout(r, 1200); });
  await page.keyboard.press('4');
  await new Promise(function (r) { setTimeout(r, 200); });
  ok(pageErrors.length === 0, 'no page errors after starting audio + key press');

  // --- D. camera comes up ---------------------------------------------
  var status = await page.$eval('#status', function (el) { return el.textContent; });
  ok(/camera live/i.test(status), 'camera starts and reports live (status: "' + status + '")');
  ok(await page.evaluate(function () { return document.getElementById('cam').readyState; }) >= 2,
    'video element is actually streaming frames');

  // --- E. the camera motion actually produces hits ---------------------
  var before = await page.evaluate(function () {
    return Array.prototype.reduce.call(window.__airDrums.counts, function (a, b) { return a + b; }, 0);
  });
  await new Promise(function (r) { setTimeout(r, 2500); });
  var after = await page.evaluate(function () {
    return Array.prototype.reduce.call(window.__airDrums.counts, function (a, b) { return a + b; }, 0);
  });
  ok(after > before, 'moving image in front of the camera fires hits (total went ' + before + ' -> ' + after + ')');

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
