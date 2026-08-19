# Card Mosaic — Architecture Contract

Browser game, ES modules, no build step. Entry `index.html` loads `js/main.js` (`<script type="module">`). Three.js r160 is vendored at `vendor/three.module.js` and imported via import map (`"three": "./vendor/three.module.js"`). All modules are plain ES modules; `js/rules.js`, `js/rng.js`, `js/content.js`, `js/session.js` must stay environment-agnostic (importable in node — the test suite and `server.js` import them).

## Existing modules (do not modify; code against these APIs)

### js/rng.js
`hashString(str)`, `class RngStream { float(), int(n), intRange(a,b), pick(arr), shuffle(arr), fork(name) }`, `createRng(seedString)`.

### js/rules.js (pure rules engine)
- Constants: `RULES_VERSION`, `SCORE` (PER_MATCHED_EDGE=10, PER_LOCK=15, COMPLETION_BASE=100, COMPLETION_PER_CELL=5, SWAP_PENALTY=5, INVALID_PENALTY=2), `TERMINAL` ({COMPLETE, MOVES_EXHAUSTED, TIME_UP, CONCEDED}).
- `canonicalStringify(v)`, `hashState(state)` → 8-char hex, `cloneState(state)`.
- Geometry: `cellXY(state,cell)`, `cellIndex(state,x,y)`, `neighbors(state,cell)`, `directionBetween(state,a,b)`, `effectiveEdges(card)` → `[N,E,S,W]` motif ids after rotation.
- `createInitialState(content)`, `analyzeBoard(state)` → `{pairs:[{a,b,dir,matched,open}], matched, mismatched, open}`, `emptyCellCount(state)`, `isSolved(state)`, `terminalCondition(state, elapsedMs?)`.
- `validateCommand(state, cmd)` → `{ok:true}|{ok:false,reason}`; reasons: `unknown-command, round-over, bad-tray-slot, bad-cell, tray-slot-empty, cell-occupied, cell-empty, card-locked, no-tray-slot, same-cell, rotation-disabled, lock-disabled, already-locked, neighbors-mismatch, not-terminal`.
- `applyCommand(state, cmd)` → events array; `applyInvalid(state, cmd, reason)`; `quantizeElapsed(ms)`; `listLegalCommands(state)`; `compareResults(a,b)`.
- Commands: `{type:'place',tray,cell}`, `{type:'recall',cell}`, `{type:'swap',a,b}`, `{type:'rotateTray',tray}`, `{type:'lock',cell}`, `{type:'concede',elapsedMs}`. All commands get `{id, elapsed}` stamped by the session.
- State shape: `{tick,status:'active'|'terminal',terminalReason,grid:{w,h},palette,tray:[cardId|null],cells:[cardId|null],cards:{id:{id,edges:[4],rot,slot,locked}},mechanics:{rotation,lock,decoys},moveLimit,timeLimitMs,movesUsed,swapsUsed,invalidCount,lockedCount,elapsedMs,score:{matched,locks,completion,swapPenalty,invalidPenalty,timeBonus,total}}`.

### js/content.js
- `MOTIFS` (8, `{id,name}`), `THEMES` (5 light descriptors), `CONTENT_VERSION`.
- `generatePuzzle(contentId, seed, params)` → content doc `{version,contentId,seed,grid,palette,mechanics,goals:{moveLimit,timeLimitMs,par:{moves,ms}},theme,tutorial,cards:[{id,edges,cell,slot,decoy?,prelocked?}],traySize,initialRotations,solution:{cell:{card,rot}},prelocked:[cell]}`.
- `instantiate(content)` → initial rules state (applies prelocked). `validateContent(doc)` → `{ok,errors,solutionHash}`.
- `JOURNEY` (50 stage descriptors `{index,id,chapter,mastery,name,params}`), `journeyContent(i)`.
- `dailyKey(date?)` → `YYYY-MM-DD`, `dailyContent(dateKey?)`.
- `PRACTICE_DIFFICULTIES` (4, `{id,name,params}`), `practiceContent(difficultyId, seedString)`.
- `CHALLENGES` (5, `{id,name,blurb,params}`), `challengeContent(id, seedString)`.
- `LESSONS` (6, `{id,name,intro,params,steps:[{id,text,require:{type}}]}`), `lessonContent(id)` → `{lesson, content}`. Lesson step `require.type` is a command type (`place`,`recall`,`rotateTray`,`lock`) or `'terminal'`.

### js/session.js
- `MODES` (`learn,journey,daily,practice,challenge,score` → `{undoAllowed,hintAllowed,ranked,label}`), `BUILD_VERSION`, `REPLAY_SCHEMA`.
- `class Session(content, {mode, sessionId?, lesson?})`:
  - `.state`, `.content`, `.mode`, `.ranked`, `.undoAllowed`, `.hintAllowed`, `.result` (null until terminal), `.commands`, `.sessionId`.
  - `dispatch(cmd, elapsedMs)` → `{ok,reason?,events,terminal?}`. Auto-settles on terminal conditions.
  - `concede(elapsedMs)`, `undo()` → `{ok,...}`, `clockUpdate(elapsedMs)` → result|null (timed modes).
  - `hint()` → `{command,text,card?,tray?,cell?}|null`.
  - `analysis()`, `legalCommands()`, `stateHash`, `serializeReplay()`, `snapshot()`; static `Session.replay(content,envelope)` → `{ok,hash,state,result,mismatches}`, `Session.restore(snapshot)` → Session|null.
- Events emitted by dispatch: `{type:'place',card,tray,cell}`, `{type:'recall',card,cell,tray}`, `{type:'swap',a,b,cardA,cardB}`, `{type:'rotateTray',card,tray,rot}`, `{type:'lock',card,cell}`, `{type:'invalid',reason,command}`, `{type:'board',matched,mismatched,open}`, `{type:'terminal-pending',reason}`, `{type:'terminal',reason,score}`, `{type:'duplicate',id}`, `{type:'undo'}`.
- Result: `{terminalReason,score,elapsedMs,movesUsed,swapsUsed,invalidCount,sessionId,contentId,contentVersion,seed,mode,assists:{hints,undos}}`.

### js/themes.js
`THEMES` map id→full palette `{id,name,bg,fog,table,tableEdge,felt,feltLine,cardFace,cardBack,cardEdge,cellInlay,cellEmpty,accent,accentSoft,select,invalid,match,text,textSoft,light:{key,keyIntensity,fill,fillIntensity,ambient},exposure}`; `getTheme(id)`; `motifColors(cvd)` → 8 hex colors; `themeCssVars(theme,cvd)` → css var map.

### js/motifs.js
`drawMotif(ctx,id,x,y,size,color)`, `motifSvg(id,color,size)` → inline SVG string, `paintCardFace(canvas,edges,colors,{face,frame,center?})`.

## Modules to build (this task)

### js/storage.js — versioned local persistence (localStorage, key prefix `cardmosaic.v1.`)
- `loadSettings()` / `saveSettings(s)`; `loadProgress()` / `saveProgress(p)` (journey completion, stars, lesson completion, mastery XP); `loadAchievements()` / `saveAchievements(a)`; `loadBoards()` / `saveBoards(b)` (local leaderboards); `saveSnapshot(obj)` / `loadSnapshot()` / `clearSnapshot()`; generic checksummed envelopes `{v, data, crc}` — corrupt entries read as null.

### js/render.js — Three.js presentation layer
Exports `class Renderer`:
- `static isSupported()` — WebGL detection.
- `constructor({ container, canvas, onIntent, settings })` — `onIntent(intent)` where intent = `{kind:'cell',cell}` | `{kind:'tray',tray}` | `{kind:'background'}`. settings: `{quality:'low'|'medium'|'high', reducedMotion:bool, cvd:bool, theme}`.
- `load(content, themeId)` — build board/card meshes from a content doc + initial state.
- `syncState(state, meta)` — reconcile meshes to an immutable rules snapshot. meta: `{selectedTray, selectedCell, hintTray, hintCell, legalCells:[], lockableCells:[], keyboardFocus:{kind,index}|null}`.
- `playEvents(events, state)` — animate session events (place/recall/swap/rotate/lock/invalid/terminal) with bounded VFX; must expose `skipAnimations()` that settles everything into the exact logical end state.
- `setTheme(themeId)`, `setQuality(tier)`, `setReducedMotion(b)`, `setCvd(b)`, `resetCamera()`, `resize()`, `dispose()`.
- Self-runs its own `requestAnimationFrame` loop; pauses when `document.hidden`. Pixel ratio capped per tier (low 1, medium 1.5, high 2). No raycast against decorative objects; cosmetic particles on non-raycast layer. Prewarm shaders on load.
- `getStats()` → `{drawCalls, triangles, fps}` for the perf HUD/debug.

### js/audio.js — WebAudio procedural audio
Exports `class AudioEngine`:
- `constructor(settings)`; `resume()` (gesture unlock); `playEvent(name)` for `select,place,recall,swap,rotate,lock,invalid,match,complete,fail,tick,uiOpen,uiClose,pause,hint,achievement`.
- Buses: `music,effects,ambience,voice`; `setBusVolume(bus,v0to1)`, `setMuted(bool)`; `startAmbience(themeId)`, `stopAmbience()`, `setMusicIntensity(0..2)`.
- All sounds synthesized (oscillators + filtered noise), seeded pitch variants via `createRng`. No audio assets.

### js/platform.js — StarHermit host adapter (graceful offline)
Exports `class Platform`:
- `constructor()`; `init()` — detect hosting (same-origin `/api`), read launch token from URL/host shell (never persisted).
- `getServerTime()` → `{nowMs, offsetMs, source:'server'|'local'}` using `/api/v1/time` with RTT adjustment; fallback local.
- `submitScore(entry)`, `fetchLeaderboard({board,scope})`, `saveCloud(doc)`, `loadCloud()`, `postTelemetry(events)` (consent-gated), `activityStart(meta)`/`activityEnd(summary)`, `presenceHeartbeat()` throttled. All methods no-op/fallback locally when not hosted.

### js/ui.js + index.html + css/style.css — DOM shell
Semantic HTML over/beside canvas. Screens: loading, title, mode-select, journey map, lesson list, setup (per mode), play HUD, pause, settings, results, help, profile/achievements, score chase/leaderboards, compatibility notice. Fully playable DOM mirror board (grid of buttons + tray), keyboard navigation, live regions, focus management, responsive (wide ≥1024px rails; compact drawers; portrait mobile tray; landscape mobile rail), safe-area insets, 44px targets.

### server.js — StarHermit authoritative script (node, stdlib only)
JSON endpoints: `GET /api/v1/time`, `POST /api/v1/scores` (validates replay envelope by regenerating content and running `Session.replay`; rejects impossible/stale), `GET /api/v1/leaderboards`, cloud save get/put, achievements. Serves static files too. Runnable: `node server.js [port]`.

### starhermit.txt
`name=Card Mosaic`, `launch=index.html`, `server=server.js`.

### tests/*.mjs — node test suite (run: `node tests/run.mjs`)
Unit tests for every command + invalid reason, scoring components, terminal states, serialization, replay determinism property test (random seeds × random command sequences → identical hashes), fuzz malformed commands, content validators over all journey/daily/challenge/lesson content, golden sessions.

## Wiring (js/main.js owns)
State machine `boot → title → profile-ready → mode-select → preparing → tutorial/countdown → active ↔ paused → resolving → results → progression`. Owns the wall clock (active-play ms excluding pauses), passes `elapsedMs` to session, mediates intents from UI/renderer into `session.dispatch`, saves snapshots, drives achievements/progress, applies settings to renderer/audio/UI.
