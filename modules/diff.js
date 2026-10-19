'use strict';
const fs = require('node:fs/promises');
const fss = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const createDiff = require('diff');
const { guard } = require('../lib/runner');

async function walk(absDir, base = '') {
  const out = [];
  const entries = await fs.readdir(absDir, { withFileTypes: true });
  for (const e of entries) {
    const rel = path.join(base, e.name);
    const abs = path.join(absDir, e.name);
    if (e.isDirectory()) out.push(...await walk(abs, rel));
    else if (e.isFile()) {
      const buf = await fs.readFile(abs);
      const h = crypto.createHash('sha256').update(buf).digest('hex');
      out.push({ rel, abs, size: buf.length, hash: h });
    }
  }
  return out;
}

module.exports = (ctx) => ({
  name: 'diff',
  tools() { return []; },
  describe() {
    return {
      files: {
        description: '按行对比两个文本文件，返回增删行。',
        properties: { a: { type: 'string' }, b: { type: 'string' } },
        required: ['a', 'b'],
      },
      dirs: {
        description: '递归对比两个目录，返回 onlyInA / onlyInB / changed。',
        properties: { a: { type: 'string' }, b: { type: 'string' } },
        required: ['a', 'b'],
      },
    };
  },
  async files({ a, b } = {}) {
    const [sa, sb] = await Promise.all([
      fs.readFile(guard(ctx.ws, a), 'utf8'),
      fs.readFile(guard(ctx.ws, b), 'utf8'),
    ]);
    return createDiff.diffLines(sa, sb).filter(d => d.added || d.removed);
  },
  async dirs({ a, b } = {}) {
    const absA = guard(ctx.ws, a);
    const absB = guard(ctx.ws, b);
    if (!fss.existsSync(absA) || !fss.existsSync(absB)) throw new Error('目录不存在');
    const [listA, listB] = await Promise.all([walk(absA), walk(absB)]);
    const mapA = new Map(listA.map(x => [x.rel, x]));
    const mapB = new Map(listB.map(x => [x.rel, x]));

    const onlyInA = [], onlyInB = [], changed = [];
    for (const [rel, x] of mapA) {
      if (!mapB.has(rel)) onlyInA.push({ rel, size: x.size });
      else if (mapB.get(rel).hash !== x.hash) changed.push({ rel, sizeA: x.size, sizeB: mapB.get(rel).size });
    }
    for (const [rel, x] of mapB) if (!mapA.has(rel)) onlyInB.push({ rel, size: x.size });
    return { onlyInA, onlyInB, changed };
  },
});
