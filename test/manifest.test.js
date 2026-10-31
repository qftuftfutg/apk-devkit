'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const Session = require('../orchestrator');

test('all modules load and manifest exposes the documented tool count', t => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'apk-devkit-manifest-'));
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  const session = new Session(ws).load(path.join(__dirname, '..', 'modules'));
  assert.deepEqual(session.failures(), []);
  assert.equal(Object.keys(session.modules).length, 10);
  const manifest = session.manifest();
  assert.equal(manifest.length, 38);
  const names = manifest.map(tool => tool.name);
  assert.equal(new Set(names).size, names.length, 'tool names must be unique');
  for (const tool of manifest) {
    assert.equal(typeof tool.name, 'string');
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(typeof tool.inputSchema.properties, 'object');
  }
});
