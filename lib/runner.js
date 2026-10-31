'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const treeKill = require('tree-kill');

const MAX_CONCURRENT = 2;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/*
 * 子进程输出硬上限（stdout / stderr 各算）。
 *
 * 没有它时 `stdout += d.toString()` 是无界累积：apktool / d8 / APKEditor
 * 在 verbose 或异常包上可吐出几十上百 MB，一个洪泛子进程就能把整个
 * 插件进程（连带 DSH 会话）打爆。这与 file.js 的 READ_HARD_CAP、
 * file_list 的 HARD_CAP 是同类保护，只是它处在最底层原语上，
 * 一处生效即保护所有模块。
 *
 * 超限后不再累积（但仍继续 drain 管道，避免子进程因管道写满而阻塞），
 * 并在结果里置 truncated 与 outputTruncated 标记。
 */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024; // 8 MB

let running = 0;
const queue = [];

function enqueue(task) {
  return new Promise((resolve, reject) => {
    queue.push({ task, resolve, reject });
    pump();
  });
}

function pump() {
  while (running < MAX_CONCURRENT && queue.length) {
    const { task, resolve, reject } = queue.shift();
    running++;
    task().then(resolve, reject).finally(() => { running--; pump(); });
  }
}

function isWithin(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}

function guard(workspace, ...p) {
  const root = path.resolve(workspace);
  const abs = path.resolve(root, ...p);

  // 第一层：先做词法路径检查，拒绝显式 .. 越界。
  if (!isWithin(root, abs)) {
    throw Object.assign(
      new Error(`路径越界被拒绝: ${p.join('/')}`),
      { code: 'EPATHESCAPE', path: abs }
    );
  }

  // 第二层：解析真实路径，防止 workspace 内的 symlink/junction 指向外部。
  // 对尚不存在的输出文件，向上寻找最近的现存祖先，realpath 后再拼回缺失部分。
  let probe = abs;
  const missing = [];
  let physical;
  while (true) {
    try {
      physical = fs.realpathSync.native
        ? fs.realpathSync.native(probe)
        : fs.realpathSync(probe);
      break;
    } catch (err) {
      if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') throw err;
      const parent = path.dirname(probe);
      if (parent === probe) throw err;
      missing.unshift(path.basename(probe));
      probe = parent;
    }
  }

  const realRoot = fs.realpathSync.native
    ? fs.realpathSync.native(root)
    : fs.realpathSync(root);
  const resolved = path.resolve(physical, ...missing);
  if (!isWithin(realRoot, resolved)) {
    throw Object.assign(
      new Error(`路径经符号链接/目录联接越界被拒绝: ${p.join('/')}`),
      { code: 'EPATHESCAPE', path: resolved }
    );
  }
  return abs;
}

function quoteCmdArg(value) {
  const arg = String(value);
  // cmd.exe expands %VAR% even inside quotes; delayed expansion can also affect !VAR!.
  // Reject shell syntax instead of trying to emulate cmd's full escaping grammar.
  if (/[&|<>^()%!"\x00-\x1f]/u.test(arg)) {
    throw Object.assign(
      new Error('批处理工具参数包含 cmd.exe 元字符，已拒绝执行；请重命名文件或改用 .exe/.jar 工具'),
      { code: 'EUNSAFECMDARG' }
    );
  }
  const trailingBackslashes = (arg.match(/\\+$/u) || [''])[0].length;
  return '"' + arg + '\\\\'.repeat(trailingBackslashes) + '"';
}

function exec(cmd, args, opts = {}) {
  const spawnArgs = opts.shell ? args.map(quoteCmdArg) : args;
  return enqueue(() => new Promise((resolve, reject) => {
    const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const child = spawn(cmd, spawnArgs, {
      cwd: opts.cwd,
      // D2 修复：合并调用方传入的 env，而不是直接用 process.env。
      //
      // 早前硬编码 env: process.env，调用方想给子进程注入变量（如 apksigner
      // 的密码）就只能往全局 process.env 里写 —— 那是进程级共享的可变单例：
      //   · 并发两次签名时后一次会覆盖前一次的密码
      //   · 密码在进程退出前一直挂在环境里，任何子进程都能读到
      // 现在改成基于 process.env 做一次浅拷贝再叠加 opts.env，
      // 注入只作用于本次 spawn，不改全局。
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      windowsHide: true,
      shell: !!opts.shell,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    track(child);

    let stdout = '', stderr = '';
    let stdoutBytes = 0, stderrBytes = 0;
    let stdoutCapped = false, stderrCapped = false;
    let stdoutNotified = false, stderrNotified = false;
    let settled = false;
    const done = (fn, v) => { if (!settled) { settled = true; untrack(child); fn(v); } };

    /*
     * 带封顶的累积：超限后不再累积，但管道仍在读（不阻塞子进程）。
     *
     * ⚠️ 封顶必须**同时作用于 opts.onStdout / onStderr 回调**。
     * 早前只封了返回值缓冲，回调仍无条件转发每一块 —— 而 apkedit 的
     * build/merge/refactor/decode 全都传了 onStdout: ctx.log，
     * 洪泛子进程照样能从回调侧把会话刷爆（正是本保护想防的事故）。
     *
     * 另外按**原始 Buffer 字节数**计（chunk.length），避免先解码再计数时
     * 因 UTF-8 多字节字符跨 chunk 而把替换字符计入，导致上限统计失真。
     */
    const CAP_NOTE = '[apk-devkit] 子进程输出超过上限，后续已截断\n';
    const feed = (which) => (d) => {
      const s = d.toString();
      const n = d.length;
      const isOut = which === 'out';
      let capped = isOut ? stdoutCapped : stderrCapped;

      if (!capped) {
        if (isOut) { stdout += s; stdoutBytes += n; if (stdoutBytes >= MAX_OUTPUT_BYTES) stdoutCapped = true; }
        else { stderr += s; stderrBytes += n; if (stderrBytes >= MAX_OUTPUT_BYTES) stderrCapped = true; }
      } else {
        if (isOut) stdoutCapped = true; else stderrCapped = true;
      }

      // 回调同样封顶：未截断才转发；刚截断时补发一条提示，之后彻底静默
      const cb = isOut ? opts.onStdout : opts.onStderr;
      if (!cb) return;
      if (!capped) { cb(s); return; }
      const notified = isOut ? stdoutNotified : stderrNotified;
      if (!notified) {
        if (isOut) stdoutNotified = true; else stderrNotified = true;
        cb(CAP_NOTE);
      }
    };

    /*
     * 杀进程树，而不是只杀直接子进程。
     *
     * 形态：apktool.bat（Windows）或包一层的 sh 脚本会再 spawn java。
     * `child.kill('SIGKILL')` 只杀掉 cmd.exe / sh 这一层，java 成孤儿继续
     * 占内存；10 分钟超时反复触发就会 OOM（P0-4）。
     *
     * tree-kill 在 Windows 走 `taskkill /PID <pid> /T /F`，POSIX 走
     * ps 遍历子进程再逐个 kill。两条路径都**不经 shell**，也不把任何
     * 用户输入拼进命令行，因此不引入注入面（S1.3 禁区 4）。
     */
    const killTree = () => {
      // spawn 自身失败时 child.pid 为 undefined，tree-kill 内部会拼出
      // 非法命令行，故先判空。
      if (!child.pid) return;
      treeKill(child.pid, 'SIGKILL', err => {
        // 杀树失败不应改变调用方看到的错误码（仍是 ETIMEDOUT），只旁路提示
        if (err) opts.onStderr?.(`[apk-devkit] 终止子进程树失败: ${err.message}\n`);
      });
    };

    const timer = setTimeout(() => {
      killTree();
      done(reject, Object.assign(new Error(`${path.basename(cmd)} 执行超时 ${timeout}ms`), { code: 'ETIMEDOUT' }));
    }, timeout);

    const onAbort = () => killTree();
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', feed('out'));
    child.stderr.on('data', feed('err'));

    child.on('error', e => { untrack(child); clearTimeout(timer); opts.signal?.removeEventListener('abort', onAbort); done(reject, e); });
    child.on('close', code => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      const out = {
        code, stdout, stderr, cmd, args: [...args],
        // 输出被截断时置位，调用方据此判断"结果不完整"
        truncated: stdoutCapped || stderrCapped,
        outputTruncated: stdoutCapped || stderrCapped,
        stdoutTruncated: stdoutCapped,
        stderrTruncated: stderrCapped,
      };
      if (code === 0) done(resolve, out);
      else done(reject, Object.assign(new Error(`${path.basename(cmd)} 退出码 ${code}`), out));
    });
  }));
}

// 供 server.js 在 SIGTERM 时回收仍在跑的子进程
const ACTIVE_CHILDREN = new Set();
function track(child) { ACTIVE_CHILDREN.add(child); }
function untrack(child) { ACTIVE_CHILDREN.delete(child); }

module.exports = { exec, guard, enqueue, ACTIVE_CHILDREN, quoteCmdArg };
