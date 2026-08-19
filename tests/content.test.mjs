// content.test.mjs — validators over every shipped content source, plus
// determinism and versioned-field shape checks for generated documents.

import assert from 'node:assert/strict';
import {
  MOTIFS, THEMES, CONTENT_VERSION,
  generatePuzzle, instantiate, validateContent,
  JOURNEY, journeyContent,
  dailyKey, dailyContent,
  PRACTICE_DIFFICULTIES, practiceContent,
  CHALLENGES, challengeContent,
  LESSONS, lessonContent,
} from '../js/content.js';
import { Session } from '../js/session.js';
import { test } from './helpers.mjs';

function assertValid(doc, label) {
  const v = validateContent(doc);
  assert.equal(v.ok, true, label + ' invalid: ' + v.errors.join(', '));
  assert.match(v.solutionHash, /^[0-9a-f]{8}$/, label + ' solutionHash');
  return v;
}

// ---------------------------------------------------------------------------
// catalog shape
// ---------------------------------------------------------------------------

test('catalog: >=40 journey stages, 5 themes, 8 motifs', () => {
  assert.ok(JOURNEY.length >= 40, 'journey stages: ' + JOURNEY.length);
  assert.equal(JOURNEY.length, 50);
  assert.equal(THEMES.length, 5);
  assert.equal(MOTIFS.length, 8);
  assert.equal(PRACTICE_DIFFICULTIES.length, 4);
  assert.equal(CHALLENGES.length, 5);
  assert.equal(LESSONS.length, 6);
});

// ---------------------------------------------------------------------------
// every shipped content doc validates
// ---------------------------------------------------------------------------

test('validateContent: all 50 journey stages', () => {
  for (let i = 0; i < JOURNEY.length; i++) {
    const doc = journeyContent(i);
    assertValid(doc, 'journey-' + i);
  }
});

test('validateContent: all 5 challenges, two seeds each', () => {
  for (const c of CHALLENGES) {
    for (const seed of ['content-seed-a', 'content-seed-b']) {
      assertValid(challengeContent(c.id, seed), c.id + '/' + seed);
    }
  }
});

test('validateContent: all 6 lessons', () => {
  for (const l of LESSONS) {
    const { content } = lessonContent(l.id);
    assert.ok(content, l.id);
    assertValid(content, l.id);
    assert.ok(Array.isArray(l.steps) && l.steps.length >= 1, l.id + ' steps');
    for (const s of l.steps) {
      assert.ok(['place', 'recall', 'rotateTray', 'lock', 'terminal'].includes(s.require.type),
        l.id + '/' + s.id + ' require.type');
    }
  }
});

test('validateContent: all 4 practice difficulties, two seeds each', () => {
  for (const d of PRACTICE_DIFFICULTIES) {
    for (const seed of ['content-seed-a', 'content-seed-b']) {
      assertValid(practiceContent(d.id, seed), d.id + '/' + seed);
    }
  }
});

test('validateContent: 7 consecutive daily dates', () => {
  const base = Date.parse('2026-08-10T00:00:00Z');
  for (let i = 0; i < 7; i++) {
    const key = dailyKey(new Date(base + i * 86400000));
    const doc = dailyContent(key);
    assert.equal(doc.contentId, 'daily-' + key);
    assertValid(doc, key);
  }
});

// ---------------------------------------------------------------------------
// determinism
// ---------------------------------------------------------------------------

test('determinism: identical generatePuzzle inputs -> byte-identical JSON', () => {
  const params = { w: 4, h: 4, palette: 5, removed: 8, rotation: true, lock: true, decoys: 2, prelocked: 1 };
  const a = generatePuzzle('det', 'det-seed', params);
  const b = generatePuzzle('det', 'det-seed', params);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  // and across the content sources
  assert.equal(JSON.stringify(journeyContent(7)), JSON.stringify(journeyContent(7)));
  assert.equal(JSON.stringify(dailyContent('2026-08-18')), JSON.stringify(dailyContent('2026-08-18')));
});

test('determinism: different seeds -> different docs', () => {
  const params = { w: 4, h: 4, palette: 5, removed: 8, rotation: true, lock: true, decoys: 1 };
  const a = generatePuzzle('det', 'seed-one', params);
  const b = generatePuzzle('det', 'seed-two', params);
  assert.notEqual(JSON.stringify(a.cards), JSON.stringify(b.cards));
  const pa = practiceContent('expert', 'aaa');
  const pb = practiceContent('expert', 'bbb');
  assert.notEqual(JSON.stringify(pa.cards), JSON.stringify(pb.cards));
});

// ---------------------------------------------------------------------------
// versioned document shape
// ---------------------------------------------------------------------------

test('content docs carry required versioned fields', () => {
  const docs = [
    journeyContent(0),
    journeyContent(49),
    dailyContent('2026-08-18'),
    practiceContent('master', 'shape'),
    challengeContent('grand', 'shape'),
    lessonContent('lesson-place').content,
  ];
  for (const doc of docs) {
    assert.equal(doc.version, CONTENT_VERSION, doc.contentId);
    assert.equal(typeof doc.contentId, 'string');
    assert.equal(typeof doc.seed, 'string');
    assert.ok(doc.goals && typeof doc.goals === 'object', doc.contentId + ' goals');
    assert.ok('moveLimit' in doc.goals && 'timeLimitMs' in doc.goals, doc.contentId + ' goal keys');
    assert.ok(doc.goals.par && Number.isInteger(doc.goals.par.moves) && Number.isInteger(doc.goals.par.ms),
      doc.contentId + ' par');
    assert.ok(doc.mechanics && typeof doc.mechanics.rotation === 'boolean'
      && typeof doc.mechanics.lock === 'boolean' && typeof doc.mechanics.decoys === 'boolean',
      doc.contentId + ' mechanics');
    assert.ok(THEMES.some((t) => t.id === doc.theme), doc.contentId + ' theme');
    assert.ok(doc.solution && doc.cards.length > 0 && Number.isInteger(doc.traySize));
  }
});

// ---------------------------------------------------------------------------
// validators reject corrupted docs
// ---------------------------------------------------------------------------

test('validateContent rejects corrupted documents', () => {
  const good = journeyContent(0);
  const cases = {
    'grid-out-of-bounds': (d) => { d.grid.w = 9; },
    'palette-out-of-bounds': (d) => { d.palette = 99; },
    'edge-out-of-palette': (d) => { d.cards[0].edges[0] = 99; },
    'bad-cell (duplicate)': (d) => { d.cards[1].cell = d.cards[0].cell; },
    'move-limit-below-minimum': (d) => { d.goals.moveLimit = 0; },
    'time-limit-too-tight': (d) => { d.goals.timeLimitMs = 100; },
  };
  for (const [label, mutate] of Object.entries(cases)) {
    const doc = JSON.parse(JSON.stringify(good));
    mutate(doc);
    const v = validateContent(doc);
    assert.equal(v.ok, false, label + ' must be rejected');
    assert.ok(v.errors.length > 0);
    assert.equal(v.solutionHash, null);
  }
});

// every validated doc instantiates into a Session without throwing
test('validated content instantiates into sessions', () => {
  const docs = [
    journeyContent(0), journeyContent(25), journeyContent(49),
    dailyContent('2026-08-18'), practiceContent('master', 'inst'),
    challengeContent('glasswork', 'inst'), lessonContent('lesson-decoy').content,
  ];
  for (const doc of docs) {
    const session = new Session(doc, { mode: 'practice', sessionId: 'inst-' + doc.contentId });
    assert.ok(session.stateHash.length === 8);
    const st = instantiate(doc);
    assert.equal(st.status, 'active');
  }
});
