import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { chromium } from 'playwright';

// Read-only lab observation. No workspace or model requests are needed here.
const target = new URL(process.argv[2] ?? 'http://127.0.0.1:8788/');
if (!['127.0.0.1', 'localhost', 'ieojim-staging.masondev1024.workers.dev'].includes(target.hostname) || target.pathname !== '/') {
  throw new Error('Use the local build or the established staging landing URL.');
}

const browser = await chromium.launch();
const observations = [];
try {
  for (let run = 1; run <= 3; run += 1) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, reducedMotion: 'no-preference' });
    const page = await context.newPage();
    const client = await context.newCDPSession(page);
    await client.send('Network.enable');
    await client.send('Network.setCacheDisabled', { cacheDisabled: true });
    await client.send('Network.emulateNetworkConditions', {
      offline: false, latency: 150, downloadThroughput: 200_000, uploadThroughput: 93_750,
    });
    await client.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    const apiRequests: string[] = [];
    const errors: string[] = [];
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.startsWith('/api/')) apiRequests.push(new URL(request.url()).pathname);
    });
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    await page.addInitScript(() => {
      const measurements = { lcpMs: 0, cls: 0, longTaskCount: 0, longTaskTotalMs: 0, longestTaskMs: 0 };
      Object.assign(window, { __frontendLab: measurements });
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) measurements.lcpMs = entry.startTime;
      }).observe({ type: 'largest-contentful-paint', buffered: true });
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const shift = entry as PerformanceEntry & { hadRecentInput: boolean; value: number };
          if (!shift.hadRecentInput) measurements.cls += shift.value;
        }
      }).observe({ type: 'layout-shift', buffered: true });
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          measurements.longTaskCount += 1;
          measurements.longTaskTotalMs += entry.duration;
          measurements.longestTaskMs = Math.max(measurements.longestTaskMs, entry.duration);
        }
      }).observe({ type: 'longtask', buffered: true });
    });
    await page.goto(target.href, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: '계획은 바뀌어도, 내 결정은 그대로.' }).waitFor();
    // Fixed quiet observation window; this is not field p75 / INP evidence.
    await page.waitForTimeout(1_000);
    const metrics = await page.evaluate(() => ({
      ...(window as unknown as { __frontendLab: { lcpMs: number; cls: number; longTaskCount: number; longTaskTotalMs: number; longestTaskMs: number } }).__frontendLab,
      fcpMs: performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null,
      resources: (performance.getEntriesByType('resource') as PerformanceResourceTiming[]).map((entry) => ({
        path: new URL(entry.name).pathname, transferBytes: entry.transferSize, encodedBytes: entry.encodedBodySize,
      })),
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      canvasCount: document.querySelectorAll('canvas').length,
    }));
    observations.push({ run, ...metrics, apiRequests, errors });
    await context.close();
  }
} finally {
  await browser.close();
}

const assets = [];
for (const name of (await readdir('dist/assets')).sort()) {
  const bytes = await readFile(`dist/assets/${name}`);
  assets.push({ file: `dist/assets/${name}`, rawBytes: bytes.length, gzipBytes: gzipSync(bytes).length });
}
const font = await readFile('public/fonts/SUIT-Variable.woff2');
const artifact = {
  recordedAt: new Date().toISOString(), target: target.href, browser: 'Playwright Chromium',
  profile: { viewport: '390×844', cache: 'disabled; fresh context per run', cpuSlowdown: 4, latencyMs: 150, downloadBytesPerSecond: 200_000, runs: 3 },
  limits: 'Local or staging lab observations on this host. Not real-device, geographic, field p75, INP, or a claim about all users. CLS records no-input shifts in this bounded load window.',
  assets, font: { file: 'SUIT-Variable.woff2', woff2Bytes: font.length, display: 'optional' }, observations,
};
await mkdir('artifacts', { recursive: true });
await writeFile('artifacts/premium-frontend-performance.json', `${JSON.stringify(artifact, null, 2)}\n`);
console.log(JSON.stringify({ artifact: 'artifacts/premium-frontend-performance.json', runs: observations.map(({ run, lcpMs, cls, canvasCount, apiRequests, errors }) => ({ run, lcpMs, cls, canvasCount, apiRequests, errors })) }, null, 2));
if (observations.some((run) => run.apiRequests.length > 0 || run.errors.length > 0 || run.horizontalOverflow || run.canvasCount > 0)) process.exitCode = 1;
