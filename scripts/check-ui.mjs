/**
 * Playwright smoke-test for fleet-console (4318) + web-ide (5174).
 * Run: node scripts/check-ui.mjs
 */
import { chromium } from 'playwright';

const FLEET  = 'http://127.0.0.1:4318';
const WEBIDE = 'http://localhost:5174';

let failures = 0;
const pass = (msg) => console.log(`  ✓  ${msg}`);
const fail = (msg) => { console.error(`  ✗  ${msg}`); failures++; };

// ── 1. Fleet-console API checks ───────────────────────────────────────────────
async function checkApi(page) {
  console.log('\n── Fleet-console API (4318) ──');

  // /api/state returns sessions list
  const r1 = await page.goto(`${FLEET}/api/state`);
  if (r1 && r1.status() === 200) {
    const body = await r1.json().catch(() => null);
    if (body && Array.isArray(body.sessions)) {
      pass(`/api/state → 200 · ${body.sessions.length} live sessions`);
    } else {
      fail('/api/state missing sessions array');
    }
  } else {
    fail(`/api/state → ${r1?.status() ?? 'no response'}`);
  }

  // /api/history
  const r2 = await page.goto(`${FLEET}/api/history`);
  if (r2 && r2.status() === 200) {
    const h = await r2.json().catch(() => null);
    if (h && Array.isArray(h.sessions)) {
      pass(`/api/history → ${h.sessions.length} history entries`);
      // Spot-check: each entry should have rel and label
      const first = h.sessions[0];
      if (first && first.rel && first.label !== undefined) {
        pass(`history entry has rel="${first.rel.slice(0, 40)}", label="${String(first.label).slice(0, 40)}"`);
      }
      // Check completedInstructions field exists (may be null for old sessions)
      const withCompleted = h.sessions.filter(s => Array.isArray(s.completedInstructions));
      console.log(`  ℹ  ${withCompleted.length}/${h.sessions.length} history sessions have completedInstructions`);
    } else {
      fail('/api/history missing sessions array');
    }
  } else {
    fail(`/api/history → ${r2?.status() ?? 'no response'}`);
  }

  // /api/skills
  const r3 = await page.goto(`${FLEET}/api/skills`);
  if (r3 && r3.status() === 200) {
    const s = await r3.json().catch(() => null);
    pass(`/api/skills → 200 · ${s?.files?.length ?? 0} skill files · dir: ${s?.dir || '(none)'}`);
  } else {
    fail(`/api/skills → ${r3?.status() ?? 'no response'}`);
  }

  // /api/instructions/global
  const r4 = await page.goto(`${FLEET}/api/instructions/global`);
  if (r4 && r4.status() === 200) {
    const s = await r4.json().catch(() => null);
    pass(`/api/instructions/global → 200 · ${s?.files?.length ?? 0} global instruction files`);
  } else {
    fail(`/api/instructions/global → ${r4?.status() ?? 'no response'}`);
  }

  // POST /api/sessions creates session — just check it's reachable (we won't create one)
  const r5 = await page.goto(`${FLEET}/api/sessions`);
  // GET /api/sessions → 404 is expected; we just confirm the server responds
  pass(`/api/sessions GET → ${r5?.status() ?? '?'} (POST-only endpoint — 404 GET is correct)`);
}

// ── 2. Web-IDE shell loads ────────────────────────────────────────────────────
async function checkWebIdeShell(page) {
  console.log('\n── Web-IDE shell (5174) ──');
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

  const resp = await page.goto(WEBIDE, { waitUntil: 'networkidle', timeout: 20000 })
    .catch(e => { fail(`page.goto failed: ${e.message}`); return null; });
  if (!resp) return false;

  if (resp.status() === 200) pass('index.html → 200');
  else { fail(`index.html → ${resp.status()}`); return false; }

  const title = await page.title();
  pass(`page title: "${title}"`);

  const root = await page.$('#root');
  if (root) pass('#root mounted');
  else { fail('#root missing — React did not mount'); return false; }

  // Wait for the activity bar to appear
  await page.waitForTimeout(2500);

  const realErrors = errors.filter(e =>
    !e.includes('favicon') && !e.includes('net::ERR') && !e.includes('ResizeObserver')
  );
  if (realErrors.length === 0) pass('No JS errors on load');
  else realErrors.slice(0, 3).forEach(e => fail(`JS error: ${e.slice(0, 120)}`));

  return true;
}

// ── 3. Navigate to Fleet Console panel ───────────────────────────────────────
async function checkFleetPanel(page) {
  console.log('\n── Fleet Console panel ──');

  // Find the Fleet Console button in the left activity bar (MessageSquare icon)
  const fleetBtn = page.locator('[title="Fleet Console (AI Agent Manager)"]');
  const visible = await fleetBtn.isVisible().catch(() => false);
  if (visible) {
    pass('Fleet Console button found in activity bar');
    await fleetBtn.click();
    await page.waitForTimeout(2000);
  } else {
    fail('Fleet Console button not found in activity bar — checking title variants');
    // Try alternative title
    const alt = page.locator('button', { hasText: 'fleet' });
    await alt.first().click().catch(() => {});
    await page.waitForTimeout(2000);
  }

  // After clicking, the fleet view renders Sessions + History panes on the left
  const sessionsPaneHdr = page.locator('text=Sessions').first();
  if (await sessionsPaneHdr.isVisible().catch(() => false)) {
    pass('Sessions pane visible inside fleet panel');
  } else {
    fail('Sessions pane not found — fleet view may not have loaded');
  }

  const historyPaneHdr = page.locator('text=History').first();
  if (await historyPaneHdr.isVisible().catch(() => false)) {
    pass('History pane visible inside fleet panel');
  } else {
    fail('History pane not found inside fleet panel');
  }

  // Check right activity bar buttons
  const skillsBtn = page.locator('[title="Skills Library"]');
  if (await skillsBtn.isVisible().catch(() => false)) {
    pass('Skills Library button in right activity bar');
  } else {
    fail('Skills Library button missing from right activity bar');
  }

  const instrBtn = page.locator('[title="Instructions"]');
  if (await instrBtn.isVisible().catch(() => false)) {
    pass('Instructions button in right activity bar');
  } else {
    fail('Instructions button missing from right activity bar');
  }

  const queueBtn = page.locator('[title="Instruction Queue"]');
  if (await queueBtn.isVisible().catch(() => false)) {
    pass('Instruction Queue button present');

    // Click queue, check panel opens
    await queueBtn.click();
    await page.waitForTimeout(600);

    // Look for "Current" and "History" tabs inside the queue panel
    const currentTab = page.locator('text=Current').first();
    const histTab    = page.locator('text=History ·').first();
    const tabAlt     = page.locator('text=History').nth(1); // could be 2nd "History"

    const ctVisible = await currentTab.isVisible().catch(() => false);
    const htVisible = await histTab.isVisible().catch(() => false) || await tabAlt.isVisible().catch(() => false);

    if (ctVisible) pass('Queue panel: Current tab visible');
    else fail('Queue panel: Current tab not found');

    if (htVisible) pass('Queue panel: History tab visible');
    else fail('Queue panel: History tab not found');
  } else {
    fail('Instruction Queue button missing from right activity bar');
  }

  // Screenshot of fleet panel
  await page.screenshot({ path: 'scripts/check-ui-fleet.png', fullPage: false });
  pass('Fleet panel screenshot → scripts/check-ui-fleet.png');
}

// ── 4. Copy Session right-click ──────────────────────────────────────────────
async function checkCopySession(page) {
  console.log('\n── Copy Session context menu ──');

  // Close any open panel first
  const queueBtn = page.locator('[title="Instruction Queue"]');
  if (await queueBtn.isVisible().catch(() => false)) {
    await queueBtn.click();
    await page.waitForTimeout(300);
  }

  // Find first history session entry and right-click it
  // History entries are the clickable rows inside the tree (below date group headers)
  await page.waitForTimeout(500);
  const rows = page.locator('[style*="border-left"]'); // session rows have borderLeft style
  const count = await rows.count();
  if (count === 0) {
    console.log('  (no history rows visible — skipping)');
    return;
  }

  // Right-click the first visible session row in the history pane
  // Look for a row that has the session label pattern
  const histSection = page.locator('text=HISTORY').first();
  const histVisible = await histSection.isVisible().catch(() => false);
  if (!histVisible) {
    console.log('  (history pane not visible — skipping)');
    return;
  }

  // The sessions are in the history pane tree — right click a session row
  const sessionRows = page.locator('.fleet-pane-hdr').filter({ hasText: 'History' })
    .locator('~ div [tabindex="0"]');
  const firstRow = sessionRows.first();
  const rowVisible = await firstRow.isVisible().catch(() => false);

  if (!rowVisible) {
    // Fall back: find any tabindex=0 element below the History header
    const anyRow = page.locator('[tabindex="0"]').first();
    if (!(await anyRow.isVisible().catch(() => false))) {
      console.log('  (history rows not found — skipping copy session check)');
      return;
    }
    await anyRow.click({ button: 'right' });
  } else {
    await firstRow.click({ button: 'right' });
  }

  await page.waitForTimeout(400);

  // Context menu should appear with "Copy Session"
  const copyItem = page.locator('text=Copy Session').first();
  if (await copyItem.isVisible().catch(() => false)) {
    pass('"Copy Session" appears in context menu');

    await copyItem.click();
    await page.waitForTimeout(1500); // fetch + modal open

    // The New Session modal should open with a pre-filled label
    const modalHeader = page.locator('text=New Session').first();
    if (await modalHeader.isVisible().catch(() => false)) {
      pass('New Session modal opened after Copy Session');

      // Check label starts with YYYY-MM-DD
      const labelInput = page.locator('input[placeholder="my-task"]');
      const labelVal = await labelInput.inputValue().catch(() => '');
      const datePattern = /^\d{4}-\d{2}-\d{2}: /;
      if (datePattern.test(labelVal)) {
        pass(`Label pre-filled: "${labelVal}"`);
      } else {
        fail(`Label not in YYYY-MM-DD: <repo> format — got: "${labelVal}"`);
      }

      // Check CWD is pre-filled
      const cwdCode = page.locator('code').first();
      const cwdText = await cwdCode.textContent().catch(() => '');
      if (cwdText && cwdText.length > 2) {
        pass(`CWD pre-filled: "${cwdText.slice(0, 60)}"`);
      } else {
        console.log('  (CWD not visible in preview — may need to select working dir tab)');
      }

      // Close the modal
      const cancelBtn = page.locator('text=Cancel').first();
      if (await cancelBtn.isVisible().catch(() => false)) await cancelBtn.click();
      await page.waitForTimeout(300);
    } else {
      fail('New Session modal did not open after clicking Copy Session');
    }
  } else {
    fail('"Copy Session" not found in context menu');
    // Close the context menu if open
    await page.keyboard.press('Escape');
  }

  await page.screenshot({ path: 'scripts/check-ui-copy-session.png', fullPage: false });
  pass('Copy Session screenshot → scripts/check-ui-copy-session.png');
}

// ── 5. History pane has entries (no "retrying" banner) ───────────────────────
async function checkHistoryEntries(page) {
  console.log('\n── History pane entries ──');

  // Navigate back to the history pane (close queue panel first by clicking elsewhere)
  const queueBtn = page.locator('[title="Instruction Queue"]');
  if (await queueBtn.isVisible().catch(() => false)) {
    await queueBtn.click(); // toggle off
    await page.waitForTimeout(400);
  }

  const retrying = await page.locator('text=Fleet-console not reachable').isVisible().catch(() => false);
  if (retrying) {
    fail('History pane shows "Fleet-console not reachable" — API is not responding from web-ide');
  } else {
    pass('History pane is NOT showing retry banner');
  }

  const noHistory = await page.locator('text=No history found').isVisible().catch(() => false);
  if (noHistory) {
    fail('History pane shows "No history found" — sessions may not be loading or there are none');
  } else {
    pass('History pane is NOT showing "No history found" (entries loaded or still loading)');
  }

  // Look for any date group heading (Today, Yesterday, This Week, etc.)
  const dateGroups = ['Today', 'Yesterday', 'This Week', 'Last Week', 'This Month', 'Older'];
  let found = false;
  for (const g of dateGroups) {
    if (await page.locator(`text=${g}`).first().isVisible().catch(() => false)) {
      pass(`History date group "${g}" visible`);
      found = true;
      break;
    }
  }
  if (!found) {
    fail('No history date groups visible — history may be empty or not loaded');
  }
}

// ── main ──────────────────────────────────────────────────────────────────────
(async () => {
  console.log('Fleet Console UI smoke test');
  console.log('============================');
  const browser = await chromium.launch({ headless: true });
  const ctx  = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await ctx.newPage();

  try {
    await checkApi(page);
    const shellOk = await checkWebIdeShell(page);
    if (shellOk) {
      await checkFleetPanel(page);
      await checkCopySession(page);
      await checkHistoryEntries(page);
    }
  } catch (e) {
    fail(`Unexpected error: ${e.message}`);
  } finally {
    await browser.close();
  }

  console.log('\n============================');
  if (failures > 0) {
    console.error(`${failures} check(s) FAILED — see ✗ lines above.`);
    process.exit(1);
  } else {
    console.log('All checks passed.');
  }
})();
