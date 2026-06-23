/**
 * Playwright smoke test — open Fleet Console, click Instruction Queue, capture errors.
 * Run: node scripts/check-queue-crash.mjs
 * Requires: fleet console running on port 4318
 */
import { chromium } from 'playwright';

const URL = 'http://localhost:5199';

const errors   = [];
const warnings = [];

const browser = await chromium.launch({ headless: true });
const ctx     = await browser.newContext();
const page    = await ctx.newPage();

page.on('pageerror', err => errors.push(`PAGE ERROR: ${err.message}\n${err.stack}`));
page.on('console',   async msg => {
  if (msg.type() === 'error') {
    // Resolve all %s args so we see the real message
    const args = await Promise.all(msg.args().map(a => a.jsonValue().catch(() => '?'))).catch(() => []);
    let text = msg.text();
    for (const arg of args) text = text.replace('%s', String(arg));
    errors.push(`CONSOLE ERROR: ${text}`);
  }
  if (msg.type() === 'warning') warnings.push(`WARN: ${msg.text()}`);
});
page.on('requestfailed', req => errors.push(`REQUEST FAILED: ${req.url()} — ${req.failure()?.errorText}`));

console.log(`Navigating to ${URL} …`);
const resp = await page.goto(URL, { waitUntil: 'networkidle', timeout: 15_000 }).catch(e => { console.error('Nav failed:', e.message); process.exit(1); });
console.log(`Page loaded — status ${resp.status()}`);

// Give React time to hydrate
await page.waitForTimeout(1500);

// Screenshot before click
await page.screenshot({ path: 'scripts/queue-before.png' });
console.log('Screenshot saved: scripts/queue-before.png');

// Capture ALL unhandled rejections too
process.on('unhandledRejection', r => errors.push(`UNHANDLED REJECTION: ${r}`));

// Step 1: click the Fleet Console activity bar button
const fleetBtn = page.locator('button[title="Fleet Console (AI Agent Manager)"]');
if (await fleetBtn.count() > 0) {
  console.log('Clicking Fleet Console activity bar button…');
  await fleetBtn.first().click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'scripts/queue-fleet.png' });
  console.log('Screenshot saved: scripts/queue-fleet.png');
} else {
  console.log('Fleet Console button not found — already in fleet view?');
}

// Step 2: find the Instruction Queue button in the right activity bar
const queueBtn = page.locator('button[title="Instruction Queue"]');
const count = await queueBtn.count();
console.log(`Found ${count} button(s) with title "Instruction Queue"`);

if (count === 0) {
  const titles = await page.locator('button[title]').evaluateAll(els => els.map(el => el.getAttribute('title')));
  console.log('All button titles now visible:', titles);
} else {
  console.log('Clicking Instruction Queue button…');
  await queueBtn.first().click();
  await page.waitForTimeout(2500);
  await page.screenshot({ path: 'scripts/queue-after.png' });
  console.log('Screenshot saved: scripts/queue-after.png');
}

// Step 3: click a real session row to select it
// Look for a session row in the sessions pane
const sessionRows = page.locator('.session-row');
const rowCount = await sessionRows.count();
console.log(`Found ${rowCount} session-row elements`);
// Also try text matching on session labels visible in screenshots
const firstSessionRow = page.locator('text=2026-06-22').first();
if (await firstSessionRow.isVisible().catch(() => false)) {
  console.log('Selecting a session (clicking first 2026-06-22 row)…');
  await firstSessionRow.click();
  await page.waitForTimeout(1000);
  await page.screenshot({ path: 'scripts/queue-session-selected.png' });
  console.log('Screenshot saved: scripts/queue-session-selected.png');
}

// Step 4: also click the History tab within the queue panel (target right panel)
// Use a more specific selector to avoid clicking the HISTORY section in the sidebar
const queueHistoryTab = page.locator('button', { hasText: /^History/ }).last();
if (await queueHistoryTab.count() > 0) {
  console.log('Clicking History tab in queue panel…');
  await queueHistoryTab.click();
  await page.waitForTimeout(2000);
  await page.screenshot({ path: 'scripts/queue-history.png' });
  console.log('Screenshot saved: scripts/queue-history.png');
}

// Step 5: also test the "Instructions" panel (different from queue)
const instrBtn = page.locator('button[title="Instructions"]');
if (await instrBtn.count() > 0) {
  console.log('Clicking Instructions panel button…');
  await instrBtn.first().click();
  await page.waitForTimeout(2000);
  await page.screenshot({ path: 'scripts/queue-instructions.png' });
  console.log('Screenshot saved: scripts/queue-instructions.png');
  const instrErrors = errors.length;
  if (instrErrors > 0) console.log(`Errors after clicking Instructions: ${instrErrors}`);
}

// Check if the panel rendered
const panelHeader = await page.locator('text=Instruction Queue').first().isVisible().catch(() => false);
console.log(`Panel header visible: ${panelHeader}`);

await browser.close();

console.log('\n=== Errors ===');
if (errors.length === 0) console.log('None.');
else errors.forEach(e => console.log(e));

console.log('\n=== Warnings ===');
if (warnings.length === 0) console.log('None.');
else warnings.forEach(w => console.log(w));
