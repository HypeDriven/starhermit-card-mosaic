# Card Mosaic — Running Game Design Document

## 1. Overview

**Pitch.** On a green-felt panel in a quiet studio, square parchment cards carry a motif on each of their four edges. Place the loose cards from the tray into the grid so every touching edge shows the same motif; when the last mismatch is gone, the picture is whole.

| | |
|---|---|
| Genre | Single-player edge-matching placement puzzle; perfect information, deterministic, seeded |
| Players | 1. Asynchronous comparison through validated daily / challenge leaderboards when hosted; local boards otherwise |
| Session | 20 s (Learn lesson) to ~8 min (6×5 mastery stage or Grand Table); Daily ≈5 min |
| Platforms | Desktop and mobile browsers. WebGL renders the studio; without WebGL the DOM board is the whole game (Limited graphics mode) |
| Rendering | Three.js r160 (`vendor/three.module.js`, import map) draws the table, props and lighting behind a semantic HTML board that is the actual input surface |
| Versions | `BUILD_VERSION 1.0.0` (`js/session.js`), `CONTENT_VERSION 1`, `RULES_VERSION 1`, `REPLAY_SCHEMA 1`, service-worker cache `cardmosaic-v3` |

File map (everything that ships or tests the game):

| Path | Owns |
|---|---|
| `index.html` | Shell: 12 `<section class="screen">` panels, 4 overlays, live regions, toasts, captions, static rule cards |
| `css/style.css` | Theme tokens (`--t-*`, `--motif-*`), board/tray, four breakpoints, a11y modes, key-art and results-art styling |
| `js/rng.js` | FNV-1a `hashString`, mulberry32 `RngStream` with named forks, `createRng(seedString)` |
| `js/rules.js` | Pure rules: state, `validateCommand`, `applyCommand`, scoring, terminal conditions, `listLegalCommands`, `compareResults`, hashing |
| `js/content.js` | `generatePuzzle`, `validateContent`, 8 motifs, 5 theme ids, 50 Journey stages, daily ladder, 4 Practice presets, 5 Challenges, 6 Lessons |
| `js/session.js` | `Session`: command log, auto-settle, undo snapshots, hints, replay envelope, resumable snapshot, `MODES` |
| `js/storage.js` | Checksummed localStorage envelopes (`cardmosaic.v1.*`), defaults, `journeyStars`, 6 achievements, local boards, snapshot |
| `js/themes.js` | Five full palettes, standard and Okabe–Ito motif colours, `themeCssVars` |
| `js/motifs.js` | Procedural motif glyphs (canvas + inline SVG) and `paintCardFace` card textures |
| `js/render.js` | Three.js studio: table, felt, cells, tray, cards, props, key/fill light, particles, event animations, quality tiers, picking |
| `js/ui.js` | DOM shell: screens, overlays, focus, roving-tabindex board and tray, HUD, results, settings, captions |
| `js/audio.js` | WebAudio buses, 18 event ids → clip map with synthesized fallback, generative music, room-tone ambience |
| `js/platform.js` | StarHermit adapter: hosting probe, server time, scores, leaderboards, achievements, telemetry, activity, presence |
| `js/main.js` | Controller: phase machine, wall clock, selection, command dispatch, progression, achievements, submissions |
| `server.js` | Authoritative script (`server=server.js`): static host, `/api/v1/*`, replay-validated boards, cloud, achievements |
| `sw.js` | Service worker: precache app shell + art, cache-first static, network-first API |
| `sfx/*.opus`, `sfx/manifest.txt` | 18 authored clips and the canonical event binding table (§9); `manifest.json` drives generation |
| `assets/key-art.webp`, `assets/results-*.webp` | Title key art and two results illustrations (§8, §15) |
| `coverart.png`, `icon.png`, `favicon.svg` | Store cover (1200×675), 256 px icon, SVG tab icon |
| `tests/run.mjs`, `tests/*.test.mjs`, `tests/helpers.mjs` | `npm test`: 67 rules / content / replay / fuzz / golden checks |
| `tests/e2e.mjs` | `npm run test:e2e`: Playwright playthrough at 1280×800 and 390×844 |
| `tools/build-dist.sh`, `dist/` | Assembles the uploadable distribution (`starhermit.txt` at its root) |
| `starhermit.txt`, `LICENSE.md`, `README.md`, `ARCHITECTURE.md`, `knownissues.md` | Manifest, PolyForm Noncommercial 1.0.0, module contract, QA history |

## 2. Vision and design pillars

The fantasy is a slow morning at a studio card table: walnut, green felt, cream parchment, one warm window. Every placement should feel like setting a tile; a finished mosaic should feel like the room going quiet.

1. **The edge is the only rule.** A card is right where all four of its edges agree with its neighbours. Rules in: four edge motifs per card, quarter-turn rotation, locking a fully agreeing card, decoy cards that belong nowhere. Rules out: card values, suits, hands, opponents, hidden cards, timers before Chapter 4, anything that changes a card after it is dealt.
2. **Nothing you do is fatal.** Invalid tries never move a card, cost 2 points, and are explained in plain words; recall, swap and undo are always one action away in relaxed modes. Rules in: reversible placement, per-reason explanation text, hints that name a concrete legal move. Rules out: losing cards, cascading penalties, unsolvable boards (every puzzle is generated solved and re-proven by `validateContent`).
3. **Same seed, same table.** Daily, Journey, Challenge and Lesson puzzles are pure functions of a seed string; a replay log re-executes to the same hash on the client, in the test suite and on the server. Rules in: seeded RNG forks for rules, content, audio and props; quantized elapsed time; server-side replay validation. Rules out: client-asserted scores, per-device variation, cosmetic randomness leaking into rules.
4. **The felt panel is the screen.** The board and tray are real buttons on a felt-coloured panel; the Three.js studio is the room behind it. Rules in: one view model feeding both the DOM board and the 3D scene, a game that is complete without WebGL. Rules out: canvas-only controls, hover-only information, effects that can hide a legal target.
5. **Quiet, not empty.** Sound is paper, felt, glass and brass; motion is short arcs and a settle. Rules in: one cue per event, ducking under dialogs, a single warning tick in timed rounds. Rules out: music stings on every move, screen shake outside invalid/complete, particles above the 2000/500 caps.

## 3. Player experience

**Target player.** Someone who likes tile-matching and jigsaw logic in five-minute sittings, plays on a phone as often as a laptop, and wants a daily puzzle to compare with friends without a clock breathing down their neck.

**First 60 seconds.** Title → **Play** (the one large button) → six mode cards, each stating duration, player count, assists and a Ranked/Casual badge. A new player picking **Learn** gets "First Placement": a 2×2 board with one loose card; the HUD lesson line says "Select the tray card, then place it in the glowing empty cell", the legal cell glows yellow, and the round completes on that single placement with the completion chime. Picking **Journey** instead opens Chapter 1 with only Stage 1 unlocked (3×3, three loose cards, three motifs, no rotation); the Objective rail reads "Complete the mosaic — fill 3 of 9 cells", every edge that agrees draws a green link bar, and the first correct placement fires the match bell. Each later mechanic arrives in its own lesson or chapter: rotation (Chapter 2 / "Quarter Turns"), locking and decoys (Chapter 3 / "Locking In", "The Impostor"), move and time limits (Chapter 4). Help is one tap away on the title, in the pause menu, and as static rule cards.

**Session shape.** A typical sitting is Daily (one board, ranked, undo allowed) or two or three Journey stages. Results always show the six-line score breakdown, par, stars, achievements and a recommended next action ("Next stage" / "Next lesson" / "Play again"). Leaving a round from the pause menu stores it live; the title then offers **Resume saved round**.

**The emotional beat.** The last card. The board's mismatch count reaches zero, the green link bars close the grid, the completion chime resolves to a major chord, particles drift up over the felt, and the results screen opens on the completed-mosaic illustration.

## 4. Core loop and rules contract

All rules live in `js/rules.js`; the session wrapper in `js/session.js` owns the log, undo and hints; `js/main.js` owns the wall clock and selection.

**Board and entities** (`createInitialState`). A `w×h` grid (2..8 each side), row-major cell indices. Every card has `edges [N,E,S,W]` (motif ids `0..palette-1`, palette 2..8), `rot` (0..3 quarter turns clockwise, applied by `effectiveEdges`), a fixed tray `slot` (−1 for anchored cards), and `locked`. The tray has `traySize = removed + decoys` stable slots. `mechanics {rotation, lock, decoys}` gate commands; `moveLimit` and `timeLimitMs` are `null` when absent.

**Generation** (`content.js generatePuzzle`). Every internal edge is assigned a random motif, so the grid is solved by construction; border edges draw from the same palette. `removed` cells are lifted into the tray in shuffled slot order; the rest stay anchored, and `prelocked` of them start locked. Decoy cards get four random edges and the highest slots. When rotation is on, each lifted non-decoy card starts with a random rotation. `goals.par = { moves: removed + ceil(removed/2), ms: max(30000, removed × 9000) }`.

**Commands and legality** (`validateCommand`; reasons are stable strings mapped to sentences in `ui.js REASON_TEXT`):

| Command | Legal when | Reasons |
|---|---|---|
| `place {tray, cell}` | slot holds a card, cell empty | `bad-tray-slot`, `bad-cell`, `tray-slot-empty`, `cell-occupied` |
| `recall {cell}` | occupied, unlocked, card owns a slot | `cell-empty`, `card-locked`, `no-tray-slot` |
| `swap {a, b}` | two distinct occupied, unlocked cells | `same-cell`, `cell-empty`, `card-locked` |
| `rotateTray {tray}` | rotation mechanic on, slot holds a card | `rotation-disabled`, `tray-slot-empty` |
| `lock {cell}` | lock mechanic on, unlocked card, every placed neighbour's facing edge equals its own | `lock-disabled`, `already-locked`, `neighbors-mismatch` |
| `settle {elapsedMs}` | a terminal condition genuinely holds | `not-terminal` |
| `concede {elapsedMs}` | round active | — |

Any command after terminal is `round-over`; unknown shapes are `unknown-command`. Invalid commands go through `applyInvalid`: `tick+1`, `invalidCount+1`, no layout change, and the attempt is logged with its reason.

**Resolution order** (`applyCommand`). Duplicate command ids (64-entry window) are rejected before mutation. Then: mutate layout; `movesUsed+1` for place/recall/swap/lock (rotation is free); `swapsUsed+1` for swap; `refreshScore`; emit `board {matched, mismatched, open}`; if `terminalCondition` holds, emit `terminal-pending` and the session immediately appends a `settle` whose id is `<triggering id>:settle`. Completion outranks move exhaustion; time-up is polled at 10 Hz by `Session.clockUpdate`.

**Scoring** (`SCORE`, `refreshScore`, `settle`):

```
matched        = matchedInternalPairs × 10
locks          = lockedCount × 15            (prelocked cards count)
completion     = 100 + 5 × (w × h)           only on COMPLETE
timeBonus      = floor((timeLimitMs − elapsedMs) / 1000)   only on COMPLETE in timed content
swapPenalty    = swapsUsed × 5
invalidPenalty = invalidCount × 2
total          = max(0, matched + locks + completion + timeBonus − swapPenalty − invalidPenalty)
```

Worked example (golden test): Journey Stage 4 is 3×3 with 6 loose cards. Six placements, no swaps, no invalid tries → 12 internal pairs × 10 = 120, completion 100 + 45 = 145, total **265**. A 4×4 Sprint solved in 71.3 s with two locks, one swap and one invalid try → 240 + 30 + 180 + 48 − 5 − 2 = **491**.

**Terminal states** (`TERMINAL`): `complete` (no empty cell, no mismatched pair), `moves-exhausted` (`movesUsed ≥ moveLimit`), `time-up` (`elapsed ≥ timeLimitMs`), `conceded`. Elapsed time enters state only through `quantizeElapsed` (100 ms steps, non-finite → 0).

**Tie-break** (`compareResults`): completed before not; higher total; fewer invalid actions; lower elapsed; then session id string order. Used by local boards and by `server.js`.

**Stars** (`storage.js journeyStars`): 1 for completion, +1 if `movesUsed ≤ par.moves`, +1 if `elapsedMs ≤ par.ms`.

**RNG and seeding** (`rng.js`). `createRng(seed)` seeds mulberry32 from FNV-1a; `fork(name)` derives independent streams. Content uses `fork('content')`; audio timbre variants use `fork('audio')`; table props use `fork('cosmetic')`. Seeds: `cm-journey-journey-N`, `cm-daily-YYYY-MM-DD`, `cm-practice-<random>`, `cm-challenge-<id>-fixed-<id>`, `cm-lesson-<id>`.

**Undo and hints** (`session.js`). Undo pops the pre-command snapshot and the log entry (never part of the replay), counting `assists.undos`. Hint reads the content solution and returns the first verified legal step in priority order: rotate a tray card whose solution rotation differs → place a tray card into its solution cell → recall a misplaced unlocked card → lock any lockable card; each counts `assists.hints`. Both are gated per mode (§5). `listLegalCommands` is the single legal-action enumeration used by hints, the fuzz player and the legal-cell highlight.

## 5. Modes and progression

`session.js MODES` and `main.js _modeSetup`:

| Mode | Content | Undo | Hint | Ranked | Notes |
|---|---|---|---|---|---|
| Learn | 6 lessons, fixed seeds, `tutorial:true` | yes | yes | no | Each step requires a command type (`place`, `recall`, `rotateTray`, `lock`) or `terminal`; the HUD lesson line advances and the hint chime plays per step |
| Journey | 50 stages, 10 chapters | yes | yes | no | Stars, best score/moves per stage, mastery XP (1, or 3 for mastery stages) |
| Daily | one puzzle per UTC day | yes | no | yes | Board key `daily-YYYY-MM-DD`; countdown to next UTC midnight on the title, synced to `/api/v1/time` when hosted |
| Practice | 4 presets, fresh random seed each start | yes | yes | no | Casual 3×3/3 motifs/4 loose; Skilled 4×3/4/6 + rotation; Expert 4×4/5/9 + lock, 1 decoy, 1 prelocked; Master 5×5/6/14, 2 decoys, 2 prelocked |
| Challenge | 5 fixed puzzles (`fixed-<id>` seed) | no | no | yes | Frugal Hands (4×3, 8-move budget), Studio Sprint (4×4, 120 s), Impostors (4×4, 2 decoys), Grand Table (6×5, 15 loose, 3 prelocked), Glasswork (4×4 full lift, 30 moves) |
| Score chase | — | — | — | — | The mode card opens the leaderboard screen for today's daily board (Global / Friends); it starts no round |

**Journey curve** (`content.js` table `J`). Chapters 1–5 introduce one idea each, then a mastery stage with a full lift: 1 placement (3×3, palettes 3–4), 2 rotation (up to 4×3, palette 5), 3 locking + decoys with 2–3 prelocked anchors (4×4), 4 constraints (move limits 12–34, one 150 s stage), 5 large mosaics (5×4 → 6×5, palette 6, up to 3 decoys). Chapters 6–10 replay the arc one notch harder: +1 column on the two hardest rows of each chapter, +1 palette, +1 loose card, decoys alternate +1, move limits +2, time limits −30 s (floor 60 s). Unlocking: a stage needs the previous stage complete; a chapter's first stage needs the previous chapter's last.

**Daily ladder** (`dailyContent`): `daysSinceEpoch % 7` picks one of seven parameter rows (3×3/3 motifs/4 loose → 4×4 full lift with 2 decoys), theme id `daysSinceEpoch % 5`. The seed is the date, so the puzzle is immutable once published.

**Achievements** (`storage.js ACHIEVEMENTS`, unlocked in `main.js _applyOutcome`): `first_completion`, `mechanic_mastery` (complete a stage whose content has rotation, lock and decoys), `streak_7` (7 different daily dates completed), `chapter_clear`, `mastery_10`, `long_haul` (50 sessions started). Unlocks are idempotent locally and mirrored to the host.

## 6. Controls and interaction

Selection lives in `main.js` (`selectedTray` / `selectedCell`) and is echoed back to the UI through the view model; the DOM board forwards raw taps.

| Input | Desktop | Mobile | Result |
|---|---|---|---|
| Tap tray card | click | tap | Select (toggle off on repeat); legal empty cells highlight; `select` cue |
| Tap empty cell with tray card selected | click | tap | `place` |
| Tap occupied cell, nothing selected | click | tap | Select placed card; Rotate/Lock/Recall buttons enable as legal |
| Tap second occupied cell | click | tap | `swap` (−5) |
| Tap occupied cell with tray card selected | click | tap | Rejected locally: "That cell already holds a card." (not logged, no penalty) |
| Tap empty cell with placed card selected | click | tap | Toast "Recall the card first, then place it here." + `invalid` cue (not logged) |
| Long-press tray card | — | 550 ms hold, <10 px drift | Announces the card's four motifs |
| Rotate / Lock / Recall / Undo / Hint / Pause | buttons or `R` `L` — `U` `H` `P` | action bar (bottom, horizontally scrollable) | As labelled; keys act on the current selection |
| Arrow keys | move focus across the grid; ↓ from the last row jumps to the tray, ↑ from the tray returns | — | Roving tabindex, one tab stop per group |
| Enter / Space | activate focused cell or tray slot | — | Same as tap |
| Esc | cancel selection; with nothing selected, pause; inside a dialog, close (pause dialog: resume) | — | — |
| Gamepad | D-pad → arrows, A → Enter, B → Esc, Start → P, Y → H, X → U | — | Translated to synthetic key events in `main.js` |
| Canvas pointer | click/drag outside the felt panel | tap | Background intent clears the selection; renderer picking uses a 6 px / 250 ms tap threshold |

Feedback for every input: a visual state change on the button (`selected`, `legal`, `lockable`, `mismatch`, `hint` pulse), a caption line (`captions` on by default), a live-region announcement for rejections and locks, and one audio cue (§9). Haptics (Accessibility setting, on by default) pulse on invalid tries and on completion where `navigator.vibrate` exists.

**Input locking.** `main.js` sets `resolving` on terminal; `ui.setBusy(true)` adds `#board-grid.busy` (pointer-events off, `aria-disabled`) until results open (900 ms, 60 ms under reduced motion, 300 ms on time-up). While any overlay is open, Tab is trapped and play shortcuts are ignored. Commands are deduplicated by id, not by timers.

## 7. Screens and UI flow

`main.js` phases: `boot → title ↔ mode-select → preparing → active ↔ paused → resolving → results → (progression | title)`. `ui.js SCREENS`: loading, title, modes, journey, lessons, setup, play, results, help, profile, boards, compat. Overlays (`OVERLAYS`): pause, settings, help, confirm; they stack, trap focus, restore the invoker on close, and Esc closes the top one.

- **Loading**: progress bar with labels Rules → Studio → Table → Cards → Ready.
- **Title**: key art, tagline, optional Resume/Discard row, Play (autofocus), Daily challenge with countdown, Journey, Profile, Settings, How to play, a summary line ("Journey: n of 50 stages complete · Today's daily: open/done").
- **Choose a mode**: six cards (name, blurb, duration, assists, Ranked/Casual badge).
- **Journey**: ten chapter sections of stage buttons with stars or "Locked".
- **Lessons**: six lesson buttons with a ✓ when completed.
- **Set up**: title, rules sentence, expected duration, players, assists, ranked note; Practice lists four difficulties, Challenge lists five challenges, Daily shows Start.
- **Play**: left rail (Objective, lesson line, Progress "n of m cells filled", "a matched · b mismatched · c open", live score breakdown), centre felt panel (board grid + tray), right rail (action bar, Moves left, Time, Ranked badge). The top status line mirrors mode · ranked · placed · moves/time · score.
- **Pause**: Resume first; Settings shortcuts (Audio, Graphics, Controls, Accessibility); How to play; Restart, Concede (confirmed), Leave round (confirmed; saves the live round).
- **Results**: headline (Mosaic complete! / Out of moves / Time is up / Round conceded), time · moves, outcome illustration, stars, "New personal best!", six-line breakdown, par, achievement lines, Retry / Next / Map / Title.
- **Help**: eight rule cards (goal, placing, matching, rotating, locking, swapping & recall, invalid moves, impostors); the pause-menu variant shows three compact cards.
- **Profile**: display name (session memory), statistics, six achievements with unlock dates.
- **Score chase**: Global/Friends toggle, note, ranked list; local entries are labelled casual when no host board exists.
- **Limited graphics mode**: shown if WebGL construction or a load fails; Continue keeps the round.

**Layouts** (`css/style.css`). ≥1024 px: three columns `minmax(220px,17rem) 1fr minmax(230px,19rem)`, action bar vertical. 700–1023 px: rails become side drawers (☰ Goal / Actions ☰ in the top bar), board `min(100%, 92vmin, 560px)`. <700 px portrait: board `min(100%, 96vw, 70vh)`, Objective rail as a bottom sheet (≤70dvh), action bar as one horizontally scrollable row with key hints hidden. Landscape ≤540 px tall: board and tray side by side (`board ≤78vh`, tray ≤170 px wide), actions in a right column, Objective as a left drawer. Short desktop (≤820 px tall): board ≤60vh, smaller tray slots and title art. Safe-area insets pad the top bar, footer, overlays and action bar; the footer hides during play. Every screen scrolls vertically, so nothing is clipped; the title art hides itself if the file fails to load. Never cut off: the Play button, the whole board and tray, the action bar, the results Next button, the pause Resume button.

## 8. Art direction

**Palette** (`themes.js`; CSS defaults in `style.css :root` are Studio Dawn):

| Token | Studio Dawn | Slate Night | Verdant | Ember Glow | Porcelain |
|---|---|---|---|---|---|
| bg | `#e8ded0` | `#171c26` | `#dfe8d2` | `#241a16` | `#eef1f2` |
| table | `#7a5c3e` | `#2c3444` | `#5d6b41` | `#4a2f24` | `#9aa7ad` |
| felt | `#4c6b58` | `#233040` | `#3f5a3c` | `#40251f` | `#b9c8cc` |
| card face / edge | `#f6efe3` / `#d8cdb8` | `#e9e4d8` / `#c9c2b2` | `#f4f1e2` / `#d6d2ba` | `#f2e3cf` / `#d9c3a6` | `#fdfcf8` / `#e3e0d5` |
| accent | `#c96f2e` | `#5aa7d1` | `#3e7d4e` | `#e07b39` | `#3a6ea5` |
| select / match / invalid | `#ffd166` / `#7fb069` / `#c0392b` | `#f2c14e` / `#6fc28a` / `#e0604f` | `#ffd166` / `#9cc46f` / `#b23c2e` | `#ffd97a` / `#8fae62` / `#d94530` | `#e8a33d` / `#5f9e6e` / `#c0392b` |
| text / soft | `#2c2620` / `#6b5f52` | `#e6e1d6` / `#9aa5b1` | `#243020` / `#5c6a50` | `#f0e2d2` / `#b09a86` | `#22303a` / `#5d6d77` |

Motif colours, standard: Wave `#2e6f8e`, Sun `#c98a2b`, Leaf `#5f8f3e`, Moon `#6b5ca5`, Star `#b8517d`, Drop `#33998a`, Ember `#b8542e`, Fern `#7a8a3a`. Colour-vision-safe palette (Okabe–Ito): `#0072B2 #E69F00 #009E73 #56B4E9 #CC79A7 #0072B2 #D55E00 #F0E442`; the glyph shape is always the primary channel.

**Shape language.** Rounded rectangles everywhere (`--radius: 10px`; cards 7 px, panels 15–20 px; 3D cards 0.09 bevel radius). Cards are cream parchment with a thin frame, one glyph near each edge and a small centre medallion repeating all four glyphs. Cells are darker felt inlays; matched edges draw 5 px green bars on the touching sides; mismatches tint the cell; lockable cells get a double green border; locked cards carry a green padlock seal.

**Typography.** `system-ui` stack, 100% base (118% with Larger text), 70ch measure, tabular numerals for clocks and scores, uppercase 0.8 rem rail headings with 0.05 em tracking, `<kbd>` badges for shortcuts.

**Hero.** The felt panel with its board and tray. The 3D scene frames it: authored perspective, FOV 38°, 55° elevation, look-at biased 20 % toward the tray, fog at 0.9×–3.2× camera distance, warm key light (`light.key`, 2.2–2.6 intensity, 2048 px PCF soft shadows) plus cool fill and ambient, a seeded mug, pencil, spare-card stack and a window-light patch. Four render layers: environment, play (only raycast targets), UI rings/glows/ghost, effects (never raycastable).

**Motion.** Card placement and recall fly on a 1.05-unit arc, swaps on 0.6, rotation is a 0.35 s quarter turn with a small lift, lock scales a seal with back-ease and bursts 14 particles, matched-count increases sparkle along the new seams (40-particle budget), invalid flashes a red veil and nudges the camera 0.018, completion fires eight confetti bursts and a 0.05 nudge, other endings fade a bg-coloured veil to 45 %. Events queue 0.12 s apart; `skipAnimations()` settles everything before results. DOM side: 0.18 s card rotation, 0.7 s board glow and a score pop on a new match, 1 s hint pulse.

**Reduced motion** (setting or `prefers-reduced-motion`): all CSS animations/transitions collapse to 0.01 ms, hint pulses become dashed outlines, 3D rotation 0.1 s, lock 0.05 s, particles cut to 4/8-per-burst budgets, no camera shake, camera resets instantly, results open after 60 ms.

**Visual assets the design calls for** (all shipped, §15): title key art of the studio table; a completed-mosaic illustration for winning results; an unfinished-mosaic illustration for other endings; a titled 16:9 store cover derived from the key art. No 3D model asset: every mesh is procedural.

## 9. Audio direction

**Mix.** Four gain buses under one master: music 0.7, effects 0.9, ambience 0.5, voice 0.8 (reserved; nothing plays on it). Mute zeroes the master; dialogs duck the master to 0.25. The AudioContext is created on the first pointer/key gesture; clips are fetched lazily on first use and decoded once; while a clip loads (or if it 404s) the matching synthesized recipe plays, so no cue is ever silent. Timbre variants come from `createRng(seed).fork('audio')`, so a replayed round sounds the same.

**Music and ambience** (synthesized). A-minor pentatonic (A3–A5). Intensity 1 on the title (1 s beat: sparse pad every 8 steps, 60 % arpeggio on odd steps), 2 in play (0.5 s beat plus a soft 110/82 Hz pulse), 0 elsewhere. Ambience is a looped low-passed (320 Hz) room tone at 0.05 plus sparse single chimes every 4–12 s with per-theme density (studio 0.5, slate 0.25, verdant 0.7, ember 0.4, porcelain 0.3).

**SFX event table** — source of `sfx/manifest.txt` (48 kHz mono Opus, MOSS-SoundEffect v2.0, 100 steps; all on the effects bus):

| Event id | File | Sound | Usage |
|---|---|---|---|
| `select` | card-select.opus | card lifted off felt, soft paper slide | tray or placed card selected |
| `place` | card-place.opus | paper snap then low felt thud | `place` applied |
| `recall` | card-recall.opus | paper swish back toward the hand | `recall` applied |
| `swap` | card-swap.opus | quick double paper flutter | `swap` applied |
| `rotate` | card-rotate.opus | two light paper flicks | `rotateTray` applied |
| `lock` | card-lock.opus | small metal latch snap with chime tail | `lock` applied |
| `invalid` | invalid-move.opus | muted knuckle double-knock | logged invalid tries and local rejections |
| `match` | edge-match.opus | small glass bell ting | `board` event with a higher matched count |
| `complete` | mosaic-complete.opus | rising glass chimes into a major chord | results, `complete` |
| `fail` | round-fail.opus | three descending marimba notes | results, any other terminal reason |
| `hint` | hint-reveal.opus | wind-chime shimmer with a glint | hint shown; lesson step passed |
| `achievement` | achievement-unlock.opus | four-note glockenspiel fanfare | new achievement |
| `pause` | pause-toggle.opus | two music-box plucks | pause overlay opened |
| `uiOpen` | ui-open.opus | wooden panel sliding open | settings / help / confirm opened |
| `uiClose` | ui-close.opus | wooden panel sliding closed | any overlay closed (including Resume) |
| `undo` | card-undo.opus | reversed paper swish with a snap | undo applied |
| `timeWarning` | time-warning.opus | three brass clock ticks and a bell tap | once at 10 s left in timed rounds, with an assertive announcement |
| `newBest` | new-best.opus | two glass notes rising a fifth | results, 0.7 s after `complete`, on a new personal best |

Captions (`#captions`, on by default) print a short text for placed / recalled / swapped / rotated / locked / not allowed / undo / mosaic complete / round over.

## 10. Localization

Shipped language: **English only** (`<html lang="en">`). Every string is inline in `index.html`, `js/ui.js` (reason texts, mode blurbs, headlines), `js/main.js` (toasts, setup copy), `js/content.js` (stage, lesson and challenge names and step text) and `js/storage.js` (achievement names). There is no string table, no language selector and no locale detection. The layout is prepared for translation: logical CSS properties throughout, `html[dir="rtl"]` rules for drawers, link bars and the left-handed mirror, a 70ch measure, wrapping button rows, and no fixed-width labels, so 30 % expansion fits. The required locales — en-US, en-GB, es-419, es-ES, de-DE, fr-FR, fr-CA, pt-BR, it-IT — are design intent (§17).

## 11. Accessibility

- **Keyboard-only path**: title → Play → mode card → stage/lesson → arrows/Enter on the board and tray → `R`/`L`/`U`/`H`/`P` → results Next. Every screen focuses its `[data-autofocus]` control or heading on entry; overlays trap Tab and restore the invoker.
- **Focus**: 3 px `--t-select` outline (4 px in High contrast) on `:focus-visible`; roving tabindex keeps the grid and tray to one tab stop each.
- **Semantics**: cells and tray slots are buttons with labels like "Cell 3, card with Wave north, Sun east, Leaf south, Moon west"; tray slots expose `aria-pressed`; the board and tray are labelled groups; the top status line and Objective rail are `role="status"`; `#announcer-polite` / `#announcer-assertive` carry phase changes, rejections, hints, lesson steps and the time warning; the lock seal and stars have text equivalents.
- **Colour**: eight distinct glyph shapes carry the motif; the colour-vision-safe palette swaps hues; High contrast thickens borders to 3 px in ink colour and boosts glyph contrast.
- **Motion**: Reduced motion setting and media query (§8).
- **Text and layout**: Larger text (118 %), Left-handed layout (mirrors rails and action bar), 44 px minimum targets with 8 px gaps, `viewport-fit=cover` safe areas.
- **Audio**: independent bus sliders, mute, captions for meaningful sounds, no audio-only information.
- **Other**: Replay tutorials, haptics toggle, telemetry consent off by default, `<noscript>` explanation, Limited graphics mode with the full DOM game.

## 12. StarHermit integration

Conventions follow https://wiki.starhermit.com/. `starhermit.txt`: `name=Card Mosaic`, `launch=index.html`, `owner=…`, `server=server.js`, `cover=coverart.png`. `js/platform.js` probes `GET /api/v1/time` (2 s timeout) at boot; when it answers, the game is *hosted* and every call below is live, otherwise each degrades to `{ok:false}` / local behaviour and the game is fully playable offline.

| Feature | Used | How |
|---|---|---|
| Launch token / identity | yes | `?launchToken=` or `?token=` read into memory only, sent as `Authorization: Bearer`; the server hashes it into a player key. Never persisted |
| Server time | yes | RTT-adjusted offset from `/api/v1/time`; drives the daily key, countdown and result timestamps; re-synced on tab return |
| Leaderboards | yes | `POST /api/v1/scores {board, entry:{result, replay}}` for ranked modes (Daily, Challenge). `server.js` regenerates content from `contentId`, requires `board === contentId`, replays the log with `Session.replay`, re-checks score and terminal reason, rejects `elapsed < 3 s`, `> 10000` moves, or totals above `maxPossibleScore`, rate-limits 6/min/IP, keeps 500 entries sorted by `compareResults`. `GET /api/v1/leaderboards?board=daily-YYYY-MM-DD&scope=` feeds the Score chase screen |
| Achievements | yes | `POST /api/v1/achievements {key}` on every new unlock; idempotent server-side |
| Activity / presence | yes | `POST /api/v1/activity` start at boot and end on `pagehide`; `POST /api/v1/presence` every 30 s while a round is active |
| Telemetry | yes, consent-gated | batches of funnel events (`start`, `tutorial-step`, `round-end`, `retry`, `settings-change`, `error` category) to `/api/v1/telemetry`; the server keeps only per-name counters |
| Daily seed endpoint | server only | `GET /api/v1/daily` returns today's key/contentId/seed |
| Cloud save | endpoint only | `PUT/GET /api/v1/cloud` (versioned, CRC-checked, 409 on conflict) exists in server and adapter but the client never calls it; progress is local |
| Friends filtering, realtime rooms, matchmaking, chat, voice, containers | no | Not used; `scope=friends` returns the global board with `friendsFiltered:false` |

## 13. Technical architecture

- **Modules** (§1 table). Only `rules.js`, `content.js`, `session.js`, `rng.js`, `storage.js` (guarded) and `themes.js` are environment-agnostic; the node tests and `server.js` import the first four. `main.js` is the only writer of rules state and only through `Session.dispatch`; `ui.js` and `render.js` consume the same view model / state snapshot.
- **Determinism and replay.** State is JSON-serialisable and hashed with FNV-1a over a canonical (sorted-key) stringify. The replay envelope (`serializeReplay`) carries schema, build, mode, content version/id/seed, initial hash, start time, the ordered command log including invalid attempts and auto-settles, a state hash every 8 commands, and the result. `Session.replay` re-executes it against regenerated content and reports mismatches; `Session.restore` rebuilds a saved round the same way and refuses corrupted snapshots.
- **Persistence** (`storage.js`). Keys `cardmosaic.v1.{settings, progress, achievements, boards, snapshot, analytics-id}` as `{v, data, crc}` envelopes; corrupt or foreign versions read as null; a quota failure switches to an in-memory map for the session. The snapshot stores the content doc, mode, command log, assists and a `meta` block (stage, challenge, difficulty, daily key, lesson step, elapsed) written after every command, on Leave, and on `pagehide`.
- **Clock.** `main.js` accumulates active-play milliseconds with `performance.now()`, excluding pauses (including automatic pause on `visibilitychange`), and stamps each command with the quantized value; a 10 Hz tick refreshes the HUD, checks time limits and the 10 s warning, and sends presence.
- **Rendering budget.** Quality tiers: low (pixel ratio 1, no shadows/AA, 500 particles, no props), medium (1.5, shadows, AA, 2000), high (2, 2048 px shadow map). Card faces are 256 px canvas textures repainted on theme/CVD change; particles are one pooled `Points`; the loop stops while the tab is hidden; WebGL context loss rebuilds the scene from the content doc and falls back to the DOM board if that fails.
- **Offline.** `sw.js` precaches the shell, scripts, `three`, manifest, favicon and the three art files; static requests are cache-first, `/api/` is network-first and never cached. `CACHE_VERSION` is bumped on every shipped change.
- **Distribution.** `tools/build-dist.sh` copies `index.html css js vendor sfx assets server.js starhermit.txt sw.js favicon.svg icon.png coverart.png LICENSE.md` into `dist/`; `server.js` refuses paths outside its root and serves only known MIME types, so `tests/`, `tools/` and dotfiles are never served.
- **How the e2e drives the real UI.** `tests/e2e.mjs` starts its own static server (`PORT` env or ephemeral), launches system Chrome with SwiftShader, and clicks real buttons: `#btn-play`, `.mode-card[data-mode="journey"]`, `.stage-btn`, `#tray .tray-slot[data-index]`, `#board-grid .cell[data-index]`, key presses `r`/`h`/`u`/`p`, `#btn-resume`, `#btn-pause-leave`, `#btn-confirm-yes`, `#btn-title-resume`. It reads `window.__cm` only to decide which card goes where and to wait for ticks.

## 14. Testing and acceptance criteria

`npm test` (`node tests/run.mjs`, 67 checks, ~0.3 s): **rules** (42) — canonical stringify and hashing, `quantizeElapsed`, geometry helpers, `effectiveEdges`, every command's legal branch and every reason string (including the anchored-card `no-tray-slot` regression), lock/`analyzeBoard` agreement, each scoring component and the time bonus, all four terminal reasons, completion-over-exhaustion precedence, `listLegalCommands`, `compareResults` ordering; **content** (11) — catalogue sizes (50/5/8/4/5/6), every journey stage, challenge and practice preset (two seeds each), every lesson and 7 consecutive daily dates pass `validateContent`; byte-identical regeneration, distinct seeds differ, versioned fields present, corrupted documents rejected, validated docs instantiate; **replay** (1) — 40 random sessions across all content kinds with 20 % invalid commands serialise, replay, restore and undo to identical hashes; **fuzz** (6) — malformed commands, settle spam after terminal, duplicate ids, a randomised garbage storm, generator edge-case params and hostile `quantizeElapsed` input never corrupt state or produce non-finite scores; **golden** (7) — Stage 4 = 265 exactly, lock/decoy/prelock accounting, a 6×5 full lift, snapshot → restore → finish equals the uninterrupted run, concede yields zero completion, two fresh daily sessions with identical commands agree, every lesson plays through its steps.

`npm run test:e2e` passes twice (desktop 1280×800, mobile 390×844 touch) with zero page errors: title visible → settings open/close → journey stage 1 → solve through the board → results with ≥5 breakdown rows → progression persisted → next stage → pause/resume → hint + undo → leave round → title offers resume → resumed round is playable with its journey context. Console noise accepted: headless GPU driver messages and `/api/` 404s from the static-only server.

QA bar (agents/qa.md) as checkable statements: the first Learn lesson and Journey stage teach placement with an on-screen instruction and a glowing legal cell; every feature (six mode cards, all lessons, all challenges, settings tabs, profile, boards, help) is reachable by clicking; no console error or warning on boot or through a full round; at 1280×800, 390×844 portrait and 844×390 landscape the board, tray, action bar and primary buttons are fully visible or reachable by scrolling; hosted features go through `/api/v1` and nothing is faked client-side.

## 15. Asset inventory

| Path | Purpose | Source | Status |
|---|---|---|---|
| `assets/key-art.webp` (1280×720, 58 KB) | Title screen key art; also the base of the cover | FLUX.2 klein, seed 2401, 1536×864, 28 steps | generated in this pass, wired (`#title-art`) |
| `assets/results-complete.webp` (960×540, 70 KB) | Results illustration for `complete` | FLUX.2 klein, seed 2402, 1024×576 | generated in this pass, wired (`#results-art`) |
| `assets/results-over.webp` (960×540, 38 KB) | Results illustration for moves-exhausted / time-up / conceded | FLUX.2 klein, seed 2403, 1024×576 | generated in this pass, wired |
| `coverart.png` (1200×675, 357 KB) | Store cover: key art with title and tagline (ffmpeg drawtext, DejaVu Serif), 256-colour PNG | derived from seed 2401 | replaced in this pass (previous file was a generic template) |
| `icon.png` (256 px), `favicon.svg` | Launcher icon, tab icon | authored | shipped |
| `sfx/card-select … ui-close.opus` (15 clips) | Event cues (§9) | MOSS-SoundEffect v2.0, 100 steps | shipped |
| `sfx/card-undo.opus`, `sfx/time-warning.opus`, `sfx/new-best.opus` | `undo`, `timeWarning`, `newBest` cues | MOSS-SoundEffect v2.0, 100 steps, seeds from `generate_sfx_from_manifests.py` | generated in this pass, wired |
| `sfx/manifest.txt` / `manifest.json` / `manifest.md` | Canonical binding table / generator input / generator report | — | shipped |
| Card faces, motif glyphs, table, props, particles | All in-game geometry and textures | procedural (`motifs.js`, `render.js`) | shipped |
| 3D model, character animation | — | not called for (no hero prop beyond procedural cards, no humanoid) | none |

## 16. Known limitations

- No localization layer; English only (§10).
- The Profile display name lives in memory for the session and labels local board entries; it is not persisted, although the field says "stored on this device".
- Score chase is a board viewer for today's daily, not a separate ranked ruleset; `scope=friends` shows the global board.
- Table theme follows the Settings choice (default Studio Dawn); the per-chapter and per-day theme ids in `content.js` only apply when the setting is `'auto'`, which the theme picker does not offer.
- "Hold to confirm" and "Timing assist" are saved but change nothing; keyboard bindings can be reset but not remapped.
- Cloud save endpoints exist but the client never syncs; progress is per browser.
- Replayed elapsed time is client-declared with only a 3 s floor, so the elapsed tie-break on host boards is advisory (knownissues.md, suspected 3).
- `tick` has a synthesized recipe but no caller and no clip.
- Defective daily content cannot be flagged as excluded from ranking; the seed is simply the date.

## 17. Design intent not yet implemented

- Nine-locale string tables with runtime selection from the host profile / `navigator.languages`.
- Persisted profile name and cloud-synced progress with 409 conflict resolution.
- An "Auto (follow the puzzle)" theme option so Journey chapters and daily themes rotate the table.
- Friends-filtered boards and a dedicated Score chase ruleset with its own validated seed.
- Remappable desktop bindings; behaviour for the hold-to-confirm and timing-assist toggles.
