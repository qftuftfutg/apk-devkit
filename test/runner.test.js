'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { guard } = require('../lib/runner');

function temp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'apk-devkit-guard-'));
}

test('allows workspace files and non-existent output paths', t => {
  const ws = temp();
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  fs.mkdirSync(path.join(ws, 'in'));
  fs.writeFileSync(path.join(ws, 'in', 'a.txt'), 'ok');
  assert.equal(guard(ws, 'in', 'a.txt'), path.join(ws, 'in', 'a.txt'));
  assert.equal(guard(ws, 'out', 'new.apk'), path.join(ws, 'out', 'new.apk'));
});

test('rejects lexical traversal outside workspace', t => {
  const ws = temp();
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  assert.throws(() => guard(ws, '..', 'outside.txt'), { code: 'EPATHESCAPE' });
});

test('rejects an existing symlink that resolves outside workspace', t => {
  const parent = temp();
  const ws = path.join(parent, 'workspace');
  const outside = path.join(parent, 'outside');
  fs.mkdirSync(ws);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  try {
    fs.symlinkSync(outside, path.join(ws, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (err) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(err.code)) {
      t.skip('Windows runner does not permit creating directory junctions');
      return;
    }
    throw err;
  }
  assert.throws(() => guard(ws, 'escape', 'secret.txt'), { code: 'EPATHESCAPE' });
  assert.throws(() => guard(ws, 'escape', 'new.txt'), { code: 'EPATHESCAPE' });
});

test('allows a symlink that resolves to another location inside workspace', t => {
  const ws = temp();
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  fs.mkdirSync(path.join(ws, 'real'));
  fs.symlinkSync(path.join(ws, 'real'), path.join(ws, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(guard(ws, 'alias', 'new.txt'), path.join(ws, 'alias', 'new.txt'));
});

test('quotes safe arguments for cmd.exe and rejects shell metacharacters', () => {
  const { quoteCmdArg } = require('../lib/runner');
  assert.equal(quoteCmdArg('C:\\Program Files\\Android\\apktool.bat'), '"C:\\Program Files\\Android\\apktool.bat"');
  assert.throws(() => quoteCmdArg('name&calc.exe'), { code: 'EUNSAFECMDARG' });
  assert.throws(() => quoteCmdArg('%TEMP%\\payload.apk'), { code: 'EUNSAFECMDARG' });
  assert.throws(() => quoteCmdArg('line1\nline2'), { code: 'EUNSAFECMDARG' });
});

test('exec safely invokes a batch file with a spaced argument', async t => {
  if (process.platform !== 'win32') {
    t.skip('Windows batch execution is platform-specific');
    return;
  }
  const fs = require('node:fs');
  const os = require('node:os');
  const { exec } = require('../lib/runner');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apk-devkit-cmd-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const script = path.join(dir, 'batch tool.cmd');
  fs.writeFileSync(script, '@echo off\r\necho %~1\r\n', 'utf8');
  const result = await exec(script, ['hello world'], {
    cwd: dir,
    shell: true,
    timeoutMs: 10000,
  });
  assert.match(result.stdout, /hello world/);
});
