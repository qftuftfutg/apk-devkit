'use strict';
const fs = require('node:fs');
const path = require('node:path');
const AdmZip = require('adm-zip');
const { guard } = require('../lib/runner');

function deny(code, message) {
  return Object.assign(new Error(message), { code });
}

function load(ws, zipPath) {
  const abs = guard(ws, zipPath);
  // 带 code，与其余拒绝路径（EPATHESCAPE / EBADENTRY ...）保持约定一致，
  // 方便 AI 侧按 code 分类处理，而不是靠匹配 message 字符串
  if (!fs.existsSync(abs)) throw deny('ENOENT', `ZIP 不存在: ${zipPath}`);
  return { abs, zip: new AdmZip(abs) };
}

// list 硬上限：百万条目 ZIP 的 JSON 会撑爆会话（与 file.js 的 HARD_CAP 同类）
const LIST_HARD_CAP = 5000;

/*
 * 符号链接条目检测（ZIP-Slip 的"第二形态"）。
 *
 * safeEntryName 只看条目名是否含 ../。但还有一种绕过方式：
 * 条目名完全无害（如 `link.txt`），但其 external_attr 的高 16 位
 * 带 S_IFLNK（0o120000），解压后会在 workspace 内落地一个**指向外部
 * 任意路径的软链**；后续条目（或其他工具）顺着它写就能越界。
 * ZIP 恰是制造这类软链最自然的载体。
 *
 * 实测：adm-zip 的 entry.attr 高 16 位即 Unix 文件类型位，
 * symlink 条目读到 0o120000，普通文件为 0。
 *
 * 处理：与 ../ 同级 —— 整体拒绝解压，不留半成品。
 */
const S_IFLNK = 0o120000;
/*
 * ⚠️ 已知边界：若 entry.attr 缺失或非数值（某些 ZIP 不写 external_attr），
 * 这里返回 false（假阴性）——会被当作普通文件解压。
 * adm-zip 实测对 symlink 条目填的是 0o120000，普通文件为 0，
 * 故实际 ZIP 上可靠；但若遇到不填 attr 的打包器则检测不到。
 * 属"已声明边界"，与 README 的 symlink/TOCTOU 例外一致。
 */
function isSymlinkEntry(e) {
  const attr = e.attr;
  if (typeof attr !== 'number') return false;
  return ((attr >>> 16) & 0o170000) === S_IFLNK;
}

/*
 * D1 修复：校验 ZIP 内的条目名，防路径穿越。
 *
 * guard() 只管我们接到的外部参数（ZIP 文件本身、输出目录），
 * 完全不介入包内条目名。而条目名来自不受信任的第三方压缩包，
 * adm-zip 解压时会按它拼接目标路径 —— 含 ../ 就能写到 workspace 之外。
 * 这正是 README 承诺"所有路径都被 guard 限制在 workspace 内"的破口。
 *
 * 判定：统一用 posix 分隔符归一化后，必须既不为空、也不是绝对路径、
 * 且归一化后不以 .. 开头。同时拒绝盘符（C:\）与反斜杠形式。
 */
function safeEntryName(name, what) {
  if (typeof name !== 'string' || name === '') {
    throw deny('EBADENTRY', `${what}: 条目名为空`);
  }
  // Windows 盘符（C:\evil）与反斜杠形式一并挡掉
  if (/^[A-Za-z]:/.test(name) || name.includes('\\')) {
    throw deny('EPATHESCAPE', `${what}: 条目名含盘符或反斜杠，拒绝: ${name}`);
  }
  const norm = path.posix.normalize(name);
  if (norm === '.' || norm === '..' || norm.startsWith('../') || path.posix.isAbsolute(norm)) {
    throw deny('EPATHESCAPE', `${what}: 条目名试图跳出解压目录，拒绝: ${name}`);
  }
  return norm;
}

/*
 * 按名字找条目 —— **不能用 adm-zip 的 getEntry / extractEntryTo**。
 *
 * 实测发现（adm-zip 自身行为，非本文件引入）：
 *   · getEntries() 返回的 entryName 是包内原始名，如 `dir/./f.txt`
 *   · 但 getEntry('dir/./f.txt') 返回 null —— **原始名也查不到**
 *   · getEntry('dir/f.txt')（归一化名）同样返回 null
 *   · 只有 extractAllTo() 正常，它遍历 entryList 而非查 entryTable
 * 也就是说：只要包内条目名不是最简形式（含 ./ 或 ../），
 * 按名提取这条路在 adm-zip 上就走不通。
 *
 * 修法：
 *   1. 自己遍历 getEntries() 建索引（原始名 + 归一化名都能命中）
 *   2. 拿到 ZipEntry 对象后**自己写文件**（entry.getData()），
 *      不调用 extractEntryTo，绕开 entryTable 查找
 *   3. 落盘路径用归一化名，并再次校验仍在 outAbs 内
 */
function buildEntryIndex(zipFile) {
  const byRaw = new Map();
  const byNorm = new Map();
  for (const e of zipFile.getEntries()) {
    byRaw.set(e.entryName, e);
    let norm;
    try { norm = path.posix.normalize(e.entryName); } catch { norm = e.entryName; }
    if (!byNorm.has(norm)) byNorm.set(norm, e);
  }
  return function findEntry(name, what) {
    safeEntryName(name, what);                 // 安全校验（判越界）
    let e = byRaw.get(name);                   // 原始名优先
    if (!e) {
      const norm = path.posix.normalize(name);
      e = byNorm.get(norm);                    // 归一化名兜底
    }
    if (!e) throw deny('ENOENTRY', `${what}: 包内不存在该条目: ${name}`);
    return e;
  };
}

/*
 * 把单个 ZipEntry 写到 outAbs 下（自己落盘，不走 extractEntryTo）。
 * 落盘前二次校验最终绝对路径仍在 outAbs 内 —— 即便前面已校验过条目名，
 * 这里仍兜一道，因为路径是"条目名 + 输出目录"拼出来的。
 */
function writeEntry(e, outAbs) {
  const rel = safeEntryName(e.entryName, 'extract');
  const target = path.resolve(outAbs, rel);
  if (!target.startsWith(outAbs + path.sep) && target !== outAbs) {
    throw deny('EPATHESCAPE', `extract: 落盘路径越界，拒绝: ${e.entryName}`);
  }
  if (e.isDirectory) {
    fs.mkdirSync(target, { recursive: true });
    // 返回 rel 而非 null：显式请求目录条目时也要计入 extracted，
    // 否则 requested 与 extracted 对不上（"报了 N 个实际 N-1 个"）
    return rel;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, e.getData());
  return rel;
}

module.exports = (ctx) => ({
  name: 'zip',
  tools() { return []; },
  describe() {
    return {
      list: {
        description: '列出 ZIP 内条目（含 suspicious 标记指出可疑路径）。单次最多返回 5000 条，超出会置 truncated。',
        properties: { zip: { type: 'string' } },
        required: ['zip'],
      },
      extract: {
        description: '解压 ZIP 全部或指定条目到目录。包内条目名会被校验，含 ../ 或绝对路径的恶意条目会被拒绝（不会静默跳过）。指定 entries 时按包内原始名匹配（也接受归一化名）。',
        properties: {
          zip: { type: 'string' }, out: { type: 'string' },
          entries: { type: 'array', items: { type: 'string' } },
        },
        required: ['zip', 'out'],
      },
      add: {
        description: '向 ZIP 添加条目（覆盖同名）。path 只能是包内相对路径，含 ../ 会被拒绝。',
        properties: {
          zip: { type: 'string' },
          entries: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string' }, source: { type: 'string' },
              },
              required: ['path', 'source'],
            },
          },
        },
        required: ['zip', 'entries'],
      },
      remove: {
        description: '删除 ZIP 内条目。',
        properties: { zip: { type: 'string' }, names: { type: 'array', items: { type: 'string' } } },
        required: ['zip', 'names'],
      },
    };
  },
  async list({ zip } = {}) {
    const { zip: z } = load(ctx.ws, zip);
    const all = z.getEntries();
    const entries = all.slice(0, LIST_HARD_CAP).map(e => {
      const name = e.entryName;
      let suspicious = null;
      try { safeEntryName(name, 'list'); }
      catch (err) { suspicious = err.message; }
      if (!suspicious && isSymlinkEntry(e)) suspicious = '符号链接条目（解压后可能指向 workspace 外）';
      return {
        name, size: e.header.size, compressed: e.header.compressedSize,
        isDirectory: e.isDirectory,
        isSymlink: isSymlinkEntry(e),
        suspicious,   // 非 null 表示解压会被拒绝，AI 可据此先排查
      };
    });
    return {
      count: entries.length,
      total: all.length,
      truncated: all.length > LIST_HARD_CAP,
      cappedByHardLimit: all.length > LIST_HARD_CAP,
      entries,
    };
  },
  async extract({ zip, out, entries } = {}) {
    const { zip: z } = load(ctx.ws, zip);
    const outAbs = guard(ctx.ws, out);
    fs.mkdirSync(outAbs, { recursive: true });

    const allEntries = z.getEntries();
    const all = allEntries.map(e => e.entryName);

    // 校验范围的取舍（此前踩过坑）：
    //   早前无论是否指定 entries，都先对**整包**做全量校验再决定是否解压。
    //   结果 hint 里"或只解压可信的 entries"这条逃生口被代码自己封死了 ——
    //   包里只要有一个坏条目就整体 throw，根本走不到 entries 分支，
    //   指定再安全的 entries 也救不出来（承诺了自己给不了的规避方案）。
    //
    // 现在的策略：
    //   · 指定了 entries → **只校验本次真正要解压的这些条目**，选择性解压成立
    //   · 未指定（整体解压）→ 仍全量校验，因为 extractAllTo 会遍历全部条目
    if (entries && entries.length) {
      const findEntry = buildEntryIndex(z);
      const found = [];
      const bad = [];
      for (const n of entries) {
        try {
          const e = findEntry(n, 'extract');
          if (isSymlinkEntry(e)) throw deny('EPATHESCAPE', '符号链接条目');
          found.push(e);
        } catch (err) {
          bad.push(`${n}（${err.code || '非法'}: ${err.message}）`);
        }
      }
      // 先全部解析再落盘：任一不合法就整体拒绝，不留半成品
      if (bad.length) {
        throw Object.assign(
          deny('EPATHESCAPE',
            `指定 entries 中有 ${bad.length} 个可疑条目，已整体拒绝解压（未写入任何文件）: ` +
            `${bad.slice(0, 5).join(', ')}${bad.length > 5 ? ' …' : ''}`),
          { badEntries: bad, hint: '先用 zip_list 查看 suspicious 字段确认，只挑可信条目解压' }
        );
      }
      const done = [];
      for (const e of found) {
        const rel = writeEntry(e, outAbs);
        if (rel) done.push(rel);
      }
      // 完整性核对：报告实际落盘数，避免"报了 N 个实际 < N"的静默不完整
      return {
        extractedTo: out,
        requested: entries.length,
        extracted: done.length,
        count: done.length,
        entries: done,
      };
    }

    // 整体解压：全量校验（extractAllTo 不校验条目名）
    const bad = [];
    for (const e of allEntries) {
      try { safeEntryName(e.entryName, 'extract'); }
      catch (err) { bad.push(e.entryName); continue; }
      if (isSymlinkEntry(e)) bad.push(`${e.entryName}（符号链接）`);
    }
    if (bad.length) {
      throw Object.assign(
        deny('EPATHESCAPE',
          `ZIP 含 ${bad.length} 个可疑条目，已整体拒绝解压（未写入任何文件）: ` +
          `${bad.slice(0, 5).join(', ')}${bad.length > 5 ? ' …' : ''}`),
        { badEntries: bad, hint: '先用 zip_list 查看 suspicious 字段确认，或只解压可信的 entries' }
      );
    }
    // 整体解压仍需先全量校验（extractAllTo 不校验条目名）
    z.extractAllTo(outAbs, true);
    return { extractedTo: out, count: all.length };
  },
  async add({ zip, entries } = {}) {
    const { abs, zip: z } = load(ctx.ws, zip);
    const added = [];
    // 先校验全部 path 再动手，避免部分写入
    const plan = entries.map(e => {
      const srcAbs = guard(ctx.ws, e.source);
      if (!fs.existsSync(srcAbs)) throw deny('ENOENT', `源文件不存在: ${e.source}`);
      const safe = safeEntryName(e.path, 'add');
      return { srcAbs, safe };
    });
    for (const { srcAbs, safe } of plan) {
      const dir = path.posix.dirname(safe);
      z.addLocalFile(srcAbs, dir === '.' ? '' : dir, path.posix.basename(safe));
      added.push(safe);
    }
    z.writeZip(abs);
    return { zip, added };
  },
  async remove({ zip, names } = {}) {
    const { abs, zip: z } = load(ctx.ws, zip);
    // 与 add/extract 的校验策略保持一致（remove 不落盘、无逃逸风险，
    // 但统一校验能让"哪些名字合法"在全模块只有一个口径）
    const list = Array.isArray(names) ? names : [names];
    for (const n of list) safeEntryName(n, 'remove');
    for (const n of list) z.deleteFile(n);
    z.writeZip(abs);
    return { zip, removed: list };
  },
});
