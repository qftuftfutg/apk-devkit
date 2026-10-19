'use strict';
const path = require('node:path');
const fs = require('node:fs');

/*
 * ⚠️ 平台支持范围：**仅 Windows**。
 *
 * 本项目当前只在 Windows 上发行与验证（DSH Windows 客户端 + JDK 17+）。
 * Linux / macOS / Termux **不在支持范围内**：工具目录只有 tools/windows/，
 * 且外部工具（apktool.bat、*.exe、*.jar）均按 Windows 形态准备。
 *
 * 在非 Windows 平台上，resolve() 会抛出 EPLATFORM 明确报错，
 * 而不是静默 fallback 到 PATH 后给出一个"命令找不到"的模糊错误。
 * 将来若要支持 Linux，需要：补 tools/linux/、恢复 .jar + 无扩展名可执行文件的
 * 查找顺序、并处理 chmod +x 与 shell 脚本调用。
 */
const isWin = process.platform === 'win32';

/*
 * 工具目录解析：
 *
 *   用户显式设了 APK_TOOLS_DIR  → 直接用它本身（不再拼任何子目录）
 *   未设置                      → 用项目内的 tools/windows/
 *   都找不到                    → 兜底到系统 PATH
 *
 * ⚠️ 关键：APK_TOOLS_DIR 是"工具就在这个目录里"的意思，
 *    不能再往下拼 'windows'。用户常把它指向 Android SDK 的
 *    build-tools\<ver>\，那里只有 aapt2.exe / zipalign.exe 等裸文件，
 *    若拼成 build-tools\34.0.0\windows\ 则必然找不到，
 *    所有工具都会静默退化到 PATH 兜底。
 */
const PROJECT_TOOL_DIR = path.join(__dirname, '..', 'tools', 'windows');
const TOOL_DIR = process.env.APK_TOOLS_DIR || PROJECT_TOOL_DIR;

/*
 * 自动探测 Java 运行时（所有 .jar 工具依赖它）。
 * Windows 上常见：JAVA_HOME 指向 JDK 根目录，其下有 bin\java.exe
 *
 * 返回 { cmd, args, shell, javaFound }：
 *   javaFound=false 表示既没在 JAVA_HOME 下找到、也没把握 PATH 里有 java。
 *   调用方（runner / orchestrator 的 _hint）可据此给出
 *   "需要安装 JDK 17+" 的明确提示，而不是让用户去猜 spawn java.exe ENOENT。
 */
function findJava() {
  if (process.env.JAVA_HOME) {
    const cand = path.join(process.env.JAVA_HOME, 'bin', 'java.exe');
    if (fs.existsSync(cand)) return { cmd: cand, args: [], shell: false, javaFound: true };
  }
  // PATH 兜底：无法同步确认是否存在，故 javaFound=false（表示"未确认"）
  return { cmd: 'java.exe', args: [], shell: false, javaFound: false };
}

const JAVA = findJava();

/*
 * 解析某个具体工具在本平台的落地方式。
 *
 * 查找目录：APK_TOOLS_DIR（若设置）否则项目内 tools/windows/
 * 目录内优先级：
 *   apktool.exe → 原生 exe（最快，无 shell 层、无 JVM 启动开销）
 *   apktool.bat / .cmd → 直接跑脚本（Android SDK 自带的启动脚本）
 *   apktool.jar → java -jar
 * 目录内都没有 → 兜底到系统 PATH
 */
function resolve(tool) {
  if (!isWin) {
    throw Object.assign(
      new Error(`apk-devkit 当前仅支持 Windows（检测到 ${process.platform}）。` +
        `如需其他平台支持，请自行补充 tools/<platform>/ 与本文件的解析逻辑。`),
      { code: 'EPLATFORM', platform: process.platform }
    );
  }

  const dir = TOOL_DIR;
  if (fs.existsSync(dir)) {
    // 原生 exe 优先：无 shell 层
    const exe = path.join(dir, tool + '.exe');
    if (fs.existsSync(exe)) return { cmd: exe, args: [], shell: false };
    // bat / cmd 脚本
    //
    // 含空格路径的引号处理（此前判断错了，已修正）：
    //   spawn(..., {shell:true}) 在 Windows 下由 Node 拼成
    //     cmd.exe /d /s /c "<整条命令>"
    //   关键在 /s：它会**剥掉最外层那一对引号**再交给 cmd 分词。
    //   剥完之后，如果 bat 路径本身没被引号包住，
    //   `C:\Program Files\...\apktool.bat -i x` 就会在空格处被截断 —— 执行失败。
    //   （这正是 cross-spawn 存在的理由。）
    //
    //   所以正确做法是**给 bat 路径自己加一对内引号**：
    //     cmd.exe /d /s /c ""C:\Program Files\...\apktool.bat" -i x"
    //   /s 剥掉外层后，剩下 `"C:\Program Files\...\apktool.bat" -i x`，
    //   cmd 分词时路径仍被引号保护 → 安全。
    //
    //   ⚠️ 该结论基于 cmd 分词规则推导，尚未在 Windows 真机实测。
    //   若真机仍失败，退路是 shell:false + 显式 argv：
    //     spawn('cmd.exe', ['/d','/s','/c', batPath, ...args], {shell:false})
    for (const ext of ['.bat', '.cmd']) {
      const p = path.join(dir, tool + ext);
      if (fs.existsSync(p)) return { cmd: `"${p}"`, args: [], shell: true };
    }
    // jar（apksigner / apkeditor / baksmali / smali 的主要分发形态）
    const jar = path.join(dir, tool + '.jar');
    if (fs.existsSync(jar)) {
      return { cmd: JAVA.cmd, args: ['-jar', jar], shell: false, javaFound: JAVA.javaFound };
    }
  }
  // 兜底到 PATH。
  // ⚠️ 已知边界：这里只按裸工具名 spawn（shell:false）。
  //    若该工具在 PATH 上只有 .bat/.cmd 形式（apktool 常见），
  //    Windows 下 spawn 不带 shell 无法直接执行批处理，会得到 ENOENT。
  //    解决办法：把 apktool.bat + apktool.jar 一起放进 tools/windows/（推荐），
  //    本函数会在目录内命中 .bat 分支并带 shell:true 执行。
  return { cmd: tool, args: [], shell: false };
}

module.exports = { isWin, TOOL_DIR, resolve, findJava };
