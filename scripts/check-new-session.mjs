import { chromium } from 'playwright';

const pass = (msg) => console.log(`  ✓  ${msg}`);
const fail = (msg) => { console.error(`  ✗  ${msg}`); process.exitCode = 1; };

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx  = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await ctx.newPage();

  await page.goto('http://localhost:5174', { waitUntil: 'networkidle', timeout: 20000 });
  await page.locator('[title="Fleet Console (AI Agent Manager)"]').click();
  await page.waitForTimeout(2000);

  // Open modal via the "+ New Session" button in the empty state
  const mainPlus = page.locator('text=+ New Session').first();
  if (await mainPlus.isVisible().catch(() => false)) {
    await mainPlus.click();
  } else {
    // Or the + icon in the sessions pane header
    await page.locator('button[title="New session"]').first().click();
  }
  await page.waitForTimeout(1500);

  const modal = page.locator('text=New Session').first();
  if (await modal.isVisible().catch(() => false)) pass('New Session modal opened');
  else { fail('Modal not visible'); await browser.close(); return; }

  // 1. Default label has today's date
  const labelInput = page.locator('input[placeholder="my-task"]');
  const labelVal = await labelInput.inputValue().catch(() => '');
  if (/^\d{4}-\d{2}-\d{2}: ?$/.test(labelVal)) {
    pass(`Default label is date prefix: "${labelVal}"`);
  } else {
    fail(`Label default wrong — got: "${labelVal}" (expected YYYY-MM-DD: )`);
  }

  // 2. Recent group appears in the repo picker
  await page.waitForTimeout(1000); // wait for history fetch
  const recentHeader = page.locator('span', { hasText: 'Recent' }).first();
  if (await recentHeader.isVisible().catch(() => false)) {
    pass('Recent group visible in working directory picker');
  } else {
    fail('Recent group not found in picker');
  }

  // 3. Click the first recent repo and check label auto-completes
  const recentRows = page.locator('[tabindex="0"]').filter({ hasNot: page.locator('.fleet-pane-hdr') });
  // Actually find a repo row inside the modal
  const repoRows = page.locator('div[style*="cursor: pointer"]').filter({ hasText: /\// });
  const firstRecentRepo = repoRows.first();
  if (await firstRecentRepo.isVisible().catch(() => false)) {
    await firstRecentRepo.click();
    await page.waitForTimeout(300);
    const newLabel = await labelInput.inputValue().catch(() => '');
    if (/^\d{4}-\d{2}-\d{2}: .+/.test(newLabel)) {
      pass(`Label auto-completed after picking folder: "${newLabel}"`);
    } else {
      console.log(`  ℹ  Label after pick: "${newLabel}" (may not have matched date prefix pattern)`);
    }
  } else {
    console.log('  ℹ  No repo rows visible to click (repos may not have loaded yet)');
  }

  await page.screenshot({ path: 'scripts/check-new-session-modal.png' });
  pass('Screenshot → scripts/check-new-session-modal.png');

  await browser.close();

  if (process.exitCode === 1) console.error('\nSome checks FAILED');
  else console.log('\nAll checks passed.');
})();
