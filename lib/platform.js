'use strict';
const path = require('node:path');
const fs = require('node:fs');

const isWin = process.platform === 'win32';
const PROJECT_TOOL_DIR = path.join(__dirname, '..', 'tools', 'windows');
const TOOL_DIR = process.env.APK_TOOLS_DIR || PROJECT_TOOL_DIR;

function findJava() {
  if (process.env.JAVA_HOME) {
    const cand = path.join(process.env.JAVA_HOME, 'bin', 'java.exe');
    if (fs.existsSync(cand)) return { cmd: cand, args: [], shell: false, javaFound: true };
  }
  return { cmd: 'java.exe', args: [], shell: false, javaFound: false };
}

const JAVA = findJava();

function resolve(tool) {
  if (!isWin) {
    throw Object.assign(
      new Error(`apk-devkit 当前仅支持 Windows（检测到 ${process.platform}）。如需其他平台支持，请补充 tools/<platform>/ 与平台解析逻辑。`),
      { code: 'EPLATFORM', platform: process.platform }
    );
  }

  const dir = TOOL_DIR;
  if (fs.existsSync(dir)) {
    const exe = path.join(dir, tool + '.exe');
    if (fs.existsSync(exe)) return { cmd: exe, args: [], shell: false };

    for (const ext of ['.bat', '.cmd']) {
      const batchPath = path.join(dir, tool + ext);
      if (fs.existsSync(batchPath)) {
        if (/[&|<>^()%!"\x00-\x1f]/u.test(batchPath)) {
          throw Object.assign(
            new Error('批处理工具路径包含 cmd.exe 特殊字符，请将工具目录移到普通路径下'),
            { code: 'EUNSAFECMDPATH', path: batchPath }
          );
        }
        return { cmd: batchPath, args: [], shell: true };
      }
    }

    const jar = path.join(dir, tool + '.jar');
    if (fs.existsSync(jar)) {
      return { cmd: JAVA.cmd, args: ['-jar', jar], shell: false, javaFound: JAVA.javaFound };
    }
  }
  return { cmd: tool, args: [], shell: false };
}

module.exports = { isWin, TOOL_DIR, resolve, findJava };
