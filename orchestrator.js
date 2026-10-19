'use strict';
const fs = require('node:fs');
const path = require('node:path');

class Session {
  constructor(ws) {
    this.ws = path.resolve(ws);
    if (!fs.existsSync(this.ws)) fs.mkdirSync(this.ws, { recursive: true });
    this.ctx = { ws: this.ws, log: msg => process.stderr.write(msg) };
    this.modules = {};
  }

  load(dir) {
    const absDir = path.resolve(dir);
    const failed = [];
    for (const f of fs.readdirSync(absDir)) {
      if (!f.endsWith('.js')) continue;
      let mod;
      // 模块名由文件名推导（diff.js → diff），加载失败时也能报出模块名，
      // 这样 disabledModules 的取值与工具名前缀（diff_*）一致，客户端能匹配上
      const modName = path.basename(f, '.js');
      try {
        mod = require(path.join(absDir, f))(this.ctx);
      } catch (e) {
        // 单个模块加载失败（依赖缺失、语法错误）不应拖垮整个工具集
        failed.push({ module: modName, file: f, error: e.message });
        process.stderr.write(`[apk-devkit] 模块加载失败 ${f}: ${e.message}\n`);
        continue;
      }
      if (!mod || !mod.name) continue;
      this.modules[mod.name] = mod;
    }
    this._failed = failed;
    if (failed.length) {
      process.stderr.write(`[apk-devkit] ${failed.length} 个模块未加载，${Object.keys(this.modules).length} 个可用\n`);
    }
    return this;
  }

  manifest() {
    const tools = [];
    for (const [modName, m] of Object.entries(this.modules)) {
      const desc = typeof m.describe === 'function' ? m.describe() : {};
      const methods = Object.keys(m).filter(k =>
        typeof m[k] === 'function' && !['tools', 'describe', 'name'].includes(k)
      );
      for (const fn of methods) {
        const meta = desc[fn] || {};
        tools.push({
          name: `${modName}_${fn}`,
          description: meta.description || `${modName}.${fn}`,
          inputSchema: {
            type: 'object',
            properties: meta.properties || {},
            required: meta.required || [],
          },
          _route: { mod: modName, fn },
        });
      }
    }
    return tools;
  }

  // 供 MCP server 告知客户端哪些模块不可用（如 sharp 未装导致 img 模块整体失败）
  // 元素含 module（= 工具名前缀，如 diff / zip）与 file（= diff.js）
  failures() {
    return this._failed || [];
  }

  // 直接给出模块名数组，供 serverInfo.disabledModules 使用（D6 修复）
  disabledModules() {
    return (this._failed || []).map(f => f.module);
  }

  async call(mod, fn, args = {}) {
    const m = this.modules[mod];
    if (!m || typeof m[fn] !== 'function') {
      return { ok: false, mod, fn, error: `未知能力 ${mod}.${fn}`, hint: '检查 manifest() 输出的 name' };
    }
    const start = Date.now();
    try {
      const result = await m[fn](args);
      return { ok: true, mod, fn, elapsed: Date.now() - start, result };
    } catch (e) {
      return {
        ok: false, mod, fn, elapsed: Date.now() - start,
        error: e.message, stderr: e.stderr, hint: this._hint(mod, fn, e),
      };
    }
  }

  _hint(mod, fn, err) {
    // 平台不支持：明确这是设计限制而非 bug，与"缺工具"区分开
    if (err.code === 'EPLATFORM') {
      return '本项目设计上仅支持 Windows（不是 bug）。' +
        '如需其他平台，需自行补充 tools/<platform>/ 与 lib/platform.js 的解析逻辑';
    }
    // 只有 spawn 自身失败（syscall === 'spawn'）才算"缺工具"。
    // 文件不存在也是 ENOENT（syscall === 'open'/'stat'），必须区分，
    // 否则会把"文件没找到"误报成"缺少底层工具"，误导排错。
    const missingTool =
      err.code === 'ENOENT_TOOL' ||
      (err.code === 'ENOENT' && err.syscall === 'spawn') ||
      /spawn\s+\S+\s+ENOENT/.test(err.message || '');

    if (missingTool) {
      // java 启动失败 ≠ 缺工具，是缺 JDK。
      //
      // 所有 .jar 形态的工具（apkeditor / apksigner / baksmali / smali）都由
      // platform.js 解析成 `java -jar xxx.jar`。此时 spawn 失败的是 java 本身，
      // 若落到下面的"缺工具"分支，用户会被告知去装 apkeditor —— 而他缺的是 JDK。
      //
      // 判定只看可执行名（err.path，spawn 失败时由 Node 填入）与 spawn 报文，
      // 不扫整个 message：文件不存在是 syscall=open 的 ENOENT，进不到本分支。
      const exePath = String(err.path || '');
      const isJava =
        /(^|[\\/])javaw?(\.exe)?$/i.test(exePath) ||
        /\bspawn\s+javaw?(\.exe)?\b/i.test(err.message || '');
      if (isJava) {
        return '缺少 Java 运行时（JDK 17+），请先安装并确认 `java -version` 可用';
      }
      const tools = this.modules[mod]?.tools?.() || [];
      return `缺少底层工具，请先安装：${tools.join(', ') || '对应 npm 包'}`;
    }
    if (err.code === 'ENOENT') return `文件不存在或路径错误（已限制在 workspace 内）`;
    if (/路径越界/.test(err.message)) return '输入/输出路径必须在 workspace 内，用相对路径';
    if (/退出码/.test(err.message)) return '查看 stderr 定位工具报错：参数错误 / 输入损坏 / JDK 版本不匹配';
    // 兜底：模块自己带的 hint 一律透传（如 EBADFILTER / ETOOSMALL 的"下一步该怎么做"）。
    // 放在最后，保证上面几条针对性判断优先；模块只需在 throw 时附 hint 字段即可，
    // 不必把提示硬塞进 message。
    if (err.hint) return err.hint;
    return null;
  }
}

module.exports = Session;
