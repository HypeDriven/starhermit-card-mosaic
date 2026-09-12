// main.js — bootstrap and wiring. Owns the game state machine, the wall
// clock, selection model, and mediates between UI (DOM), Renderer (Three.js),
// AudioEngine, Session (rules) and Platform (host). Rendering consumes
// immutable snapshots; rules state changes only through validated commands.

import { Session, MODES, BUILD_VERSION } from './session.js';
import {
  JOURNEY, LESSONS, CHALLENGES, PRACTICE_DIFFICULTIES, MOTIFS,
  journeyContent, lessonContent, dailyContent, dailyKey,
  practiceContent, challengeContent,
} from './content.js';
import { listLegalCommands, TERMINAL, compareResults, quantizeElapsed } from './rules.js';
import { getTheme } from './themes.js';
import {
  loadSettings, saveSettings, loadProgress, saveProgress, journeyStars,
  loadAchievements, saveAchievements, unlockAchievement, ACHIEVEMENTS,
  loadBoards, saveBoards, saveSnapshot, loadSnapshot, clearSnapshot,
  analyticsSessionId,
} from './storage.js';
import { Platform } from './platform.js';
import { AudioEngine } from './audio.js';

// Renderer is optional: WebGL may be unavailable (compat mode keeps DOM board).
let Renderer = null;
try {
  ({ Renderer } = await import('./render.js'));
} catch (err) {
  console.warn('3D renderer unavailable, using DOM board only.', err);
}

const $ = (sel) => document.querySelector(sel);

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

class App {
  constructor() {
    this.phase = 'boot';
    this.settings = loadSettings();
    this.progress = loadProgress();
    this.achievements = loadAchievements();
    this.boards = loadBoards();
    this.platform = new Platform();
    this.audio = new AudioEngine(this.settings);
    this.ui = null;
    this.renderer = null;
    this.rendererWanted = true;

    this.session = null;         // active Session
    this.mode = null;
    this.lesson = null;
    this.lessonStepIndex = 0;
    this.stageIndex = null;      // journey
    this.challengeId = null;
    this.difficultyId = null;
    this.dailyDateKey = null;

    this.selectedTray = null;
    this.selectedCell = null;
    this.hintData = null;

    // wall clock: active-play milliseconds (pauses excluded)
    this.clockBase = 0;          // performance.now() at last resume
    this.clockAccum = 0;         // ms accumulated before current run segment
    this.clockRunning = false;

    this.serverOffset = 0;
    this.serverTimeSource = 'local';
    this.pausedAt = null;
    this.awaySummary = null;
    this.telemetryQueue = [];
    this.lastHeartbeat = 0;
    this.dailyCountdownTimer = null;
  }

  // -------------------------------------------------------------------------
  // boot
  // -------------------------------------------------------------------------

  async boot() {
    const { UI } = await import('./ui.js');
    this.ui = new UI(document, this._handlers());
    this.ui.applySettings(this.settings);
    this.ui.showScreen('loading');
    this.ui.setLoading(0.1, 'Rules');

    // service worker (offline after initial load); ignore failures
    if ('serviceWorker' in navigator && location.protocol !== 'file:') {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }

    await this.platform.init();
    this.ui.setLoading(0.35, 'Studio');

    // Hosted: resolve the account nickname, then prefer the remote save
    // (cloud slot) over the local cache before anything reads progress.
    if (this.platform.hosted) {
      try {
        await Promise.race([
          this.platform.fetchProfile(),
          new Promise((r) => setTimeout(r, 2500)),
        ]);
      } catch { /* nickname lands whenever it resolves */ }
      const remote = await this.platform.loadCloud();
      if (remote) this._applyCloud(remote);
      this.platform.onSync(() => {
        if (this.ui && this.ui._screen === 'profile') this.ui.showScreen('profile');
      });
    }

    const t = await this.platform.getServerTime();
    this.serverOffset = t.offsetMs;
    this.serverTimeSource = t.source;
    this.ui.setLoading(0.5, 'Table');

    // renderer
    if (Renderer && Renderer.isSupported()) {
      try {
        this.renderer = new Renderer({
          container: $('#canvas-wrap'),
          canvas: $('#game-canvas'),
          onIntent: (intent) => this._onRenderIntent(intent),
          settings: this._renderSettings(),
        });
      } catch (err) {
        console.warn('Renderer construction failed; DOM board only.', err);
        this.renderer = null;
      }
    }
    this.ui.setLoading(0.8, 'Cards');

    this._bindGlobal();
    this.ui.setLoading(1, 'Ready');
    this._transition('title');

    // resume offer
    const snap = loadSnapshot();
    if (snap && snap.content) {
      this.ui.toast('An interrupted round was saved — Resume from the title screen.', 'info');
    }
    this.platform.activityStart({ build: BUILD_VERSION });
  }

  now() { return Date.now() + this.serverOffset; }
  utcToday() { return dailyKey(new Date(this.now())); }

  /* Cloud save: the local save doc is the offline cache; hosted mirrors it
   * to the platform slot (zip+base64). Remote wins on boot. */
  _cloudDoc() {
    return {
      v: 1, at: new Date().toISOString(),
      settings: this.settings, progress: this.progress,
      achievements: this.achievements, boards: this.boards,
    };
  }

  _applyCloud(doc) {
    if (!doc || typeof doc !== 'object') return;
    if (doc.settings) { this.settings = doc.settings; saveSettings(this.settings); }
    if (doc.progress) { this.progress = doc.progress; saveProgress(this.progress); }
    if (doc.achievements) { this.achievements = doc.achievements; saveAchievements(this.achievements); }
    if (doc.boards) { this.boards = doc.boards; saveBoards(this.boards); }
  }

  /** Debounced cloud mirror; call after any persist point when hosted. */
  _mirrorCloud() {
    if (!this.platform.hosted) return;
    this.platform.saveCloud(this._cloudDoc()).catch(() => {});
  }

  // -------------------------------------------------------------------------
  // state machine
  // -------------------------------------------------------------------------

  _transition(phase, data) {
    const prev = this.phase;
    this.phase = phase;
    switch (phase) {
      case 'title':
        this._teardownRound();
        {
          const homeTheme = this.settings.graphics.theme === 'auto' ? 'studio' : this.settings.graphics.theme;
          this.ui.setTheme(homeTheme, this.settings.graphics.cvd);
          this.renderer?.setTheme(homeTheme);
        }
        this.ui.showScreen('title', {
          snapshotAvailable: !!(loadSnapshot() || {}).content,
          journeyDone: Object.keys(this.progress.journey).length,
          journeyTotal: JOURNEY.length,
          dailyKey: this.utcToday(),
          dailyDone: !!this.progress.dailies[this.utcToday()],
          serverTimeSource: this.serverTimeSource,
        });
        this._startDailyCountdown();
        this.audio.setMusicIntensity(1);
        break;
      case 'mode-select':
        this.ui.showScreen('modes', { modes: MODES, serverTimeSource: this.serverTimeSource });
        break;
      case 'preparing':
        this.ui.showScreen('setup', data);
        break;
      case 'active':
        this.ui.showScreen('play');
        this._startClock();
        this._pushView();
        this.audio.setMusicIntensity(2);
        break;
      case 'paused':
        this._stopClock();
        this.pausedAt = performance.now();
        this.ui.openOverlay('pause');
        this.audio.playEvent('pause');
        this.audio.duck();
        break;
      case 'resolving':
        this.ui.setBusy(true);
        break;
      case 'results': {
        this._stopClock();
        this.audio.setMusicIntensity(1);
        this.audio.unduck();
        const result = this.session.result;
        const breakdown = this._scoreBreakdown(result);
        const stars = this.mode === 'journey' ? journeyStars(result, this.session.content.goals.par) : 0;
        const newly = this._applyOutcome(result);
        this._submitResult(result);
        clearSnapshot();
        this.ui.showScreen('results');
        this.ui.resultsView({
          result,
          breakdown,
          par: this.session.content.goals.par,
          stars,
          isNewBest: this._lastWasNewBest,
          nextAction: this._nextAction(),
          achievements: newly.map((k) => ACHIEVEMENTS.find((a) => a.key === k)),
          mode: this.mode,
          lesson: this.lesson,
          stageIndex: this.stageIndex,
        });
        this.audio.playEvent(result.terminalReason === TERMINAL.COMPLETE ? 'complete' : 'fail');
        if (this._lastWasNewBest) setTimeout(() => this.audio.playEvent('newBest'), 700);
        if (result.terminalReason === TERMINAL.COMPLETE) this._haptic([30, 60, 30]);
        this._telemetry('round-end', { mode: this.mode, reason: result.terminalReason, score: result.score.total });
        break;
      }
      case 'progression':
        this.ui.showScreen('journey', { journey: JOURNEY, progress: this.progress });
        break;
      default:
        this.ui.showScreen(phase, data);
    }
    if (prev !== phase) this.ui.announce(this._phaseAnnouncement(phase), false);
  }

  _phaseAnnouncement(phase) {
    return {
      title: 'Title screen', 'mode-select': 'Choose a mode', preparing: 'Round setup',
      active: 'Round started', paused: 'Paused', results: 'Round results',
      progression: 'Journey map',
    }[phase] || phase;
  }

  // -------------------------------------------------------------------------
  // round lifecycle
  // -------------------------------------------------------------------------

  _startRound(content, mode, extras = {}) {
    this._teardownRound();
    this.session = new Session(content, {
      mode,
      lesson: extras.lesson || null,
    });
    this.session.startedAt = new Date(this.now()).toISOString();
    this.mode = mode;
    this.lesson = extras.lesson || null;
    this.lessonStepIndex = 0;
    this.stageIndex = extras.stageIndex ?? null;
    this.challengeId = extras.challengeId ?? null;
    this.difficultyId = extras.difficultyId ?? null;
    this.selectedTray = null;
    this.selectedCell = null;
    this.hintData = null;
    this.clockAccum = 0;
    this.clockRunning = false;
    // match SFX compares against the previous board event of *this* round
    this._prevMatched = undefined;
    this._lastWasNewBest = false;
    this._timeWarned = false;

    this.audio.setSeed(content.seed);
    this.ui.setTheme(this._themeFor(content), this.settings.graphics.cvd);
    if (this.renderer) {
      try {
        this.renderer.load(content, this._themeFor(content));
      } catch (err) {
        console.error('renderer load failed; continuing with DOM board', err);
        this._dropRenderer();
      }
    }
    this.audio.startAmbience(this._themeFor(content));
    this.progress.sessionsPlayed++;
    saveProgress(this.progress);
    this._telemetry('start', { mode });
    this._transition('active');
  }

  /**
   * Persist the live round. The session log alone cannot describe *which*
   * journey stage / challenge / daily produced it, nor the active tutorial
   * step or the wall clock, so round context rides along under `meta`.
   */
  _saveSnapshot() {
    if (!this.session) return;
    saveSnapshot({
      ...this.session.snapshot(),
      meta: {
        stageIndex: this.stageIndex,
        challengeId: this.challengeId,
        difficultyId: this.difficultyId,
        dailyDateKey: this.dailyDateKey,
        lessonId: this.lesson ? this.lesson.id : null,
        lessonStepIndex: this.lessonStepIndex,
        elapsedMs: this.elapsedMs(),
      },
    });
  }

  _teardownRound() {
    this._stopClock();
    if (this.dailyCountdownTimer) { clearInterval(this.dailyCountdownTimer); this.dailyCountdownTimer = null; }
    this.audio.stopAmbience();
    this.session = null;
    this.lesson = null;
    this.selectedTray = null;
    this.selectedCell = null;
    this.ui?.setBusy(false);
  }

  _themeFor(content) {
    const s = this.settings.graphics.theme;
    return !s || s === 'auto' ? (content?.theme || 'studio') : s;
  }

  _renderSettings() {
    return {
      quality: this.settings.graphics.quality,
      reducedMotion: this.settings.access.reducedMotion,
      cvd: this.settings.graphics.cvd,
      theme: this.settings.graphics.theme === 'auto' ? 'studio' : this.settings.graphics.theme,
    };
  }

  _dropRenderer() {
    if (this.renderer) { try { this.renderer.dispose(); } catch {} this.renderer = null; }
    this.ui.showScreen('compat', { canContinue: !!this.session });
  }

  // -------------------------------------------------------------------------
  // clock (authoritative elapsed, pauses excluded)
  // -------------------------------------------------------------------------

  _startClock() {
    if (!this.clockRunning) {
      this.clockBase = performance.now();
      this.clockRunning = true;
    }
  }
  _stopClock() {
    if (this.clockRunning) {
      this.clockAccum += performance.now() - this.clockBase;
      this.clockRunning = false;
    }
  }
  elapsedMs() {
    return quantizeElapsed(this.clockAccum + (this.clockRunning ? performance.now() - this.clockBase : 0));
  }

  // -------------------------------------------------------------------------
  // selection + commands
  // -------------------------------------------------------------------------

  _onRenderIntent(intent) {
    if (!this.session || this.phase !== 'active') return;
    if (intent.kind === 'cell') this._onCell(intent.cell);
    else if (intent.kind === 'tray') this._onTray(intent.tray);
    else this._clearSelection();
  }

  _onTray(tray) {
    if (!this.session || this.session.result) return;
    this.audio.resume();
    if (this.selectedTray === tray) {
      this.selectedTray = null;
    } else if (this.session.state.tray[tray] !== null) {
      this.selectedTray = tray;
      this.selectedCell = null;
      this.audio.playEvent('select');
    }
    this._pushView();
  }

  _onCell(cell) {
    const s = this.session;
    if (!s || s.result || this.phase !== 'active') return;
    this.audio.resume();
    const occupied = s.state.cells[cell] !== null;

    if (!occupied && this.selectedTray !== null) {
      this._dispatch({ type: 'place', tray: this.selectedTray, cell });
      return;
    }
    if (!occupied && this.selectedCell !== null) {
      // move = recall + place would chain two commands; explain instead
      this.ui.toast('Recall the card first, then place it here.', 'warn');
      this.audio.playEvent('invalid');
      return;
    }
    if (occupied) {
      if (this.selectedCell === null) {
        this.selectedCell = cell;
        this.selectedTray = null;
        this.audio.playEvent('select');
      } else if (this.selectedCell === cell) {
        this.selectedCell = null;
      } else {
        this._dispatch({ type: 'swap', a: this.selectedCell, b: cell });
        return;
      }
    } else if (this.selectedTray === null) {
      this.ui.toast('Select a tray card first.', 'info');
    }
    this._pushView();
  }

  _clearSelection() {
    this.selectedTray = null;
    this.selectedCell = null;
    this._pushView();
  }

  _dispatch(cmd) {
    const s = this.session;
    if (!s || s.result) return;
    const res = s.dispatch(cmd, this.elapsedMs());
    this._handleEvents(res.events || [], res.ok);
    if (res.ok) {
      this.selectedTray = null;
      this.selectedCell = null;
      this.hintData = null;
      this._checkLessonProgress(cmd.type);
      this._saveSnapshot();
    }
    if (res.terminal) {
      this._transition('resolving');
      // cosmetic animations may continue; skip settles deterministically
      setTimeout(() => {
        this.renderer?.skipAnimations();
        this._transition('results');
      }, this.settings.access.reducedMotion ? 60 : 900);
    }
    this._pushView();
  }

  _handleEvents(events, ok) {
    if (!ok) {
      const inv = events.find((e) => e.type === 'invalid');
      if (inv) { this.audio.playEvent('invalid'); this._haptic([20, 40, 20]); }
    } else {
      for (const e of events) {
        if (e.type === 'place') this.audio.playEvent('place');
        else if (e.type === 'recall') this.audio.playEvent('recall');
        else if (e.type === 'swap') this.audio.playEvent('swap');
        else if (e.type === 'rotateTray') this.audio.playEvent('rotate');
        else if (e.type === 'lock') this.audio.playEvent('lock');
        else if (e.type === 'board' && this._prevMatched !== undefined && e.matched > this._prevMatched) this.audio.playEvent('match');
        if (e.type === 'board') this._prevMatched = e.matched;
      }
    }
    this.ui.playEvents(events, this.session.state);
    if (this.renderer) this.renderer.playEvents(events, this.session.state);
  }

  /** Optional haptic pulse (Accessibility > Haptic feedback); never throws. */
  _haptic(pattern) {
    if (!this.settings.access.haptics) return;
    try {
      if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function' &&
          navigator.userActivation?.hasBeenActive !== false) navigator.vibrate(pattern);
    } catch { /* haptics are optional */ }
  }

  // -------------------------------------------------------------------------
  // lessons (tutorial steps verified through the same command pipeline)
  // -------------------------------------------------------------------------

  _checkLessonProgress(cmdType) {
    if (!this.lesson) return;
    const steps = this.lesson.steps;
    const step = steps[this.lessonStepIndex];
    if (!step) return;
    if (step.require.type === cmdType) {
      this.lessonStepIndex++;
      this._telemetry('tutorial-step', { lesson: this.lesson.id, step: step.id });
      this.audio.playEvent('hint');
      if (steps[this.lessonStepIndex]) {
        this.ui.announce(steps[this.lessonStepIndex].text);
      }
    }
  }

  // -------------------------------------------------------------------------
  // view model push (UI + renderer consume the same snapshot)
  // -------------------------------------------------------------------------

  _pushView() {
    const s = this.session;
    if (!s) return;
    const st = s.state;
    const legal = this.selectedTray !== null ? listLegalCommands(st) : [];
    const legalCells = legal.filter((c) => c.type === 'place' && c.tray === this.selectedTray).map((c) => c.cell);
    const lockableCells = listLegalCommands(st).filter((c) => c.type === 'lock').map((c) => c.cell);
    const analysis = s.analysis();
    const elapsed = this.elapsedMs();
    const step = this.lesson ? this.lesson.steps[this.lessonStepIndex] : null;
    const vm = {
      state: st,
      content: s.content,
      mode: this.mode,
      lesson: this.lesson,
      lessonStep: step,
      lessonStepIndex: this.lessonStepIndex,
      elapsedMs: elapsed,
      ranked: s.ranked,
      canUndo: s.undoAllowed && s.snapshots.length > 0 && !s.result,
      canHint: s.hintAllowed && !s.result,
      canRotate: st.mechanics.rotation && this.selectedTray !== null && st.tray[this.selectedTray] !== null,
      canLock: st.mechanics.lock && this.selectedCell !== null && lockableCells.includes(this.selectedCell),
      canRecall: this.selectedCell !== null && st.cells[this.selectedCell] !== null && !st.cards[st.cells[this.selectedCell]].locked,
      selectedTray: this.selectedTray,
      selectedCell: this.selectedCell,
      legalCells,
      lockableCells,
      hintCell: this.hintData?.cell ?? null,
      hintTray: this.hintData?.tray ?? null,
      movesLeft: st.moveLimit !== null ? Math.max(0, st.moveLimit - st.movesUsed) : null,
      timeLeftMs: st.timeLimitMs !== null ? Math.max(0, st.timeLimitMs - elapsed) : null,
      analysis,
      score: st.score,
      motifs: MOTIFS,
    };
    this.ui.setSessionView(vm);
    if (this.renderer) {
      this.renderer.syncState(st, {
        selectedTray: this.selectedTray,
        selectedCell: this.selectedCell,
        hintTray: vm.hintTray,
        hintCell: vm.hintCell,
        legalCells,
        lockableCells,
        keyboardFocus: null,
      });
    }
  }

  // -------------------------------------------------------------------------
  // outcomes, achievements, progression, boards
  // -------------------------------------------------------------------------

  _scoreBreakdown(result) {
    const s = result.score;
    const rows = [
      { label: 'Matched edges', value: s.matched },
      { label: 'Locked cards', value: s.locks },
      { label: 'Completion bonus', value: s.completion },
      { label: 'Time bonus', value: s.timeBonus },
      { label: 'Swap penalty', value: -s.swapPenalty },
      { label: 'Invalid actions', value: -s.invalidPenalty },
      { label: 'Total', value: s.total, total: true },
    ];
    return rows;
  }

  _applyOutcome(result) {
    const newly = [];
    const p = this.progress;
    const done = result.terminalReason === TERMINAL.COMPLETE;
    // modes without a persisted best (practice, learn, score chase) must not
    // inherit the previous round's verdict
    this._lastWasNewBest = false;

    if (done) newly.push(...this._unlock('first_completion'));

    if (this.mode === 'journey' && this.stageIndex !== null) {
      const stage = JOURNEY[this.stageIndex];
      const rec = p.journey[stage.id] || {};
      const stars = journeyStars(result, this.session.content.goals.par);
      const best = Math.max(rec.bestScore || 0, result.score.total);
      this._lastWasNewBest = done && result.score.total > (rec.bestScore || 0);
      p.journey[stage.id] = {
        completed: rec.completed || done,
        bestScore: best,
        bestMoves: Math.min(rec.bestMoves ?? 1e9, result.movesUsed),
        stars: Math.max(rec.stars || 0, stars),
        completedAt: rec.completedAt || (done ? new Date(this.now()).toISOString() : null),
      };
      if (done) {
        p.masteryXp += stage.mastery ? 3 : 1;
        const mech = this.session.content.mechanics;
        if (mech.rotation && mech.lock && mech.decoys) newly.push(...this._unlock('mechanic_mastery'));
        // chapter clear
        const chapterStages = JOURNEY.filter((j) => j.chapter === stage.chapter);
        if (chapterStages.every((j) => (p.journey[j.id] || {}).completed)) newly.push(...this._unlock('chapter_clear'));
        const masteriesDone = JOURNEY.filter((j) => j.mastery && (p.journey[j.id] || {}).completed).length;
        if (masteriesDone >= 10) newly.push(...this._unlock('mastery_10'));
      }
    }
    if (this.mode === 'learn' && this.lesson && done) {
      p.lessons[this.lesson.id] = { completed: true };
      if (!this.settings.tutorial.completed.includes(this.lesson.id)) {
        this.settings.tutorial.completed.push(this.lesson.id);
        saveSettings(this.settings);
      }
    }
    if (this.mode === 'daily') {
      const key = this.dailyDateKey || this.utcToday();
      const prev = p.dailies[key];
      this._lastWasNewBest = !prev || result.score.total > prev.score;
      p.dailies[key] = {
        score: Math.max(prev?.score || 0, result.score.total),
        completed: (prev?.completed || done),
        result: { total: result.score.total, reason: result.terminalReason },
      };
      if (done) {
        const days = Object.values(p.dailies).filter((d) => d.completed).length;
        if (days >= 7) newly.push(...this._unlock('streak_7'));
      }
    }
    if (this.mode === 'challenge' && this.challengeId) {
      const prev = p.challenges[this.challengeId] || {};
      this._lastWasNewBest = done && result.score.total > (prev.bestScore || 0);
      p.challenges[this.challengeId] = {
        bestScore: Math.max(prev.bestScore || 0, result.score.total),
        completed: prev.completed || done,
      };
    }
    if (p.sessionsPlayed >= 50) newly.push(...this._unlock('long_haul'));
    saveProgress(p);
    this._mirrorCloud();
    return newly;
  }

  _unlock(key) {
    if (unlockAchievement(this.achievements, key)) {
      saveAchievements(this.achievements);
      this._mirrorCloud();
      const meta = ACHIEVEMENTS.find((a) => a.key === key);
      this.ui.toast(`Achievement unlocked: ${meta?.name || key}`, 'achievement');
      this.audio.playEvent('achievement');
      // mirror to the host when hosted; idempotent server-side, best effort
      this.platform.postAchievement(key).catch(() => {});
      return [key];
    }
    return [];
  }

  _nextAction() {
    if (this.mode === 'journey' && this.stageIndex !== null && this.session.result.terminalReason === TERMINAL.COMPLETE) {
      const next = this.stageIndex + 1;
      if (next < JOURNEY.length) return { label: 'Next stage', action: 'next' };
      return { label: 'Journey complete — back to map', action: 'map' };
    }
    if (this.mode === 'learn') {
      const idx = LESSONS.findIndex((l) => l.id === this.lesson.id);
      if (idx >= 0 && idx + 1 < LESSONS.length) return { label: 'Next lesson', action: 'next' };
      return { label: 'Lessons done — to title', action: 'title' };
    }
    return { label: 'Play again', action: 'retry' };
  }

  async _submitResult(result) {
    const boardKey = result.contentId;
    // local board always
    const entry = {
      score: result.score.total,
      result,
      at: new Date(this.now()).toISOString(),
      assists: result.assists,
      sessionId: result.sessionId,
      name: this.profileName() || 'Guest',
    };
    const list = this.boards.entries[boardKey] || [];
    list.push(entry);
    list.sort((a, b) => compareResults(a.result, b.result));
    this.boards.entries[boardKey] = list.slice(0, 100);
    saveBoards(this.boards);
    this._mirrorCloud();
    // ranked modes: submit to the own-server backend when available
    if (this.session.ranked) {
      const replay = this.session.serializeReplay();
      const resp = await this.platform.submitScore({
        board: boardKey,
        entry: {
          result, replay,
          name: this.profileName() || 'You',
          playerId: this.platform.userId || undefined,
        },
      });
      if (!resp.ok && resp.error !== 'offline') {
        this.ui.toast('Score submission failed: ' + resp.error, 'warn');
      }
    }
  }

  profileName() {
    // Hosted: the platform account nickname; offline: the local profile name.
    const hostedName = this.platform.profile && !this.platform.profile.guest && this.platform.profile.name;
    return hostedName || this._profileName || '';
  }

  syncText() {
    if (!this.platform.hosted) return 'Offline — progress saves on this device.';
    return this.platform.sync === 'synced' ? 'Cloud save synced.'
      : this.platform.sync === 'saving' ? 'Saving to cloud…'
      : 'Cloud sync unavailable — local copy is current.';
  }

  // -------------------------------------------------------------------------
  // telemetry (anonymous funnel events only, consent-gated)
  // -------------------------------------------------------------------------

  _telemetry(type, data = {}) {
    if (!this.settings.privacy.telemetryConsent) return;
    this.telemetryQueue.push({ type, ...data, at: Date.now(), sid: analyticsSessionId() });
    if (this.telemetryQueue.length >= 10) this._flushTelemetry();
  }
  _flushTelemetry() {
    if (this.telemetryQueue.length === 0) return;
    const batch = this.telemetryQueue.splice(0);
    this.platform.postTelemetry(batch);
  }

  // -------------------------------------------------------------------------
  // daily countdown (synchronized to platform time)
  // -------------------------------------------------------------------------

  _startDailyCountdown() {
    if (this.dailyCountdownTimer) clearInterval(this.dailyCountdownTimer);
    const update = () => {
      const now = this.now();
      const next = Date.parse(dailyKey(new Date(now)) + 'T00:00:00Z') + 86400000;
      const ms = Math.max(0, next - now);
      const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000), s = Math.floor((ms % 60000) / 1000);
      const el = $('#daily-countdown');
      if (el) el.textContent = `${h}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
    };
    update();
    this.dailyCountdownTimer = setInterval(update, 1000);
  }

  // -------------------------------------------------------------------------
  // HUD tick (10 Hz) — clock, timed-mode settle, presence heartbeat
  // -------------------------------------------------------------------------

  _hudTick() {
    if (!this.session || this.phase !== 'active') return;
    const res = this.session.clockUpdate(this.elapsedMs());
    if (res) {
      this._transition('resolving');
      setTimeout(() => { this.renderer?.skipAnimations(); this._transition('results'); }, 300);
      return;
    }
    this._pushView();
    // timed rounds: one warning cue when 10 s remain
    const st = this.session.state;
    if (st.timeLimitMs !== null && !this._timeWarned) {
      const left = st.timeLimitMs - this.elapsedMs();
      if (left > 0 && left <= 10000) {
        this._timeWarned = true;
        this.audio.playEvent('timeWarning');
        this.ui.announce('Ten seconds left.', true);
      }
    }
    const now = performance.now();
    if (now - this.lastHeartbeat > 30000) {
      this.lastHeartbeat = now;
      this.platform.presenceHeartbeat({ mode: this.mode });
    }
  }

  // -------------------------------------------------------------------------
  // global bindings: visibility, resize, gamepad, first-gesture audio
  // -------------------------------------------------------------------------

  _bindGlobal() {
    setInterval(() => this._hudTick(), 100);

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        if (this.phase === 'active') {
          this._transition('paused');
          this._wasAutoPaused = true;
        }
        this._flushTelemetry();
      } else if (this._wasAutoPaused && this.session) {
        // "while you were away" — solo simulation paused, clock preserved
        const awayMs = this.pausedAt ? performance.now() - this.pausedAt : 0;
        const mins = Math.floor(awayMs / 60000);
        this.ui.toast(`Welcome back — paused for ${mins > 0 ? mins + ' min' : Math.round(awayMs / 1000) + ' s'}. Your clock was stopped.`, 'info');
        this._wasAutoPaused = false;
        this.platform.getServerTime().then((t) => { this.serverOffset = t.offsetMs; });
      }
    });

    window.addEventListener('resize', () => this.renderer?.resize());
    window.addEventListener('orientationchange', () => setTimeout(() => this.renderer?.resize(), 120));

    const unlock = () => { this.audio.resume(); };
    window.addEventListener('pointerdown', unlock, { once: false });
    window.addEventListener('keydown', unlock, { once: false });

    window.addEventListener('error', (e) => this._telemetry('error', { category: String(e.message || 'unknown').slice(0, 40) }));

    // close the host activity so playtime is accurate (spec §"Start and end
    // launch activity"); pagehide fires on mobile where unload does not
    window.addEventListener('pagehide', () => {
      if (this.session && !this.session.result) { this._stopClock(); this._saveSnapshot(); }
      this._flushTelemetry();
      this.platform.activityEnd({ build: BUILD_VERSION, mode: this.mode || null });
    }, { once: true });

    // gamepad: translate to synthetic keyboard events the UI already handles
    this._gamepadPrev = {};
    const pad = () => {
      const gp = navigator.getGamepads ? [...navigator.getGamepads()].find(Boolean) : null;
      if (gp) {
        const map = [
          [14, 'ArrowLeft'], [15, 'ArrowRight'], [12, 'ArrowUp'], [13, 'ArrowDown'],
          [0, 'Enter'], [1, 'Escape'], [9, 'p'], [3, 'h'], [2, 'u'],
        ];
        for (const [btn, key] of map) {
          const pressed = gp.buttons[btn]?.pressed;
          if (pressed && !this._gamepadPrev[btn]) {
            document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
          }
          this._gamepadPrev[btn] = pressed;
        }
      }
      requestAnimationFrame(pad);
    };
    requestAnimationFrame(pad);

    // WebGL context recovery: rebuild GPU resources from retained state
    const canvas = $('#game-canvas');
    if (canvas) {
      canvas.addEventListener('webglcontextlost', (e) => {
        e.preventDefault();
        this._contextLost = true;
      });
      canvas.addEventListener('webglcontextrestored', () => {
        if (this.session && this.renderer) {
          try {
            this.renderer.load(this.session.content, this._themeFor(this.session.content));
            this._pushView();
            this._contextLost = false;
          } catch { this._dropRenderer(); }
        }
      });
    }
  }

  // -------------------------------------------------------------------------
  // UI handlers
  // -------------------------------------------------------------------------

  _handlers() {
    return {
      onPlay: () => this._transition('mode-select'),
      onModeSelect: (mode) => this._modeSetup(mode),
      onDaily: () => this._modeSetup('daily'),
      onJourneyStage: (i) => this._startJourney(i),
      onLesson: (id) => this._startLesson(id),
      onPractice: (diff) => this._startPractice(diff),
      onChallenge: (id) => this._startChallenge(id),
      onScoreChase: () => this._showBoards(),
      onResumeSnapshot: () => this._resumeSnapshot(),
      onDiscardSnapshot: () => { clearSnapshot(); this._transition('title'); },

      onResume: () => { this.ui.closeOverlay(); this.audio.unduck(); this._transition('active'); },
      onPause: () => { if (this.phase === 'active') this._transition('paused'); },
      onLeave: () => {
        // "Leave" is an interruption, not a concession: the round is stored
        // live so Resume picks it up exactly where it stopped. Conceding is a
        // separate, explicitly confirmed action.
        if (this.session && !this.session.result) {
          this._stopClock();
          this._saveSnapshot();
        }
        this.ui.closeOverlay();
        this._transition('title');
      },
      onRestart: () => this._restartCurrent(),
      onConcede: () => {
        if (this.session && !this.session.result) {
          const r = this.session.concede(this.elapsedMs());
          this._handleEvents(r.events, true);
          this._transition('results');
        }
      },

      onUndo: () => {
        if (!this.session) return;
        const r = this.session.undo();
        if (r.ok) {
          this.audio.playEvent('undo');
          this._saveSnapshot();
          this._clearSelection();
        } else {
          this.ui.toast('Undo is not available here.', 'warn');
        }
      },
      onHint: () => {
        if (!this.session) return;
        const h = this.session.hint();
        if (h) {
          this.hintData = h;
          this.audio.playEvent('hint');
          this.ui.announce(h.text);
          this._pushView();
        } else {
          this.ui.toast('No hint available right now.', 'info');
        }
      },
      onRotate: () => {
        if (this.selectedTray !== null) this._dispatch({ type: 'rotateTray', tray: this.selectedTray });
      },
      onLock: () => {
        if (this.selectedCell !== null) this._dispatch({ type: 'lock', cell: this.selectedCell });
      },
      onRecall: () => {
        if (this.selectedCell !== null) this._dispatch({ type: 'recall', cell: this.selectedCell });
      },

      onCell: (cell) => this._onCell(cell),
      onTray: (tray) => this._onTray(tray),

      onSettingsChanged: (settings) => {
        this.settings = settings;
        saveSettings(settings);
        this.ui.applySettings(settings);
        if (this.renderer) {
          this.renderer.setQuality(settings.graphics.quality);
          this.renderer.setReducedMotion(settings.access.reducedMotion);
          this.renderer.setCvd(settings.graphics.cvd);
          this.renderer.setTheme(settings.graphics.theme === 'auto'
            ? this._themeFor(this.session?.content)
            : settings.graphics.theme);
        }
        this.audio.setBusVolume('music', settings.audio.music);
        this.audio.setBusVolume('effects', settings.audio.effects);
        this.audio.setBusVolume('ambience', settings.audio.ambience);
        this.audio.setBusVolume('voice', settings.audio.voice);
        this.audio.setMuted(settings.audio.muted);
        this._telemetry('settings-change', {});
      },
      onThemeChange: (themeId) => {
        this.settings.graphics.theme = themeId;
        saveSettings(this.settings);
        const resolved = themeId === 'auto' ? this._themeFor(this.session?.content) : themeId;
        if (this.renderer) this.renderer.setTheme(resolved);
        this.ui.setTheme(resolved, this.settings.graphics.cvd);
      },
      onQualityChange: (q) => {
        this.settings.graphics.quality = q;
        saveSettings(this.settings);
        this.renderer?.setQuality(q);
      },
      onResultsAction: (action) => this._resultsAction(action),
      onTelemetryConsent: (v) => {
        this.settings.privacy.telemetryConsent = v;
        saveSettings(this.settings);
      },
      onCompatDismiss: () => this._transition(this.session ? 'active' : 'title'),
      onOverlayOpen: (name) => { if (name !== 'pause') this.audio.playEvent('uiOpen'); },
      onOverlayClose: () => this.audio.playEvent('uiClose'),
      onProfileSave: (name) => { this._profileName = String(name || '').slice(0, 24); },
      onProfileData: () => ({
        name: this.profileName(),
        account: !!this.platform.hosted,
        sync: this.syncText(),
      }),
      onReplayTutorial: () => this.ui.showScreen('lessons', { lessons: LESSONS, progress: this.progress }),
    };
  }

  _modeSetup(mode) {
    switch (mode) {
      case 'learn':
        this.ui.showScreen('lessons', { lessons: LESSONS, progress: this.progress });
        break;
      case 'journey':
        this._transition('progression');
        break;
      case 'daily': {
        const key = this.utcToday();
        this.dailyDateKey = key;
        const content = dailyContent(key);
        this._transition('preparing', this._setupData('daily', content));
        break;
      }
      case 'practice':
        this._transition('preparing', this._setupData('practice', null));
        break;
      case 'challenge':
        this.ui.showScreen('challenges', { challenges: CHALLENGES, progress: this.progress });
        break;
      case 'score':
        this._showBoards();
        break;
    }
  }

  _setupData(mode, content) {
    const base = {
      mode,
      ranked: MODES[mode].ranked,
      players: 1,
      assists: { undo: MODES[mode].undoAllowed, hints: MODES[mode].hintAllowed },
    };
    if (mode === 'daily') {
      return {
        ...base,
        title: 'Daily Mosaic — ' + (this.dailyDateKey || this.utcToday()),
        rules: 'One shared seed for everyone today. Complete the mosaic; fewest invalid actions and fastest time break ties.',
        duration: '5–10 min',
        start: () => this._startRound(content, 'daily'),
        content,
      };
    }
    if (mode === 'practice') {
      return {
        ...base,
        title: 'Practice',
        rules: 'Unranked. Undo and hints allowed. Pick a difficulty.',
        duration: '3–15 min',
        difficulties: PRACTICE_DIFFICULTIES,
        start: (diffId) => this._startPractice(diffId),
      };
    }
    return base;
  }

  _startJourney(i) {
    const content = journeyContent(i);
    if (!content) return;
    this._startRound(content, 'journey', { stageIndex: i });
  }
  _startLesson(id) {
    const got = lessonContent(id);
    if (!got) return;
    this._startRound(got.content, 'learn', { lesson: got.lesson });
    this.ui.announce(got.lesson.intro, true);
  }
  _startPractice(diffId) {
    const seed = 'p-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e6).toString(36);
    this._startRound(practiceContent(diffId || 'casual', seed), 'practice', { difficultyId: diffId });
  }
  _startChallenge(id) {
    const c = CHALLENGES.find((x) => x.id === id);
    if (!c) return;
    this._startRound(challengeContent(id, 'fixed-' + id), 'challenge', { challengeId: id });
  }

  _restartCurrent() {
    if (!this.session) return;
    const content = this.session.content;
    const mode = this.mode;
    const extras = { lesson: this.lesson, stageIndex: this.stageIndex, challengeId: this.challengeId, difficultyId: this.difficultyId };
    this._telemetry('retry', { mode });
    this._startRound(content, mode, extras);
  }

  _resultsAction(action) {
    if (action === 'retry') this._restartCurrent();
    else if (action === 'next') {
      if (this.mode === 'journey' && this.stageIndex !== null) this._startJourney(this.stageIndex + 1);
      else if (this.mode === 'learn') {
        const idx = LESSONS.findIndex((l) => l.id === this.lesson.id);
        if (idx + 1 < LESSONS.length) this._startLesson(LESSONS[idx + 1].id);
        else this._transition('title');
      }
    } else if (action === 'map') this._transition('progression');
    else this._transition('title');
  }

  _resumeSnapshot() {
    const snap = loadSnapshot();
    if (!snap) return this._transition('title');
    const session = Session.restore(snap);
    if (!session) {
      clearSnapshot();
      this.ui.toast('Saved round was corrupted and has been cleared.', 'warn');
      return this._transition('title');
    }
    this._teardownRound();
    const meta = snap.meta || {};
    this.session = session;
    this.mode = session.mode;
    this.stageIndex = meta.stageIndex ?? null;
    this.challengeId = meta.challengeId ?? null;
    this.difficultyId = meta.difficultyId ?? null;
    this.dailyDateKey = meta.dailyDateKey ?? null;
    this.lesson = meta.lessonId ? (LESSONS.find((l) => l.id === meta.lessonId) || null) : null;
    session.lesson = this.lesson;
    this.lessonStepIndex = meta.lessonStepIndex ?? snap.lessonStep ?? 0;
    this.clockAccum = Math.max(session.state.elapsedMs, meta.elapsedMs || 0);
    this.clockRunning = false;
    this._prevMatched = undefined;
    this._timeWarned = false;
    this.selectedTray = null;
    this.selectedCell = null;
    this.hintData = null;
    this.audio.setSeed(session.content.seed);
    this.ui.setTheme(this._themeFor(session.content), this.settings.graphics.cvd);
    if (this.renderer) {
      try { this.renderer.load(session.content, this._themeFor(session.content)); }
      catch { this._dropRenderer(); }
    }
    this.audio.startAmbience(this._themeFor(session.content));
    if (session.result) this._transition('results');
    else this._transition('active');
  }

  async _showBoards() {
    const local = this.boards.entries;
    // host boards are keyed by contentId (see server.js handleScores), so the
    // daily board is "daily-<utc date>", never the bare mode name
    const remote = await this.platform.fetchLeaderboard({
      board: dailyContent(this.utcToday()).contentId,
      scope: 'global',
    });
    let remoteEntries = null;
    if (remote.ok) {
      // Resolve account ids to profile nicknames; fall back to the stored
      // (self-asserted) name.
      remoteEntries = await Promise.all(remote.entries.map(async (e) => {
        const name = e.playerId
          ? await this.platform.profileFor(e.playerId)
          : (e.name || 'Anonymous');
        return { ...e, name };
      }));
    }
    this.ui.showScreen('boards', {
      local,
      remote: remoteEntries,
      validated: remote.ok ? remote.validated : false, // unvalidated boards are labeled casual
      dailies: this.progress.dailies,
    });
  }
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

const app = new App();
window.__cm = app; // support/debug handle (read-only introspection in tests)
app.boot().catch((err) => {
  console.error(err);
  document.body.innerHTML = '<main style="padding:2rem;font-family:system-ui"><h1>Card Mosaic</h1><p>Something went wrong while starting. Please reload.</p></main>';
});
