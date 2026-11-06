// i18n.test.mjs — localization coverage: every English key the engine client
// (native/*.ts), the content and the store show is translated in every
// locale (en-GB → en-US, es-ES → es-419, fr-CA → fr-FR inherit), with its
// placeholders, and no table keeps a key nothing shows; the classic
// the tables are assets/strings.json (native/i18n.ts).
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from './helpers.mjs';
import { loadTables, codeKeys, audit, bootI18n } from './i18n-common.mjs';
import { MOTIFS, THEMES, LESSONS, PRACTICE_DIFFICULTIES, CHALLENGES } from '../js/content.js';
import { MODES } from '../js/session.js';
import { ACHIEVEMENTS } from '../js/storage.js';

const ROOT = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8');

export function usedKeys() {
  const keys = new Set();
  for (const f of readdirSync(new URL('native/', ROOT)).filter((n) => n.endsWith('.ts'))) {
    codeKeys(read('native/' + f), ['tr']).forEach((k) => keys.add(k));
  }
  for (const m of MOTIFS) keys.add(m.name);
  for (const t of THEMES) keys.add(t.name);
  for (const l of LESSONS) { keys.add(l.name); keys.add(l.intro); for (const s of l.steps || []) keys.add(s.text); }
  for (const d of PRACTICE_DIFFICULTIES) keys.add(d.name);
  for (const c of CHALLENGES) { keys.add(c.name); keys.add(c.blurb); }
  for (const m of Object.values(MODES)) keys.add(m.label);
  for (const a of ACHIEVEMENTS) { keys.add(a.name); keys.add(a.desc); }
  for (const m of read('js/session.js').matchAll(/text: '((?:[^'\\]|\\.)*)'/g)) keys.add(m[1]);
  return [...keys].filter((k) => !k.startsWith('starhermit.')).sort();
}

test('every used key is translated in every locale; placeholders and markup intact', () => {
  assert.deepEqual(audit(JSON.parse(read('assets/strings.json')), usedKeys()), []);
});

