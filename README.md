# Card Mosaic

An original adjacency puzzle: place edge-coded cards into a rectangular mosaic so neighboring motifs connect. A StarHermit engine script game (engine 1.18.0): the felt board, HUD and menus on `starhermit:ui`, the studio card table on `starhermit:scene`, played natively by the StarHermit client and in browsers by the engine's web runtime.

## Run

```bash
starhermit .            # natively (the StarHermit runtime, ~/sh/runtime/1.18.0/…)
npm run package         # writes the web loader index.html + starhermit-files.json (after every change)
npm run serve           # optional: node server.js, a local static host for the packaged folder
```

## Test

```bash
npm test                # unit tests (rules, content, replay, fuzz, golden, migration, i18n) + engine checks
npm run test:browser    # headless Chrome plays the packaged loader (desktop, phone, landscape)
npm run gen-play        # regenerate tests/native/*.play from the content's solutions
npm run css             # tools/ui-style.css → assets/ui-style.json
```

## Layout

- `native/*.ts` — the engine client (entry `native/main.ts`): state machine, board, screens, 3D table, audio, platform, styles
- `js/rules.js`, `js/content.js`, `js/session.js`, `js/rng.js`, `js/themes.js` — pure rules, content and session (shared with the tests and `server.js`)
- `js/storage.js`, `js/migrate.js` — merges, achievements, the save document and the browser build's save/settings migration
- `js/strings.js`, `js/i18n.js`, `js/platform-strings.js` — nine locales
- `score-script.js` — the platform script posting totals to the `high-score` board

See spec.md for the full design and ARCHITECTURE.md for the module contract.
