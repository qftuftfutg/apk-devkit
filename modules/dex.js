'use strict';
const fs = require('node:fs');
const { exec, guard } = require('../lib/runner');
const { resolve } = require('../lib/platform');

module.exports = (ctx) => ({
  name: 'dex',
  tools() { return ['baksmali', 'smali', 'd8']; },
  describe() {
    return {
      disassemble: {
        description: 'DEX → smali 目录。',
        properties: { dex: { type: 'string' }, out: { type: 'string' } },
        required: ['dex', 'out'],
      },
      assemble: {
        description: 'smali 目录 → DEX。',
        properties: { smaliDir: { type: 'string' }, outDex: { type: 'string' } },
        required: ['smaliDir', 'outDex'],
      },
      jar2dex: {
        description: 'JAR → DEX（输出到指定目录）。',
        properties: { jar: { type: 'string' }, outDir: { type: 'string' } },
        required: ['jar', 'outDir'],
      },
    };
  },
  async disassemble({ dex, out } = {}) {
    const t = resolve('baksmali');
    const args = ['d', '-o', guard(ctx.ws, out), guard(ctx.ws, dex)];
    return exec(t.cmd, [...t.args, ...args], { cwd: ctx.ws, shell: t.shell });
  },
  async assemble({ smaliDir, outDex } = {}) {
    const t = resolve('smali');
    const args = ['a', '-o', guard(ctx.ws, outDex), guard(ctx.ws, smaliDir)];
    return exec(t.cmd, [...t.args, ...args], { cwd: ctx.ws, shell: t.shell });
  },
  async jar2dex({ jar, outDir } = {}) {
    const t = resolve('d8');
    const outAbs = guard(ctx.ws, outDir);
    fs.mkdirSync(outAbs, { recursive: true });
    const args = ['--output', outAbs, guard(ctx.ws, jar)];
    return exec(t.cmd, [...t.args, ...args], { cwd: ctx.ws, shell: t.shell });
  },
});
