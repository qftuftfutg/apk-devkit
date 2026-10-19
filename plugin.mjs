/**
 * apk-devkit — DeepSeek Harness (DSH) cordis 插件入口
 *
 * 与 server.js（MCP stdio）的区别：
 *   server.js  → 以 MCP 外部服务接入，工具名带 mcp__ 前缀，需手写 cordis.patch.yml
 *   plugin.mjs → 以 cordis 原生插件接入，工具名即 apk_decode，安装即生效
 *
 * 二者共用同一套 orchestrator / modules，能力完全一致，只是挂载方式不同。
 *
 * ⚠️ 硬约束：本文件不得 import 任何 `@deepseek-ai/*` 模块。
 *   本项目走"出仓安装"路线（独立目录 + `dsh plugin add ./apk-devkit`）。
 *   Node 解析裸包名时从插件文件所在目录逐级向上找 node_modules，
 *   独立目录里没有宿主包的 node_modules，第一个裸包 import 就会触发
 *   ERR_MODULE_NOT_FOUND。仓内开发路线（clone DSH 源码 + `--patch`）
 *   才允许 import 宿主包，本项目不是那条路线。
 *   只允许 `node:*` 内置模块和本项目相对路径。
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const Session = require('./orchestrator.js');

export const name = 'apk-devkit';

// 静态声明依赖：未声明的服务访问会被 context proxy 拒绝
export const inject = ['tools'];

/**
 * 把 session.call 的返回翻译成 cordis 工具结果。
 *
 * 统一形状（成功与失败都是 object，与 output.schema 的 { type: 'object' } 匹配）：
 *   成功 → { ok: true,  isError: false, content: <result> }
 *   失败 → { ok: false, isError: true,  error: { message, info }, stderr? }
 *
 * 同时带 ok / isError 两套标记，兼容不同前端对"失败"的识别习惯。
 * 若将来真机确认 DSH 期望别的形状，只改本函数，不必动 render 与 execute。
 */
function toResult(toolName, route, r) {
  if (r.ok) {
    // content 为 undefined 会让 DSH 的工具结果校验报 "not lossless JSON"：
    // JSON.stringify 丢掉 undefined 键后往返不一致。统一折成 null。
    return { ok: true, isError: false, content: r.result === undefined ? null : r.result };
  }
  const message = r.hint
    ? `[${toolName}] ${r.error}\n提示：${r.hint}`
    : `[${toolName}] ${r.error}`;
  const out = {
    ok: false,
    isError: true,
    error: {
      message,
      info: {
        name: toolName,
        code: r.hint ? 'HINTED' : 'ERROR',
        module: route.mod,
        fn: route.fn,
      },
    },
  };
  // 同理：stderr 缺省时不能留 undefined 键。
  if (r.stderr !== undefined && r.stderr !== null) out.stderr = r.stderr;
  return out;
}

/**
 * 把 toResult 的输出渲染为前端可见的文本。
 * 失败走纯文本（易读），成功走 JSON（便于 AI 解析结构化字段）。
 */
function renderResult(_args, value) {
  if (value && value.isError) {
    return [{ type: 'text', text: value.error?.message || '未知错误' }];
  }
  const content = value && Object.prototype.hasOwnProperty.call(value, 'content')
    ? value.content
    : value;
  const text = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
  return [{ type: 'text', text }];
}

export function apply(ctx, config = {}) {
  const workspace =
    config.workspace ||
    process.env.APK_WORKSPACE ||
    path.join(process.cwd(), 'workspace');

  const session = new Session(workspace).load(path.join(__dirname, 'modules'));
  const tools = session.manifest();
  const disposers = [];

  // 真机验证 Checklist 第 1 项依赖这行日志：数字不是 37 说明有模块加载失败，
  // 紧跟其后的 "[apk-devkit] 模块加载失败 X: ..." 会给出原因。
  console.log(`[apk-devkit] loaded; registering ${tools.length} tools; workspace=${workspace}`);

  for (const t of tools) {
    disposers.push(
      ctx.tools.register({
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,

        // render 决定结果如何回传给 DSH 前端。
        // 后续做编辑器 / 预览时，这里可返回更丰富的结构（image / html / 自定义 type），
        // 但务必保持对 isError 分支的兜底，否则失败会被静默成空结果。
        output: {
          schema: { type: 'object' },
          render: renderResult,
        },

        async execute(args = {}) {
          const r = await session.call(t._route.mod, t._route.fn, args);
          // 不 throw：结构化返回才能让 AI 拿到 hint 自我纠错；
          // throw 出去的信息在 cordis 侧会被包一层，只剩 message。
          return toResult(t.name, t._route, r);
        },
      })
    );
  }

  // 返回清理函数：插件热禁用 / 卸载时注销全部工具
  return () => {
    for (const d of disposers) {
      try { d?.(); } catch {}
    }
  };
}
