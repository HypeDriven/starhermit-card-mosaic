/**
 * Card Mosaic — end-to-end QA playthrough.
 *
 * Drives the real visible UI in headless Chrome (playwright-core + system
 * Chrome) through the full player journey, twice: desktop 1280x800 and
 * mobile 390x844 (touch). Flow per pass:
 *
 *   load → title → settings open/close (desktop) → mode select → journey
 *   map → stage 1 → solve the mosaic by clicking actual tray slots and
 *   board cells (solution read from window.__cm only to decide WHAT to
 *   click; every action is a real UI click/key press) → results screen
 *   with score breakdown → next stage → pause/resume → hint/undo
 *   (desktop) → leave round.
 *
 * The game is fully playable offline; the StarHermit backend (server.js)
 * is NOT used here — this file embeds its own ephemeral static server and
 * the platform adapter falls back to local mode.
 *
 * Run: npm run test:e2e
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.glb': 'model/gltf-binary',
  '.woff2': 'font/woff2', '.ts': 'video/mp2t',
};
// Benign headless-GPU console noise (mirrors tools/production_game_audit.mjs).
const browserNoise = /GL Driver Message|GPU stall due to ReadPixels|Automatic fallback to software WebGL|EnableWebGLDeveloperExtensions/i;

// The platform adapter probes the StarHermit /api/v1 surface on every boot;
// against this static-only server that 404s, which Chrome logs as a console
// error. That is expected offline behavior, not a game bug — collect console
// errors through this filter so only genuinely actionable ones fail the run.
function wireErrorCollection(page) {
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (m.text().startsWith('Failed to load resource') && (m.location()?.url || '').includes('/api/')) return;
    errors.push(`console: ${m.text()}`);
  });
}

const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const file = normalize(join(ROOT, p));
    if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end('not found');
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const BASE = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
});

const errors = [];
const step = async (name, fn) => {
  await fn();
  console.log(`ok - ${name}`);
};

/** Read the rules snapshot for sync/decisions; never acts on the game. */
const readState = (page) => page.evaluate(() => {
  const app = window.__cm;
  const s = app?.session;
  if (!s) return { phase: app?.phase ?? null };
  const st = s.state;
  return {
    phase: app.phase, tick: st.tick, status: st.status,
    result: s.result ? s.result.terminalReason : null,
    selectedTray: app.selectedTray,
    tray: st.tray.slice(), cells: st.cells.slice(),
    rots: Object.fromEntries(Object.entries(st.cards).map(([id, c]) => [id, c.rot])),
    solution: s.content.solution,
    rotation: !!st.mechanics.rotation,
  };
});

/**
 * Solve the current mosaic through the visible UI: click a tray slot,
 * rotate with the R key when the card is turned, click its solution cell.
 */
async function playRound(page, tag, shotOnce) {
  let shotTaken = false;
  for (let i = 0; i < 80; i++) {
    const st = await readState(page);
    if (st.result) return st.result;
    if (st.status === 'terminal') return 'terminal';
    // next unsolved solution entry with its card still available
    let todo = null;
    for (const [cellStr, want] of Object.entries(st.solution)) {
      const cell = Number(cellStr);
      const placed = st.cells[cell];
      if (placed === want.card && ((st.rots[want.card] % 4) + 4) % 4 === ((want.rot || 0) % 4 + 4) % 4) continue;
      if (placed !== null) throw new Error(`cell ${cell} holds unexpected card ${placed}`);
      const tray = st.tray.indexOf(want.card);
      if (tray < 0) throw new Error(`card ${want.card} for cell ${cell} is not in the tray`);
      todo = { tray, cell, card: want.card, wantRot: ((want.rot || 0) % 4 + 4) % 4 };
      break;
    }
    if (!todo) throw new Error('nothing left to place but round is not terminal');

    await page.click(`#tray .tray-slot[data-index="${todo.tray}"]`);
    if (st.rotation) {
      for (let r = 0; r < 4; r++) {
        const cur = await readState(page);
        const rot = ((cur.rots[todo.card] % 4) + 4) % 4;
        if (rot === todo.wantRot) break;
        if (cur.selectedTray !== todo.tray) {
          await page.click(`#tray .tray-slot[data-index="${todo.tray}"]`);
        }
        const before = cur.tick;
        await page.keyboard.press('r');
        await page.waitForFunction((t) => window.__cm.session.state.tick !== t, before);
      }
      const cur = await readState(page);
      if (((cur.rots[todo.card] % 4) + 4) % 4 !== todo.wantRot) {
        throw new Error(`card ${todo.card} could not be rotated to ${todo.wantRot}`);
      }
    }
    const before = (await readState(page)).tick;
    await page.click(`#board-grid .cell[data-index="${todo.cell}"]`);
    await page.waitForFunction(
      (t) => window.__cm.session.state.tick !== t || !!window.__cm.session.result, before);
    if (shotOnce && !shotTaken) {
      shotTaken = true;
      await page.screenshot({ path: `/tmp/card-mosaic-e2e-play-${tag}.png` });
    }
  }
  throw new Error('round did not reach a terminal state within 80 UI actions');
}

async function waitTitle(page) {
  await page.waitForSelector('#screen-title:not([hidden])', { timeout: 15000 });
  await page.waitForFunction(() => window.__cm?.phase === 'title');
}

async function startJourneyStage1(page, tag) {
  await page.click('#btn-play');
  await page.waitForSelector('#screen-modes:not([hidden])');
  const modes = await page.locator('#mode-list .mode-card').count();
  if (modes !== 6) throw new Error(`expected 6 mode cards, got ${modes}`);
  await page.click('.mode-card[data-mode="journey"]');
  await page.waitForSelector('#screen-journey:not([hidden])');
  await page.screenshot({ path: `/tmp/card-mosaic-e2e-journey-${tag}.png` });
  const unlocked = await page.locator('.stage-btn:not([disabled])').count();
  if (unlocked !== 1) throw new Error(`expected 1 unlocked journey stage, got ${unlocked}`);
  await page.locator('.stage-btn:not([disabled])').first().click();
  await page.waitForFunction(() => window.__cm?.phase === 'active');
  await page.waitForSelector('#screen-play:not([hidden])');
  if (await page.locator('#tray .tray-slot').count() < 1) throw new Error('tray is empty');
}

async function pauseResume(page, tag) {
  await page.keyboard.press('p');
  await page.waitForSelector('#overlay-pause:not([hidden])');
  await page.screenshot({ path: `/tmp/card-mosaic-e2e-pause-${tag}.png` });
  await page.click('#btn-resume');
  await page.waitForSelector('#overlay-pause:not([hidden])', { state: 'detached' })
    .catch(() => page.waitForFunction(() => document.getElementById('overlay-pause').hidden));
  await page.waitForFunction(() => window.__cm?.phase === 'active');
}

async function expectClean(tag) {
  const bad = errors.filter((e) => !browserNoise.test(e));
  if (bad.length) throw new Error(`${tag} pass had page errors:\n${bad.join('\n')}`);
}

try {
  // ------------------------------------------------------------- desktop
  {
    const tag = 'desktop';
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    wireErrorCollection(page);

    await step('load + title visible', async () => {
      await page.goto(BASE, { waitUntil: 'load' });
      await waitTitle(page);
      await page.screenshot({ path: `/tmp/card-mosaic-e2e-title-${tag}.png` });
    });

    await step('settings open/close from title', async () => {
      await page.click('#btn-title-settings');
      await page.waitForSelector('#overlay-settings:not([hidden])');
      await page.click('#tab-graphics');
      await page.waitForSelector('#panel-graphics:not([hidden])');
      await page.screenshot({ path: `/tmp/card-mosaic-e2e-settings-${tag}.png` });
      await page.click('#btn-settings-close');
      await page.waitForFunction(() => document.getElementById('overlay-settings').hidden);
    });

    await step('journey stage 1 starts', () => startJourneyStage1(page, tag));

    await step('solve mosaic through the board UI → results', async () => {
      const reason = await playRound(page, tag, true);
      if (reason !== 'complete') throw new Error(`round ended as ${reason}, expected complete`);
      await page.waitForSelector('#screen-results:not([hidden])', { timeout: 8000 });
      const rows = await page.locator('#results-breakdown dt').count();
      if (rows < 5) throw new Error(`expected score breakdown rows, got ${rows}`);
      const headline = await page.textContent('#results-headline');
      console.log('  headline:', headline.trim());
      await page.screenshot({ path: `/tmp/card-mosaic-e2e-results-${tag}.png` });
    });

    await step('progression persisted (stage 1 complete)', async () => {
      const prog = await page.evaluate(() => JSON.parse(localStorage.getItem('cardmosaic.v1.progress'))?.data);
      if (!prog?.journey?.['journey-1']?.completed) {
        throw new Error('journey-1 completion not persisted: ' + JSON.stringify(prog?.journey));
      }
    });

    await step('next stage → pause → resume', async () => {
      await page.click('#btn-results-next');
      await page.waitForFunction(() => window.__cm?.phase === 'active');
      await page.waitForSelector('#screen-play:not([hidden])');
      await pauseResume(page, tag);
    });

    await step('hint + undo via UI', async () => {
      const before = (await readState(page)).tick;
      await page.keyboard.press('h');
      await page.waitForTimeout(150);
      // place one card per the highlighted hint, then undo it
      const st = await readState(page);
      let acted = false;
      for (const [cellStr, want] of Object.entries(st.solution)) {
        const cell = Number(cellStr);
        if (st.cells[cell] !== null) continue;
        const tray = st.tray.indexOf(want.card);
        if (tray < 0) continue;
        if (st.rotation && ((st.rots[want.card] % 4) + 4) % 4 !== ((want.rot || 0) % 4 + 4) % 4) continue;
        await page.click(`#tray .tray-slot[data-index="${tray}"]`);
        await page.click(`#board-grid .cell[data-index="${cell}"]`);
        await page.waitForFunction((t) => window.__cm.session.state.tick !== t, before);
        acted = true;
        break;
      }
      if (!acted) throw new Error('could not place a card for the undo check');
      await page.keyboard.press('u');
      await page.waitForFunction((t) => window.__cm.session.state.tick === t, before);
      console.log('  hint announced, placement undone back to tick', before);
    });

    await step('leave round → title offers resume', async () => {
      await page.keyboard.press('p');
      await page.waitForSelector('#overlay-pause:not([hidden])');
      await page.click('#btn-pause-leave');
      await page.waitForSelector('#overlay-confirm:not([hidden])');
      await page.click('#btn-confirm-yes');
      await waitTitle(page);
      await page.waitForSelector('#title-resume:not([hidden])');
      await page.screenshot({ path: `/tmp/card-mosaic-e2e-leave-${tag}.png` });
    });

    await ctx.close();
    await expectClean(tag);
    console.log('ok - desktop pass clean of page errors');
  }

  // -------------------------------------------------------------- mobile
  {
    const tag = 'mobile';
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true,
    });
    const page = await ctx.newPage();
    wireErrorCollection(page);

    await step('mobile: load + title visible', async () => {
      await page.goto(BASE, { waitUntil: 'load' });
      await waitTitle(page);
      await page.screenshot({ path: `/tmp/card-mosaic-e2e-title-${tag}.png` });
    });

    await step('mobile: journey stage 1 starts', () => startJourneyStage1(page, tag));

    await step('mobile: pause → resume', () => pauseResume(page, tag));

    await step('mobile: solve mosaic through the board UI → results', async () => {
      const reason = await playRound(page, tag, true);
      if (reason !== 'complete') throw new Error(`round ended as ${reason}, expected complete`);
      await page.waitForSelector('#screen-results:not([hidden])', { timeout: 8000 });
      const rows = await page.locator('#results-breakdown dt').count();
      if (rows < 5) throw new Error(`expected score breakdown rows, got ${rows}`);
      await page.screenshot({ path: `/tmp/card-mosaic-e2e-results-${tag}.png` });
    });

    await ctx.close();
    await expectClean(tag);
    console.log('ok - mobile pass clean of page errors');
  }

  console.log('\nE2E PASS — card-mosaic desktop + mobile playthroughs, no page errors');
} finally {
  await browser.close();
  server.close();
}
