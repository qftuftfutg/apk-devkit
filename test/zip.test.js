'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const AdmZip = require('adm-zip');
const createZipModule = require('../modules/zip');

function temp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'apk-devkit-zip-'));
}

test('ZIP extraction rejects an existing output symlink that points outside workspace', async t => {
  const parent = temp();
  const ws = path.join(parent, 'workspace');
  const outside = path.join(parent, 'outside');
  const out = path.join(ws, 'out');
  fs.mkdirSync(path.join(out, 'nested'), { recursive: true });
  fs.mkdirSync(outside);
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));

  try {
    fs.rmSync(path.join(out, 'nested'), { recursive: true, force: true });
    fs.symlinkSync(outside, path.join(out, 'nested'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (err) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(err.code)) {
      t.skip('Windows runner does not permit creating directory junctions');
      return;
    }
    throw err;
  }

  const zipPath = path.join(ws, 'payload.zip');
  const archive = new AdmZip();
  archive.addFile('nested/pwn.txt', Buffer.from('must not escape'));
  archive.writeZip(zipPath);

  const zip = createZipModule({ ws });
  await assert.rejects(
    () => zip.extract({ zip: 'payload.zip', out: 'out' }),
    err => err.code === 'EPATHESCAPE'
  );
  assert.equal(fs.existsSync(path.join(outside, 'pwn.txt')), false);
});

test('ZIP extraction still writes ordinary entries inside workspace', async t => {
  const ws = temp();
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  const archive = new AdmZip();
  archive.addFile('nested/ok.txt', Buffer.from('safe'));
  archive.writeZip(path.join(ws, 'payload.zip'));

  const zip = createZipModule({ ws });
  const result = await zip.extract({ zip: 'payload.zip', out: 'out' });
  assert.equal(result.count, 1);
  assert.equal(fs.readFileSync(path.join(ws, 'out', 'nested', 'ok.txt'), 'utf8'), 'safe');
});
