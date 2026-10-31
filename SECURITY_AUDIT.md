# 安全修复记录（2026-10-31）

本文件记录本次针对仓库静态审计截图中问题的代码变更与尚未消除的边界。它不是第三方认证，也不代表已经完成 Windows 真机验证。

## 本次处理

| 审计项 | 处理 | 代码位置 | 验证状态 |
|---|---|---|---|
| Windows 批处理命令注入 | 移除 Node `shell:true` 启动方式；改为显式启动 `cmd.exe`，对批处理路径和每个参数拒绝 CMD 元字符，并将命令行作为单一参数传入 | `lib/platform.js`, `lib/runner.js` | 增加 Windows 专项测试；需等待 GitHub Actions Windows runner |
| workspace 路径越界 / junction | 保留词法路径 + realpath 祖先检查；目录 diff 对每个遍历路径再次检查，并且不遍历符号链接 / junction | `lib/runner.js`, `modules/diff.js` | 现有路径测试 + 新增 diff 符号链接测试；TOCTOU 仍是已知边界 |
| diff 大文件导致内存压力 | 目录哈希改为流式 SHA-256；限制每侧 20000 个文件、累计 2 GiB；文本 diff 每个输入限制 2 MiB；超限返回 `EDIFFLIMIT` | `modules/diff.js` | 新增大文件限制和目录差异测试；需等待 CI |
| 插件兼容性声明不完整 | 仓库已有可选 peer dependency：`@deepseek-ai/cordis >=0.1.0-rc.6`。没有加入未经实测的 `engines.dsh` 版本范围，避免虚构兼容承诺 | `package.json`, `README.md` | 元数据核对；仍需在目标 DSH 版本实机安装验证 |

## 重要安全边界

1. Windows 批处理参数含 CMD 元字符时会被拒绝。遇到 `EUNSAFECMDARG` / `EUNSAFECMDPATH`，应重命名相关文件或改用原生 `.exe` / `.jar` 工具，不应关闭校验。
2. workspace 路径检查不是 OS 级沙箱。攻击者若能在检查与文件打开之间并发替换目录项，仍可能触发 TOCTOU 竞态。高风险部署应让 workspace 仅由插件进程写入，并使用操作系统权限隔离。
3. 目录 diff 的 2 GiB 和 20000 文件限制按每一侧目录分别计算；文本 diff 的 2 MiB 限制是为了控制行 diff 的内存占用。
4. 本次没有将项目改成 Android / Termux 插件。仓库当前仍声明 Windows 运行平台；APK 是被处理的文件格式，不代表插件自身是 Android APK。
5. 自动化测试通过不等于底层 apktool / APKEditor / JDK 在所有 Windows 机器上均兼容，也不等于对所有恶意输入完成形式化验证。

## 发布前验收

- GitHub Actions 的 Windows 测试工作流必须为绿色。
- 在目标 DSH 版本执行安装、插件加载、工具枚举。
- 对实际安装的 apktool / APKEditor / apksigner 版本执行授权测试 APK 的解包、重建、签名和验签。
- 不要在 CI 通过前将本次提交描述为“已完成真机验证”。
