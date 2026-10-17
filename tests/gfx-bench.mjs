// Graphics benchmark hook for tools/gfx-bench.mjs (dev-only): picks a preset on the real Settings →
// Graphics tab, starts Journey stage 1 and keeps placing cards from the visible tray onto board cells
// (card flights, placement sparkles, dust and the post chain all run).
export const presets = ['low', 'balanced', 'high', 'ultra'];
export const levels = { low: 0, balanced: 4, high: 10, ultra: 17 };

export async function setPreset(page, preset) {
  await page.waitForFunction(() => window.__cm?.phase === 'title', null, { timeout: 20000 });
  await page.click('#btn-title-settings');
  await page.waitForSelector('#overlay-settings:not([hidden])');
  await page.click('#tab-graphics');
  await page.waitForSelector('#panel-graphics:not([hidden])');
  await page.selectOption('#set-quality', preset);
  await page.waitForFunction((p) => document.documentElement.dataset.gfxPreset === p, preset);
  await page.click('#btn-settings-close');
  await page.waitForFunction(() => document.getElementById('overlay-settings').hidden);
}

export async function start(page) {
  await page.click('#btn-play');
  await page.click('.mode-card[data-mode="journey"]');
  await page.locator('.stage-btn:not([disabled])').first().click();
  await page.waitForFunction(() => window.__cm?.phase === 'active');
  let open = true, i = 0;
  page.once('close', () => { open = false; });
  (async () => {
    while (open) {
      try {
        const slots = await page.locator('#tray .tray-slot').count();
        const cells = await page.locator('#board-grid .cell').count();
        if (slots && cells) {
          await page.click(`#tray .tray-slot[data-index="${i % slots}"]`, { timeout: 500 });
          await page.click(`#board-grid .cell[data-index="${(i * 7) % cells}"]`, { timeout: 500 });
        }
        i++;
        await page.waitForTimeout(350);
      } catch { if (!open) return; }
    }
  })();
  await page.waitForTimeout(500);
}
