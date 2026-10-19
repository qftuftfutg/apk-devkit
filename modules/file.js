'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { guard } = require('../lib/runner');

// file_read 单次读取上限：防止几百 MB 文本一次性进内存、返回的 JSON 撑爆 DSH 会话
const READ_MAX_BYTES = 5 * 1024 * 1024;   // 5MB
// 与 list 的 HARD_CAP 同理，这里给 maxBytes 一个不可突破的硬顶
const READ_HARD_CAP = 20 * 1024 * 1024;   // 20MB

// 统一的错误构造：所有拒绝类错误都带 code，便于 AI 按 code 分类处理
function deny(code, message) {
  return Object.assign(new Error(message), { code });
}

// 分片读时把尾部回退到完整字符边界，避免把多字节序列劈断产生 U+FFFD 乱码。
//
// 注意：不能用"转换后是否含 U+FFFD"来判定——文件本身可能合法包含 U+FFFD
// （字节 EF BF BD），那样会把末尾的合法字节误截掉。
// 这里改为直接看字节：从末尾往前数 continuation byte（10xxxxxx），
// 找到起始字节后按首字节高位推断该字符的总长度，不完整就整个截掉。
function trimToCharBoundary(buf, encoding) {
  if (encoding === 'utf16le') return buf.length - (buf.length % 2);
  if (encoding !== 'utf8') return buf.length;

  const end = buf.length;
  let back = 0;
  while (back < 3 && end - back - 1 >= 0) {
    const byte = buf[end - back - 1];
    if ((byte & 0xC0) === 0x80) { back++; continue; }  // continuation byte
    const len =
      byte < 0x80 ? 1 :
      (byte & 0xE0) === 0xC0 ? 2 :
      (byte & 0xF0) === 0xE0 ? 3 :
      (byte & 0xF8) === 0xF0 ? 4 : 1;
    // 已数到的字节数 == 该字符长度 → 完整；否则截掉这半个/残缺字符
    return back + 1 === len ? end : end - (back + 1);
  }
  return end;
}

module.exports = (ctx) => ({
  name: 'file',
  tools() { return []; },
  describe() {
    return {
      copy: {
        description: '复制文件或目录（递归）。不支持复制到 workspace 根目录。',
        properties: {
          from: { type: 'string' }, to: { type: 'string' },
          overwrite: { type: 'boolean', default: true },
        },
        required: ['from', 'to'],
      },
      move: {
        description: '移动或重命名文件/目录。跨盘时退化为"复制到临时名 → 原子改名"。',
        properties: { from: { type: 'string' }, to: { type: 'string' } },
        required: ['from', 'to'],
      },
      rename: {
        description: '在同一目录内改名。newName 只能是纯文件名，不能含路径分隔符。',
        properties: { path: { type: 'string' }, newName: { type: 'string' } },
        required: ['path', 'newName'],
      },
      batchRename: {
        description: '按正则批量改名目录下条目（不递归）。replacement 按字面量处理（不支持 $1 等捕获组引用）；生成的名字只能是纯文件名；遇到目标冲突会整体拒绝，不做部分改名。',
        properties: { dir: { type: 'string' }, pattern: { type: 'string' }, replacement: { type: 'string' } },
        required: ['dir', 'pattern', 'replacement'],
      },
      read: {
        description: '读取文本文件内容。自动剥离 UTF-8 BOM（仅 offset=0 时）。默认最多读取 5MB，超出会截断并返回 nextOffset 供续读；分片点会自动对齐字符边界，避免多字节字符被劈断。仅支持 utf8 / utf16le / latin1，GBK / GB18030 会读成乱码（不支持）。',
        properties: {
          path: { type: 'string' },
          encoding: { type: 'string', enum: ['utf8', 'utf16le', 'latin1'], default: 'utf8' },
          offset: { type: 'number', default: 0, description: '起始字节偏移，必须是非负整数且不超过文件大小' },
          maxBytes: { type: 'number', default: 5242880, description: '本次最多读取的字节数，硬顶 20MB' },
        },
        required: ['path'],
      },
      write: {
        description: '写入文本文件，父目录自动创建。整体覆盖写入。',
        properties: {
          path: { type: 'string' }, content: { type: 'string' },
          encoding: { type: 'string', enum: ['utf8', 'utf16le', 'latin1'], default: 'utf8' },
          bom: { type: 'boolean', default: false, description: '是否写入 BOM。仅 utf8 / utf16le 支持，latin1 会被拒绝' },
        },
        required: ['path', 'content'],
      },
      list: {
        description: '列出目录内容。单个无权限子目录会被跳过而非整体失败。',
        properties: {
          path: { type: 'string', default: '.' },
          recursive: { type: 'boolean', default: false },
          maxEntries: { type: 'number', default: 2000, description: '硬顶 5000' },
        },
        required: [],
      },
      stat: {
        description: '查询文件/目录信息：是否存在、类型、磁盘大小、修改时间。',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
      delete: {
        description: '删除文件或目录（递归）。拒绝删除 workspace 根目录。',
        properties: { path: { type: 'string' }, recursive: { type: 'boolean', default: true } },
        required: ['path'],
      },
      mkdir: {
        description: '创建目录（含父目录）。',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
      readHex: {
        description: '读取文件局部十六进制。',
        properties: {
          path: { type: 'string' }, offset: { type: 'number', default: 0 },
          length: { type: 'number', default: 256 },
        },
        required: ['path'],
      },
      patch: {
        description: '在指定偏移写入字节（hex 字符串）。offset 超出文件末尾会报错，避免产生空洞文件。',
        properties: { path: { type: 'string' }, offset: { type: 'number' }, bytes: { type: 'string' } },
        required: ['path', 'offset', 'bytes'],
      },
    };
  },

  async copy({ from, to, overwrite = true } = {}) {
    const s = guard(ctx.ws, from), d = guard(ctx.ws, to);
    // 与 move / delete 对齐：不允许把内容覆盖到 workspace 根
    if (d === ctx.ws) {
      throw deny('EROOTCOPY', '拒绝复制到 workspace 根目录，请指定具体目标路径');
    }
    await fs.cp(s, d, { recursive: true, force: overwrite, errorOnExist: !overwrite });
    return { from, to };
  },

  async move({ from, to } = {}) {
    const s = guard(ctx.ws, from), d = guard(ctx.ws, to);
    if (s === ctx.ws) {
      throw deny('EROOTMOVE', '拒绝移动 workspace 根目录');
    }
    if (d === ctx.ws) {
      throw deny('EROOTMOVE', '拒绝移动到 workspace 根目录');
    }
    await fs.mkdir(path.dirname(d), { recursive: true });
    try {
      await fs.rename(s, d);
      return { from, to };
    } catch (e) {
      // 目标已存在且是非空目录：rename 抛 ENOTEMPTY / EISDIR，
      // 给 AI 一个语义明确的 code，而不是让它猜底层 errno
      if (e.code === 'ENOTEMPTY' || e.code === 'EISDIR') {
        throw deny('EDESTDIR', `目标已存在且为非空目录，无法移动：${to}`);
      }
      // 跨盘（C:\ → D:\）fs.rename 抛 EXDEV
      if (e.code !== 'EXDEV') throw e;
      // 先复制到临时名，再原子改名：避免 cp 半途失败时目标留下半成品
      const tmp = `${d}.__moving__${process.pid}_${Date.now()}`;
      try {
        await fs.cp(s, tmp, { recursive: true, force: true });
        await fs.rename(tmp, d);
      } catch (e2) {
        // 清理临时产物，并明确告知调用方"源仍在、目标未建立"
        try { await fs.rm(tmp, { recursive: true, force: true }); } catch {}
        throw Object.assign(
          deny('EMOVEPARTIAL', `跨盘移动失败，已回滚；源文件保持不变：${e2.message}`),
          { from, to, sourceIntact: true }
        );
      }
      await fs.rm(s, { recursive: true, force: true });
      return { from, to, fallback: 'cross-device: copy-tmp + atomic rename' };
    }
  },

  async rename({ path: p, newName } = {}) {
    const s = guard(ctx.ws, p);
    // newName 必须是纯文件名：空串、含分隔符、含 .. 一律拒绝
    if (typeof newName !== 'string' || newName === '') {
      throw deny('EBADNAME', 'newName 不能为空');
    }
    if (/[/\\]/.test(newName) || newName === '.' || newName === '..') {
      throw deny('EBADNAME', 'newName 只能是纯文件名，不能含路径分隔符或 . / ..');
    }
    const d = path.join(path.dirname(s), newName);
    if (!d.startsWith(ctx.ws + path.sep)) {
      throw deny('EPATHESCAPE', '路径越界被拒绝');
    }
    await fs.rename(s, d);
    return { from: p, to: path.relative(ctx.ws, d) };
  },

  async batchRename({ dir, pattern, replacement } = {}) {
    const abs = guard(ctx.ws, dir);
    let re;
    try { re = new RegExp(pattern); }
    catch { throw deny('EBADREGEX', `非法正则: ${pattern}`); }

    const names = await fs.readdir(abs);

    // 第一步：只计算映射，不落盘。
    // 任何非法目标 → 整体拒绝，绝不做部分改名。
    // 用回调而非字符串 replacement：避免 $1 / $& / $` / $' 被当作替换模板解释，
    // replacement 一律按字面量处理（不支持捕获组引用）。
    const plan = [];
    for (const name of names) {
      const next = name.replace(re, () => replacement);
      if (next === name) continue;
      if (typeof next !== 'string' || next === '') {
        throw deny('EBADNAME', `改名结果为空，拒绝：${name}`);
      }
      // 关键：replacement 可含 / 或 ../，必须拒绝，否则 path.join 能跳出 workspace
      if (/[/\\]/.test(next) || next === '.' || next === '..') {
        throw deny('EPATHESCAPE', `改名结果含路径分隔符，拒绝（rename 只改文件名）: ${name} → ${next}`);
      }
      const target = guard(ctx.ws, path.join(dir, next));
      if (!target.startsWith(abs + path.sep)) {
        throw deny('EPATHESCAPE', `改名目标越界，拒绝: ${name} → ${next}`);
      }
      plan.push({ from: name, to: next, srcAbs: path.join(abs, name), dstAbs: target });
    }

    // 第二步：冲突检测。
    // 目标重复、或目标撞上目录里已存在的名字 → 拒绝，避免静默覆盖丢数据。
    const seen = new Set();
    for (const item of plan) {
      if (seen.has(item.to)) {
        throw deny('ENAMECLASH', `多个文件改名为同一目标，拒绝: ${item.to}`);
      }
      seen.add(item.to);
    }
    const existing = new Set(names);
    for (const item of plan) {
      if (existing.has(item.to)) {
        throw deny('ENAMECLASH', `目标已存在，拒绝覆盖: ${item.from} → ${item.to}`);
      }
    }

    // 第三步：全部校验通过后才执行
    const renamed = [];
    try {
      for (const item of plan) {
        await fs.rename(item.srcAbs, item.dstAbs);
        renamed.push({ from: item.from, to: item.to });
      }
    } catch (e) {
      // 中途失败：尽力回滚已改的部分，保持"要么全成要么全不变"
      for (const done of renamed.reverse()) {
        try { await fs.rename(path.join(abs, done.to), path.join(abs, done.from)); } catch {}
      }
      throw Object.assign(
        deny('EBATCHPARTIAL', `批量改名中途失败，已回滚: ${e.message}`),
        { attempted: renamed.length }
      );
    }
    return { renamed, count: renamed.length };
  },

  // ---- 文本读写：改 XML / smali 的前提 ----
  async read({ path: p, encoding = 'utf8', offset = 0, maxBytes = READ_MAX_BYTES } = {}) {
    const abs = guard(ctx.ws, p);
    // 与 patch 保持一致：offset 必须是非负整数，否则 fh.read 会抛 ERR_OUT_OF_RANGE
    if (!Number.isInteger(offset) || offset < 0) {
      throw deny('EOFFSETRANGE', 'offset 必须是非负整数');
    }
    const limit = Math.min(Math.max(1, Number(maxBytes) || READ_MAX_BYTES), READ_HARD_CAP);

    const st = await fs.stat(abs);
    const fileSize = st.size;
    if (offset > fileSize) {
      throw deny('EOFFSETRANGE', `offset ${offset} 超出文件末尾 ${fileSize}`);
    }

    // 分片读：只读 [offset, offset+limit)，避免大文件一次性进内存
    const fh = await fs.open(abs, 'r');
    let buf;
    try {
      const want = Math.min(limit, fileSize - offset);
      buf = Buffer.alloc(want);
      if (want > 0) await fh.read(buf, 0, want, offset);
    } finally { await fh.close(); }

    // 头：offset > 0 续读时，跳过落在多字节序列中间的续字节
    let head = 0;
    if (encoding === 'utf8') {
      while (head < buf.length && (buf[head] & 0xC0) === 0x80) head++;
    } else if (encoding === 'utf16le') {
      // 判断的是"起点是否为奇数字节"，不是 head（head 初始恒为 0，
      // 写成 head % 2 会永远是 false，是死代码）
      if (offset % 2 !== 0) head++;
    }
    // 尾：回退到完整字符边界，避免末尾半个字符变 U+FFFD
    const tail = trimToCharBoundary(buf, encoding);

    // 有效字节数 <= 0：这个分片装不下任何一个完整字符。
    // 若不处理，nextOffset 不会前进 → AI 续读时无限循环。
    // 此处直接报错，让调用方把 maxBytes 调大。
    const usable = tail - head;
    if (usable <= 0 && offset + Math.max(tail, head) < fileSize) {
      throw deny(
        'ETOOSMALL',
        `maxBytes=${limit} 太小，无法在 offset=${offset} 处凑出一个完整字符` +
        `（当前编码 ${encoding} 单字符最多 ${encoding === 'utf8' ? 4 : 2} 字节）。请将 maxBytes 调大到至少 ${encoding === 'utf8' ? 4 : 2}`
      );
    }

    const slice = buf.subarray(head, tail);
    let text = slice.toString(encoding);
    // 仅在 offset === 0 时剥离 BOM，否则会误删文件中间的正常字节
    const hadBom = offset === 0 && text.charCodeAt(0) === 0xfeff;
    if (hadBom) text = text.slice(1);

    // nextOffset 必须严格前进：用 max(tail, head) 兜底，杜绝回退
    const end = offset + Math.max(tail, head);
    return {
      path: p, encoding,
      fileSize,                              // 磁盘真实大小（与 stat 可对照）
      offset: offset + head,                 // 真实读取起点（可能已跳过续字节）
      bytesReturned: Buffer.byteLength(text, encoding),  // 本次返回内容字节数
      truncated: end < fileSize,
      nextOffset: end < fileSize ? end : null,           // 续读的起点（已对齐字符边界）
      boundaryAdjusted: head > 0 || tail < buf.length,   // 是否做过边界对齐
      bomStripped: hadBom,
      content: text,
    };
  },

  async write({ path: p, content, encoding = 'utf8', bom = false } = {}) {
    const abs = guard(ctx.ws, p);
    // BOM 只在 utf8 / utf16le 下有意义：
    //   utf8    → EF BB BF ✅
    //   utf16le → FF FE   ✅
    //   latin1  → 被截成单字节 FF ❌ 不是任何合法 BOM
    if (bom && encoding === 'latin1') {
      throw deny('EBADBOM', 'bom 仅支持 utf8 / utf16le，latin1 下会写出非法字节');
    }
    await fs.mkdir(path.dirname(abs), { recursive: true });
    const data = bom ? '﻿' + content : content;
    await fs.writeFile(abs, data, encoding);
    return { path: p, encoding, bom, written: Buffer.byteLength(data, encoding) };
  },

  // ---- 目录浏览：AI 定位文件的眼睛 ----
  async list({ path: p = '.', recursive = false, maxEntries = 2000 } = {}) {
    const abs = guard(ctx.ws, p);
    // 硬上限：防止返回几百 MB JSON 把 DSH 会话撑爆
    const HARD_CAP = 5000;
    const limit = Math.min(Math.max(1, Number(maxEntries) || 2000), HARD_CAP);
    const capped = limit < Number(maxEntries);

    const out = [];
    const skipped = [];          // 无权限 / 已消失的子目录，记录而非整体失败
    let aborted = false;         // 只有"因达到上限提前停"才算真截断
    const walk = async (dir, base) => {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch (e) {
        skipped.push({ dir: base || '.', error: e.code || e.message });
        return;
      }
      for (const e of entries) {
        if (out.length >= limit) { aborted = true; return; }
        const rel = base ? path.join(base, e.name) : e.name;
        if (e.isDirectory()) {
          out.push({ rel, type: 'dir' });
          if (recursive) await walk(path.join(dir, e.name), rel);
        } else {
          let size = null;
          try { size = (await fs.stat(path.join(dir, e.name))).size; } catch {}
          out.push({ rel, type: 'file', size });
        }
      }
    };
    await walk(abs, '');
    return {
      path: p, count: out.length,
      truncated: aborted, cappedByHardLimit: capped, limit,
      skipped, entries: out,
    };
  },

  async stat({ path: p } = {}) {
    const abs = guard(ctx.ws, p);
    try {
      const st = await fs.stat(abs);
      return {
        path: p, exists: true,
        type: st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other',
        size: st.size, mtime: st.mtime.toISOString(),
      };
    } catch (e) {
      if (e.code === 'ENOENT') return { path: p, exists: false };
      throw e;
    }
  },

  async delete({ path: p, recursive = true } = {}) {
    const abs = guard(ctx.ws, p);
    // guard 只防"越界"，不防"删根"：delete({path:'.'}) 会把整个 workspace 干掉
    if (abs === ctx.ws) {
      throw deny('EROOTDEL', '拒绝删除 workspace 根目录，请指定子路径');
    }
    // fs.rm 带 force 时对不存在的路径也"成功"，会让 AI 误以为删掉了东西。
    // 先探一次存在性，把真实情况回传。
    let existed = false;
    try { await fs.stat(abs); existed = true; } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    await fs.rm(abs, { recursive, force: true });
    return { path: p, deleted: true, existed };
  },

  async mkdir({ path: p } = {}) {
    const abs = guard(ctx.ws, p);
    await fs.mkdir(abs, { recursive: true });
    return { path: p, created: true };
  },

  async readHex({ path: p, offset = 0, length = 256 } = {}) {
    const abs = guard(ctx.ws, p);
    const fh = await fs.open(abs, 'r');
    try {
      const buf = Buffer.alloc(length);
      const { bytesRead } = await fh.read(buf, 0, length, offset);
      return {
        path: p, offset, length: bytesRead,
        hex: buf.subarray(0, bytesRead).toString('hex').match(/../g)?.join(' ') ?? '',
      };
    } finally { await fh.close(); }
  },

  async patch({ path: p, offset, bytes } = {}) {
    const abs = guard(ctx.ws, p);
    const hex = bytes.replace(/\s+/g, '');
    if (hex.length % 2 || !/^[0-9a-fA-F]*$/.test(hex)) {
      throw deny('EBADHEX', 'bytes 必须是偶数长度的十六进制字符串');
    }
    if (!Number.isInteger(offset) || offset < 0) {
      throw deny('EBADOFFSET', 'offset 必须是非负整数');
    }
    const buf = Buffer.from(hex, 'hex');
    // offset 超出文件末尾时，fs.write 会把中间补零形成空洞文件，这里直接拒绝
    const st = await fs.stat(abs);
    if (offset > st.size) {
      throw deny('EOFFSETRANGE', `offset ${offset} 超出文件末尾 ${st.size}，拒绝写入（会形成空洞文件）`);
    }
    const fh = await fs.open(abs, 'r+');
    try { await fh.write(buf, 0, buf.length, offset); } finally { await fh.close(); }
    return { path: p, offset, written: buf.length, newSize: Math.max(st.size, offset + buf.length) };
  },
});
