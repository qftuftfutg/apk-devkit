'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const { guard } = require('../lib/runner');

module.exports = (ctx) => ({
  name: 'hash',
  tools() { return []; },
  describe() {
    return {
      compute: {
        description: '计算文件哈希（md5/sha1/sha256）。',
        properties: {
          path: { type: 'string' },
          algo: { type: 'string', enum: ['md5', 'sha1', 'sha256'], default: 'sha256' },
        },
        required: ['path'],
      },
    };
  },
  async compute({ path: p, algo = 'sha256' } = {}) {
    if (!['md5', 'sha1', 'sha256'].includes(algo)) throw new Error('algo 必须是 md5/sha1/sha256');
    const abs = guard(ctx.ws, p);
    return new Promise((resolve, reject) => {
      const h = crypto.createHash(algo);
      const stream = fs.createReadStream(abs);
      stream.on('data', d => h.update(d));
      stream.on('error', reject);
      stream.on('end', () => resolve({ path: p, algo, hash: h.digest('hex') }));
    });
  },
});
