'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const createDiff = require('../modules/diff');

function temp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'apk-devkit-diff-'));
}

test('directory diff hashes files and reports changed and missing entries', async t => {
  const ws = temp();
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  for (const dir of ['a', 'b']) fs.mkdirSync(path.join(ws, dir));
  fs.writeFileSync(path.join(ws, 'a', 'same.txt'), 'same');
  fs.writeFileSync(path.join(ws, 'b', 'same.txt'), 'same');
  fs.writeFileSync(path.join(ws, 'a', 'changed.txt'), 'old');
  fs.writeFileSync(path.join(ws, 'b', 'changed.txt'), 'new');
  fs.writeFileSync(path.join(ws, 'a', 'only-a.txt'), 'a');
  fs.writeFileSync(path.join(ws, 'b', 'only-b.txt'), 'b');
  const result = await createDiff({ ws }).dirs({ a: 'a', b: 'b' });
  assert.deepEqual(result.onlyInA.map(x => x.rel), ['only-a.txt']);
  assert.deepEqual(result.onlyInB.map(x => x.rel), ['only-b.txt']);
  assert.deepEqual(result.changed.map(x => x.rel), ['changed.txt']);
});

test('text diff rejects files above the configured memory limit', async t => {
  const ws = temp();
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  fs.writeFileSync(path.join(ws, 'a.txt'), 'a'.repeat(2 * 1024 * 1024 + 1));
  fs.writeFileSync(path.join(ws, 'b.txt'), 'b');
  await assert.rejects(() => createDiff({ ws }).files({ a: 'a.txt', b: 'b.txt' }), err => err.code === 'EDIFFLIMIT');
});

test('directory diff does not follow symlinked directories', async t => {
  const parent = temp();
  const ws = path.join(parent, 'workspace');
  const outside = path.join(parent, 'outside');
  fs.mkdirSync(ws);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  try {
    fs.symlinkSync(outside, path.join(ws, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (err) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(err.code)) {
      t.skip('Windows runner does not permit creating directory junctions');
      return;
    }
    throw err;
  }
  const result = await createDiff({ ws }).dirs({ a: '.', b: '.' });
  assert.deepEqual(result.onlyInA, []);
  assert.deepEqual(result.onlyInB, []);
  assert.deepEqual(result.changed, []);
});
