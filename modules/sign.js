'use strict';
const { exec, guard } = require('../lib/runner');
const { resolve } = require('../lib/platform');

// 密码一律通过环境变量传给 apksigner，避免明文出现在进程命令行里
// （ps / 任务管理器 / /proc/<pid>/cmdline 对同机其他用户可见）。
//
// 返回的是一份**增量 env**（只包含要注入的变量），交给 runner#exec 的
// opts.env 与 process.env 浅拷贝合并后传给子进程。
// 绝不直接写全局 process.env —— 那是进程级共享的可变单例：
//   · 并发两次签名时后一次会覆盖前一次的密码
//   · 密码在进程退出前一直挂在环境里，任何后续子进程都能读到
function withSecrets(ksPass, keyPass) {
  const env = {};
  if (ksPass !== undefined) env.APK_KS_PASS = ksPass;
  if (keyPass !== undefined) env.APK_KEY_PASS = keyPass;
  return env;
}

module.exports = (ctx) => ({
  name: 'sign',
  tools() { return ['apksigner', 'zipalign']; },
  describe() {
    return {
      apk: {
        description: '对 APK 进行 V1/V2/V3 签名。keystore 由用户自备；密码由参数传入，经环境变量中转以避免命令行泄露。',
        properties: {
          apk: { type: 'string' }, out: { type: 'string' },
          ks: { type: 'string', description: 'keystore 相对路径' },
          alias: { type: 'string' },
          ksPass: { type: 'string', writeOnly: true, description: 'keystore 密码' },
          keyPass: { type: 'string', writeOnly: true, description: '私钥密码，缺省时使用 ksPass' },
          v1: { type: 'boolean', default: true },
          v2: { type: 'boolean', default: true },
          v3: { type: 'boolean', default: false },
        },
        required: ['apk', 'out', 'ks', 'alias', 'ksPass'],
      },
      verify: {
        description: '验证 APK 签名并输出证书信息。',
        properties: { apk: { type: 'string' } },
        required: ['apk'],
      },
      align: {
        description: 'zipalign 对齐 APK。',
        properties: { apk: { type: 'string' }, out: { type: 'string' } },
        required: ['apk', 'out'],
      },
    };
  },
  async apk({ apk, out, ks, alias, ksPass, keyPass, v1 = true, v2 = true, v3 = false } = {}) {
    const t = resolve('apksigner');
    // apksigner 支持 --ks-pass env:<NAME>、--key-pass env:<NAME>
    const args = [
      'sign',
      '--ks', guard(ctx.ws, ks),
      '--ks-key-alias', alias,
      '--ks-pass', 'env:APK_KS_PASS',
      '--key-pass', 'env:APK_KEY_PASS',
      '--v1-signing-enabled', String(v1),
      '--v2-signing-enabled', String(v2),
      '--v3-signing-enabled', String(v3),
      '--out', guard(ctx.ws, out),
      guard(ctx.ws, apk),
    ];
    return exec(t.cmd, [...t.args, ...args], {
      cwd: ctx.ws,
      shell: t.shell,
      env: withSecrets(ksPass, keyPass === undefined ? ksPass : keyPass),
    });
  },
  async verify({ apk } = {}) {
    const t = resolve('apksigner');
    const { stdout } = await exec(t.cmd,
      [...t.args, 'verify', '--verbose', '--print-certs', guard(ctx.ws, apk)],
      { cwd: ctx.ws, shell: t.shell });
    return { ok: !/FAILED/i.test(stdout), raw: stdout };
  },
  async align({ apk, out } = {}) {
    const t = resolve('zipalign');
    const args = ['-p', '4', '-f', guard(ctx.ws, apk), guard(ctx.ws, out)];
    return exec(t.cmd, [...t.args, ...args], { cwd: ctx.ws, shell: t.shell });
  },
});
