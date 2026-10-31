# 发布清单：让 DSH 能从插件库拉取

本文档把"发布上去 → DSH 能拉到"拆成可执行步骤。
本文描述 GitHub bundle 与 npm 两种安装路径。是否能安装并正常运行，仍取决于 DSH 版本、Node 版本、插件依赖和外部工具环境；发布流程不等于兼容性验证。当前 `package.json` 声明 Node.js `>=18`，但没有声明 `engines.dsh` 版本范围；这只是包自身的 Node 元数据，不等于 DSH 主程序在 Node 18 上受支持。发布前应在实际目标 DSH 版本测试，并按 DSH 官方 bundle 文档补充经过验证的 `engines.dsh` 范围。

---

## 在手机 / Linux 上先验证（可选，但强烈建议）

项目发布时锁死 `os: ["win32"]`，但**纯 JS 内核本身是跨平台的**。
如果你想在手机（Linux/ARM，如 DSH 手机版）或 Mac 上先把代码跑通再发布，
按本节操作。

> 本节包含历史 Linux 实机验证记录；本次文档审查未重新执行这些命令。Linux/Android 并非本项目支持运行平台，相关命令仅用于有限的源码/纯 Node 诊断。

---

### 两个必须解决的独立报错

非 Windows 本地验证时，会遇到**两个完全独立**、但都导致装不上依赖的问题：

**① `os` 字段拦截（EBADPLATFORM）**

`package.json` 的 `os: ["win32"]` 对**根项目自身**的安装同样生效
（npm 在 reify 阶段对整个 package 树做 `checkPlatform`，不止校验依赖包）。
直接跑 `npm install` 会被拒：

```
npm error code EBADPLATFORM
npm error notsup Unsupported platform for apk-devkit@0.1.0:
  wanted {"os":"win32","cpu":"x64,arm64"} (current: {"os":"linux","cpu":"x64"})
```

> ⚠️ 网上流传"根项目不受 os 拦截"的说法是**错的**，别信。

**② `npm config global=true` 导致路径错乱**

若 npm 处于全局模式，依赖会装进 `/usr/local/lib/node_modules`
而不是当前项目，`require('diff')` 依然找不到。
此时 **`--prefix .` 不管用** —— 全局配置的优先级盖过局部参数。
必须用 `--global=false` 才能真正解除封印。

```bash
npm config get global        # 返回 true 就要加 --global=false
```

---

### 两种解法（任选其一；下列终端输出属于历史验证记录）

#### 路 A（推荐：不改动任何文件）

```bash
npm install --global=false --force --omit=optional
npm run count-tools
```

`--force` 绕过平台校验（仅本次验证，不改文件），
`--global=false` 让依赖落进当前目录。

> 关于 `--force` 的副作用：它会绕过 engine-strict、peer 冲突等检查。
> 但此场景风险可控 —— 你装的是 `diff` / `adm-zip` 两个**纯 JS 包**，
> 无原生编译、无 peer 冲突，且这只是本地验证、不进发布产物。

#### 路 B：临时删掉 `os` / `cpu`

```bash
# ⚠️ 警告：绝对不能把 "os" 改成 /* "os": ["win32"] */
# package.json 是纯 JSON 格式，不支持任何注释。
# 加 /* */ 或 // 会让 npm 和 Node 的 require() 直接解析失败 —— 只能整行删除！

# 1. 编辑 package.json，删除这整行：
#    "os": ["win32"],

# 注：在 armv7l 等罕见架构上，"cpu" 字段也会拦截，需一并删掉：
#    "cpu": ["x64", "arm64"],
# 常规 x64 机器或 ARM64 手机只删 "os" 即可通过。

# 2. 验证
npm install --global=false --omit=optional
npm run count-tools

# 3. 验证完务必把删掉的 "os" / "cpu" 字段原样加回去再推送！
```

**路 B 的风险**：改回来这步**极易忘记**。一旦忘了就推送，
发布出去的就是"声称只支持 Windows、实际谁都能装"的版本，与设计意图相反。
**强烈建议优先用路 A** —— `--force` 不改任何文件，不存在忘记还原的问题。

---

### 验证时能看到什么

历史验证快照中，依赖装好后曾输出一行裸数字 `37`。当前 main 分支的 README 工具清单按 10 个模块静态合计为 **38 个工具**；本次文档审查没有在 Windows/Linux 运行时重新执行 `npm run count-tools`，因此请以目标提交上实际运行的 `npm run count-tools` 输出为准。不要把旧快照的 37 当作当前版本验收值。

> 历史版本日志曾出现 `[apk-devkit] loaded; registering 37 tools; workspace=...`；该数字不是当前 main 分支的验收标准。
> 那行是 **`plugin.mjs` 第 91 行**打印的，只在 **DSH 真正挂载插件并启动**时出现
> （见下文"发布后自检"）。`count-tools` 走 `orchestrator.js`，根本不加载 `plugin.mjs`。
> 它也**不是** `server.js` 的日志 —— `server.js` 里 `[apk-devkit]` 出现 0 次。

**关于 sharp（再次核实）**：`img` 模块对 sharp 是**懒加载**：

```js
function loadSharp() {
  try { return require('sharp'); }        // 在函数内，不在模块顶层
  catch { throw ...('sharp 未安装，请执行 npm i sharp') }
}
```

所以 `node_modules` 里**没有 sharp 也不会阻止 img 模块注册**。历史快照中的工具数量输出不代表当前 main 分支计数。
只有真正调用 `img_convert` / `img_resize` 时才抛
`ENOENT_TOOL: sharp 未安装，请执行 npm i sharp`。

实测（两条路都跑过）：

```
node_modules: @emnapi @img adm-zip diff     ← 没有 sharp
count-tools: 37（历史快照；当前 main 分支未重新运行）
```

依赖没装全时，stderr 会长这样。注意模块名**带 `.js`**
（`f` 来自 `readdirSync`，是文件名不是模块名）：

```
[apk-devkit] 模块加载失败 diff.js: Cannot find module 'diff'
[apk-devkit] 模块加载失败 zip.js: Cannot find module 'adm-zip'
[apk-devkit] 2 个模块未加载（历史快照；模块数/工具数随提交变化）
31（历史快照）
```

上述 31 是历史快照，不是当前预期值。看 stderr 定位缺失模块，补装相应依赖后，必须在当前提交重新运行 `npm run count-tools`。

---

### 手机上能用多少

| 类别 | 模块 | 工具数 | 手机上 |
|---|---|---|---|
| 纯 Node（不调外部工具） | file / hash / diff / zip | **19** | ✅ 稳定可用 |
| 懒加载原生依赖 | img | 2 | ✅ 能注册；**调用时**需装好 sharp（ARM 下常无预编译包） |
| 依赖外部 jar / exe | apk / apkedit / sign / dex / dex2jar | 17 | ⚠️ 抛 `EPLATFORM` |

> **19 而不是 21**：`img` 虽不调 exe/jar（不会撞 `EPLATFORM`），
> 但**调用时**硬依赖原生包 sharp，ARM 上大概率装不上，
> 所以算进"稳可用的纯 Node"是虚的。

`EPLATFORM` 的 hint 已明确写"这是设计限制，不是 bug"，
所以手机上看到它是**符合预期的**，不是故障。

> 结论边界：历史 Linux 验证记录只覆盖纯 Node 模块的部分调用路径；它不能证明 Windows-only 外部工具可用，也不能证明插件在 Android/Termux 上受支持。当前 main 分支静态工具清单为 38 项，实际可用数量应以目标环境逐项执行测试为准。

---

## 发布前必做（一次性）

### 1. 替换占位符

> 全项目只有 **一种真占位符**：`<your-account>` / `<你的账号>`，共 **8 处**，
> 全部替换成**同一个值**——你的 GitHub 用户名（下面记作 `YOUR_NAME`）。
>
> 漏改会让 `dsh plugin add github:...` 与 npm 发布直接失败。

#### 必须改的 8 处（逐条对照）

| # | 文件 | 行 | 当前内容 | 改成 |
|---|---|---|---|---|
| 1 | `package.json` | 11 | `git+https://github.com/＜your-account＞/apk-devkit.git` | `git+https://github.com/YOUR_NAME/apk-devkit.git` |
| 2 | `package.json` | 14 | `https://github.com/＜your-account＞/apk-devkit/issues` | `https://github.com/YOUR_NAME/apk-devkit/issues` |
| 3 | `package.json` | 16 | `https://github.com/＜your-account＞/apk-devkit#readme` | `https://github.com/YOUR_NAME/apk-devkit#readme` |
| 4 | `README.md` | 37 | `dsh plugin --profile web add github:＜你的账号＞/apk-devkit` | `... github:YOUR_NAME/apk-devkit` |
| 5 | `PUBLISHING.md` | — | 本文档「发布到 GitHub」章节的示例块 | 同 #1（**示例块，可留可改**） |
| 6 | `PUBLISHING.md` | — | 本文档「发布到 GitHub」章节的示例块 | 同 #2（**示例块，可留可改**） |
| 7 | `PUBLISHING.md` | 97 | `git remote add origin https://github.com/＜your-account＞/...` | `... YOUR_NAME/apk-devkit.git` |
| 8 | `PUBLISHING.md` | 120 / 151 | `dsh plugin --profile web add github:＜your-account＞/...` | `... github:YOUR_NAME/apk-devkit` |

> 行号以本文档当前版本为准；若你改动过本文档，按内容搜关键字即可。

> #5 / #6 位于本文档的**示例代码块**里（教你长什么样），改不改都不影响发布；
> #1–#4、#7–#8 是**真实生效的配置与命令**，必须改。

**批量替换**（在 `apk-devkit/` 目录下执行，先给 `YOUR_NAME` 赋值）。

> ⚠️ 对 `PUBLISHING.md` 必须用**带前缀的精确匹配**（`github:` / `github.com/`），
> 否则会连本文档里的说明文字、以及这两条 sed 命令自身一起替换掉。

```bash
YOUR_NAME=你的用户名

# 1) package.json / README.md：全量替换（这两文件里没有自引，安全）
sed -i "s#<your-account>#$YOUR_NAME#g; s#<你的账号>#$YOUR_NAME#g" package.json README.md

# 2) PUBLISHING.md：只替换真实命令行，保留本文档的说明与示例
sed -i -E "s#(github\.com/|github:)<your-account>#\1$YOUR_NAME#g" PUBLISHING.md
```

**Windows 怎么跑**：装了 Git 就有 **Git Bash**，在里面执行上面两条即可
（项目是 Windows-only，但你做发布准备时本机多半已装 Git）。
没有 Git Bash 就手动改这 8 处，两分钟的事。

替换后本文档**说明文字里的占位符**会保留原样（它们只是告诉你"要找什么"），
这是正常的，不影响发布。

#### 不用改的（这些是说明文字里的通配示例，不是占位符）

| 写法 | 出现在 | 含义 |
|---|---|---|
| `@<scope>/apk-devkit` | README.md:75 | 说明"将来若发到某个 scope 下"的泛指 |
| `build-tools\<ver>\` | README.md:92、tools/README.md:6 | Android SDK 的版本号目录（如 `34.0.0`） |
| `<tool>.exe` / `<tool>.bat` / `<tool>.jar` | README.md:94、tools/README.md:9-12 | 工具查找顺序的通配写法 |
| `<cwd>` | cordis.patch.yml:12 | "当前工作目录"的意思 |
| `<name>` | cordis.patch.yml:7 | profile 名（如 `web`） |
| `<platform>` | 交接文档 / platform.js 注释 | 泛指平台名 |

改完自查：

```bash
grep -rn "your-account\|<你的账号>" --include=*.json --include=*.md .
```

**预期**：输出**全部来自 `PUBLISHING.md`**（本页的对照表与这两条 sed 命令自身），
`package.json` 和 `README.md` 一行都不该出现。

> 为什么 `PUBLISHING.md` 会剩 9 行？实测确认，这 9 行**全是教学说明**：
> 对照表里展示"当前内容"用的是**全角** `＜your-account＞`（刻意如此 ——
> 既避免被替换，也避免 markdown 把它当 HTML 标签吃掉），
> 加上这两条 sed 命令与 grep 命令自身。**它们不需要改，也不该改。**

想要一条"干净"的自查（排除全角说明文字），用这个 —— **输出应为空**：

```bash
grep -rnE "[^＜]your-account|[^＜]你的账号" --include=*.json --include=*.md . | grep -v PUBLISHING.md
```

> **实测（以 `testuser` 跑完整流程）**：
> `package.json` 3 → 0、`README.md` 1 → 0，
> `PUBLISHING.md` 里 3 处真实命令全部命中：
> ```bash
> 247: git remote add origin https://github.com/testuser/apk-devkit.git
> 270: dsh plugin --profile web add github:testuser/apk-devkit
> 301: dsh plugin --profile web add github:testuser/apk-devkit
> ```
> 替换后 `package.json` 仍是合法 JSON。
> 另：sed 命令自身不会被误替换 —— 第 198 行里是 `github:)<your-account>`
> （冒号后有 `)`），不匹配正则，安全。

### 2. 确认打包内容干净

```bat
npm pack --dry-run
```

应只看得到源码（22 个文件，约 29kB），**不应出现**：

- `lib/node_modules/**`（本地测试依赖副本）
- `tools/windows/*.jar|exe|bat`（外部工具二进制，各有许可且体积大）
- `workspace/*`（运行时产物）

已通过 `.gitignore` + `.npmignore` + `files` 三重收口。

---

## 路径 A：GitHub Bundle 安装（由用户执行）

1. 推到 GitHub：

```bat
git init && git add . && git commit -m "init"
git remote add origin https://github.com/qftuftfutg/apk-devkit.git
git push -u origin main
```

2. 如需提交到第三方插件目录，请按该目录当时公开的投稿规则单独申请。`dsh-plugin` topic 只是 GitHub 元数据标签；本项目没有验证任何目录会自动抓取、审核或展示本仓库，也不能保证获得“verified”标记。DSH 官方 bundle 安装机制与第三方目录收录是两件不同的事。

3. 打 release tag（可选，用于标记源码版本；tag 本身不代表已被任何插件目录收录）：

```bat
git tag v0.1.0 && git push origin v0.1.0
```

用户侧：

```bat
dsh plugin --profile web add apk-devkit
dsh plugin --profile web add github:qftuftfutg/apk-devkit
```

---

## 路径 B：npm（也可被市场与 AI 拉取）

```bat
npm login
npm publish --access public
```

> `os: ["win32"]` 已在 package.json 里声明，
> 非 Windows 机器上 `npm i apk-devkit` 会被拒绝——这是有意的。

用户侧：

```bat
dsh plugin --profile web add apk-devkit
```

---

## 路径 C：由 AI 助手协助安装（需用户确认）

不要假定 DSH 会自动解析 README 并执行安装命令。本项目未验证这种自动化行为，也不应在没有用户确认的情况下安装第三方代码。可让 AI 助手解释安装命令，但实际安装仍由用户在受信任的终端中执行，并在安装前审查来源、依赖和权限。

---

## 本地开发安装（不用发布）

```bat
dsh plugin --profile web add link:
dsh plugin --profile web add D:\dev\apk-devkit
```

改完代码重启 Web UI 即生效。

---

## 发布后自检

```bat
dsh --profile web --dump-config | grep apk-devkit
dsh --profile web
```

- `--dump-config` 无输出 → `dsh.bundle.patch` 没生效，检查 `cordis.patch.yml`
  是否在 `files` 里、路径是否为 `/cordis.patch.yml`
- 启动日志中的注册工具数量应与当前提交 `npm run count-tools` 的结果一致（当前 README 静态清单为 38 项，未在本次审查中运行验证）。
- 数量不一致时，检查模块加载失败日志，并确认依赖是否完整。

---

## 版本更新流程

1. 改代码 → 本地 `dsh plugin add link:` 验证
2. `package.json` 升 version
3. `git tag vX.Y.Z && git push --tags`
4. `npm publish`
5. GitHub release 写 changelog

> 两条路径的版本号请保持一致，避免用户困惑。
