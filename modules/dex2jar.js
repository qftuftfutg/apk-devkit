'use strict';
/*
 * 来源与许可声明
 * ---------------------------------------------------------------------------
 * 本文件是 apk-devkit 自研的**参数封装层**，为独立编写。
 *
 * 它不复制、不翻译、不修改 dex2jar 的任何源代码，也不包含其转换逻辑。
 * 本文件所做的全部工作：
 *   1. 把工具入参映射为 dex2jar 的命令行参数
 *   2. 通过 lib/runner.js#exec() 以子进程方式调用官方发布的 d2j-dex2jar
 *   3. 把其 stdout / stderr 原样返回
 *
 * 因此本文件不构成 dex2jar 的衍生作品，适用 apk-devkit 自身的 MIT 许可。
 *
 * 被调用的上游项目：
 *   pxb1988/dex2jar  https://github.com/pxb1988/dex2jar
 *   Apache License 2.0
 * 许可与致谢见项目根目录的 NOTICE 文件。
 * ---------------------------------------------------------------------------
 */
const { exec, guard } = require('../lib/runner');
const { resolve } = require('../lib/platform');

/*
 * 工具名解析。
 *
 * dex2jar 的官方发行形态是 `d2j-dex2jar.bat`（Windows）/ `d2j-dex2jar-*.jar`，
 * 而不是 `dex2jar.bat`。两种命名都接受：
 *   先按 d2j-dex2jar 找（官方发行名），未命中目录内文件时再退回 dex2jar。
 * resolve() 在"目录内没找到"时会返回裸工具名（PATH 兜底），
 * 正是用它来区分"命中了项目内文件"和"只是兜底"。
 */
function resolveDex2jar() {
  for (const name of ['d2j-dex2jar', 'dex2jar']) {
    const t = resolve(name);
    if (t.cmd !== name) return t; // 命中 tools/windows/ 内的 exe / bat / jar
  }
  return resolve('dex2jar'); // 两者都未命中 → 裸名，交给 PATH
}

module.exports = (ctx) => ({
  name: 'dex2jar',
  tools() { return ['dex2jar']; },
  describe() {
    return {
      jar: {
        description: 'DEX → JAR（dex2jar）。输出文件在 workspace 内。',
        properties: {
          dex: { type: 'string', description: 'workspace 内的 .dex 路径，或包含 dex 的目录' },
          out: { type: 'string', description: '输出的 .jar 路径（workspace 内）' },
        },
        required: ['dex', 'out'],
      },
    };
  },
  async jar({ dex, out } = {}) {
    const t = resolveDex2jar();
    const args = [guard(ctx.ws, dex), '-o', guard(ctx.ws, out)];
    // 大 APK 的 DEX 转换可能跑很久，给足 10 分钟（默认 5 分钟不够）
    return exec(t.cmd, [...t.args, ...args], {
      cwd: ctx.ws,
      timeoutMs: 10 * 60 * 1000,
      shell: t.shell,
    });
  },
});
