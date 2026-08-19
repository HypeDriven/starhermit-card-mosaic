// session.js — session lifecycle around the rules engine: validated commands,
// snapshots, undo, replay envelopes, hints, and elapsed-time plumbing.
// Pure logic module; the host (main.js) owns the wall clock and rendering.

import {
  createInitialState, cloneState, hashState, canonicalStringify,
  validateCommand, applyCommand, applyInvalid, terminalCondition, isSolved,
  analyzeBoard, listLegalCommands, effectiveEdges, quantizeElapsed, compareResults,
  SCHEMA_VERSION,
} from './rules.js';
import { instantiate, validateContent } from './content.js';
import { createRng } from './rng.js';

export const BUILD_VERSION = '1.0.0';
export const REPLAY_SCHEMA = 1;

let commandSeq = 0;

/**
 * mode rules: { undoAllowed, hintAllowed, ranked, label }
 */
export const MODES = Object.freeze({
  learn:     { undoAllowed: true,  hintAllowed: true,  ranked: false, label: 'Learn' },
  journey:   { undoAllowed: true,  hintAllowed: true,  ranked: false, label: 'Journey' },
  daily:     { undoAllowed: true,  hintAllowed: false, ranked: true,  label: 'Daily' },
  practice:  { undoAllowed: true,  hintAllowed: true,  ranked: false, label: 'Practice' },
  challenge: { undoAllowed: false, hintAllowed: false, ranked: true,  label: 'Challenge' },
  score:     { undoAllowed: true,  hintAllowed: false, ranked: true,  label: 'Score Chase' },
});

export class Session {
  /**
   * @param content validated content document
   * @param opts { mode, sessionId, undoAllowed?, hintAllowed?, lesson? }
   */
  constructor(content, opts = {}) {
    const v = validateContent(content);
    if (!v.ok) throw new Error('invalid content: ' + v.errors.join(','));
    this.content = content;
    this.mode = opts.mode || 'practice';
    const modeRules = MODES[this.mode] || MODES.practice;
    this.undoAllowed = opts.undoAllowed ?? modeRules.undoAllowed;
    this.hintAllowed = opts.hintAllowed ?? modeRules.hintAllowed;
    this.ranked = modeRules.ranked;
    this.sessionId = opts.sessionId || ('s-' + hashState(canonicalStringify({ c: content.contentId, t: Date.now(), r: Math.floor(Math.random() * 1e9) })));
    this.lesson = opts.lesson || null;

    this.initialState = instantiate(content);
    this.state = cloneState(this.initialState);
    this.initialHash = hashState(this.state);
    this.commands = [];        // ordered applied commands (incl. invalid markers)
    this.stateHashes = [];     // every 8 applied commands
    this.snapshots = [];       // for undo: state before each command
    this.lastMatched = analyzeBoard(this.state).matched;
    this.result = null;        // set on terminal
    this._cmdSalt = (commandSeq++ * 2654435761) >>> 0;
  }

  /** Unique, dedupe-safe command id (idempotent retry protection). */
  nextCommandId() {
    this._cmdSalt = (this._cmdSalt + 1) >>> 0;
    return this.sessionId + ':' + this._cmdSalt;
  }

  get stateHash() { return hashState(this.state); }

  /** Board analysis for UI/HUD. */
  analysis() { return analyzeBoard(this.state); }

  /** Legal commands — single source of truth for hints/tutorials/nav. */
  legalCommands() { return listLegalCommands(this.state); }

  /**
   * Dispatch a player command.
   * @param cmd command object (id optional; one is assigned when absent)
   * @param elapsedMs authoritative active-play milliseconds from the host clock
   * @returns { ok, reason?, events, terminal? }
   */
  dispatch(cmd, elapsedMs = 0) {
    if (this.result) return { ok: false, reason: 'round-over', events: [] };
    if (cmd.id === undefined) cmd = { ...cmd, id: this.nextCommandId() };
    // Stamp quantized authoritative elapsed so replays reproduce auto-settle.
    cmd = { ...cmd, elapsed: quantizeElapsed(elapsedMs) };

    const check = validateCommand(this.state, cmd);
    if (!check.ok) {
      // invalid placement stays reversible: log it, penalize, keep layout
      this.snapshots.push(cloneState(this.state));
      const events = applyInvalid(this.state, cmd, check.reason);
      this.commands.push({ ...cmd, invalid: check.reason });
      return { ok: false, reason: check.reason, events };
    }

    this.snapshots.push(cloneState(this.state));
    const events = applyCommand(this.state, cmd);
    this.commands.push(cmd);
    this._afterCommand(events, cmd.elapsed, cmd.id);
    return { ok: true, events, terminal: this.result };
  }

  _afterCommand(events, elapsedMs, triggeringId = null) {
    const pending = events.find((e) => e.type === 'terminal-pending');
    const done = events.find((e) => e.type === 'terminal');
    if (pending && !done) {
      // auto-settle through the real pipeline so replays are self-contained;
      // its id derives from the triggering command for replay determinism
      const settle = { type: 'settle', id: (triggeringId || this.nextCommandId()) + ':settle', elapsedMs: quantizeElapsed(elapsedMs) };
      const settleEvents = applyCommand(this.state, settle);
      this.commands.push(settle);
      events.push(...settleEvents);
    }
    const term = events.find((e) => e.type === 'terminal');
    if (term) {
      this.result = {
        terminalReason: term.reason,
        score: { ...this.state.score },
        elapsedMs: this.state.elapsedMs,
        movesUsed: this.state.movesUsed,
        swapsUsed: this.state.swapsUsed,
        invalidCount: this.state.invalidCount,
        sessionId: this.sessionId,
        contentId: this.content.contentId,
        contentVersion: this.content.version,
        seed: this.content.seed,
        mode: this.mode,
        assists: this._assistsUsed || { hints: 0, undos: 0 },
      };
    }
    if (this.commands.length % 8 === 0) {
      this.stateHashes.push({ n: this.commands.length, hash: this.stateHash });
    }
  }

  /** Concede the round. */
  concede(elapsedMs = 0) {
    if (this.result) return { ok: false, reason: 'round-over', events: [] };
    const cmd = { type: 'concede', id: this.nextCommandId(), elapsedMs: quantizeElapsed(elapsedMs) };
    this.snapshots.push(cloneState(this.state));
    const events = applyCommand(this.state, cmd);
    this.commands.push(cmd);
    this._afterCommand(events, elapsedMs);
    return { ok: true, events, terminal: this.result };
  }

  /**
   * Refresh the authoritative clock (timed modes): settles automatically when
   * the time limit lapses. Returns terminal result if the round just ended.
   */
  clockUpdate(elapsedMs) {
    if (this.result) return null;
    if (this.state.timeLimitMs !== null && elapsedMs >= this.state.timeLimitMs) {
      const cmd = { type: 'settle', id: this.nextCommandId(), elapsedMs: quantizeElapsed(elapsedMs) };
      this.snapshots.push(cloneState(this.state));
      const events = applyCommand(this.state, cmd);
      this.commands.push(cmd);
      this._afterCommand(events, elapsedMs);
      return this.result;
    }
    return null;
  }

  /** Undo the last command (where mode rules permit). */
  undo() {
    if (!this.undoAllowed || this.result || this.snapshots.length === 0) return { ok: false, reason: 'undo-unavailable' };
    this.state = this.snapshots.pop();
    // remove the matching log entry (and an auto-settle if it came along)
    this.commands.pop();
    this._assistsUsed = this._assistsUsed || { hints: 0, undos: 0 };
    this._assistsUsed.undos++;
    this.lastMatched = analyzeBoard(this.state).matched;
    return { ok: true, events: [{ type: 'undo' }] };
  }

  /**
   * Hint: propose a concrete legal command using the content solution,
   * verified through the same validation path as play.
   */
  hint() {
    if (!this.hintAllowed || this.result) return null;
    this._assistsUsed = this._assistsUsed || { hints: 0, undos: 0 };
    const st = this.state;
    // 1) a tray card that belongs in an empty cell
    for (let t = 0; t < st.tray.length; t++) {
      const id = st.tray[t];
      if (id === null) continue;
      for (let cell = 0; cell < st.cells.length; cell++) {
        const sol = this.content.solution[cell];
        if (!sol || sol.card !== id) continue;
        if (st.cells[cell] !== null) continue;
        const targetRot = sol.rot || 0;
        if (st.cards[id].rot !== targetRot && st.mechanics.rotation) {
          const cmd = { type: 'rotateTray', tray: t };
          if (validateCommand(st, cmd).ok) {
            this._assistsUsed.hints++;
            return { command: cmd, text: 'Rotate this tray card — its motifs are turned.', card: id, tray: t };
          }
        }
        const cmd = { type: 'place', tray: t, cell };
        if (validateCommand(st, cmd).ok) {
          this._assistsUsed.hints++;
          return { command: cmd, text: 'This card fits the highlighted cell.', card: id, tray: t, cell };
        }
      }
    }
    // 2) a misplaced card worth recalling
    for (let cell = 0; cell < st.cells.length; cell++) {
      const id = st.cells[cell];
      if (id === null || st.cards[id].locked) continue;
      const sol = this.content.solution[cell];
      if (!sol || sol.card !== id || st.cards[id].rot !== (sol.rot || 0)) {
        const cmd = { type: 'recall', cell };
        if (validateCommand(st, cmd).ok) {
          this._assistsUsed.hints++;
          return { command: cmd, text: 'This card sits better elsewhere — recall it.', card: id, cell };
        }
      }
    }
    // 3) a lockable card
    if (st.mechanics.lock) {
      for (const cmd of listLegalCommands(st)) {
        if (cmd.type === 'lock') {
          this._assistsUsed.hints++;
          return { command: cmd, text: 'This card matches all its neighbors — lock it.', cell: cmd.cell };
        }
      }
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // replay envelope
  // -------------------------------------------------------------------------

  serializeReplay() {
    return {
      schema: REPLAY_SCHEMA,
      build: BUILD_VERSION,
      contentVersion: this.content.version,
      contentId: this.content.contentId,
      seed: this.content.seed,
      initialHash: this.initialHash,
      startedAt: this.startedAt || null,
      commands: this.commands.map((c) => ({ ...c })),
      stateHashes: this.stateHashes.slice(),
      result: this.result ? { ...this.result } : null,
    };
  }

  /**
   * Deterministically replay an envelope against fresh content.
   * Returns { ok, hash, state, mismatches[] } — used by the authoritative
   * validator (server.js) and the property tests.
   */
  static replay(content, envelope) {
    const session = new Session(content, { mode: envelope.mode || 'practice', sessionId: 'replay' });
    const mismatches = [];
    if (envelope.initialHash && envelope.initialHash !== session.initialHash) {
      mismatches.push({ at: 0, expected: envelope.initialHash, actual: session.initialHash });
    }
    session._replayCommands(envelope.commands, mismatches);
    if (envelope.result && session.result) {
      if (envelope.result.terminalReason !== session.result.terminalReason ||
          envelope.result.score.total !== session.result.score.total) {
        mismatches.push({ at: 'result', expected: envelope.result, actual: session.result });
      }
    } else if (!!envelope.result !== !!session.result) {
      mismatches.push({ at: 'result', expected: envelope.result, actual: session.result });
    }
    return { ok: mismatches.length === 0, hash: session.stateHash, state: session.state, result: session.result, mismatches };
  }

  /**
   * Mirror of dispatch() driven purely by the logged command stream.
   * A logged settle that follows an identical auto-settle is verified and
   * consumed rather than applied twice.
   */
  _replayCommands(commands, mismatches = null) {
    for (let i = 0; i < commands.length; i++) {
      const raw = commands[i];
      const cmd = { ...raw };
      const invalid = cmd.invalid;
      delete cmd.invalid;
      if (cmd.type === 'settle' && this.state.status === 'terminal') {
        // auto-settle already applied: verify the logged copy agrees, and keep
        // the dedupe window identical to the live session
        if (mismatches && this.state.elapsedMs !== (cmd.elapsedMs || 0)) {
          mismatches.push({ at: i, expected: cmd.elapsedMs, actual: this.state.elapsedMs });
        }
        if (cmd.id != null && !this.state.appliedCommandIds.includes(cmd.id)) {
          this.state.appliedCommandIds.push(cmd.id);
          if (this.state.appliedCommandIds.length > 64) this.state.appliedCommandIds.shift();
        }
        this.commands.push(raw);
        continue;
      }
      const check = validateCommand(this.state, cmd);
      if (!check.ok) {
        if (mismatches && invalid !== check.reason) {
          mismatches.push({ at: i, expected: 'invalid:' + invalid, actual: 'invalid:' + check.reason });
        }
        this.snapshots.push(cloneState(this.state));
        applyInvalid(this.state, cmd, check.reason);
        this.commands.push(raw);
        continue;
      }
      this.snapshots.push(cloneState(this.state));
      const events = applyCommand(this.state, cmd);
      this.commands.push(raw);
      this._afterCommand(events, cmd.elapsed ?? cmd.elapsedMs ?? 0, cmd.id);
      if (this.result) {
        // consume any remaining logged settle copies, then stop
        continue;
      }
    }
  }

  /** Compact resumable snapshot (last-safe local save). */
  snapshot() {
    return {
      schema: REPLAY_SCHEMA,
      savedAt: new Date().toISOString(),
      content: this.content,
      mode: this.mode,
      sessionId: this.sessionId,
      commands: this.commands.map((c) => ({ ...c })),
      lessonStep: this.lessonStep ?? null,
    };
  }

  /** Restore from snapshot by replaying the command log (never trusting state). */
  static restore(snapshot) {
    let session;
    try {
      session = new Session(snapshot.content, {
        mode: snapshot.mode,
        sessionId: snapshot.sessionId,
        lesson: snapshot.lesson || null,
      });
    } catch {
      return null;
    }
    const mismatches = [];
    session._replayCommands(snapshot.commands, mismatches);
    if (mismatches.length > 0) return null; // corrupted snapshot — refuse to resume
    session.lessonStep = snapshot.lessonStep ?? null;
    return session;
  }
}

export { compareResults, isSolved, effectiveEdges, createRng };
