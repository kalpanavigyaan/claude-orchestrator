import { chromium } from 'playwright';

const br = await chromium.launch();
const pg = await br.newPage();
await pg.setViewportSize({ width: 1400, height: 900 });
await pg.goto('http://localhost:5174');
await pg.waitForSelector('#root', { timeout: 5000 });

const fleetBtn = pg.locator('[title="Fleet Console (AI Agent Manager)"]');
await fleetBtn.click();
await pg.waitForTimeout(800);

const chute = pg.locator('text=2026-06-21: Chute').first();
if (await chute.count() > 0) await chute.click();
await pg.waitForTimeout(800);

// Scroll to bottom of left panel so controls are visible
const controls = pg.locator('.fleet-section-title').filter({ hasText: 'Configuration' });
if (await controls.count() > 0) await controls.scrollIntoViewIfNeeded();
await pg.waitForTimeout(300);

// Screenshot just the left sidebar
const sidebar = pg.locator('.fleet-left-panel, [class*="left-panel"], [class*="sidebar"]').first();
const box = sidebar.count() > 0 ? await sidebar.boundingBox() : null;

// Scroll the controls section into view and screenshot full left panel
const compactBtn = pg.locator('button:has-text("Compact now")').first();
if (await compactBtn.count() > 0) await compactBtn.scrollIntoViewIfNeeded();
await pg.waitForTimeout(200);

await pg.screenshot({ path: 'scripts/controls-pane.png', clip: { x: 0, y: 0, width: 280, height: 900 } });

await br.close();
console.log('done');
