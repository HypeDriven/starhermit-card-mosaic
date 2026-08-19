# Card Mosaic

An original adjacency puzzle: place edge-coded cards into a rectangular mosaic so neighboring motifs connect. Three.js studio card-table presentation with a fully playable semantic HTML board layer.

## Run

```bash
node server.js 8080        # static host + authoritative API (time, scores, boards, cloud saves)
# or any static server, e.g.: python3 -m http.server 8080
```

Open http://localhost:8080/. Offline play works after first load (service worker). If WebGL is unavailable the DOM board remains fully playable.

## Test

```bash
node tests/run.mjs         # 67 checks: rules, content validation, replay determinism, fuzz, golden
```

## Layout

- `js/rules.js` — pure deterministic rules engine (commands, legality, scoring, terminal states, hashing)
- `js/content.js` — versioned content: 50-stage journey, daily seed, practice difficulties, challenges, lessons, validators
- `js/session.js` — command log, undo, hints, replay envelopes, snapshots
- `js/render.js` — Three.js scene (themes, quality tiers, VFX, pointer input)
- `js/ui.js` + `index.html` + `css/style.css` — DOM shell, screens, accessibility mirror board
- `js/audio.js` — synthesized WebAudio (4 buses, adaptive music, ambience)
- `js/platform.js` — StarHermit host adapter (offline-graceful); `server.js` — authoritative script
- `js/storage.js` — versioned, checksummed local persistence
- `tools/build-dist.sh` — assemble `dist/` for upload (starhermit.txt at its root)

See ARCHITECTURE.md for the module contract.
