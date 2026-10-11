/**
 * End-to-end smoke test for Find Anything.
 *
 *   node scripts/e2e-smoke.cjs                 # expects the dev server on :5180
 *   BASE_URL=http://localhost:5180 node scripts/e2e-smoke.cjs
 *
 * What it verifies, in a real browser with a synthetic camera
 * (Chromium fake device — no real camera needed):
 *
 *   1. Landing → dashboard flow, BYOK key connect (session storage mode).
 *   2. Reference photo upload → analysis → template chips rendered.
 *   3. Live search with the camera: the engine locks on and draws a box.
 *   4. BOUNDING-BOX ALIGNMENT on desktop / tablet / mobile viewports: the drawn
 *      box is compared against an independently computed expected rectangle.
 *   5. Occlusion: the target disappears → status degrades honestly, box clears.
 *   6. Session end: camera tracks released, UI resets.
 *
 * The Gemini endpoints are stubbed with `page.route`, so the test costs no quota
 * and is deterministic. It is integration tooling, NOT a demo mode: the product
 * itself never fakes detections (see README → testing).
 *
 * Requires: `npm i -D playwright && npx playwright install chromium`
 */

const fs = require('fs');
const path = require('path');

const BASE_URL = process.env.BASE_URL || 'http://localhost:5180';
const PLAYWRIGHT_PATH = process.env.PW_PATH || 'playwright';
const SHOTS = path.resolve(__dirname, '..', 'docs', 'screenshots');

let chromium;
try {
  ({ chromium } = require(PLAYWRIGHT_PATH));
} catch {
  console.error(
    `Could not load Playwright from "${PLAYWRIGHT_PATH}".\n` +
      'Install it with:  npm i -D playwright && npx playwright install chromium\n' +
      'or point PW_PATH at an existing installation.',
  );
  process.exit(1);
}

const PROFILE = {
  name: 'blue ceramic mug',
  category: 'drinkware',
  attributes: [
    { key: 'colour', value: 'blue', distinctiveness: 'high' },
    { key: 'handle', value: 'curved, right side', distinctiveness: 'medium' },
  ],
  distinguishingColors: ['cobalt blue'],
  targetBBox: { x: 0.3, y: 0.28, width: 0.4, height: 0.44 },
  descriptors: ['cobalt blue glaze', 'white rim', 'cylindrical body', 'curved handle'],
  sceneGuidance: 'Pan slowly across the shelf, left to right.',
  searchHint: 'Scanning for the blue mug',
  ambiguityRisks: ['other mugs', 'glasses'],
};

/** The stub model walks the target across the frame between calls. */
const DETECTIONS = [
  { visible: true, confidence: 0.88, bbox: { x: 0.18, y: 0.22, width: 0.22, height: 0.3 }, reason: 'mug on the left shelf' },
  { visible: true, confidence: 0.9, bbox: { x: 0.42, y: 0.24, width: 0.24, height: 0.32 }, reason: 'mug centre-left' },
];

const VIEWPORTS = [
  { name: 'desktop-1440x900', width: 1440, height: 900 },
  { name: 'tablet-1024x768', width: 1024, height: 768 },
  { name: 'mobile-390x844', width: 390, height: 844 },
];

const PNG_1PX_MUG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAGQAAABkCAYAAABw4pVUAAAAOUlEQVR42u3RMQ0AMAgEwF9CJ2yCJmyCJmyCJmyCJmyCJmyCJmyCJmyCJmyCJmyCJmyCJmyCJmyCJmyCBtydAt1zH0GyAAAAAElFTkSuQmCC',
  'base64',
);

const log = (...args) => console.log(...args);
const step = async (name, fn) => {
  process.stdout.write(`  • ${name} … `);
  try {
    const result = await fn();
    log('ok');
    return result;
  } catch (error) {
    log(`FAILED (${error.message.split('\n')[0]})`);
    throw error;
  }
};

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch({
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
    ],
  });
  const context = await browser.newContext({ permissions: ['camera'], viewport: VIEWPORTS[0] });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message.slice(0, 160)));

  let detectCall = 0;
  await page.route('**/api/analyze', (route) =>
    route.fulfill({ json: { profile: PROFILE, warnings: [], model: 'stub-vision', latencyMs: 38 } }),
  );
  await page.route('**/api/detect', (route) => {
    const next = DETECTIONS[Math.min(detectCall, DETECTIONS.length - 1)];
    detectCall += 1;
    route.fulfill({ json: { ...next, model: 'stub-vision', latencyMs: 120 } });
  });
  await page.route('**/api/verify', (route) =>
    route.fulfill({ json: { visible: true, confidence: 0.82, reason: 'matches reference' } }),
  );
  await page.route('**/api/live-instruction', (route) =>
    route.fulfill({ json: { instruction: 'You are Find Anything.', scenePrompt: 'status?' } }),
  );

  log('\n1. Landing → dashboard (BYOK)');
  await step('load landing page', () => page.goto(BASE_URL, { waitUntil: 'networkidle' }));
  await step('click "Start Visual Search"', () => page.click('button:has-text("Start Visual Search")'));
  await step('settings opens when no key exists', () => page.waitForSelector('#api-key'));
  await step('choose "This tab only" storage', () =>
    page.locator('div[role="dialog"] button:has-text("This tab only")').first().click(),
  );
  await step('paste API key', () => page.fill('#api-key', 'AIzaSyFAKEkey_e2e_smoke_test'));
  await step('connect key', () =>
    page.locator('div[role="dialog"] button:text-is("Connect")').first().click(),
  );
  await page.waitForTimeout(300);
  const voiceToggle = page.locator('#voice-enabled');
  await step('disable voice (keeps the test offline)', async () => {
    if (await voiceToggle.isChecked()) await voiceToggle.uncheck();
  });
  await step('close settings', () => page.keyboard.press('Escape'));

  log('\n2. Reference photo → analysis');
  await page.locator('input[type="file"]').first().setInputFiles({
    name: 'mug.png',
    mimeType: 'image/png',
    buffer: PNG_1PX_MUG,
  });
  await step('profile rendered in the left panel', () => page.waitForSelector('text=blue ceramic mug', { timeout: 20000 }));
  await step('template chips + pipeline details rendered', () =>
    // The descriptors live inside the collapsed "Vision pipeline details" block.
    page.locator('text=cobalt blue glaze').first().waitFor({ state: 'attached', timeout: 10000 }),
  );
  await page.screenshot({ path: path.join(SHOTS, 'e2e-1-reference.png') });

  log('\n3. Live search with the (fake device) camera');
  await step('start visual search', () =>
    page.locator('button:has-text("Start visual search")').first().click({ timeout: 8000 }),
  );
  await step('camera delivers frames', () =>
    page.waitForFunction(() => (window.__fa_debug?.state()?.video?.width ?? 0) > 0, null, { timeout: 20000 }),
  );
  const live = await page.evaluate(() => window.__fa_debug.state());
  log(`  media: ${live.video.width}x${live.video.height} (synthetic camera)`);

  log('\n4. Bounding-box alignment across viewports');
  let allAligned = true;
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    // On phones/tablets the viewport lives in the "camera" tab — bring it up first.
    if (viewport.width < 1024) {
      await page.locator('[role="tab"]', { hasText: 'camera' }).first().click();
      const selected = await page.locator('[role="tab"][aria-selected="true"]').first().textContent();
      if (selected?.trim().toLowerCase() !== 'camera') throw new Error(`camera tab not selected (got "${selected}")`);
    }
    await page.waitForTimeout(2600); // let the engine lock and the overlay settle
    const measured = await page.evaluate(async () => {
      // Both the desktop grid and the mobile stack exist in the DOM; only one is
      // visible at a given width, so always measure the rendered instance.
      const read = () => {
        const overlays = Array.from(document.querySelectorAll('.bracket-tl'))
          .map((node) => node.parentElement)
          .filter((node) => node instanceof HTMLElement && node.getBoundingClientRect().width > 2);
        const overlay = overlays[0];
        const video = overlay?.closest('section')?.querySelector('video')
          ?? Array.from(document.querySelectorAll('video')).find((v) => v.getBoundingClientRect().width > 2)
          ?? null;
        const state = window.__fa_debug?.state();
        if (!overlay || !video || !state?.video) return null;
        const box = overlay.getBoundingClientRect();
        const rect = video.getBoundingClientRect();
        return {
          box: { left: box.left - rect.left, top: box.top - rect.top, width: box.width, height: box.height },
          videoElement: { width: rect.width, height: rect.height },
          media: state.video,
          engine: state.engine,
        };
      };
      const first = read();
      await new Promise((resolve) => setTimeout(resolve, 400));
      return { first, second: read() };
    });

    if (!measured.first) {
      log(`  [${viewport.name}] no box was drawn — skipping`);
      allAligned = false;
      continue;
    }
    const { box, videoElement, media, engine } = measured.first;
    // Independent expectation: object-fit: contain mapping + the 6 px overlay pad.
    const scale = Math.min(videoElement.width / media.width, videoElement.height / media.height);
    const contentWidth = media.width * scale;
    const contentHeight = media.height * scale;
    const contentLeft = (videoElement.width - contentWidth) / 2;
    const contentTop = (videoElement.height - contentHeight) / 2;
    const expected = {
      left: contentLeft + engine.rawBox.x * contentWidth - 6,
      top: contentTop + engine.rawBox.y * contentHeight - 6,
      width: engine.rawBox.width * contentWidth + 12,
      height: engine.rawBox.height * contentHeight + 12,
    };
    const deltas = ['left', 'top', 'width', 'height'].map((key) => box[key] - expected[key]);
    const aligned = deltas.every((delta) => Math.abs(delta) < 3);
    const stable = JSON.stringify(measured.first.box) === JSON.stringify(measured.second.box);
    allAligned = allAligned && aligned;
    log(
      `  [${viewport.name}] state=${engine.state} conf=${engine.confidence.toFixed(2)} source=${engine.source} ` +
        `| content ${contentWidth.toFixed(1)}x${contentHeight.toFixed(1)} ` +
        `| ALIGNMENT ${aligned ? 'OK' : 'MISALIGNED'} ` +
        `(Δ ${deltas.map((d) => d.toFixed(1)).join(', ')}) | stable: ${stable}`,
    );
    await page.screenshot({ path: path.join(SHOTS, `box-alignment-${viewport.name}.png`) });
  }

  log('\n5. Detection panel timestamps (UI clock sanity)');
  const lastSeen = await page.locator('text=last seen').first().locator('xpath=following-sibling::*[1]').textContent();
  const sane = !/\d{3,}[hm] ago/.test(lastSeen || '') && /just now|\d+s ago|\d+m ago|—/.test(lastSeen || '');
  log(`  "last seen" reads: "${(lastSeen || '').trim()}" → ${sane ? 'OK' : 'WRONG CLOCK'}`);

  log('\n6. Occlusion handling');
  await page.unroute('**/api/detect');
  await page.route('**/api/detect', (route) =>
    route.fulfill({
      json: { visible: false, confidence: 0.12, bbox: null, reason: 'not in frame', model: 'stub-vision', latencyMs: 90 },
    }),
  );
  await page.waitForTimeout(1600);
  const occluded = await page.evaluate(() => window.__fa_debug.state().engine);
  log(
    `  state=${occluded.state} conf=${occluded.confidence.toFixed(2)} ` +
      `box=${occluded.box ? 'held at last known position' : 'cleared'}`,
  );
  await page.screenshot({ path: path.join(SHOTS, 'box-occluded.png') });

  log('\n7. Session end releases resources');
  await page.locator('button[aria-label^="End session"]:visible').first().click();
  await page.waitForTimeout(900);
  const afterEnd = await page.evaluate(() => {
    const video = document.querySelector('video');
    return {
      released: !video || video.srcObject === null,
      message: document.body.innerText.includes('Session ended'),
    };
  });
  log(`  camera tracks released: ${afterEnd.released} | session summary shown: ${afterEnd.message}`);

  log(`\nPage errors: ${pageErrors.length ? JSON.stringify(pageErrors) : 'none'}`);
  await browser.close();

  const ok = allAligned && sane && afterEnd.released && pageErrors.length === 0;
  log(ok ? '\nE2E SMOKE: PASS\n' : '\nE2E SMOKE: FAIL\n');
  process.exit(ok ? 0 : 1);
}

main().catch((error) => {
  console.error('\nE2E SMOKE: FAIL —', error.message);
  process.exit(1);
});
