'use strict';
const fs = require('node:fs/promises');
const fss = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const createDiff = require('diff');
const { guard } = require('../lib/runner');

const MAX_TEXT_DIFF_BYTES = 2 * 1024 * 1024;
const MAX_DIR_FILES = 20000;
const MAX_DIR_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;

async function hashFile(abs, maxBytes) {
  const hash = crypto.createHash('sha256');
  let size = 0;
  await new Promise((resolve, reject) => {
    const stream = fss.createReadStream(abs);
    stream.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        stream.destroy(Object.assign(new Error('目录累计文件大小超过 2 GiB 上限'), { code: 'EDIFFLIMIT' }));
        return;
      }
      hash.update(chunk);
    });
    stream.once('error', reject);
    stream.once('end', resolve);
  });
  return { size, hash: hash.digest('hex') };
}

async function walk(absDir, base = '', state = { files: 0, bytes: 0 }, workspace) {
  const out = [];
  const entries = await fs.readdir(absDir, { withFileTypes: true });
  for (const entry of entries) {
    const rel = path.join(base, entry.name);
    const abs = path.join(absDir, entry.name);
    if (entry.isDirectory()) {
      guard(workspace, rel);\n      out.push(...await walk(abs, rel, state, workspace));
    } else if (entry.isFile()) {
      state.files++;
      if (state.files > MAX_DIR_FILES) {
        throw Object.assign(new Error(`目录文件数量超过上限（${MAX_DIR_FILES}）`), { code: 'EDIFFLIMIT' });
      }
      guard(workspace, rel);
      const stat = await fs.lstat(abs);
      if (!stat.isFile()) continue;
      state.bytes += stat.size;
      if (state.bytes > MAX_DIR_TOTAL_BYTES) {
        throw Object.assign(new Error('目录累计文件大小超过 2 GiB 上限'), { code: 'EDIFFLIMIT' });
      }
      const result = await hashFile(abs, MAX_DIR_TOTAL_BYTES - (state.bytes - stat.size));
      out.push({ rel, size: result.size, hash: result.hash });
    }
    // Symlinks and junctions are intentionally not traversed.
  }
  return out;
}

module.exports = (ctx) => ({
  name: 'diff',
  tools() { return []; },
  describe() {
    return {
      files: {
        description: '按行对比两个文本文件（每个文件最大 2 MiB），返回增删行。',
        properties: { a: { type: 'string' }, b: { type: 'string' } },
        required: ['a', 'b'],
      },
      dirs: {
        description: '递归对比两个目录；流式计算 SHA-256，最多 20000 个文件且累计 2 GiB。',
        properties: { a: { type: 'string' }, b: { type: 'string' } },
        required: ['a', 'b'],
      },
    };
  },
  async files({ a, b } = {}) {
    const fileA = guard(ctx.ws, a);
    const fileB = guard(ctx.ws, b);
    const [statA, statB] = await Promise.all([fs.stat(fileA), fs.stat(fileB)]);
    if (!statA.isFile() || !statB.isFile()) throw new Error('对比目标必须是普通文件');
    if (statA.size > MAX_TEXT_DIFF_BYTES || statB.size > MAX_TEXT_DIFF_BYTES) {
      throw Object.assign(new Error('文本对比文件超过 2 MiB 上限；请先拆分文件再对比'), { code: 'EDIFFLIMIT' });
    }
    const [textA, textB] = await Promise.all([fs.readFile(fileA, 'utf8'), fs.readFile(fileB, 'utf8')]);
    return createDiff.diffLines(textA, textB).filter(part => part.added || part.removed);
  },
  async dirs({ a, b } = {}) {
    const absA = guard(ctx.ws, a);
    const absB = guard(ctx.ws, b);
    if (!fss.existsSync(absA) || !fss.existsSync(absB)) throw new Error('目录不存在');
    if (!fss.statSync(absA).isDirectory() || !fss.statSync(absB).isDirectory()) {
      throw new Error('目录对比目标必须是目录');
    }
    const [listA, listB] = await Promise.all([walk(absA, '', undefined, ctx.ws), walk(absB, '', undefined, ctx.ws)]);
    const mapA = new Map(listA.map(item => [item.rel, item]));
    const mapB = new Map(listB.map(item => [item.rel, item]));
    const onlyInA = [], onlyInB = [], changed = [];
    for (const [rel, item] of mapA) {
      if (!mapB.has(rel)) onlyInA.push({ rel, size: item.size });
      else if (mapB.get(rel).hash !== item.hash) changed.push({ rel, sizeA: item.size, sizeB: mapB.get(rel).size });
    }
    for (const [rel, item] of mapB) if (!mapA.has(rel)) onlyInB.push({ rel, size: item.size });
    return { onlyInA, onlyInB, changed };
  },
});
