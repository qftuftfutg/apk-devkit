'use strict';
const path = require('node:path');
const Session = require('./orchestrator');

async function main() {
  const ws = path.join(__dirname, 'workspace');
  const s = new Session(ws).load(path.join(__dirname, 'modules'));

  console.log('=== manifest ===');
  console.log(JSON.stringify(s.manifest(), null, 2));

  // 示例：读取一个 APK 的信息（需先放一个 app.apk 到 workspace）
  // const r = await s.call('apk', 'info', { apk: 'app.apk' });
  // console.log(r);
}

main().catch(e => { console.error(e); process.exit(1); });
