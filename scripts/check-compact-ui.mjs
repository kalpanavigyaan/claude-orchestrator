import { chromium } from 'playwright';

const br = await chromium.launch();
const pg = await br.newPage();
pg.on('console', m => m.type() === 'error' && console.error('JS ERR:', m.text()));

await pg.goto('http://localhost:5174');
await pg.waitForSelector('#root', { timeout: 5000 });

const fleetBtn = pg.locator('[title="Fleet Console (AI Agent Manager)"]');
await fleetBtn.click();
await pg.waitForTimeout(800);

// Click the active session — try multiple selectors
const sessSelectors = ['.fleet-session-item', '[class*="session-item"]', '.fleet-scroll .fleet-section li'];
for (const sel of sessSelectors) {
  const el = pg.locator(sel).first();
  if (await el.count() > 0) { await el.click(); break; }
}
// Also try clicking by text content
const chute = pg.locator('text=2026-06-21: Chute').first();
if (await chute.count() > 0) await chute.click();
await pg.waitForTimeout(800);

// Check for auto-compact checkbox
const autoCompactCb = pg.locator('input[type="checkbox"]').filter({ hasText: '' }).nth(3); // 4th checkbox
const labels = await pg.locator('.fleet-section label').allTextContents();
console.log('Labels found:', labels);

// Check auto-compact row text
const autoCompactText = await pg.locator('text=Auto-compact at').count();
console.log(`"Auto-compact at" text found: ${autoCompactText}`);

// Check Compact now button
const compactBtn = await pg.locator('button:has-text("Compact now")').count();
console.log(`"Compact now" button found: ${compactBtn}`);

await pg.screenshot({ path: 'scripts/check-compact-ui.png', fullPage: true });
await br.close();

if (autoCompactText > 0 && compactBtn > 0) {
  console.log('\n✓ Auto-compact controls verified');
} else {
  console.error('\n✗ Auto-compact controls missing');
  process.exit(1);
}
