'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

test('MCP server answers ping with an empty result object', async () => {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const exit = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  child.stdin.end(JSON.stringify({ jsonrpc: '2.0', id: 17, method: 'ping' }) + '\n');
  const result = await exit;
  assert.equal(result.code, 0, stderr);
  const response = JSON.parse(stdout.trim().split(/\r?\n/)[0]);
  assert.equal(response.jsonrpc, '2.0');
  assert.equal(response.id, 17);
  assert.deepEqual(response.result, {});
});
