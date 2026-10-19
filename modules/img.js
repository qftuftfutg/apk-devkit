'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { guard } = require('../lib/runner');

function loadSharp() {
  try { return require('sharp'); }
  catch {
    throw Object.assign(new Error('sharp 未安装，请执行 npm i sharp'), { code: 'ENOENT_TOOL' });
  }
}

module.exports = (ctx) => ({
  name: 'img',
  tools() { return []; },
  describe() {
    return {
      convert: {
        description: '图片格式转换（png/webp/jpeg），可选质量。',
        properties: {
          input: { type: 'string' }, output: { type: 'string' },
          format: { type: 'string', enum: ['png', 'webp', 'jpeg'] },
          quality: { type: 'number', default: 85 },
        },
        required: ['input', 'output', 'format'],
      },
      resize: {
        description: '按宽度等比缩放。',
        properties: { input: { type: 'string' }, output: { type: 'string' }, width: { type: 'number' } },
        required: ['input', 'output', 'width'],
      },
    };
  },
  async convert({ input, output, format, quality = 85 } = {}) {
    const sharp = loadSharp();
    const s = guard(ctx.ws, input), d = guard(ctx.ws, output);
    await fs.mkdir(path.dirname(d), { recursive: true });
    let p = sharp(s);
    if (format === 'jpeg') p = p.jpeg({ quality });
    else if (format === 'webp') p = p.webp({ quality });
    else p = p.png();
    await p.toFile(d);
    return { input, output, format, quality };
  },
  async resize({ input, output, width } = {}) {
    const sharp = loadSharp();
    const s = guard(ctx.ws, input), d = guard(ctx.ws, output);
    await fs.mkdir(path.dirname(d), { recursive: true });
    await sharp(s).resize({ width }).toFile(d);
    return { input, output, width };
  },
});
