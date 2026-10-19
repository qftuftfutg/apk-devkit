'use strict';
/*
 * 来源与许可声明
 * ---------------------------------------------------------------------------
 * 本文件是 apk-devkit 自研的**参数封装层**，为独立编写。
 *
 * 它不复制、不翻译、不修改 REAndroid/APKEditor 的任何源代码，
 * 也不包含 ARSCLib 的任何实现逻辑。本文件所做的全部工作：
 *   1. 把工具入参映射为 APKEditor 的命令行参数
 *   2. 通过 lib/runner.js#exec() 以子进程方式调用官方发布的 apkeditor.jar
 *   3. 解析其 stdout（JSON 或纯文本）后返回
 *
 * 因此本文件不构成 APKEditor 的衍生作品，适用 apk-devkit 自身的 MIT 许可。
 *
 * 被调用的上游项目：
 *   REAndroid/APKEditor  https://github.com/REAndroid/APKEditor
 *   Apache License 2.0
 * 许可与致谢见项目根目录的 NOTICE 文件。
 * ---------------------------------------------------------------------------
 */
const { exec, guard } = require('../lib/runner');
const { resolve } = require('../lib/platform');

/**
 * 集成 REAndroid/APKEditor（https://github.com/REAndroid/APKEditor）
 *
 * 它基于自研 ARSCLib 直接编辑二进制资源（resources.arsc），
 * **不依赖 aapt / aapt2**，一个 jar 就能跑完"资源解码 → 改 → 重建"。
 *
 * 部署：把官方发布的 APKEditor-x.x.x.jar 重命名为小写后放入
 *   tools/windows/apkeditor.jar    （platform.js 自动走 java -jar）
 * 或设 APK_TOOLS_DIR 指向其所在目录（本项目仅支持 Windows）。
 *
 * 命令速记：d=decode  b=build  m=merge  x=refactor  p=protect  info
 *
 * ⚠️ CLI 参数待真机核实（本模块按官方 README + Wiki 编写，未实跑过 jar）：
 *   跑 `java -jar apkeditor.jar info -h` 与 `... d -h` 拿真实 help 后校准下列项：
 *     1. info 下是 `-signatures` 还是 `-signature`？是否真有 `-signatures-base64`？
 *     2. `-xmlstrings` / `-xmltree` 是 info 的子参数，还是独立子命令？
 *     3. `-filter-type` 是否需要配合 `-type` 使用？
 *     4. `d -t json` 的最低版本要求（老版本可能只支持 xml / raw）
 *     5. `m -i` 是否真能吃 .xapk / .apkm / .apks（官方 README 声称可以，未实测）
 *   核实后请把真实参数表回填到本注释，接手者就不必再查。
 */
// 一次性警告：让使用者在运行时也能看到"CLI 参数未经真机核实"。
//
// ⚠️ 必须放在模块顶层（require 时执行），而不是工厂函数 (ctx) => { ... } 内部。
//    放工厂内会在每次 module.exports(ctx) 被调用时打一遍；
//    插件热重载 / 测试里多次 new Session().load() 就会刷屏。
//    放顶层则由 Node 的模块缓存保证整个进程只打一次。
process.stderr.write(
  '[apk-devkit/apkedit] 注意：APKEditor 的 CLI 参数尚未在真机上核实，' +
  '如遇参数报错请对照 `java -jar apkeditor.jar info -h` 校准' +
  '（详见 modules/apkedit.js 头部注释的 5 条待核实项）\n'
);

// 入参校验辅助：本模块所有入参最终都会拼进 java -jar 的 argv。
// 底层是 spawn(args 数组) 且 shell:false，不构成 shell 注入；
// 但仍需挡住两类问题：(a) 类型不对（如 files 传了字符串会被逐字符劈开）
// (b) 值以 '-' 开头会被 APKEditor 当成额外选项（参数混淆）。
function needArray(v, name) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) {
    throw Object.assign(
      new Error(`${name} 必须是数组，收到 ${typeof v}`),
      { code: 'EBADARG' }
    );
  }
  return v;
}
function needNoDash(v, name) {
  if (typeof v === 'string' && v.startsWith('-')) {
    throw Object.assign(
      new Error(`${name} 不能以 '-' 开头（会被当作命令行选项）: ${v}`),
      { code: 'EBADARG' }
    );
  }
  return v;
}
function needPositiveInt(v, name) {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) {
    throw Object.assign(
      new Error(`${name} 必须是正整数，收到 ${JSON.stringify(v)}`),
      { code: 'EBADARG' }
    );
  }
  return n;
}

module.exports = (ctx) => {
  return {
  name: 'apkedit',
  tools() { return ['apkeditor']; },
  describe() {
    return {
      info: {
        description: '读取 APK 深度信息。不依赖 aapt2。默认只打印 package/app-name/activities/dex/signatures 五项（避免大 APK 输出几十 MB 撑爆会话）；传 what: ["all"] 打印全部。',
        properties: {
          apk: { type: 'string' },
          what: {
            type: 'array',
            description: '要打印的项。留空 → package/activities/dex/signatures；传 ["all"] → 全部。可选：resources permissions dex package activities languages locales configurations list-files list-xml-files signatures signatures-base64 app-name app-icon app-round-icon app-class min-sdk-version',
            items: { type: 'string' },
          },
          filterType: { type: 'string', description: '按资源类型过滤，如 drawable / string。仅当 what 包含 "resources" 时可用，否则会报 EBADFILTER' },
          json: { type: 'boolean', default: true, description: '以 JSON 输出。注意：-t json 对部分子项（如 list-files）不保证输出 JSON，此时返回 raw 字段兜底' },
        },
        required: ['apk'],
      },
      decode: {
        description: '把 APK 二进制资源解码为可编辑的 json（默认）或 xml。',
        properties: {
          apk: { type: 'string' }, out: { type: 'string' },
          type: { type: 'string', enum: ['json', 'xml', 'raw'], default: 'json' },
          resDir: { type: 'string', description: '自定义资源目录名' },
          loadDex: { type: 'number', description: '一次加载多少个 DEX，内存紧张时调小' },
        },
        required: ['apk', 'out'],
      },
      build: {
        description: '把解码后的目录重建为 APK（自动 zipalign）。',
        properties: { src: { type: 'string' }, out: { type: 'string' } },
        required: ['src', 'out'],
      },
      merge: {
        description: '合并分割包为独立 APK。目录形式已确认可用；XAPK / APKM / APKS 官方声称支持但本项目未实测，如遇报错请对照 `apkeditor.jar -h` 校准。',
        properties: { src: { type: 'string' }, out: { type: 'string' } },
        required: ['src', 'out'],
      },
      refactor: {
        description: '把混淆的资源名重命名为可读名（反混淆，提升可读性）。',
        properties: { apk: { type: 'string' }, out: { type: 'string' } },
        required: ['apk', 'out'],
      },
      xmlStrings: {
        description: '打印指定编译后 XML 的字符串池（对应"字符常量池"）。',
        properties: { apk: { type: 'string' }, files: { type: 'array', items: { type: 'string' } } },
        required: ['apk', 'files'],
      },
      xmlTree: {
        description: '以树形打印指定编译后 XML（对应"XML 编辑"的只读视图）。',
        properties: { apk: { type: 'string' }, files: { type: 'array', items: { type: 'string' } } },
        required: ['apk', 'files'],
      },
    };
  },

  // info -i <apk> [-resources -permissions ...] [-t json]
  async info({ apk, what, filterType, json = true } = {}) {
    const KNOWN = [
      'resources', 'permissions', 'dex', 'package', 'activities',
      'languages', 'locales', 'configurations', 'list-files',
      'list-xml-files', 'signatures', 'signatures-base64',
      'app-name', 'app-icon', 'app-round-icon', 'app-class', 'min-sdk-version',
    ];
    const known = new Set(KNOWN);

    // 默认只打印这几项：-resources / -list-files 对大 APK 会输出几十 MB，
    // 足以撑爆 DSH 会话。要全量必须显式传 what: ['all']。
    const DEFAULT_INFO = ['package', 'app-name', 'activities', 'dex', 'signatures'];

    let picked;
    if (!what || what.length === 0) {
      picked = [...DEFAULT_INFO];
    } else if (what.includes('all')) {
      picked = [...KNOWN];
    } else {
      picked = what.filter(w => known.has(w));
      // 传了但全不认识 → 明确报错，不能静默退化成"什么都不打印"
      if (picked.length === 0) {
        const bad = what.filter(w => !known.has(w));
        throw Object.assign(
          new Error(`未知的 what: ${bad.join(', ')}。可选：${KNOWN.join(', ')}、all`),
          { code: 'EBADWHAT', validValues: [...KNOWN, 'all'] }
        );
      }
    }

    // -filter-type 只对 -resources 有意义；配合 -package 等其他子项
    // 可能被 APKEditor 报错或忽略。参数校验放在 spawn 之前，
    // 这样即使平台/工具未就绪也能立刻反馈，而不是先撞上 EPLATFORM。
    if (filterType !== undefined) needNoDash(filterType, 'filterType');
    if (filterType && !picked.includes('resources')) {
      throw Object.assign(
        new Error('filterType 仅在 what 包含 "resources" 时可用'),
        { code: 'EBADFILTER', hint: '请改为 what: ["resources", ...] 后再传 filterType' }
      );
    }

    const t = resolve('apkeditor');
    const args = ['info', '-i', guard(ctx.ws, apk)];
    for (const w of picked) args.push('-' + w);
    if (filterType) args.push('-filter-type', filterType);
    if (json) args.push('-t', 'json');

    const { stdout } = await exec(t.cmd, [...t.args, ...args], {
      cwd: ctx.ws, timeoutMs: 5 * 60 * 1000, shell: t.shell,
    });
    if (!json) return { raw: stdout, requested: picked };
    try { return { ...JSON.parse(stdout), requested: picked }; }
    catch {
      // APKEditor 的 -t json 对部分子项（如 list-files）不保证输出 JSON，此处兜底
      return {
        raw: stdout, requested: picked,
        warn: 'APKEditor 未返回合法 JSON（-t json 对部分子项不保证 JSON 输出），已原样返回 raw',
      };
    }
  },

  // d -i <apk> -o <dir> [-t json|xml|raw] [--res-dir name] [-load-dex n]
  async decode({ apk, out, type = 'json', resDir, loadDex } = {}) {
    // describe 声明了 enum ['json','xml','raw']，实现侧必须真校验，
    // 否则 bogus 值会一路拼进 argv，报错要等子进程吐出来才知道
    if (!['json', 'xml', 'raw'].includes(type)) {
      throw Object.assign(
        new Error(`type 必须是 json / xml / raw 之一，收到 ${JSON.stringify(type)}`),
        { code: 'EBADARG', validValues: ['json', 'xml', 'raw'] }
      );
    }
    if (resDir !== undefined) needNoDash(resDir, 'resDir');
    if (loadDex !== undefined) needPositiveInt(loadDex, 'loadDex');
    const t = resolve('apkeditor');
    const args = ['d', '-i', guard(ctx.ws, apk), '-o', guard(ctx.ws, out), '-t', type];
    if (resDir) args.push('--res-dir', resDir);
    if (loadDex !== undefined) args.push('-load-dex', String(loadDex));
    return exec(t.cmd, [...t.args, ...args], {
      cwd: ctx.ws, timeoutMs: 10 * 60 * 1000, onStdout: ctx.log, shell: t.shell,
    });
  },

  // b -i <dir> -o <apk>
  async build({ src, out } = {}) {
    const t = resolve('apkeditor');
    const args = ['b', '-i', guard(ctx.ws, src), '-o', guard(ctx.ws, out)];
    return exec(t.cmd, [...t.args, ...args], {
      cwd: ctx.ws, timeoutMs: 15 * 60 * 1000, onStdout: ctx.log, shell: t.shell,
    });
  },

  // m -i <dir|xapk|apkm|apks> -o <apk>
  async merge({ src, out } = {}) {
    const t = resolve('apkeditor');
    const args = ['m', '-i', guard(ctx.ws, src), '-o', guard(ctx.ws, out)];
    return exec(t.cmd, [...t.args, ...args], {
      cwd: ctx.ws, timeoutMs: 15 * 60 * 1000, onStdout: ctx.log, shell: t.shell,
    });
  },

  // x -i <apk> -o <apk>
  async refactor({ apk, out } = {}) {
    const t = resolve('apkeditor');
    const args = ['x', '-i', guard(ctx.ws, apk), '-o', guard(ctx.ws, out)];
    return exec(t.cmd, [...t.args, ...args], {
      cwd: ctx.ws, timeoutMs: 10 * 60 * 1000, onStdout: ctx.log, shell: t.shell,
    });
  },

  // info -i <apk> -xmlstrings <file>...
  async xmlStrings({ apk, files } = {}) {
    const list = needArray(files, 'files').map(f => needNoDash(String(f), 'files[]'));
    const t = resolve('apkeditor');
    const args = ['info', '-i', guard(ctx.ws, apk), '-xmlstrings', ...list];
    // 与 info/其他子命令一致带超时：APKEditor 卡住时不能无限期挂住会话
    const { stdout } = await exec(t.cmd, [...t.args, ...args], {
      cwd: ctx.ws, timeoutMs: 5 * 60 * 1000, shell: t.shell,
    });
    return { raw: stdout, files: list };
  },

  // info -i <apk> -xmltree <file>...
  async xmlTree({ apk, files } = {}) {
    const list = needArray(files, 'files').map(f => needNoDash(String(f), 'files[]'));
    const t = resolve('apkeditor');
    const args = ['info', '-i', guard(ctx.ws, apk), '-xmltree', ...list];
    const { stdout } = await exec(t.cmd, [...t.args, ...args], {
      cwd: ctx.ws, timeoutMs: 5 * 60 * 1000, shell: t.shell,
    });
    return { raw: stdout, files: list };
  },
  };
};
