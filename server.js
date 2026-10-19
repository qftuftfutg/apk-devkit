#!/usr/bin/env node
'use strict';
const path = require('node:path');
const readline = require('node:readline');
const Session = require('./orchestrator');
const runner = require('./lib/runner');

const WORKSPACE = process.env.APK_WORKSPACE || path.join(process.cwd(), 'workspace');
const session = new Session(WORKSPACE).load(path.join(__dirname, 'modules'));
const TOOLS = session.manifest();
const ROUTES = new Map(TOOLS.map(t => [t.name, t._route]));
const PUBLIC_TOOLS = TOOLS.map(({ _route, ...rest }) => rest);

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

async function handle(msg) {
  const { id, method, params } = msg;
  try {
    if (method === 'initialize') {
      send({
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: {
            name: 'apk-devkit',
            version: '0.1.0',
            disabledModules: session.disabledModules(),
          },
        },
      });
      return;
    }
    if (method === 'tools/list') {
      send({ jsonrpc: '2.0', id, result: { tools: PUBLIC_TOOLS } });
      return;
    }
    if (method === 'tools/call') {
      const name = params?.name;
      const args = params?.arguments || {};
      const route = ROUTES.get(name);
      if (!route) {
        send({ jsonrpc: '2.0', id, error: { code: -32601, message: `未知工具 ${name}` } });
        return;
      }
      const r = await session.call(route.mod, route.fn, args);
      send({
        jsonrpc: '2.0', id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(r, null, 2) }],
          isError: !r.ok,
        },
      });
      return;
    }
    if (method === 'notifications/initialized' || method?.startsWith('notifications/')) return;

    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `不支持的方法 ${method}` } });
  } catch (e) {
    send({ jsonrpc: '2.0', id, error: { code: -32603, message: String(e?.message || e) } });
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', line => {
  const s = line.trim();
  if (!s) return;
  let msg;
  try { msg = JSON.parse(s); }
  catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON 解析失败' } }); return; }
  handle(msg);
});
rl.on('close', () => process.exit(0));

// DSH / 宿主退出时常发 SIGTERM，需释放 stdio 与子进程
function shutdown() {
  try { rl.close(); } catch {}
  for (const child of runner.ACTIVE_CHILDREN) try { child.kill('SIGKILL'); } catch {}
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
