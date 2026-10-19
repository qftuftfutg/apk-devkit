# 发布清单：让 DSH 能从插件库拉取

本文档把"发布上去 → DSH 能拉到"拆成可执行步骤。
两条路径都走通，用户就能**任选其一**安装。

---

## 在手机 / Linux 上先验证（可选，但强烈建议）

项目发布时锁死 `os: ["win32"]`，但**纯 JS 内核本身是跨平台的**。
如果你想在手机（Linux/ARM，如 DSH 手机版）或 Mac 上先把代码跑通再发布，
按本节操作。

> 本节每条命令都在 Linux 实机跑过，输出照实抄录。

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

### 两种解法（任选其一，均实测输出 37）

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

只要依赖装好，终端干净地输出**一行裸数字**：

```
37
```

> 不要期待 `[apk-devkit] loaded; registering 37 tools; workspace=...` ——
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

所以 `node_modules` 里**没有 sharp 也照样输出 37**。
只有真正调用 `img_convert` / `img_resize` 时才抛
`ENOENT_TOOL: sharp 未安装，请执行 npm i sharp`。

实测（两条路都跑过）：

```
node_modules: @emnapi @img adm-zip diff     ← 没有 sharp
count-tools: 37
```

依赖没装全时，stderr 会长这样。注意模块名**带 `.js`**
（`f` 来自 `readdirSync`，是文件名不是模块名）：

```
[apk-devkit] 模块加载失败 diff.js: Cannot find module 'diff'
[apk-devkit] 模块加载失败 zip.js: Cannot find module 'adm-zip'
[apk-devkit] 2 个模块未加载，7 个可用
31
```

**31 ≠ 代码有问题**。看 stderr 那行定位缺哪个包，补装 `npm install diff adm-zip` 即可。

---

### 手机上能用多少

| 类别 | 模块 | 工具数 | 手机上 |
|---|---|---|---|
| 纯 Node（不调外部工具） | file / hash / diff / zip | **19** | ✅ 稳定可用 |
| 懒加载原生依赖 | img | 2 | ✅ 能注册；**调用时**需装好 sharp（ARM 下常无预编译包） |
| 依赖外部 jar / exe | apk / apkedit / sign / dex | 16 | ⚠️ 抛 `EPLATFORM` |

> **19 而不是 21**：`img` 虽不调 exe/jar（不会撞 `EPLATFORM`），
> 但**调用时**硬依赖原生包 sharp，ARM 上大概率装不上，
> 所以算进"稳可用的纯 Node"是虚的。

`EPLATFORM` 的 hint 已明确写"这是设计限制，不是 bug"，
所以手机上看到它是**符合预期的**，不是故障。

> 结论：手机验证能稳定覆盖 **19/37** 的实际执行，
> 加上 **37/37** 的加载与清单生成 —— 足以证明内核在 Linux 下语法与依赖都没问题。

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

## 路径 A：官方插件库（用户点一下装好）

1. 推到 GitHub：

```bat
git init && git add . && git commit -m "init"
git remote add origin https://github.com/qftuftfutg/apk-devkit.git
git push -u origin main
```

2. 在 GitHub 仓库页 **Settings → Topics** 加 topic：

```
dsh-plugin
```

> 这一步是**索引的关键**。dsh-plugin.org 按该 topic 自动抓取仓库，
> 人工审核通过后标 ✅verified，出现在 DSH「设置 → 插件市场」。

3. 打 release tag（可选但推荐，市场按 tag 取版本）：

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

## 路径 C：AI 间接安装（不经审核）

DSH 的 `dsh-market` 会**解析 README 里的安装命令**自动执行。
所以 README 第一章必须保留这三行原文（已保留）：

```bat
dsh plugin --profile web add ./apk-devkit
dsh plugin --profile web add apk-devkit
dsh plugin --profile web add github:qftuftfutg/apk-devkit
```

用户只需在 DSH 会话里说一句：

> 帮我安装 apk-devkit 插件

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
- 启动日志应有 `[apk-devkit] loaded; registering 37 tools; workspace=...`
- 数字不是 37 → 有模块加载失败，看紧随其后的"模块加载失败 X"行

---

## 版本更新流程

1. 改代码 → 本地 `dsh plugin add link:` 验证
2. `package.json` 升 version
3. `git tag vX.Y.Z && git push --tags`
4. `npm publish`
5. GitHub release 写 changelog

> 两条路径的版本号请保持一致，避免用户困惑。
