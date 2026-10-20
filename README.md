# apk-devkit

**DeepSeek Harness（DSH）插件** —— 让 DSH 里的 AI 用自然语言直接对 APK 做解包、回编、签名、DEX 处理、资源与文件编辑，不用敲命令行。

他把（`apktool` / `aapt2` / `apksigner` / `zipalign` / `baksmali` / `smali` / `d8` / `APKEditor`）包装成 AI 可调用的工具。

> ⚠️ **平台支持：仅 Windows 10/11（64 位）。**
> Linux / macOS / Termux **不在支持范围，也无法安装** ——
> `package.json` 声明了 `os: ["win32"]`、`cpu: ["x64", "arm64"]`，
> 在其他平台上 `npm install` 会直接拒绝（EBADPLATFORM）。
> 32 位 Windows（ia32）同样不支持。

---

## 一、安装

### 方式 A：本地目录（开发调试，推荐）

```bash
cd /path/to/parent
dsh plugin --profile web add ./apk-devkit
```

以 `link:` 方式链接，改完代码重启 Web UI 即生效，无需重装。

### 方式 B：npm

```bash
dsh plugin --profile web add apk-devkit
```

### 方式 C：GitHub 源

```bash
dsh plugin --profile web add github:qftuftfutg/apk-devkit
```

### 验证是否挂载成功

```bash
dsh --profile web --dump-config | grep apk-devkit
dsh --profile web
```

启动后确认：

- `--dump-config` 输出里能看到 `apk-devkit` 行
- 启动日志正常应包含一行
  `[apk-devkit] loaded; registering N tools; workspace=...`
  —— 这是插件正常的加载日志，**不是报错**。
  `N` 应为 **38**。
  若同时出现 `[apk-devkit] 模块加载失败 X: ...` 或
  `[apk-devkit] N 个模块未加载`，说明对应模块有问题（多为依赖缺失），
  工具数会少于 38 —— 这些行是**正常的故障排查信息**，不是多余的报错
- 会话中 AI 能列出 `apk_decode`、`file_read`、`apkedit_decode` 等工具

**若工具不可见**，按顺序排查：

1. `dsh --dump-config` 里**根本没有** `apk-devkit` 行
   → `dsh.bundle.patch` 缺失或路径错，插件被当成普通依赖**静默忽略**
   → 检查 `package.json` 的 `dsh.bundle.patch` 与 `files` 是否含 `cordis.patch.yml`
2. 有 entry 但工具不可见
   → `inject: ['tools']` 声明不全，loader 让 entry 一直 `waiting for service: X`
3. 报 `Cannot find module '@deepseek-ai/...'`
   → 有人往 `plugin.mjs` 里加了宿主包 import（**禁止**，见文件头注释）
4. 报 `ERR_REQUIRE_ESM`
   → `"type": "commonjs"` 与宿主 ESM 冲突，见交接文档第十部分新发现 1
5. 是否在 `$DSH_HOME` 个人 patch 层重复 insert 了同一 `id`
   （两层同 id 会导致 loader 组合失败）

> 关于 `cordis.patch.yml` 的 `id`：**不必**等于 `plugin.mjs` 导出的 `name`。
> `id` 是 patch 层用于定位/覆盖该行的键，`name` 是模块说明符（包名或文件路径）。
> 将来若发布为 `@<scope>/apk-devkit`，**`name` 必须同步改，`id` 可不变**。

---

## 二、依赖

### 必需

| 依赖 | 版本 | 说明 |
|---|---|---|
| Windows | 10 / 11 | **当前唯一支持的平台** |
| Node.js | ≥ 18 | **推荐 20 LTS**（`fs.cp` 在 Node 18 早期版本有符号链接循环卡死的 bug） |
| JDK | 17+ | `java -version` 必须可用（所有 jar 依赖它） |

### 外部工具

放进 `apk-devkit/tools/windows/`，或设环境变量 `APK_TOOLS_DIR` 指向其所在目录
（如 Android SDK 的 `build-tools\<ver>\`）。

查找顺序：`<tool>.exe` → `<tool>.bat` / `.cmd` → `<tool>.jar`（走 `java -jar`）→ 系统 PATH。

> **`APK_TOOLS_DIR` 指向的就是工具所在目录本身**，不会再往下拼 `windows` 子目录。
> 例如指向 Android SDK 的 `build-tools\34.0.0\` 时，直接在该目录下找 `aapt2.exe`。

```
apktool      解包 / 回编
aapt2        读取 APK 基本信息
apksigner    签名 / 验签
zipalign     对齐
baksmali     DEX → smali
smali        smali → DEX
d8           JAR → DEX
apkeditor    二进制资源（ARSC/XML）编辑，不依赖 aapt2
```

`apkeditor` 获取：
<https://github.com/REAndroid/APKEditor/releases>
下载后**重命名为小写** `apkeditor.jar` 再放入（会自动走 `java -jar`）。

完整清单与放置规则见 [tools/README.md](./tools/README.md)。

未安装的工具，相关调用会返回明确报错与安装提示，不会静默失败。

### 可选

`sharp` —— 图片模块（`img_convert` / `img_resize`）依赖它。Windows 上无预编译包，
默认跳过安装：

```bash
npm install --omit=optional        # 跳过 sharp
npm i sharp                        # 需要图片模块时再单独装
```

不装 sharp 不影响其余 35 个工具。

---

## 三、环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `APK_WORKSPACE` | `./workspace` | 工作区根目录，所有路径操作限定于此 |
| `APK_TOOLS_DIR` | `./tools` | 外部工具目录 |
| `APK_KS_PASS` | — | 签名 keystore 密码（可选，通常由参数传入） |
| `APK_KEY_PASS` | — | 签名私钥密码 |

所有文件操作的路径都会被 `lib/runner.js#guard` 强制限制在 workspace 内，
传入 `../` 等越界路径会被拒绝。

---

## 四、工具清单（38 个，10 个模块）

| 模块 | 数量 | 工具 | 用途 |
|---|---|---|---|
| apk | 3 | `apk_info` | 读包名、版本、minSdk、权限 |
| | | `apk_decode` | 解包到目录（出 smali） |
| | | `apk_build` | 回编为未签名 APK |
| apkedit | 7 | `apkedit_info` | 深度信息：资源表/DEX/签名/语言/文件清单 |
| | | `apkedit_decode` | 二进制资源解码为 json/xml |
| | | `apkedit_build` | 重建 APK（**自带 zipalign**） |
| | | `apkedit_merge` | 合并分割包（目录形式已可用；XAPK/APKM/APKS 待实测） |
| | | `apkedit_refactor` | 混淆资源名反混淆 |
| | | `apkedit_xmlStrings` | 打印 XML 字符串池（字符常量池） |
| | | `apkedit_xmlTree` | 树形打印编译后 XML |
| sign | 3 | `sign_apk` | V1/V2/V3 签名 |
| | | `sign_verify` | 验签并输出证书 |
| | | `sign_align` | zipalign 对齐 |
| dex | 3 | `dex_disassemble` | DEX → smali |
| | | `dex_assemble` | smali → DEX |
| | | `dex_jar2dex` | JAR → DEX |
| dex2jar | 1 | `dex2jar_jar` | DEX → JAR（d2j-dex2jar） |
| diff | 2 | `diff_files` | 文本文件按行对比 |
| | | `diff_dirs` | 目录递归对比 |
| zip | 4 | `zip_list` / `zip_extract` / `zip_add` / `zip_remove` | 压缩包增删改查 |
| file | 12 | `file_read` / `file_write` | 文本读写（自动剥 BOM） |
| | | `file_list` | 列目录（**AI 定位文件的眼睛**） |
| | | `file_stat` | 存在性/类型/大小/mtime |
| | | `file_delete` / `file_mkdir` | 删除 / 建目录 |
| | | `file_copy` / `file_move` / `file_rename` / `file_batchRename` | 复制/移动/改名 |
| | | `file_readHex` / `file_patch` | 十六进制读写（对应"十六进制"功能） |
| img | 2 | `img_convert` / `img_resize` | 图片转换 / 缩放 |
| hash | 1 | `hash_compute` | md5 / sha1 / sha256 |

`npm run list-tools` 输出完整清单（含 inputSchema）。

> 运行时若看到 `[apk-devkit/apkedit] 注意：...`，这是模块加载时的**预期警告**
> （提示 APKEditor CLI 参数未经真机核实），不是错误。
> JSON 结果正常输出到 stdout，不受影响；每个进程只打印一次。

---

## 五、典型流程

**改代码（smali）**：

```
1. apk_decode          解包到 unpacked/
2. file_list           找到要改的 smali 文件
3. file_read / write   改内容
4. apk_build           回编为未签名 APK
5. sign_align → sign_apk → sign_verify
```

**改资源（字符串/图标/ARSC）**：

```
1. apkedit_decode      解码为可编辑 json
2. file_read / write   改 values-*/strings 等
3. apkedit_build       重建（自带 zipalign）
4. sign_apk → sign_verify
```

直接用自然语言让 DSH 完成，例如：
「把 workspace 里的 app.apk 解包，改完 AndroidManifest 后回编并签名」。

---

## 六、双入口

| | plugin.mjs（主） | server.js（备用） |
|---|---|---|
| 类型 | cordis 原生插件 | MCP stdio 服务 |
| 工具名 | `apk_decode` | `mcp__apk-devkit__apk_decode` |
| 挂载 | 安装即生效 | 需手写 patch.yml 或 MCP 面板配置 |
| 渲染 | 有 `output.render` | 仅纯文本 |

两者共用同一套 `orchestrator` + `modules`，能力完全一致，可并存。
`server.js` 作为 bundle 支持不全时的退路保留。

MCP 协议版本 `2024-11-05`，实现 `initialize` / `tools/list` / `tools/call`。

---

## 七、已知限制

**功能缺口**

- `file_read` 仅支持 `utf8` / `utf16le` / `latin1`，
  **GBK / GB18030 会读成乱码**（老项目的 `res/values/strings.xml` 需注意）
- `apkedit_merge` 的分割包合并：**目录形式可用**；
  XAPK / APKM / APKS 官方 README 声称支持，**尚未实测**

**暂不提供**

- 可视化编辑器面板、音视频播放、图片预览 —— 需 GUI，命令行工具给不了
- Linux 脚本 / 任意命令执行 —— 会击穿 workspace 沙箱
- DEX / RES 混淆对抗 

**工程限制**

- ZIP 大文件（>100MB）处理有内存压力（`adm-zip` 全量读入）
- workspace 沙箱**不防符号链接逃逸**：别往 workspace 放来源不明的 symlink
- `file_move` 跨盘（C:↔D:）会自动退化为「复制+删除」
- `file_list` 单次最多返回 5000 条

详见交接文档第六、九、十部分。

---

## 八、合规声明

本工具仅面向开发者对**自身拥有完整著作权**的 Android APK 项目进行调试、
二次打包、签名与资源编辑。

**禁止用途**

1. 破解第三方应用、去除或绕过签名校验、绕过授权许可；
2. 规避软件著作权保护技术措施；
3. 违反《计算机软件保护条例》第二十四条、《刑法》第二百八十五条相关条款的行为。

> ⚠️ **开源工具 ≠ 可以处理他人的 APK。**
> 本工具调用的底层组件（APKEditor、Apktool、smali 等）均为 Apache-2.0 /
> BSD 等宽松许可的开源软件，这解决的是"**你能不能用这个工具**"；
> 而"**你能不能用它去处理某个具体 APK**"由《计算机软件保护条例》
> 与目标应用的用户协议约束，**与工具是否开源无关**。

---

## 九、许可与致谢

本项目自研代码（orchestrator.js / server.js / plugin.mjs / lib/ / modules/）
采用 **MIT** 许可，见 [LICENSE](./LICENSE)。

底层能力来自以下开源项目，本项目**仅通过子进程调用其官方发布的
可执行文件或 jar**，不复制、不翻译、不修改其源码，也不随本包分发：

| 项目 | 许可 | 用途 |
|---|---|---|
| [REAndroid/APKEditor](https://github.com/REAndroid/APKEditor) | Apache-2.0 | 二进制资源解码/回编/合并/反混淆 |
| [REAndroid/ARSCLib](https://github.com/REAndroid/ARSCLib) | Apache-2.0 | 随 APKEditor 分发，本项目不直接调用 |
| [iBotPeaches/Apktool](https://github.com/iBotPeaches/Apktool) | Apache-2.0 | 解包 / 回编 |
| [JesusFreke/smali](https://github.com/JesusFreke/smali) | BSD-3-Clause | DEX ↔ smali |
| AOSP（apksigner / zipalign / aapt2 / d8） | Apache-2.0 | 签名 / 对齐 / 信息 / JAR→DEX |

完整说明与致谢见 [NOTICE](./NOTICE)。

---

## 十、安全约束

- `lib/runner.js#guard` 强制 workspace 路径沙箱，请勿移除
- `file_delete` / `file_move` / `file_copy` 拒绝操作 workspace 根目录
- `file_rename` / `file_batchRename` 拒绝含路径分隔符的改名结果
- 签名密码经环境变量中转，不出现在进程命令行
- `server.js` 仅实现白名单方法（initialize / tools/list / tools/call）
- 子进程并发上限 2，防止 apktool / d8 吃满内存

**已加固项（原 D1 / D2 安全洞，现已修复并实测）**

- `zip_extract` / `zip_add` 会校验压缩包内的条目名。
  含 `../`、绝对路径、盘符（`C:\`）的恶意条目，以及**符号链接条目**
  （`external_attr` 带 `S_IFLNK`）会被**整体拒绝**
  ——先全量校验再解压，不会留下半成品。
  `zip_list` 的 `suspicious` / `isSymlink` 字段可在解压前先排查。
- 指定 `entries` 解压时按包内原始名匹配（也接受归一化名）。
  > 注：adm-zip 的 `getEntry()` 对非最简条目名（含 `./`）查不到，
  > 本模块已自建索引 + 自己写文件绕开该限制。
- 子进程输出有 8MB 硬上限，超限会置 `truncated` 标记，
  防止 verbose 工具吐出几十 MB 打爆插件进程。
- 签名密码经 `opts.env` 合并注入子进程，**不再写入全局 `process.env`**，
  并发签名互不干扰；命令行仍是 `--ks-pass env:APK_KS_PASS`，密码不出现在 argv。

**仍存在的边界（设计如此，已声明）**

- workspace 沙箱**不防符号链接逃逸**：
  别往 workspace 放来源不明的 symlink / junction。
- `file_rename` / `file_batchRename` 拒绝含路径分隔符的改名结果，
  但不覆盖 TOCTOU 与外部进程抢先创建的同名文件。

**⏱ 并发排队提示**

- 长任务（`apk_build` / `apkedit_build` / `dex_disassemble`，可达 10 分钟）
  执行期间，短任务（`hash_compute` / `file_read`）会**排队等待**。
  同一会话想并行做多件事时请留意。

---

## 十一、License

MIT — 见 [LICENSE](./LICENSE)
