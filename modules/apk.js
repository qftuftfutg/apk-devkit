'use strict';
const { exec, guard } = require('../lib/runner');
const { resolve } = require('../lib/platform');

module.exports = (ctx) => ({
  name: 'apk',
  tools() { return ['apktool', 'aapt2']; },
  describe() {
    return {
      info: {
        description: '读取 APK 基本信息（包名、版本、minSdk、权限）。路径需在 workspace 内。',
        properties: { apk: { type: 'string', description: 'APK 相对路径' } },
        required: ['apk'],
      },
      decode: {
        description: '解包 APK 到目录。',
        properties: { apk: { type: 'string' }, out: { type: 'string' } },
        required: ['apk', 'out'],
      },
      build: {
        description: '回编译目录为未签名 APK。',
        properties: { src: { type: 'string' }, out: { type: 'string' } },
        required: ['src', 'out'],
      },
    };
  },
  async info({ apk } = {}) {
    const t = resolve('aapt2');
    const p = guard(ctx.ws, apk);
    const { stdout } = await exec(t.cmd, [...t.args, 'dump', 'badging', p], { cwd: ctx.ws, shell: t.shell });
    const pick = (re) => re.exec(stdout)?.[1] ?? null;
    return {
      package: pick(/package: name='([^']+)'/),
      versionName: pick(/versionName='([^']+)'/),
      versionCode: pick(/versionCode='([^']+)'/),
      minSdk: pick(/sdkVersion:'([^']+)'/),
      permissions: [...stdout.matchAll(/uses-permission: name='([^']+)'/g)].map(m => m[1]),
    };
  },
  async decode({ apk, out } = {}) {
    const t = resolve('apktool');
    const args = ['d', '-f', '-o', guard(ctx.ws, out), guard(ctx.ws, apk)];
    return exec(t.cmd, [...t.args, ...args], { cwd: ctx.ws, onStdout: ctx.log, shell: t.shell });
  },
  async build({ src, out } = {}) {
    const t = resolve('apktool');
    const args = ['b', '-o', guard(ctx.ws, out), guard(ctx.ws, src)];
    return exec(t.cmd, [...t.args, ...args], {
      cwd: ctx.ws, timeoutMs: 10 * 60 * 1000, onStdout: ctx.log, shell: t.shell,
    });
  },
});
