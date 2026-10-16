// i18n.test.mjs — localization coverage: every English key the markup, code
// and content use is translated in every locale (en-GB → en-US, es-ES →
// es-419, fr-CA → fr-FR inherit), placeholders and markup survive, and the
// language follows sh-language.js and switches live.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from './helpers.mjs';
import { loadTables, codeKeys, htmlKeys, audit, bootI18n } from './i18n-common.mjs';
import { MOTIFS, THEMES, LESSONS, PRACTICE_DIFFICULTIES, CHALLENGES } from '../js/content.js';
import { MODES } from '../js/session.js';
import { ACHIEVEMENTS } from '../js/storage.js';

const ROOT = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8');

export function usedKeys() {
  const keys = new Set(htmlKeys(read('index.html')));
  for (const f of ['js/ui.js', 'js/main.js', 'js/platform.js']) codeKeys(read(f), ['tr']).forEach((k) => keys.add(k));
  for (const m of MOTIFS) keys.add(m.name);
  for (const t of THEMES) keys.add(t.name);
  for (const l of LESSONS) { keys.add(l.name); keys.add(l.intro); for (const s of l.steps || []) keys.add(s.text); }
  for (const d of PRACTICE_DIFFICULTIES) keys.add(d.name);
  for (const c of CHALLENGES) { keys.add(c.name); keys.add(c.blurb); }
  for (const m of Object.values(MODES)) keys.add(m.label);
  for (const a of ACHIEVEMENTS) { keys.add(a.name); keys.add(a.desc); }
  for (const m of read('js/session.js').matchAll(/text: '((?:[^'\\]|\\.)*)'/g)) keys.add(m[1]);
  return [...keys].sort();
}

test('every used key is translated in every locale; placeholders and markup intact', () => {
  assert.deepEqual(audit(loadTables(ROOT, 'js/strings.js', 'CM_STRINGS'), usedKeys()), []);
});

test('the locale follows sh-language and switches live', () => {
  const { I18N, events, doc } = bootI18n(ROOT, { strings: 'js/strings.js', i18n: 'js/i18n.js', global: 'CMI18N', languages: ['de-DE'] });
  assert.equal(I18N.lang, 'de-DE');
  assert.equal(doc.documentElement.lang, 'de-DE');
  assert.equal(I18N.T('Resume'), 'Fortsetzen');
  I18N.language.setChoice('fr-CA');
  assert.equal(I18N.lang, 'fr-CA');
  assert.equal(events.at(-1), 'fr-CA');
  I18N.language.setChoice('en-GB');
  assert.equal(I18N.T('Color-vision-safe motif palette'), 'Colour-vision-safe motif palette');
});
