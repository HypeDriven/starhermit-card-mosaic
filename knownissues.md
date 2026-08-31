# Known Issues — Card Mosaic

QA pass 2026-08-20. Static review driven by Qwen3.8 27B on local5090 (HauhauCS Q3_K_P, 32k ctx),
alongside the game's own test suite and headless-Chrome / HTTP probing.

## Test results

| Check | Result |
| --- | --- |
| `npm test` | not available — this game ships no `package.json`; `npm test` exits with `ENOENT ... /card-mosaic/package.json`. The documented entry point is `node tests/run.mjs` (README.md:17, ARCHITECTURE.md:84). |
| `node tests/run.mjs` | 67/67 pass, 0 fail (rules 42, content 11, replay 1, fuzz 6, golden 7) |
| `node --check` on all modules | clean (`js/*.js`, `server.js`, `sw.js`, `tests/*.mjs`) |
| `tests/e2e.mjs` (headless Chrome) | not present. Substituted a headless-Chrome smoke against `node server.js 39303`: boot to title, `#btn-play` → mode select → `[data-mode="practice"]` → setup. No page errors; one 404 (see defect 3). |
| HTTP fuzz of `server.js` (directories, traversal, malformed encodings, 20 malformed bodies + odd query strings on all 9 API routes) | survived; no crash, no traversal |

## Confirmed defects

Defects 1 and 5 were reproduced against a running copy of `server.js`; 2, 4 and 6 against the shipped
modules; 3 in a real browser.

### 1. A score can be submitted to any leaderboard, regardless of which puzzle was actually played

- **File:** `server.js:196-249` (the `/api/v1/scores` handler)
- **Trigger:** solve a Practice puzzle, then `POST /api/v1/scores` with `board: "daily-<today>"` and the
  practice run's own `result`/`replay`.
- **Behaviour:** the handler carefully regenerates the content from `result.contentId` and refuses a
  mismatch between `replay.contentId` and `result.contentId` (lines 210-214), replays the command log,
  and re-checks the score (lines 217-231) — all correct. But the destination board is taken straight from
  `body.board` (line 196) and is only run through `safeName()` when the file path is built (line 234).
  Nothing ever compares `board` to `result.contentId`. The honest client always sets
  `board = result.contentId` (`js/main.js:601`), so this is purely a client-side convention.
- **Expected:** spec.md §6 "Achievements and leaderboards" — competitive boards are validated against
  deterministic seeds; a daily board must contain daily results.
- **Evidence:** against a copy of the server, first an honest daily run, then a `master`-difficulty
  Practice puzzle posted to the same board:

  ```
  honest daily: contentId=daily-2026-08-20            score=265  -> 200 {"ok":true,"rank":1,"total":1}
  cross-board : contentId=practice-master-cheat-seed  score=985  -> 200 {"ok":true,"rank":1,"total":3}

  GET /api/v1/leaderboards?board=daily-2026-08-20&scope=global
    practice-master-cheat-seed  985
    daily-2026-08-20            265
    practice-casual-cheat-seed  265
  ```

### 2. `listLegalCommands` enumerates no swaps at all on a fresh board

- **File:** `js/rules.js:451-476` (`listLegalCommands`), specifically the `slot >= 0` guard on line 464
  that wraps the swap loop on lines 466-469
- **Trigger:** call `listLegalCommands` on any starting board that contains anchored cards.
- **Behaviour:** anchored cards — those the generator never lifted into the tray — are created with
  `slot: -1` and `locked: false` (`js/rules.js:119`, `js/content.js:103`). The `slot >= 0` test is correct
  for `recall`, which `validateCommand` rejects for anchored cards (`js/rules.js:266`), but the swap loop
  is nested inside the same `if`. `validateCommand`'s `swap` case (`js/rules.js:269-277`) checks bounds,
  distinctness, occupancy and `locked` — it never looks at `slot`. So every swap whose lower-indexed cell
  holds an anchored card is legal yet unlisted.
- **Expected:** the function's own docstring (`js/rules.js:448-449`) — "Enumerate every currently legal
  non-terminal command. This is the single source of truth for tutorials and hints." spec.md §2 also
  requires that "Tutorials and hints call the same legal-action API used by play rather than duplicating
  rules."
- **Evidence:** a fresh `practice-master` board, 27 cards, 11 of them anchored and unlocked:

  ```
  listLegalCommands total: 251 | swaps listed: 0
  swaps validateCommand accepts: 55
  legal but NOT enumerated    : 55
  examples: [{"a":2,"b":3,"aSlot":-1,"bSlot":-1},{"a":2,"b":4,"aSlot":-1,"bSlot":-1}, ...]
  ```

### 3. Every page load 404s on `/favicon.ico`

- **File:** `index.html:3-10` (the `<head>` block)
- **Trigger:** load the game in any browser.
- **Behaviour:** the head declares a charset, viewport, colour-scheme, title, stylesheet and import map,
  but no `<link rel="icon">`. The browser therefore requests `/favicon.ico`, which the server does not
  have, producing a console error on every load. A `favicon.svg` **is** shipped and served (HTTP 200) —
  it is simply never referenced.
- **Expected:** a clean console on load; the asset exists and only needs linking.
- **Evidence:**

  ```
  console error on boot: Failed to load resource: the server responded with a status of 404 (Not Found)
  curl /favicon.ico -> 404      curl /favicon.svg -> 200      curl /icon.png -> 200
  ```

### 4. Replay envelopes omit `mode`, so every server-validated result is stored as `mode: "practice"`

- **File:** `js/session.js:234-247` (`serializeReplay`) versus `js/session.js:255`
  (`new Session(content, { mode: envelope.mode || 'practice', ... })`)
- **Trigger:** submit any ranked result and read the board back.
- **Behaviour:** `serializeReplay` emits `schema`, `build`, `contentVersion`, `contentId`, `seed`,
  `initialHash`, `startedAt`, `commands`, `stateHashes` and `result` — but not `mode`. `Session.replay`
  therefore always falls back to `'practice'`, and `server.js:219` stores `recomputed.result`, which
  carries that mode. The replayed outcome is unaffected (undo and hints are not part of the command log),
  but the mode recorded against every leaderboard entry is wrong, and the mode-gated rules in
  `MODES` (`js/session.js:22-29`, e.g. `challenge.undoAllowed: false`) are not what the validation runs
  under.
- **Expected:** spec.md §5 — the replay envelope is the record a validator re-executes; the mode is part
  of the ruleset it was played under.
- **Evidence:** a daily submission comes back from the board as

  ```
  {"terminalReason":"complete", ..., "contentId":"daily-2026-08-20", "mode":"practice", ...}
  ```

### 5. A submission with `result.score` missing returns 500 `internal-error` instead of a 4xx

- **File:** `server.js:224` (`if (recomputed.result.score.total !== result.score.total) return sendError(res, 400, 'score-mismatch');`)
- **Trigger:** a submission that passes every earlier check — correct `contentVersion`, a resolvable
  `contentId`, a matching `replay.contentId`, and a replay that re-executes cleanly — but whose
  `entry.result` has `score: null` or no `score` key at all.
- **Behaviour:** the only shape check on `result` is `typeof result !== 'object'` (`server.js:200`);
  nothing constrains its sub-properties. `result.score.total` then throws a `TypeError`, which the
  handler's outer `try/catch` converts into `500 {"error":"internal-error"}`. Every other rejection on
  this path is a specific 4xx with a machine-readable reason, so a client cannot tell a bad request from
  a server fault.
- **Expected:** a malformed field is a 400 with a reason, in line with the neighbouring
  `missing-result-or-replay`, `content-version-mismatch`, `score-mismatch` and `implausible-*` errors.
- **Evidence:** against a copy of the server, all three requests carrying the same valid replay:

  ```
  baseline (valid)      -> 200 {"ok":true,"rank":1,"total":1}
  result.score = null   -> 500 {"error":"internal-error"}
  result.score omitted  -> 500 {"error":"internal-error"}
  server alive after each: 200
  ```

  The process survives — the outer `try/catch` contains it — so this is a validation/reporting defect,
  not a denial of service.


### 6. A full localStorage throws out of every `save*` call and into the game loop

- **File:** `js/storage.js:35-38` (`rawSet`), with the one-shot probe at `js/storage.js:17-29`
- **Trigger:** localStorage reaching quota part-way through a session (large blobs from another origin
  path, Safari's tight per-origin budget, etc.), then any autosave.
- **Behaviour:** `store()` probes writability **once at module load** and, if it succeeds, `backing` is
  set to the real `localStorage` for the rest of the session. `rawSet` then calls
  `backing.setItem(...)` with no `try/catch`, so a later `QuotaExceededError` propagates through
  `writeRecord` and out of `saveSettings` / `saveProgress` / `saveAchievements` / `saveBoards` /
  `saveSnapshot`. Those are called bare from the play path — e.g. `saveSnapshot(this.session.snapshot())`
  at `js/main.js:387`, inside command dispatch, and `saveProgress(this.progress)` at `js/main.js:259` —
  none of them wrapped, so the throw escapes into the game loop.
- **Expected:** a failed autosave should degrade to "this session is not persisted", not interrupt play.
  The module's own memory fallback (`js/storage.js:28`, `const memory = new Map()`) exists for exactly
  this case but is only ever selected at load time.
- **Evidence:** with a storage whose `setItem` starts working (so the load-time probe passes) and then
  begins throwing:

  ```
  saveSettings:     THREW QuotaExceededError
  saveProgress:     THREW QuotaExceededError
  saveAchievements: THREW QuotaExceededError
  saveBoards:       THREW QuotaExceededError
  saveSnapshot:     THREW QuotaExceededError
  ```


## Suspected — not confirmed

### 1. `validateCommand` appears to have no `settle`/`concede` case

- **File:** `js/rules.js:236-307`
- **Concern:** raised by the model review of lines 250-490 in isolation.
- **Why unconfirmed:** **disproved on inspection.** Both are handled *before* the switch —
  `js/rules.js:241` returns `{ ok: true }` for `concede`, and `js/rules.js:242-248` gates `settle` on
  `terminalCondition(state, cmd.elapsedMs ?? state.elapsedMs)`, which is exactly the "prevents clients
  forging a completion on a live board" behaviour the comment describes. Recorded here only so the claim
  is not re-investigated.

### 2. `serveStatic`'s stream error handler can throw on an already-destroyed response

- **File:** `server.js:389-391`
- **Concern:** the handler calls `sendError(res, 404, ...)` when `!res.headersSent`. If the client has
  already disconnected and `res` is destroyed, `res.writeHead` inside `sendError` throws from an
  EventEmitter callback with no surrounding `try/catch`, which would be an uncaught exception.
- **Why unconfirmed:** I could not force the required race — a client disconnect between `createReadStream`
  and the stream's first I/O error. Every disconnect I produced was handled cleanly.

### 3. Elapsed time in the replay is client-declared

- **File:** `server.js:229` (`if (!(r.elapsedMs >= 3000)) return sendError(res, 400, 'implausible-elapsed');`)
- **Concern:** the elapsed time the server re-derives comes from the `elapsedMs` carried on each replayed
  command, so a client can compress it; the only guard is a 3-second floor, and `compareResults` uses
  elapsed time as a tie-break.
- **Why unconfirmed:** I did not build a submission that beats an honest entry purely on the elapsed-time
  tie-break — `maxPossibleScore` (`server.js:122-130`) and the score recomputation bound the primary key,
  so the practical gain is limited to ties. Worth a human decision on whether the 3-second floor is the
  intended policy.

## Checked, no defects found

- `js/rules.js:1-250` — `effectiveEdges` rotation mapping, `directionBetween`, `analyzeBoard`'s
  E/S-neighbour adjacency enumeration with the `(dir+2)%4` opposite lookup, `terminalCondition` ordering
  (completion before exhaustion), `canonicalStringify`/`hashState`, and `createInitialState`.
- `js/rules.js:236-307` (`validateCommand`) — `place`, `recall`, `swap`, `rotateTray` and `lock` all check
  integer type, bounds, occupancy and lock state; the `settle` guard is the anti-forgery check described
  above.
- `server.js:204-231` — content version pinning, server-side content regeneration from the claimed id,
  `replay.contentId`/`result.contentId` agreement, full replay through `Session.replay`, score and
  terminal-reason re-comparison, and the `maxPossibleScore` ceiling. A client cannot inflate a score for
  a given puzzle, nor substitute its own content document; defect 1 is about *which board* the result
  lands on.
- `server.js:79-81` (`safeName`) and static serving — `/js`, `/css`, `/src`, `/tests` all 404;
  `../`, `%2e%2e%2f`, `....//` and `%c0%ae` traversals all refused; `/../../../etc/passwd` → 404.
- `server.js:228-231` — reviewed as a suspected "non-numeric `score.total` bypasses the ceiling" bug and
  **disproved**: `const r = recomputed.result` is the *server's* recomputed result, so `r.score.total` is
  always a number produced by the rules engine, never a client value.
- `server.js:326` (`handleAchievements`) — a literal `null` JSON body yields a 500 rather than a 400, the
  same reporting weakness as defect 5, but it does not crash: confirmed by fuzzing all nine API routes
  with 20 malformed bodies each.
- `js/storage.js` — corrupt-storage harness: `loadAchievements`, `loadBoards`, `loadProgress`,
  `loadSettings` and `loadSnapshot` were each called against a fake `localStorage` pre-filled with `{`,
  `null`, `[]`, `{"v":9999}`, `"a"`, `0`, `undefined`, `{"v":1}`, `{"v":1,"data":null,"crc":0}` and
  `{"data":{"progress":null}}`. None threw; the `{v, data, crc}` envelope with a CRC32 check behaves as
  its header comment claims ("corrupt or version-mismatched entries read as null (never throw)").

## Not tested

- Deep gameplay through the real UI — there is no shipped browser test, so only boot → Play → mode select
  → setup was driven.
- The service worker (`sw.js`) — it registers only over http(s) (`js/main.js:89-90`) and its offline
  behaviour was not exercised.
- Audio output (`js/audio.js`) and the WebGL layer (`js/render.js`) beyond "boots without console errors"
  under SwiftShader.
- The `dist/` build and `tools/build-dist.sh`.

## Runtime artefacts

`server.js` writes its data under `card-mosaic/.data`, which is ignored by this repo's `.gitignore`, so
`git status` is clean. The cross-board exploit above was run against a **copy** of the game in a scratch
directory; nothing was written to this folder's boards.
