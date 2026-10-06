// Drives the running Command Center dashboard with headless Chromium (Playwright).
// Usage: node .claude/skills/run-command-center/driver.mjs [outDir]   (server must be up on :8877)
// Prints one JSON object of checks; exits 1 if any check fails. Screenshots land in outDir.
import { createRequire } from 'node:module';
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
// playwright is not a project dependency; it lives in the container's global tool dir.
const { chromium } = require(process.env.PLAYWRIGHT_PATH || '/opt/node-tools/node_modules/playwright');

const BASE = process.env.CC_URL || 'http://127.0.0.1:8877/';
const out = process.argv[2] || '/tmp/cc-shots';
mkdirSync(out, { recursive: true });
const exe = process.env.CHROMIUM_PATH || ['/opt/pw-browsers/chromium', ...[
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome']].find(existsSync);

const checks = {};
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
const errors = [];
page.on('console', m => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', e => errors.push(String(e)));

await page.goto(BASE);
await page.waitForSelector('#card-google .card-body');
await page.waitForFunction(() => !document.querySelector('#card-google .card-body').textContent.includes('Loading'), null, { timeout: 15000 }).catch(() => {});
checks.title = await page.title();
checks.gmailCard = (await page.locator('#card-google .card-body').innerText()).trim();
checks.outlookCard = (await page.locator('#card-microsoft .card-body').innerText()).trim();
await page.screenshot({ path: join(out, '1-light.png'), fullPage: true });

for (let i = 0; i < 3; i++) await page.click('#audit-inc');
checks.auditAfter3 = await page.locator('#audit-count').innerText();
await page.fill('#directives', 'smoke test note');
await page.click('#theme-toggle');
checks.theme = await page.evaluate(() => document.documentElement.dataset.theme);
await page.screenshot({ path: join(out, '2-dark-after-clicks.png'), fullPage: true });

await page.reload();
await page.waitForSelector('#audit-count');
checks.auditPersisted = await page.locator('#audit-count').innerText();
checks.directivePersisted = await page.inputValue('#directives');
await page.click('#audit-reset');
checks.auditAfterReset = await page.locator('#audit-count').innerText();
await page.fill('#directives', '');
await page.click('#theme-toggle'); // back to light so reruns start clean

checks.consoleErrors = errors;
await browser.close();

const ok = checks.title === 'Command center' && checks.auditAfter3 === '3' && checks.theme === 'dark'
  && checks.auditPersisted === '3' && checks.directivePersisted === 'smoke test note'
  && checks.auditAfterReset === '0' && errors.length === 0;
console.log(JSON.stringify({ ok, ...checks, screenshots: out }, null, 2));
process.exit(ok ? 0 : 1);
