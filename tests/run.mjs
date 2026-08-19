// run.mjs — homegrown test runner. Usage: node tests/run.mjs
// Imports every test file (registering its tests), then executes all
// registered tests sequentially. Exits non-zero on any failure.

import { __setFile, __suites } from './helpers.mjs';

const FILES = [
  'rules.test.mjs',
  'content.test.mjs',
  'replay.test.mjs',
  'fuzz.test.mjs',
  'golden.test.mjs',
];

const started = Date.now();

// Registration phase — sequential so each file's tests group under its name.
for (const file of FILES) {
  __setFile(file);
  try {
    await import(new URL('./' + file, import.meta.url));
  } catch (err) {
    console.error(`FAIL ${file} — import error: ${err && err.stack || err}`);
    process.exit(1);
  }
}

// Execution phase.
let totalPass = 0;
let totalFail = 0;

for (const [file, tests] of __suites()) {
  let pass = 0;
  const failures = [];
  for (const t of tests) {
    try {
      await t.fn();
      pass++;
    } catch (err) {
      failures.push({ name: t.name, err });
    }
  }
  totalPass += pass;
  totalFail += failures.length;
  const status = failures.length === 0 ? 'PASS' : 'FAIL';
  console.log(`${status} ${file} — ${pass}/${tests.length} passed`);
  for (const f of failures) {
    const msg = f.err && f.err.stack ? f.err.stack.split('\n').slice(0, 4).join('\n      ') : String(f.err);
    console.log(`  ✗ ${f.name}\n      ${msg}`);
  }
}

console.log(`\n${totalPass} passed, ${totalFail} failed (${((Date.now() - started) / 1000).toFixed(1)}s)`);
process.exit(totalFail === 0 ? 0 : 1);
