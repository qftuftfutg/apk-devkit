# tools/windows/ — 外部工具存放目录

> **本项目当前仅支持 Windows。** Linux / macOS / Termux 不在支持范围，
> 在非 Windows 平台上调用任何外部工具会返回 `EPLATFORM` 明确报错。

本目录**只包含占位文件**，所有外部工具需你自行准备
（jar / exe 体积大且各有许可，不适合放进 git 仓库）。

`lib/platform.js` 的 `resolve()` 按下列顺序查找，
也可设 `APK_TOOLS_DIR` 环境变量指向别处（如 Android SDK 的 `build-tools\<ver>\`）：

```
1. <tool>.exe   原生 exe（最快，无 shell 层）
2. <tool>.bat / <tool>.cmd   Windows 脚本（Android SDK 自带的启动脚本）
3. <tool>.jar   → 以 java -jar 运行
4. 系统 PATH    → 兜底
```

## 需要放什么

```
tools/windows/
  apktool.bat        Apktool 官方 Windows 启动脚本
  apktool.jar        配套（apktool.bat 会调用它）
  apksigner.jar      （或 apksigner.bat）
  zipalign.exe       Android SDK build-tools
  aapt2.exe          Android SDK build-tools
  baksmali.jar
  smali.jar
  d8.jar             （或用 d8.bat）
  apkeditor.jar      REAndroid/APKEditor（注意重命名为小写）
```

> **APKEditor 下载后请重命名为小写 `apkeditor.jar`**
> （`resolve()` 按小写名查找）。

## 前置

- **JDK 17+**：`java -version` 必须可用（所有 jar 依赖它）
- 缺失某个工具时，对应模块调用会返回明确报错与安装提示，不会静默失败

## 下载

| 工具 | 地址 |
|---|---|
| Apktool | https://github.com/iBotPeaches/Apktool/releases |
| APKEditor | https://github.com/REAndroid/APKEditor/releases |
| smali / baksmali | https://bitbucket.org/JesusFreke/smali/downloads/ |
| apksigner / zipalign / aapt2 / d8 | Android SDK build-tools |
