// ui.js — DOM shell for Card Mosaic: screens, overlays, settings, live
// regions, and the fully playable DOM mirror board (also the accessibility
// mirror of the 3D scene). No three.js imports; safe in any browser.
//
// Handler contract notes (main.js codes against this):
//  - Raw taps are forwarded: every board-cell tap calls onCell(index) and
//    every occupied tray tap calls onTray(index); main.js interprets
//    sequences (place / select / two-tap swap). Exception: tapping an
//    occupied cell while a tray card is selected is rejected locally with
//    a "cell occupied" explanation and not forwarded. Esc cancels the
//    current selection by re-tapping it (main.js toggles selections off).
//  - The Recall action button calls onRecall() when the owner provides it,
//    otherwise onCell({ cell, intent: 'recall' }).
//  - Selection display is vm-authoritative: vm.selectedTray /
//    vm.selectedCell are adopted verbatim (null included) whenever the vm
//    carries the fields.
//  - showScreen also accepts 'challenges' (alias for setup in challenge
//    mode) and data payloads from main.js: setup data may carry
//    { title, rules, duration, players, assists, ranked, difficulties,
//      challenges, start }; boards data may carry { local, remote,
//      validated, scope }; title data may carry { snapshotAvailable,
//      journeyDone, journeyTotal, dailyDone }.
//  - updateBoards(boards, scope): `boards` may be an array of entries or
//    `{ entries, validated }`. `validated === false` labels the board
//    "casual". Entries: { name, score, you?, friend?, casual? }.

import { analyzeBoard, effectiveEdges, cellXY } from './rules.js';
import { MOTIFS, THEMES, JOURNEY, LESSONS, PRACTICE_DIFFICULTIES, CHALLENGES } from './content.js';
import { getTheme, themeCssVars, motifColors } from './themes.js';
import { motifSvg } from './motifs.js';
import { ACHIEVEMENTS, loadProgress, loadAchievements } from './storage.js';
import { MODES } from './session.js';

const SCREENS = ['loading', 'title', 'modes', 'journey', 'lessons', 'setup',
  'play', 'results', 'help', 'profile', 'boards', 'compat'];

const OVERLAYS = ['pause', 'settings', 'help', 'confirm'];

// Plain-language mapping for every validateCommand reason in rules.js.
const REASON_TEXT = {
  'unknown-command': 'That action is not available.',
  'round-over': 'The round is already over.',
  'bad-tray-slot': 'That tray slot does not exist.',
  'bad-cell': 'That cell is not part of the board.',
  'tray-slot-empty': 'That tray slot is empty.',
  'cell-occupied': 'That cell already holds a card.',
  'cell-empty': 'That cell is empty.',
  'card-locked': 'That card is locked and cannot move.',
  'same-cell': 'Choose two different cells to swap.',
  'rotation-disabled': 'Rotating is not part of this puzzle.',
  'lock-disabled': 'Locking is not part of this puzzle.',
  'already-locked': 'That card is already locked.',
  'neighbors-mismatch': 'Locking needs every placed neighbor to match.',
  'no-tray-slot': 'That card is anchored to the table and cannot be recalled.',
  'not-terminal': 'The round cannot be settled yet.',
};

// Static presentation data for the mode-select cards.
const MODE_META = {
  learn:     { blurb: 'Interactive lessons introduce one rule at a time.', duration: '2–5 min' },
  journey:   { blurb: 'Authored stages that combine mechanics and end in mastery tests.', duration: '3–8 min' },
  daily:     { blurb: 'One shared mosaic per UTC day, same seed for everyone.', duration: '≈5 min' },
  practice:  { blurb: 'Relaxed play at your chosen difficulty. No rating effects.', duration: '3–10 min' },
  challenge: { blurb: 'Constrained goals: move budgets, clocks, and impostor cards.', duration: '5–10 min' },
  score:     { blurb: 'Chase global and friends leaderboards on validated seeds.', duration: '5–10 min' },
};

const QUALITY_TIERS = ['low', 'medium', 'high'];
const LONG_PRESS_MS = 550;

function fmtMs(ms) {
  if (ms == null) return '';
  const s = Math.max(0, Math.ceil(ms / 1000));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text != null) e.textContent = text;
  return e;
}

export class UI {
  /**
   * @param {Document} root
   * @param {object} handlers — every handler is optional; calls are guarded.
   */
  constructor(root, handlers = {}) {
    this.root = root;
    this.h = handlers || {};

    // --- cached elements -------------------------------------------------
    const $ = (id) => root.getElementById(id);
    this.el = {
      topbar: $('topbar'),
      statusLine: $('status-line'),
      annPolite: $('announcer-polite'),
      annAssert: $('announcer-assertive'),
      toasts: $('toasts'),
      captions: $('captions'),
      loadingFill: $('loading-bar-fill'),
      loadingBar: $('loading-bar'),
      loadingLabel: $('loading-label'),
      modeList: $('mode-list'),
      journeyMap: $('journey-map'),
      lessonList: $('lesson-list'),
      setupTitle: $('setup-title'),
      setupBlurb: $('setup-blurb'),
      setupMeta: $('setup-meta'),
      setupRanked: $('setup-ranked'),
      setupOptions: $('setup-options'),
      setupStart: $('setup-start'),
      canvasContainer: $('canvas-container'),
      boardContainer: $('board-container'),
      boardGrid: $('board-grid'),
      tray: $('tray'),
      railLeft: $('rail-left'),
      railRight: $('rail-right'),
      btnDrawerLeft: $('btn-drawer-left'),
      btnDrawerRight: $('btn-drawer-right'),
      hudObjective: $('hud-objective'),
      hudLesson: $('hud-lesson'),
      hudProgress: $('hud-progress'),
      hudAnalysis: $('hud-analysis'),
      hudScore: $('hud-score-breakdown'),
      hudMoves: $('hud-moves'),
      hudTime: $('hud-time'),
      hudRanked: $('hud-ranked'),
      btnRotate: $('btn-rotate'),
      btnLock: $('btn-lock'),
      btnRecall: $('btn-recall'),
      btnUndo: $('btn-undo'),
      btnHint: $('btn-hint'),
      btnPause: $('btn-pause'),
      resultsHeadline: $('results-headline'),
      resultsSub: $('results-sub'),
      resultsStars: $('results-stars'),
      resultsNewbest: $('results-newbest'),
      resultsBreakdown: $('results-breakdown'),
      resultsPar: $('results-par'),
      resultsAchievements: $('results-achievements'),
      resultsBoard: $('results-board'),
      btnResultsRetry: $('btn-results-retry'),
      btnResultsNext: $('btn-results-next'),
      btnResultsMap: $('btn-results-map'),
      btnResultsTitle: $('btn-results-title'),
      profileName: $('profile-name'),
      profileForm: $('profile-form'),
      profileStats: $('profile-stats'),
      profileAchievements: $('profile-achievements'),
      btnBoardsGlobal: $('btn-boards-global'),
      btnBoardsFriends: $('btn-boards-friends'),
      boardsNote: $('boards-note'),
      boardsList: $('boards-list'),
      confirmTitle: $('confirm-title'),
      confirmMessage: $('confirm-message'),
      btnConfirmYes: $('btn-confirm-yes'),
      btnConfirmNo: $('btn-confirm-no'),
      themeList: $('set-theme-list'),
    };

    // --- mutable UI state ------------------------------------------------
    this._screen = null;
    this._overlayStack = [];       // [{name, invoker}]
    this._confirmAction = null;
    this._busy = false;
    this._settings = null;
    this._cvd = false;
    this._sel = { tray: null, cell: null };
    this._vm = null;               // last session view model
    this._ana = null;              // per-cell match analysis cache
    this._anaTick = -1;
    this._prevMatched = null;
    this._gridKey = null;
    this._traySize = -1;
    this._cellEls = [];
    this._trayEls = [];
    this._cardEls = new Map();     // cardId -> element (cached across frames)
    this._cellFocus = 0;           // roving tabindex: board
    this._trayFocus = 0;           // roving tabindex: tray
    this._journeyProgress = null;
    this._lessonProgress = null;
    this._boards = null;
    this._boardScope = 'global';
    this._annTimers = { polite: 0, assertive: 0 };
    this._reflecting = false;
    this._longPress = null;

    this._buildModeList();
    this._buildLessonList();
    this._buildThemePicker();
    this._buildScoreRows();
    this._wireStatic();
    this._wireBoard();
    this._wireSettings();
    this._wireKeyboard();
  }

  // ------------------------------------------------------------------ utils

  _call(name, ...args) {
    const fn = this.h && this.h[name];
    if (typeof fn === 'function') return fn(...args);
    return undefined;
  }

  _screenEl(name) { return this.root.getElementById('screen-' + name); }
  _overlayEl(name) { return this.root.getElementById('overlay-' + name); }

  /** Announce through a live region; assertive interrupts. */
  announce(msg, assertive = false) {
    const region = assertive ? this.el.annAssert : this.el.annPolite;
    if (!region) return;
    const kind = assertive ? 'assertive' : 'polite';
    clearTimeout(this._annTimers[kind]);
    region.textContent = '';
    this._annTimers[kind] = setTimeout(() => { region.textContent = msg; }, 40);
  }

  /** Transient visual toast. kind: 'info' | 'warn' | 'success'. */
  toast(msg, kind = 'info') {
    const host = this.el.toasts;
    if (!host) return;
    while (host.children.length >= 4) host.firstChild.remove();
    const t = el('div', 'toast toast-' + kind, msg);
    t.addEventListener('click', () => t.remove());
    host.appendChild(t);
    setTimeout(() => { if (t.isConnected) t.remove(); }, 4200);
  }

  _caption(text) {
    if (!this._settings || !this._settings.access || !this._settings.access.captions) return;
    const c = this.el.captions;
    if (!c) return;
    c.hidden = false;
    c.textContent = '♪ ' + text;
    clearTimeout(this._captionTimer);
    this._captionTimer = setTimeout(() => { c.hidden = true; }, 2200);
  }

  _setStatus(text) {
    if (this.el.statusLine && this._statusText !== text) {
      this._statusText = text;
      this.el.statusLine.textContent = text;
    }
  }

  // ---------------------------------------------------------------- screens

  showScreen(name, data) {
    // 'challenges' is accepted as an alias for the setup screen listing the
    // five challenges (main.js routes challenge mode setup this way).
    if (name === 'challenges') {
      name = 'setup';
      data = { ...(data || {}), mode: 'challenge' };
    }
    if (!SCREENS.includes(name)) return;
    this._closeAllOverlays();
    for (const s of SCREENS) {
      const e = this._screenEl(s);
      if (!e) continue;
      const active = s === name;
      e.classList.toggle('active', active);
      e.hidden = !active;
    }
    this._screen = name;
    this.root.body.classList.toggle('in-play', name === 'play');

    if (name === 'title') this._buildTitle(data || {});
    if (name === 'journey') this.updateJourneyMap(data && data.progress);
    if (name === 'lessons' && data && data.progress) this._lessonProgress = data.progress;
    if (name === 'lessons') this._buildLessonList();
    if (name === 'setup') this._buildSetup(data || {});
    if (name === 'results' && data) this.resultsView(data);
    if (name === 'boards' && data) this._showBoardsData(data);
    if (name === 'profile') {
      // main.js owns the profile name; progress/achievements are local
      // storage, which this layer may read for display.
      this.updateProfile(data || {
        progress: loadProgress(),
        achievements: loadAchievements(),
      });
    }

    // Focus: primary control if marked, otherwise the screen heading.
    const screen = this._screenEl(name);
    const target = screen && (screen.querySelector('[data-autofocus]') || screen.querySelector('h1, h2'));
    if (target) target.focus({ preventScroll: true });
  }

  /** Title screen payload from main.js: resume offer, progress summary. */
  _buildTitle(data) {
    const resume = this.root.getElementById('title-resume');
    if (resume) resume.hidden = !data.snapshotAvailable;
    const summary = this.root.getElementById('title-summary');
    if (summary) {
      const bits = [];
      if (data.journeyDone != null && data.journeyTotal != null) {
        bits.push('Journey: ' + data.journeyDone + ' of ' + data.journeyTotal + ' stages complete');
      }
      if (data.dailyKey) bits.push('Today’s daily: ' + (data.dailyDone ? 'done' : 'open'));
      this._setText(summary, bits.join(' · '));
    }
  }

  /** Normalize boards payloads: {boards, scope} or main.js's {local, remote, validated, scope}. */
  _showBoardsData(data) {
    if (data.boards) {
      this.updateBoards(data.boards, data.scope);
      return;
    }
    let entries;
    if (Array.isArray(data.remote) && data.remote.length) {
      entries = data.remote;
    } else {
      // Local fallback: flatten the boardKey -> entries map, best first.
      entries = [];
      for (const key of Object.keys(data.local || {})) {
        for (const e of data.local[key]) {
          entries.push({
            name: e.name || 'You',
            score: e.score != null ? e.score : (e.result && e.result.score.total),
            you: true,
            casual: true,
          });
        }
      }
      entries.sort((a, b) => (b.score || 0) - (a.score || 0));
      entries = entries.slice(0, 20);
    }
    this.updateBoards({ entries, validated: data.validated !== false }, data.scope);
  }

  /** Theme-only update hook used by main.js's onThemeChange. */
  setTheme(themeId, cvd) {
    if (cvd != null) this._cvd = !!cvd;
    if (this._settings && this._settings.graphics) this._settings.graphics.theme = themeId;
    const vars = themeCssVars(getTheme(themeId || 'studio'), this._cvd);
    const rootStyle = this.root.documentElement.style;
    for (const k of Object.keys(vars)) rootStyle.setProperty(k, vars[k]);
    this._markThemePressed();
  }

  // ---------------------------------------------------------------- overlays

  openOverlay(name, data) {
    if (!OVERLAYS.includes(name)) return;
    const top = this._overlayStack[this._overlayStack.length - 1];
    if (top && top.name === name) return;
    if (top) this._overlayEl(top.name).classList.remove('open');
    this._overlayStack.push({ name, invoker: this.root.activeElement });
    if (this._overlayStack.length === 1) this._firstInvoker = this.root.activeElement;

    const ov = this._overlayEl(name);
    if (name === 'settings') this._selectSettingsTab((data && data.tab) || 'audio');
    if (name === 'confirm') {
      this._confirmAction = (data && data.action) || null;
      this.el.confirmTitle.textContent = (data && data.title) || 'Are you sure?';
      this.el.confirmMessage.textContent = (data && data.message) || '';
      this.el.btnConfirmYes.textContent = (data && data.confirmLabel) || 'Confirm';
    }
    if (name === 'help') this._call('onHelpOpen');
    ov.hidden = false;
    ov.classList.add('open');
    const target = ov.querySelector('[data-autofocus]') || ov.querySelector('h2');
    if (target) target.focus({ preventScroll: true });
  }

  /** Close the topmost overlay; restores the previous overlay or the invoker. */
  closeOverlay() {
    const top = this._overlayStack.pop();
    if (!top) return;
    const ov = this._overlayEl(top.name);
    ov.classList.remove('open');
    ov.hidden = true;
    if (top.name === 'help') this._call('onHelpClose');

    const next = this._overlayStack[this._overlayStack.length - 1];
    if (next) {
      const nov = this._overlayEl(next.name);
      nov.hidden = false;
      nov.classList.add('open');
      const h = nov.querySelector('h2');
      if (h) h.focus({ preventScroll: true });
    } else {
      this._restoreInvoker();
    }
  }

  _closeAllOverlays() {
    while (this._overlayStack.length) {
      const top = this._overlayStack.pop();
      const ov = this._overlayEl(top.name);
      ov.classList.remove('open');
      ov.hidden = true;
      if (top.name === 'help') this._call('onHelpClose');
    }
  }

  _restoreInvoker() {
    const inv = this._firstInvoker;
    this._firstInvoker = null;
    if (inv && inv.isConnected && inv.offsetParent !== null) {
      inv.focus({ preventScroll: true });
      return;
    }
    // Invoker gone (e.g. hidden pause overlay): focus the screen heading.
    const screen = this._screenEl(this._screen);
    const h = screen && screen.querySelector('h1, h2');
    if (h) h.focus({ preventScroll: true });
  }

  _focusables(container) {
    return [...container.querySelectorAll(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), [tabindex="-1"]')]
      .filter((e) => e.offsetParent !== null || e.tagName === 'H2');
  }

  _trapTab(e) {
    const top = this._overlayStack[this._overlayStack.length - 1];
    if (!top) return;
    const ov = this._overlayEl(top.name);
    const items = this._focusables(ov).filter((f) => f.getAttribute('tabindex') !== '-1' || f.tagName === 'H2');
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && this.root.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && this.root.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  // ---------------------------------------------------------------- loading

  setLoading(fraction, label) {
    const pct = Math.round(Math.max(0, Math.min(1, fraction || 0)) * 100);
    if (this.el.loadingFill) this.el.loadingFill.style.width = pct + '%';
    if (this.el.loadingBar) this.el.loadingBar.setAttribute('aria-valuenow', String(pct));
    if (label != null && this.el.loadingLabel) this.el.loadingLabel.textContent = label;
  }

  // ---------------------------------------------------------------- session view

  /**
   * Update HUD + DOM mirror board from the session view model.
   * Cheap at ~10Hz: board structure is only (re)built when grid dimensions
   * or tray size change; card elements are cached by card id and moved, not
   * recreated; text is written only when changed.
   */
  setSessionView(vm) {
    if (!vm || !vm.state) return;
    this._vm = vm;
    const state = vm.state;

    // Selection display is vm-authoritative when the owner supplies the
    // fields (main.js always does); null clears are adopted too.
    if ('selectedTray' in vm) this._sel.tray = vm.selectedTray;
    if ('selectedCell' in vm) this._sel.cell = vm.selectedCell;

    this._ensureBoardStructure(state);
    this._syncAnalysis(state);
    this._syncCards(state);
    this._syncCells(state, vm);
    this._syncTray(state, vm);
    this._syncHud(vm);
    this._syncActionButtons(vm);
  }

  _ensureBoardStructure(state) {
    const key = state.grid.w + 'x' + state.grid.h;
    if (key !== this._gridKey) {
      this._gridKey = key;
      this._cellFocus = 0;
      this._cellEls = [];
      const grid = this.el.boardGrid;
      grid.textContent = '';
      grid.style.gridTemplateColumns = 'repeat(' + state.grid.w + ', 1fr)';
      grid.style.setProperty('--board-ratio', state.grid.w + ' / ' + state.grid.h);
      const total = state.grid.w * state.grid.h;
      for (let i = 0; i < total; i++) {
        const b = el('button', 'cell');
        b.type = 'button';
        b.dataset.index = String(i);
        b.tabIndex = i === 0 ? 0 : -1;
        grid.appendChild(b);
        this._cellEls.push(b);
      }
    }
    if (state.tray.length !== this._traySize) {
      this._traySize = state.tray.length;
      this._trayFocus = 0;
      this._trayEls = [];
      const tray = this.el.tray;
      tray.textContent = '';
      for (let i = 0; i < state.tray.length; i++) {
        const b = el('button', 'tray-slot');
        b.type = 'button';
        b.dataset.index = String(i);
        b.tabIndex = i === 0 ? 0 : -1;
        tray.appendChild(b);
        this._trayEls.push(b);
      }
    }
  }

  _syncAnalysis(state) {
    if (this._anaTick === state.tick && this._ana) return;
    this._anaTick = state.tick;
    const a = analyzeBoard(state);
    const links = state.cells.map(() => new Set());
    const mismatch = new Set();
    for (const p of a.pairs) {
      if (p.open) continue;
      if (p.matched) {
        links[p.a].add(p.dir);
        links[p.b].add((p.dir + 2) % 4);
      } else {
        mismatch.add(p.a);
        mismatch.add(p.b);
      }
    }
    this._ana = { links, mismatch, matched: a.matched, mismatched: a.mismatched, open: a.open };
  }

  _cardColors() { return motifColors(this._cvd); }

  _cardFaceHtml(card) {
    const colors = this._cardColors();
    const e = card.edges; // face rotates as a whole, so unrotated edges here
    let html = '';
    const dirs = ['n', 'e', 's', 'w'];
    for (let d = 0; d < 4; d++) {
      html += '<span class="edge edge-' + dirs[d] + '">' + motifSvg(e[d], colors[e[d]], 20) + '</span>';
    }
    html += '<span class="card-center">';
    for (let d = 0; d < 4; d++) {
      html += '<span class="mini mini-' + dirs[d] + '">' + motifSvg(e[d], colors[e[d]], 8) + '</span>';
    }
    html += '</span>';
    return html;
  }

  _cardEl(card) {
    let c = this._cardEls.get(card.id);
    if (!c) {
      c = el('span', 'card');
      c.dataset.cardId = card.id;
      const face = el('span', 'card-face');
      face.innerHTML = this._cardFaceHtml(card);
      c.appendChild(face);
      const seal = el('span', 'lock-seal');
      seal.innerHTML = '<svg width="14" height="14" viewBox="-8 -8 16 16" aria-hidden="true" focusable="false">' +
        '<path d="M -3 -1 L -3 -3 A 3 3 0 0 1 3 -3 L 3 -1 L 4 -1 L 4 5 L -4 5 L -4 -1 Z" fill="#fff"/></svg>';
      seal.hidden = true;
      c.appendChild(seal);
      this._cardEls.set(card.id, c);
    }
    // Cheap per-frame updates: rotation + lock seal.
    const rot = ((card.rot % 4) + 4) % 4;
    if (c.__rot !== rot) {
      c.__rot = rot;
      c.firstChild.style.transform = 'rotate(' + rot * 90 + 'deg)';
    }
    if (c.__locked !== !!card.locked) {
      c.__locked = !!card.locked;
      c.lastChild.hidden = !card.locked;
    }
    return c;
  }

  /** Human-readable card description: "card with Wave north, Sun east, …". */
  _cardDescription(card) {
    const eff = effectiveEdges(card);
    const dirs = ['north', 'east', 'south', 'west'];
    return 'card with ' + eff.map((m, d) => MOTIFS[m].name + ' ' + dirs[d]).join(', ');
  }

  _syncCards(state) {
    // Desired parent per card: its cell button, or its tray slot button.
    const parentOf = new Map();
    for (let i = 0; i < state.cells.length; i++) {
      if (state.cells[i] !== null) parentOf.set(state.cells[i], this._cellEls[i]);
    }
    for (let t = 0; t < state.tray.length; t++) {
      if (state.tray[t] !== null) parentOf.set(state.tray[t], this._trayEls[t]);
    }
    for (const id of Object.keys(state.cards)) {
      const card = state.cards[id];
      const elc = this._cardEl(card);
      const want = parentOf.get(id) || null;
      if (want && elc.parentElement !== want) want.appendChild(elc);
    }
  }

  _syncCells(state, vm) {
    const legal = new Set(vm.legalCells || []);
    const lockable = new Set(vm.lockableCells || []);
    for (let i = 0; i < this._cellEls.length; i++) {
      const btn = this._cellEls[i];
      const cardId = state.cells[i];
      const card = cardId !== null ? state.cards[cardId] : null;
      const linkDirs = this._ana.links[i];
      const sig = [cardId || '-', card && card.locked ? 1 : 0,
        legal.has(i) ? 1 : 0, lockable.has(i) ? 1 : 0,
        this._sel.cell === i ? 1 : 0, vm.hintCell === i ? 1 : 0,
        [...linkDirs].sort().join(''), this._ana.mismatch.has(i) ? 1 : 0,
        this._busy ? 1 : 0].join('|');
      if (btn.__sig === sig) continue;
      btn.__sig = sig;

      btn.classList.toggle('legal', cardId === null && legal.has(i));
      btn.classList.toggle('lockable', lockable.has(i));
      btn.classList.toggle('selected', this._sel.cell === i);
      btn.classList.toggle('hint', vm.hintCell === i);
      btn.classList.toggle('mismatch', this._ana.mismatch.has(i));
      btn.classList.toggle('locked-cell', !!(card && card.locked));
      for (let d = 0; d < 4; d++) {
        btn.classList.toggle('link-' + 'nesw'[d], linkDirs.has(d));
      }
      btn.setAttribute('aria-pressed', this._sel.cell === i ? 'true' : 'false');
      btn.setAttribute('aria-disabled', this._busy ? 'true' : 'false');

      // Accessible name: concise navigable description.
      const { x, y } = cellXY(state, i);
      let label = 'Row ' + (y + 1) + ' column ' + (x + 1) + ', ';
      if (!card) {
        label += legal.has(i) ? 'empty, legal placement' : 'empty';
      } else {
        label += this._cardDescription(card);
        if (card.locked) label += ', locked';
        else if (this._ana.mismatch.has(i)) label += ', has mismatched edges';
      }
      btn.setAttribute('aria-label', label);
    }
  }

  _syncTray(state, vm) {
    for (let i = 0; i < this._trayEls.length; i++) {
      const btn = this._trayEls[i];
      const cardId = state.tray[i];
      const card = cardId !== null ? state.cards[cardId] : null;
      const sig = [cardId || '-', this._sel.tray === i ? 1 : 0,
        vm.hintTray === i ? 1 : 0, this._busy ? 1 : 0].join('|');
      if (btn.__sig === sig) continue;
      btn.__sig = sig;

      btn.disabled = cardId === null;
      btn.classList.toggle('selected', this._sel.tray === i);
      btn.classList.toggle('hint', vm.hintTray === i);
      btn.setAttribute('aria-pressed', this._sel.tray === i ? 'true' : 'false');
      btn.setAttribute('aria-disabled', this._busy ? 'true' : 'false');
      btn.setAttribute('aria-label',
        'Tray slot ' + (i + 1) + ', ' + (card ? this._cardDescription(card) : 'empty'));
    }
    // Selection hygiene: selected tray slot emptied -> drop selection.
    if (this._sel.tray != null && state.tray[this._sel.tray] === null) this._sel.tray = null;
    if (this._sel.cell != null && this._sel.cell >= state.cells.length) this._sel.cell = null;
  }

  _buildScoreRows() {
    const rows = [
      ['matched', 'Matched edges'], ['locks', 'Locks'], ['completion', 'Completion'],
      ['timeBonus', 'Time bonus'], ['swapPenalty', 'Swap penalty'],
      ['invalidPenalty', 'Invalid penalty'], ['total', 'Total'],
    ];
    const mk = (dl) => {
      dl.textContent = '';
      const out = {};
      for (const [key, label] of rows) {
        const dt = el('dt', null, label);
        const dd = el('dd', null, '0');
        if (key === 'total') { dt.className = 'total'; dd.className = 'total'; }
        dl.appendChild(dt);
        dl.appendChild(dd);
        out[key] = dd;
      }
      return out;
    };
    this._hudScoreEls = mk(this.el.hudScore);
    this._resultsScoreEls = mk(this.el.resultsBreakdown);
  }

  _writeScore(els, score) {
    if (!score) return;
    for (const key of Object.keys(els)) {
      const v = score[key] || 0;
      const text = (key === 'swapPenalty' || key === 'invalidPenalty') && v > 0 ? '−' + v : String(v);
      if (els[key].textContent !== text) els[key].textContent = text;
    }
  }

  _objectiveText(vm) {
    if (vm.mode === 'learn' && vm.lesson) return 'Lesson: ' + vm.lesson.name;
    const s = vm.state;
    const total = s.grid.w * s.grid.h;
    const empty = s.cells.filter((c) => c === null).length;
    if (empty > 0) return 'Complete the mosaic — fill ' + empty + ' of ' + total + ' cells.';
    return 'Resolve the remaining mismatched edges.';
  }

  _syncHud(vm) {
    const state = vm.state;
    this._setText(this.el.hudObjective, this._objectiveText(vm));

    const lessonOn = !!(vm.lesson && vm.lesson.steps);
    this.el.hudLesson.hidden = !lessonOn;
    if (lessonOn) {
      // main.js sends the step object as lessonStep plus lessonStepIndex.
      const step = (vm.lessonStep && vm.lessonStep.text) ? vm.lessonStep
        : vm.lesson.steps[Math.min(vm.lessonStepIndex || 0, vm.lesson.steps.length - 1)];
      this._setText(this.el.hudLesson, step ? step.text : '');
    }

    const total = state.cells.length;
    const filled = state.cells.filter((c) => c !== null).length;
    this._setText(this.el.hudProgress, filled + ' of ' + total + ' cells filled');
    this._setText(this.el.hudAnalysis,
      this._ana.matched + ' matched · ' + this._ana.mismatched + ' mismatched · ' + this._ana.open + ' open');

    this._writeScore(this._hudScoreEls, vm.score || state.score);

    const movesLeft = vm.movesLeft != null ? vm.movesLeft
      : (state.moveLimit != null ? Math.max(0, state.moveLimit - state.movesUsed) : null);
    this.el.hudMoves.hidden = movesLeft == null;
    if (movesLeft != null) this._setText(this.el.hudMoves, 'Moves left: ' + movesLeft);

    const timeLeft = vm.timeLeftMs != null ? vm.timeLeftMs
      : (state.timeLimitMs != null ? Math.max(0, state.timeLimitMs - (vm.elapsedMs || 0)) : null);
    this.el.hudTime.hidden = timeLeft == null;
    if (timeLeft != null) this._setText(this.el.hudTime, 'Time: ' + fmtMs(timeLeft));

    this.el.hudRanked.hidden = !vm.ranked;

    this._setStatus(this._statusSummary(vm));
  }

  _statusSummary(vm) {
    const parts = [];
    if (vm.mode && MODES[vm.mode]) parts.push(MODES[vm.mode].label);
    if (vm.ranked) parts.push('ranked');
    const total = vm.state.cells.length;
    const filled = vm.state.cells.filter((c) => c !== null).length;
    parts.push(filled + '/' + total + ' placed');
    const movesLeft = vm.movesLeft != null ? vm.movesLeft
      : (vm.state.moveLimit != null ? Math.max(0, vm.state.moveLimit - vm.state.movesUsed) : null);
    if (movesLeft != null) parts.push(movesLeft + ' moves left');
    const timeLeft = vm.timeLeftMs != null ? vm.timeLeftMs
      : (vm.state.timeLimitMs != null ? Math.max(0, vm.state.timeLimitMs - (vm.elapsedMs || 0)) : null);
    if (timeLeft != null) parts.push(fmtMs(timeLeft));
    if (vm.score) parts.push('score ' + vm.score.total);
    return parts.join(' · ');
  }

  _setText(node, text) {
    if (node && node.textContent !== text) node.textContent = text;
  }

  _syncActionButtons(vm) {
    const state = vm.state;
    const selTray = this._sel.tray;
    const selCell = this._sel.cell;
    const selCellCard = selCell != null ? state.cells[selCell] : null;
    const lockable = new Set(vm.lockableCells || []);

    this._setBtn(this.el.btnUndo, !!vm.canUndo && !this._busy);
    this._setBtn(this.el.btnHint, !!vm.canHint && !this._busy);
    // Prefer owner-computed capability flags; derive them otherwise.
    const canRotate = vm.canRotate != null ? vm.canRotate
      : selTray != null && state.tray[selTray] != null && state.mechanics.rotation;
    const canLock = vm.canLock != null ? vm.canLock
      : selCell != null && lockable.has(selCell);
    const canRecall = vm.canRecall != null ? vm.canRecall
      : selCell != null && selCellCard != null && !state.cards[selCellCard].locked;
    this._setBtn(this.el.btnRotate, !!canRotate && !this._busy);
    this._setBtn(this.el.btnLock, !!canLock && !this._busy);
    this._setBtn(this.el.btnRecall, !!canRecall && !this._busy);
  }

  _setBtn(btn, enabled) {
    btn.disabled = !enabled;
    btn.setAttribute('aria-disabled', enabled ? 'false' : 'true');
  }

  // ---------------------------------------------------------------- events

  /** Toasts, announcements, and small DOM flourishes for session events. */
  playEvents(events, state) {
    if (!Array.isArray(events)) return;
    for (const e of events) {
      switch (e.type) {
        case 'invalid': {
          const msg = REASON_TEXT[e.reason] || 'That move is not allowed.';
          this.announce(msg, true);
          this.toast(msg, 'warn');
          this._caption('not allowed');
          break;
        }
        case 'terminal': {
          const msg = 'Round over — results are ready.';
          this.announce(msg, true);
          this.toast(msg, 'info');
          this._caption(e.reason === 'complete' ? 'mosaic complete' : 'round over');
          break;
        }
        case 'lock':
          this.announce('Card locked.');
          this._caption('card locked');
          break;
        case 'board':
          if (this._prevMatched != null && e.matched > this._prevMatched) {
            this._flourish();
          }
          this._prevMatched = e.matched;
          break;
        case 'place': this._caption('card placed'); break;
        case 'recall': this._caption('card recalled'); break;
        case 'swap': this._caption('cards swapped'); break;
        case 'rotateTray': this._caption('card rotated'); break;
        case 'undo': this.toast('Undone', 'info'); this._caption('undo'); break;
        default: break; // duplicate, terminal-pending: no UI noise
      }
    }
  }

  _flourish() {
    const bc = this.el.boardContainer;
    bc.classList.remove('flourish');
    void bc.offsetWidth; // restart the animation
    bc.classList.add('flourish');
    const total = this._hudScoreEls && this._hudScoreEls.total;
    if (total) {
      total.classList.remove('pulse');
      void total.offsetWidth;
      total.classList.add('pulse');
    }
  }

  // ---------------------------------------------------------------- busy

  setBusy(b) {
    this._busy = !!b;
    this.el.boardGrid.classList.toggle('busy', this._busy);
    if (this._vm) {
      // Refresh ARIA + button states without a full re-render.
      for (const btn of this._cellEls) btn.__sig = null;
      for (const btn of this._trayEls) btn.__sig = null;
      this._syncCells(this._vm.state, this._vm);
      this._syncTray(this._vm.state, this._vm);
      this._syncActionButtons(this._vm);
    }
  }

  // ---------------------------------------------------------------- results

  resultsView(data) {
    if (!data) return;
    const r = data.result || {};
    const headlines = {
      complete: 'Mosaic complete!',
      'moves-exhausted': 'Out of moves',
      'time-up': 'Time is up',
      conceded: 'Round conceded',
    };
    this._setText(this.el.resultsHeadline, headlines[r.terminalReason] || 'Round over');

    const bits = [];
    if (r.elapsedMs != null) bits.push('Time ' + fmtMs(r.elapsedMs));
    if (r.movesUsed != null) bits.push(r.movesUsed + ' moves');
    this._setText(this.el.resultsSub, bits.join(' · '));

    if (data.stars != null && data.stars > 0) {
      this.el.resultsStars.hidden = false;
      this._setText(this.el.resultsStars, '★'.repeat(data.stars) + '☆'.repeat(3 - data.stars));
      this.el.resultsStars.setAttribute('aria-label', data.stars + ' of 3 stars');
    } else {
      this.el.resultsStars.hidden = true;
    }
    this.el.resultsNewbest.hidden = !data.isNewBest;

    if (Array.isArray(data.breakdown) && data.breakdown.length) {
      const dl = this.el.resultsBreakdown;
      dl.textContent = '';
      for (const row of data.breakdown) {
        dl.appendChild(el('dt', null, String(row.label)));
        dl.appendChild(el('dd', null, String(row.value)));
      }
    } else if (r.score) {
      this._writeScore(this._resultsScoreEls, r.score);
    }

    // par may be an object ({moves, ms}) or a preformatted string.
    let parText = '';
    if (data.par && typeof data.par === 'object') {
      const parts = [];
      if (data.par.moves != null) parts.push(data.par.moves + ' moves');
      if (data.par.ms != null) parts.push(fmtMs(data.par.ms));
      parText = parts.length ? 'Par: ' + parts.join(' · ') : '';
    } else if (data.par) {
      parText = 'Par: ' + data.par;
    }
    this._setText(this.el.resultsPar, parText);

    const ach = (Array.isArray(data.achievements) ? data.achievements : []).filter(Boolean);
    this.el.resultsAchievements.hidden = ach.length === 0;
    if (ach.length) {
      const host = this.el.resultsAchievements;
      host.textContent = '';
      for (const a of ach) {
        const name = a.name || (ACHIEVEMENTS.find((x) => x.key === a.key) || {}).name || a.key;
        host.appendChild(el('p', 'unlock', 'Achievement unlocked: ' + name));
      }
    }

    this._setText(this.el.resultsBoard,
      data.boardEntry ? 'Leaderboard: ' + data.boardEntry : '');

    const next = data.nextAction || { label: 'Next', action: 'next' };
    this._setText(this.el.btnResultsNext, next.label || 'Next');
    this.el.btnResultsNext.dataset.action = next.action || 'next';
  }

  // ---------------------------------------------------------------- journey

  updateJourneyMap(progress) {
    this._journeyProgress = progress || this._journeyProgress;
    const p = this._journeyProgress || {};
    const stages = p.journey || p.stages || {};
    const host = this.el.journeyMap;
    host.textContent = '';

    const chapters = new Map();
    for (const st of JOURNEY) {
      if (!chapters.has(st.chapter)) chapters.set(st.chapter, []);
      chapters.get(st.chapter).push(st);
    }
    for (const [num, list] of chapters) {
      const section = el('section', 'journey-chapter');
      section.appendChild(el('h3', null, 'Chapter ' + num));
      const ul = el('ul', 'stage-list');
      list.forEach((st, i) => {
        const rec = stages[st.id] || {};
        const completed = !!rec.completed;
        const stars = rec.stars || 0;
        // Unlock rule: first stage of a chapter requires previous chapter's
        // last stage; within a chapter the previous stage must be complete.
        const prev = i > 0 ? list[i - 1] : null;
        const prevChapter = chapters.get(num - 1);
        const gate = prev || (prevChapter && prevChapter[prevChapter.length - 1]);
        const unlocked = !gate || !!(stages[gate.id] && stages[gate.id].completed);
        const li = el('li');
        const btn = el('button', 'btn stage-btn');
        btn.type = 'button';
        btn.disabled = !unlocked;
        btn.appendChild(el('span', 'stage-name', st.name));
        btn.appendChild(el('span', 'stage-stars',
          completed ? '★'.repeat(stars) + '☆'.repeat(3 - stars) : '·'));
        btn.setAttribute('aria-label',
          st.name + (completed ? ', complete, ' + stars + ' of 3 stars' : unlocked ? ', available' : ', locked'));
        if (!unlocked) btn.appendChild(el('span', 'stage-lock', 'Locked'));
        if (unlocked) {
          btn.addEventListener('click', () => this._call('onJourneyStage', st.index));
        }
        li.appendChild(btn);
        ul.appendChild(li);
      });
      section.appendChild(ul);
      host.appendChild(section);
    }
  }

  // ---------------------------------------------------------------- boards

  updateBoards(boards, scope) {
    if (boards !== undefined) this._boards = boards;
    if (scope) this._boardScope = scope;
    const raw = this._boards;
    const entries = Array.isArray(raw) ? raw : (raw && raw.entries) || [];
    const validated = !raw || raw.validated !== false;
    const isGlobal = this._boardScope !== 'friends';

    this.el.btnBoardsGlobal.setAttribute('aria-pressed', isGlobal ? 'true' : 'false');
    this.el.btnBoardsFriends.setAttribute('aria-pressed', isGlobal ? 'false' : 'true');

    this._setText(this.el.boardsNote, validated
      ? (isGlobal ? 'Global board — validated scores.' : 'Friends board — validated scores.')
      : 'Casual board — these scores are not validated.');

    const list = this.el.boardsList;
    list.textContent = '';
    const shown = entries.filter((e) => (isGlobal ? !e.friend : true));
    if (!shown.length) {
      const li = el('li', null, 'No scores yet — be the first.');
      list.appendChild(li);
      return;
    }
    shown.forEach((e, i) => {
      const li = el('li', e.you ? 'you' : null);
      const name = el('span', 'entry-name', (e.name || 'Anonymous') +
        (e.casual ? ' (casual)' : ''));
      const score = el('span', 'entry-score', String(e.score != null ? e.score : ''));
      li.appendChild(name);
      li.appendChild(score);
      li.setAttribute('aria-label', 'Rank ' + (i + 1) + ', ' +
        (e.name || 'Anonymous') + ', ' + (e.score != null ? e.score : 0) + ' points' +
        (e.casual ? ', casual' : ''));
      list.appendChild(li);
    });
  }

  // ---------------------------------------------------------------- profile

  updateProfile(data) {
    if (!data) return;
    this._profile = data;
    if (data.name != null) this.el.profileName.value = data.name;

    const stats = this.el.profileStats;
    stats.textContent = '';
    const rows = [];
    const p = data.progress || {};
    const journeyDone = Object.values(p.journey || {}).filter((s) => s.completed).length;
    rows.push(['Sessions played', data.sessionsPlayed != null ? data.sessionsPlayed : (p.sessionsPlayed || 0)]);
    rows.push(['Journey stages complete', journeyDone + ' of ' + JOURNEY.length]);
    rows.push(['Mastery XP', p.masteryXp || 0]);
    if (p.streak) rows.push(['Daily streak', (p.streak.count || 0) + ' days']);
    if (Array.isArray(data.stats)) {
      for (const s of data.stats) rows.push([s.label, s.value]);
    }
    for (const [label, value] of rows) {
      stats.appendChild(el('dt', null, String(label)));
      stats.appendChild(el('dd', null, String(value)));
    }

    const unlocked = (data.achievements && data.achievements.unlocked) || {};
    const grid = this.el.profileAchievements;
    grid.textContent = '';
    for (const a of ACHIEVEMENTS) {
      const got = unlocked[a.key];
      const li = el('li', got ? null : 'locked-ach');
      li.appendChild(el('span', 'ach-name', a.name));
      li.appendChild(el('span', 'ach-desc', a.desc));
      li.appendChild(el('span', 'ach-date',
        got ? 'Unlocked ' + String(got).slice(0, 10) : 'Not yet unlocked'));
      grid.appendChild(li);
    }
  }

  // ---------------------------------------------------------------- settings

  applySettings(settings) {
    if (!settings) return;
    const prevCvd = this._cvd;
    this._settings = settings;
    const g = settings.graphics || {};
    const a = settings.access || {};
    this._cvd = !!g.cvd;

    const vars = themeCssVars(getTheme(g.theme || 'studio'), this._cvd);
    const rootStyle = this.root.documentElement.style;
    for (const k of Object.keys(vars)) rootStyle.setProperty(k, vars[k]);

    const html = this.root.documentElement;
    html.classList.toggle('reduced-motion', !!a.reducedMotion);
    html.classList.toggle('high-contrast', !!a.highContrast);
    html.classList.toggle('large-text', !!a.largeText);
    html.classList.toggle('left-handed', !!a.leftHanded);
    html.classList.toggle('captions-off', a.captions === false);
    if (this.el.captions) this.el.captions.hidden = a.captions === false;

    this._reflectSettings();

    // Motif colors change with the CVD palette: rebuild cached card faces.
    if (prevCvd !== this._cvd) {
      this._cardEls.clear();
      if (this._vm) {
        for (const btn of this._cellEls) btn.__sig = null;
        for (const btn of this._trayEls) btn.__sig = null;
        this._syncCards(this._vm.state);
        this._syncCells(this._vm.state, this._vm);
        this._syncTray(this._vm.state, this._vm);
      }
    }
    this._markThemePressed();
  }

  _reflectSettings() {
    const s = this._settings;
    if (!s) return;
    this._reflecting = true;
    const $ = (id) => this.root.getElementById(id);
    const setVal = (id, v) => { const n = $(id); if (n && n.value !== String(v)) n.value = v; };
    const setChk = (id, v) => { const n = $(id); if (n) n.checked = !!v; };
    setVal('set-music', s.audio.music);
    setVal('set-effects', s.audio.effects);
    setVal('set-ambience', s.audio.ambience);
    setVal('set-voice', s.audio.voice);
    setChk('set-muted', s.audio.muted);
    setVal('set-quality', s.graphics.quality);
    setChk('set-cvd', s.graphics.cvd);
    setChk('set-reduced-motion', s.access.reducedMotion);
    setChk('set-high-contrast', s.access.highContrast);
    setChk('set-large-text', s.access.largeText);
    setChk('set-left-handed', s.access.leftHanded);
    setChk('set-hold-toggle', s.access.holdToConfirm);
    setChk('set-timing-assist', s.access.timingAssist);
    setChk('set-haptics', s.access.haptics);
    setChk('set-captions', s.access.captions);
    setChk('set-telemetry', s.privacy && s.privacy.telemetryConsent);
    this._reflecting = false;
  }

  _settingsChanged(mutator) {
    if (this._reflecting || !this._settings) return;
    mutator(this._settings);
    this._call('onSettingsChanged', this._settings);
  }

  _selectSettingsTab(tab) {
    for (const t of ['audio', 'graphics', 'controls', 'accessibility']) {
      const btn = this.root.getElementById('tab-' + t);
      const panel = this.root.getElementById('panel-' + t);
      const on = t === tab;
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
      btn.tabIndex = on ? 0 : -1;
      panel.hidden = !on;
    }
  }

  _markThemePressed() {
    const theme = this._settings && this._settings.graphics && this._settings.graphics.theme;
    for (const btn of this.el.themeList.children) {
      btn.setAttribute('aria-pressed', btn.dataset.themeId === theme ? 'true' : 'false');
    }
  }

  // ---------------------------------------------------------------- builders

  _buildModeList() {
    const host = this.el.modeList;
    host.textContent = '';
    for (const mode of Object.keys(MODES)) {
      const m = MODES[mode];
      const meta = MODE_META[mode] || {};
      const assists = [m.undoAllowed && 'Undo', m.hintAllowed && 'Hint'].filter(Boolean).join(', ') || 'None';
      const card = el('button', 'btn mode-card');
      card.type = 'button';
      card.dataset.mode = mode;
      card.appendChild(el('span', 'mode-name', m.label || mode));
      card.appendChild(el('p', 'mode-blurb', meta.blurb || ''));
      card.appendChild(el('p', 'mode-meta',
        (meta.duration || '') + ' · 1 player · Assists: ' + assists));
      const badge = el('span', 'badge ' + (m.ranked ? 'ranked' : 'casual'),
        m.ranked ? 'Ranked' : 'Casual');
      card.appendChild(badge);
      card.addEventListener('click', () => this._onModeCard(mode));
      host.appendChild(card);
    }
  }

  _onModeCard(mode) {
    // The owner (main.js) drives navigation from onModeSelect; only fall
    // back to local navigation when no handler is registered.
    if (this.h && typeof this.h.onModeSelect === 'function') {
      this._call('onModeSelect', mode);
      return;
    }
    if (mode === 'learn') this.showScreen('lessons');
    else if (mode === 'journey') this.showScreen('journey');
    else this.showScreen('setup', { mode });
  }

  _buildLessonList() {
    const host = this.el.lessonList;
    host.textContent = '';
    const done = (this._lessonProgress && this._lessonProgress.lessons) || {};
    for (const l of LESSONS) {
      const li = el('li');
      const btn = el('button', 'btn lesson-btn');
      btn.type = 'button';
      const name = el('span', 'lesson-name', l.name);
      if (done[l.id] && done[l.id].completed) {
        name.appendChild(el('span', 'lesson-done', ' ✓'));
      }
      btn.appendChild(name);
      btn.appendChild(el('span', 'lesson-intro', l.intro));
      btn.addEventListener('click', () => this._call('onLesson', l.id));
      li.appendChild(btn);
      host.appendChild(li);
    }
  }

  _buildSetup(data) {
    const mode = data.mode || 'practice';
    const m = MODES[mode] || { label: mode };
    const meta = MODE_META[mode] || {};
    this._setupMode = mode;
    // main.js supplies a richer payload (title/rules/duration/assists/start);
    // fall back to the static metadata when it does not.
    this._setupStartFn = typeof data.start === 'function' ? data.start : null;
    this._setText(this.el.setupTitle, data.title || m.label || mode);
    this._setText(this.el.setupBlurb, data.rules || meta.blurb || '');
    const ranked = data.ranked != null ? data.ranked : m.ranked;
    this._setText(this.el.setupRanked, ranked
      ? 'Ranked — the result counts toward leaderboards.'
      : 'Unranked — casual play, no rating effects.');

    const assistsText = data.assists
      ? [data.assists.undo && 'Undo', data.assists.hints && 'Hint'].filter(Boolean).join(', ') || 'None'
      : [m.undoAllowed && 'Undo', m.hintAllowed && 'Hint'].filter(Boolean).join(', ') || 'None';
    const dl = this.el.setupMeta;
    dl.textContent = '';
    const rows = [
      ['Expected duration', data.duration || meta.duration || 'a few minutes'],
      ['Players', String(data.players != null ? data.players : 1)],
      ['Assists', assistsText],
    ];
    for (const [k, v] of rows) {
      dl.appendChild(el('dt', null, k));
      dl.appendChild(el('dd', null, v));
    }

    const opts = this.el.setupOptions;
    opts.textContent = '';
    this.el.setupStart.hidden = true;

    const difficulties = data.difficulties || (mode === 'practice' ? PRACTICE_DIFFICULTIES : null);
    const challenges = data.challenges || (mode === 'challenge' ? CHALLENGES : null);
    if (difficulties) {
      for (const d of difficulties) {
        const b = el('button', 'btn');
        b.type = 'button';
        b.appendChild(el('span', null, d.name));
        b.appendChild(el('span', 'opt-blurb',
          d.params.w + '×' + d.params.h + ' board, ' + d.params.removed + ' cards in tray'));
        b.addEventListener('click', () => {
          if (this._setupStartFn) this._setupStartFn(d.id);
          else this._call('onPractice', d.id);
        });
        opts.appendChild(b);
      }
    } else if (challenges) {
      for (const c of challenges) {
        const b = el('button', 'btn');
        b.type = 'button';
        b.appendChild(el('span', null, c.name));
        b.appendChild(el('span', 'opt-blurb', c.blurb));
        b.addEventListener('click', () => this._call('onChallenge', c.id));
        opts.appendChild(b);
      }
    } else {
      // daily / score / anything else: a plain start button.
      this.el.setupStart.hidden = false;
    }
  }

  _buildThemePicker() {
    const host = this.el.themeList;
    host.textContent = '';
    for (const t of THEMES) {
      const full = getTheme(t.id);
      const b = el('button', 'btn theme-swatch');
      b.type = 'button';
      b.dataset.themeId = t.id;
      b.setAttribute('aria-pressed', 'false');
      const sw = el('span', 'swatch');
      sw.style.background = 'linear-gradient(135deg, ' + full.bg + ' 0%, ' + full.felt + ' 55%, ' + full.accent + ' 100%)';
      b.appendChild(sw);
      b.appendChild(el('span', null, t.name));
      b.addEventListener('click', () => {
        this._settingsChanged((s) => { s.graphics.theme = t.id; });
        this.applySettings(this._settings);
        this._call('onThemeChange', t.id);
      });
      host.appendChild(b);
    }
  }

  // ---------------------------------------------------------------- wiring

  _wireStatic() {
    const $ = (id) => this.root.getElementById(id);
    const on = (id, fn) => { const n = $(id); if (n) n.addEventListener('click', fn); };

    // Title
    on('btn-play', () => { this._call('onPlay'); });
    on('btn-title-daily', () => this._call('onDaily'));
    on('btn-title-journey', () => {
      if (this.h && typeof this.h.onModeSelect === 'function') this._call('onModeSelect', 'journey');
      else this.showScreen('journey');
    });
    on('btn-title-profile', () => this.showScreen('profile'));
    on('btn-title-settings', () => this.openOverlay('settings'));
    on('btn-title-help', () => this.showScreen('help'));
    on('btn-title-resume', () => this._call('onResumeSnapshot'));
    on('btn-title-discard', () => this._call('onDiscardSnapshot'));

    // Generic back/navigation buttons
    for (const b of this.root.querySelectorAll('.btn-nav')) {
      b.addEventListener('click', () => this.showScreen(b.dataset.nav || 'title'));
    }

    // Setup start (daily / score chase); main.js may supply a start callback.
    this.el.setupStart.addEventListener('click', () => {
      if (this._setupStartFn) { this._setupStartFn(); return; }
      if (this._setupMode === 'daily') this._call('onDaily');
      else if (this._setupMode === 'score') this._call('onScoreChase');
      else this._call('onModeSelect', this._setupMode);
    });

    // Play actions
    this.el.btnRotate.addEventListener('click', () => {
      if (this._sel.tray != null) this._call('onRotate', this._sel.tray);
    });
    this.el.btnLock.addEventListener('click', () => {
      if (this._sel.cell != null) this._call('onLock', this._sel.cell);
    });
    this.el.btnRecall.addEventListener('click', () => this._recallSelected());
    this.el.btnUndo.addEventListener('click', () => this._call('onUndo'));
    this.el.btnHint.addEventListener('click', () => this._call('onHint'));
    this.el.btnPause.addEventListener('click', () => this._pause());

    // Rail drawers (compact breakpoints)
    this.el.btnDrawerLeft.addEventListener('click', () => this._toggleDrawer(this.el.railLeft, this.el.btnDrawerLeft));
    this.el.btnDrawerRight.addEventListener('click', () => this._toggleDrawer(this.el.railRight, this.el.btnDrawerRight));

    // Results
    this.el.btnResultsRetry.addEventListener('click', () => this._call('onResultsAction', 'retry'));
    this.el.btnResultsNext.addEventListener('click', () =>
      this._call('onResultsAction', this.el.btnResultsNext.dataset.action || 'next'));
    this.el.btnResultsMap.addEventListener('click', () => this._call('onResultsAction', 'map'));
    this.el.btnResultsTitle.addEventListener('click', () => this._call('onResultsAction', 'title'));

    // Profile
    this.el.profileForm.addEventListener('submit', (e) => {
      e.preventDefault();
      this._call('onProfileSave', this.el.profileName.value.trim());
      this.toast('Display name saved', 'success');
    });

    // Boards scope toggle (client-side filter over the last supplied boards)
    this.el.btnBoardsGlobal.addEventListener('click', () => this.updateBoards(undefined, 'global'));
    this.el.btnBoardsFriends.addEventListener('click', () => this.updateBoards(undefined, 'friends'));

    // Compat
    on('btn-compat-dismiss', () => this._call('onCompatDismiss'));

    // Pause overlay
    on('btn-resume', () => this._resume());
    on('btn-pause-audio', () => this.openOverlay('settings', { tab: 'audio' }));
    on('btn-pause-graphics', () => this.openOverlay('settings', { tab: 'graphics' }));
    on('btn-pause-controls', () => this.openOverlay('settings', { tab: 'controls' }));
    on('btn-pause-accessibility', () => this.openOverlay('settings', { tab: 'accessibility' }));
    on('btn-pause-help', () => this.openOverlay('help'));
    on('btn-pause-restart', () => this.openOverlay('confirm', {
      title: 'Restart round?', message: 'The current arrangement will be discarded.',
      confirmLabel: 'Restart', action: 'restart',
    }));
    on('btn-pause-concede', () => this.openOverlay('confirm', {
      title: 'Concede round?', message: 'The round ends now and is scored as conceded.',
      confirmLabel: 'Concede', action: 'concede',
    }));
    on('btn-pause-leave', () => this.openOverlay('confirm', {
      title: 'Leave round?', message: 'You can resume later from the last saved position.',
      confirmLabel: 'Leave', action: 'leave',
    }));

    // Confirm dialog
    this.el.btnConfirmYes.addEventListener('click', () => {
      const action = this._confirmAction;
      this._confirmAction = null;
      this._closeAllOverlays();
      this._restoreInvoker();
      if (action === 'leave') this._call('onLeave');
      else if (action === 'concede') this._call('onConcede');
      else if (action === 'restart') this._call('onRestart');
    });
    this.el.btnConfirmNo.addEventListener('click', () => this.closeOverlay());

    // Settings + help overlay close buttons
    on('btn-settings-close', () => this.closeOverlay());
    on('btn-help-close', () => this.closeOverlay());

    // Settings tabs (click + arrow-key navigation)
    const tabs = ['audio', 'graphics', 'controls', 'accessibility'];
    for (const t of tabs) {
      const btn = this.root.getElementById('tab-' + t);
      btn.addEventListener('click', () => this._selectSettingsTab(t));
      btn.addEventListener('keydown', (e) => {
        const i = tabs.indexOf(t);
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
          e.preventDefault();
          const n = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
          this._selectSettingsTab(n);
          this.root.getElementById('tab-' + n).focus();
        }
      });
    }
  }

  _toggleDrawer(rail, btn) {
    const open = rail.classList.toggle('open');
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) {
      const first = rail.querySelector('button, [tabindex="-1"]');
      if (first && first.getAttribute('tabindex') !== '-1') first.focus();
    }
  }

  _pause() {
    this._call('onPause');
    this.openOverlay('pause');
  }

  _resume() {
    this._closeAllOverlays();
    this._call('onResume');
    this._restoreInvoker();
  }

  _recallSelected() {
    const cell = this._sel.cell;
    if (cell == null || !this._vm) return;
    const id = this._vm.state.cells[cell];
    if (id == null || this._vm.state.cards[id].locked) return;
    if (this.h && typeof this.h.onRecall === 'function') {
      this._call('onRecall'); // main.js recalls its own selected cell
    } else {
      // Rich intent form: recall needs no tap choreography.
      this._call('onCell', { cell, intent: 'recall' });
    }
  }

  // ---- board interaction -------------------------------------------------

  _wireBoard() {
    const grid = this.el.boardGrid;
    const tray = this.el.tray;

    grid.addEventListener('click', (e) => {
      const btn = e.target.closest('.cell');
      if (btn) this._onCellTap(Number(btn.dataset.index));
    });
    tray.addEventListener('click', (e) => {
      const btn = e.target.closest('.tray-slot');
      if (btn && !btn.disabled) this._onTrayTap(Number(btn.dataset.index));
    });

    // Roving tabindex + arrow navigation on board and tray.
    grid.addEventListener('keydown', (e) => this._onGridKey(e));
    tray.addEventListener('keydown', (e) => this._onTrayKey(e));
    grid.addEventListener('focusin', (e) => {
      const btn = e.target.closest('.cell');
      if (btn) this._setCellFocus(Number(btn.dataset.index));
    });
    tray.addEventListener('focusin', (e) => {
      const btn = e.target.closest('.tray-slot');
      if (btn) this._setTrayFocus(Number(btn.dataset.index));
    });

    // Long-press on tray cards (details / optional owner handler).
    tray.addEventListener('pointerdown', (e) => {
      const btn = e.target.closest('.tray-slot');
      if (!btn || btn.disabled) return;
      const slot = Number(btn.dataset.index);
      const startX = e.clientX, startY = e.clientY;
      this._cancelLongPress();
      const timer = setTimeout(() => {
        this._longPress = null;
        if (this.h && typeof this.h.onTrayLongPress === 'function') {
          this._call('onTrayLongPress', slot);
        } else if (this._vm) {
          const id = this._vm.state.tray[slot];
          if (id) this.announce('Tray slot ' + (slot + 1) + ': ' +
            this._cardDescription(this._vm.state.cards[id]) + '.');
        }
      }, LONG_PRESS_MS);
      this._longPress = { timer, startX, startY, target: btn };
    });
    tray.addEventListener('pointermove', (e) => {
      const lp = this._longPress;
      if (lp && Math.hypot(e.clientX - lp.startX, e.clientY - lp.startY) > 10) this._cancelLongPress();
    });
    tray.addEventListener('pointerup', () => this._cancelLongPress());
    tray.addEventListener('pointercancel', () => this._cancelLongPress());
  }

  _cancelLongPress() {
    if (this._longPress) {
      clearTimeout(this._longPress.timer);
      this._longPress = null;
    }
  }

  _setCellFocus(i) {
    if (!this._cellEls.length) return;
    this._cellFocus = Math.max(0, Math.min(i, this._cellEls.length - 1));
    this._cellEls.forEach((b, j) => { b.tabIndex = j === this._cellFocus ? 0 : -1; });
  }

  _setTrayFocus(i) {
    if (!this._trayEls.length) return;
    this._trayFocus = Math.max(0, Math.min(i, this._trayEls.length - 1));
    this._trayEls.forEach((b, j) => { b.tabIndex = j === this._trayFocus ? 0 : -1; });
  }

  _onGridKey(e) {
    if (!this._vm) return;
    const { w, h } = this._vm.state.grid;
    const i = this._cellFocus;
    let next = null;
    if (e.key === 'ArrowLeft') next = i % w === 0 ? i : i - 1;
    else if (e.key === 'ArrowRight') next = i % w === w - 1 ? i : i + 1;
    else if (e.key === 'ArrowUp') next = i - w >= 0 ? i - w : i;
    else if (e.key === 'ArrowDown') {
      next = i + w < w * h ? i + w : null; // fall through to tray from last row
      if (next === null) {
        e.preventDefault();
        this._focusTraySlot(this._firstEnabledTray());
        return;
      }
    } else return;
    e.preventDefault();
    this._setCellFocus(next);
    this._cellEls[next].focus();
  }

  _onTrayKey(e) {
    const i = this._trayFocus;
    let next = null;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const dir = e.key === 'ArrowRight' ? 1 : -1;
      next = i;
      for (let step = 0; step < this._trayEls.length; step++) {
        next = (next + dir + this._trayEls.length) % this._trayEls.length;
        if (!this._trayEls[next].disabled) break;
      }
    } else if (e.key === 'ArrowUp' && this._cellEls.length) {
      e.preventDefault();
      this._setCellFocus(this._cellFocus);
      this._cellEls[this._cellFocus].focus();
      return;
    } else return;
    e.preventDefault();
    this._setTrayFocus(next);
    this._trayEls[next].focus();
  }

  _firstEnabledTray() {
    const idx = this._trayEls.findIndex((b) => !b.disabled);
    return idx >= 0 ? idx : 0;
  }

  _focusTraySlot(i) {
    if (!this._trayEls.length) return;
    this._setTrayFocus(i);
    this._trayEls[i].focus();
  }

  _onTrayTap(slot) {
    if (this._busy || !this._vm) return;
    if (this._vm.state.tray[slot] == null) return;
    if (this.h && typeof this.h.onTray === 'function') {
      // main.js owns selection semantics (tap toggles); the vm echoes back.
      this._call('onTray', slot);
    } else {
      // Local fallback so the board remains usable without an owner.
      if (this._sel.tray === slot) this._sel.tray = null;
      else { this._sel.tray = slot; this._sel.cell = null; }
      this._refreshSelection();
    }
  }

  _onCellTap(i) {
    if (this._busy || !this._vm) return;
    const occupied = this._vm.state.cells[i] !== null;

    // Spec case: tray card in hand + occupied cell — explain, don't forward.
    if (occupied && this._sel.tray != null) {
      this.announce(REASON_TEXT['cell-occupied'], true);
      this.toast(REASON_TEXT['cell-occupied'], 'warn');
      return;
    }
    if (this.h && typeof this.h.onCell === 'function') {
      // Raw tap forwarding; main.js interprets place / select / swap.
      this._call('onCell', i);
    } else if (!occupied && this._sel.tray != null) {
      this._call('onCell', i);
    } else if (!occupied) {
      this.toast('Empty cell — select a tray card first.', 'info');
    } else if (this._sel.cell == null) {
      this._sel.cell = i;
      this._sel.tray = null;
      this._refreshSelection();
    } else if (this._sel.cell === i) {
      this._sel.cell = null;
      this._refreshSelection();
    } else {
      const first = this._sel.cell;
      this._sel.cell = null;
      this._call('onCell', first);
      this._call('onCell', i);
      this._refreshSelection();
    }
  }

  _refreshSelection() {
    if (!this._vm) return;
    for (const btn of this._cellEls) btn.__sig = null;
    for (const btn of this._trayEls) btn.__sig = null;
    this._syncCells(this._vm.state, this._vm);
    this._syncTray(this._vm.state, this._vm);
    this._syncActionButtons(this._vm);
  }

  // ---- settings controls -------------------------------------------------

  _wireSettings() {
    const $ = (id) => this.root.getElementById(id);
    const range = (id, fn) => { const n = $(id); if (n) n.addEventListener('input', () => fn(parseFloat(n.value))); };
    const check = (id, fn) => { const n = $(id); if (n) n.addEventListener('change', () => fn(n.checked)); };

    range('set-music', (v) => this._settingsChanged((s) => { s.audio.music = v; }));
    range('set-effects', (v) => this._settingsChanged((s) => { s.audio.effects = v; }));
    range('set-ambience', (v) => this._settingsChanged((s) => { s.audio.ambience = v; }));
    range('set-voice', (v) => this._settingsChanged((s) => { s.audio.voice = v; }));
    check('set-muted', (v) => this._settingsChanged((s) => { s.audio.muted = v; }));

    const q = $('set-quality');
    if (q) q.addEventListener('change', () => {
      if (!QUALITY_TIERS.includes(q.value)) return;
      this._settingsChanged((s) => { s.graphics.quality = q.value; });
      this._call('onQualityChange', q.value);
    });
    check('set-cvd', (v) => {
      this._settingsChanged((s) => { s.graphics.cvd = v; });
      this.applySettings(this._settings);
    });

    check('set-reduced-motion', (v) => this._settingsChanged((s) => { s.access.reducedMotion = v; }));
    check('set-high-contrast', (v) => this._settingsChanged((s) => { s.access.highContrast = v; }));
    check('set-large-text', (v) => this._settingsChanged((s) => { s.access.largeText = v; }));
    check('set-left-handed', (v) => this._settingsChanged((s) => { s.access.leftHanded = v; }));
    check('set-hold-toggle', (v) => this._settingsChanged((s) => { s.access.holdToConfirm = v; }));
    check('set-timing-assist', (v) => this._settingsChanged((s) => { s.access.timingAssist = v; }));
    check('set-haptics', (v) => this._settingsChanged((s) => { s.access.haptics = v; }));
    check('set-captions', (v) => this._settingsChanged((s) => { s.access.captions = v; }));
    check('set-telemetry', (v) => {
      this._settingsChanged((s) => { s.privacy.telemetryConsent = v; });
      this._call('onTelemetryConsent', v);
    });

    const reset = $('btn-controls-reset');
    if (reset) reset.addEventListener('click', () => {
      this._settingsChanged((s) => { s.controls.bindings = null; });
      this.announce('Keyboard bindings reset to defaults.');
      this.toast('Bindings reset to defaults', 'info');
    });

    // Live preview of accessibility toggles.
    for (const id of ['set-reduced-motion', 'set-high-contrast', 'set-large-text', 'set-left-handed', 'set-captions']) {
      const n = $(id);
      if (n) n.addEventListener('change', () => this.applySettings(this._settings));
    }

    const replay = $('btn-tutorial-replay');
    if (replay) replay.addEventListener('click', () => {
      this._settingsChanged((s) => { s.tutorial.replaySeen = false; s.tutorial.completed = []; });
      this._closeAllOverlays();
      this._call('onModeSelect', 'learn');
      this.showScreen('lessons');
      this.toast('Tutorials will play again', 'info');
    });
  }

  // ---- global keyboard ----------------------------------------------------

  _wireKeyboard() {
    this.root.addEventListener('keydown', (e) => {
      // Overlay stack: Tab traps, Esc closes (pause overlay Esc = resume).
      if (this._overlayStack.length) {
        if (e.key === 'Tab') { this._trapTab(e); return; }
        if (e.key === 'Escape') {
          e.preventDefault();
          const top = this._overlayStack[this._overlayStack.length - 1];
          if (top.name === 'pause') this._resume();
          else this.closeOverlay();
          return;
        }
        return; // no game shortcuts while a dialog is open
      }

      if (this._screen !== 'play') return;
      const t = e.target;
      if (t && t.closest && t.closest('input, textarea, select, [contenteditable="true"]')) return;

      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      switch (key) {
        case 'u': if (this._vm && this._vm.canUndo) this._call('onUndo'); break;
        case 'h': if (this._vm && this._vm.canHint) this._call('onHint'); break;
        case 'r':
          if (this._sel.tray != null) this._call('onRotate', this._sel.tray);
          break;
        case 'l':
          if (this._sel.cell != null && this._vm &&
              (this._vm.lockableCells || []).includes(this._sel.cell)) {
            this._call('onLock', this._sel.cell);
          }
          break;
        case 'p': this._pause(); break;
        case 'Escape':
          // Cancel selection by re-tapping it: main.js toggles selections
          // off on a repeated tap, keeping both selection models in sync.
          if (this._sel.tray != null) this._call('onTray', this._sel.tray);
          else if (this._sel.cell != null) this._call('onCell', this._sel.cell);
          else this._pause();
          break;
        default: return;
      }
      e.preventDefault();
    });
  }
}
