# apk-devkit

[简体中文](README.md) | **English**

**DeepSeek Harness (DSH) plugin** — lets the AI inside DSH unpack, rebuild, sign, process DEX files, and edit APK resources and files through natural language, without requiring users to type command-line commands.

It wraps `apktool`, `aapt2`, `apksigner`, `zipalign`, `baksmali`, `smali`, `d8`, and `APKEditor` as tools callable by AI.

<p align="center">
  <a href="https://afdian.com/a/123xiaole">
    <img src="https://img.shields.io/badge/Afdian-Support%20the%20author-946CE6?style=for-the-badge" alt="Sponsor on Afdian">
  </a>
</p>
<p align="center"><strong>Voluntarily support project maintenance</strong> · <a href="SPONSOR.en.md">Sponsorship details</a> · <a href="SPONSOR.md">简体中文</a></p>

> ⚠️ **Platform support boundary: currently released and declared for 64-bit Windows only.**
> The tool resolver deliberately returns `EPLATFORM` on non-Windows platforms. Linux, macOS, and Termux are therefore unsupported runtime platforms. `package.json` declares `os: ["win32"]` and `cpu: ["x64", "arm64"]`. Most documented validation was performed on Windows x64. The metadata allows Windows ARM64, but this does not prove that every external tool is natively compatible. 32-bit Windows (ia32) is unsupported.

---

## 1. Installation

### Option A: Local directory (development/debugging; recommended)

```bash
cd /path/to/parent
dsh plugin --profile web add ./apk-devkit
```

This uses a `link:` reference. After changing the code, restart the Web UI for the changes to take effect; reinstalling is not required.

### Option B: npm

```bash
dsh plugin --profile web add apk-devkit
```

### Option C: GitHub source

```bash
dsh plugin --profile web add github:qftuftfutg/apk-devkit
```

### Verify that the plugin loaded

```bash
dsh --profile web --dump-config | grep apk-devkit
dsh --profile web
```

After startup, check that:

- The `--dump-config` output contains an `apk-devkit` entry.
- The startup log normally contains a line similar to:
  `[apk-devkit] loaded; registering N tools; workspace=...`
  This is a normal plugin-load message, **not an error**. `N` should be **38**.
  If the log also contains `[apk-devkit] module load failed X: ...` or
  `[apk-devkit] N modules not loaded`, the affected modules have problems (usually missing dependencies), and fewer than 38 tools will be available. These messages are useful diagnostic information, not noise.
- The AI can list tools such as `apk_decode`, `file_read`, and `apkedit_decode` in the session.

**If tools are not visible**, troubleshoot in this order:

1. There is **no** `apk-devkit` entry in `dsh --dump-config`:
   `dsh.bundle.patch` may be missing or have an incorrect path, causing the plugin to be silently ignored as an ordinary dependency. Check that `package.json` includes the correct `dsh.bundle.patch` and that `files` includes `cordis.patch.yml`.
2. An entry exists, but tools are not visible:
   The `inject: ['tools']` declaration may be incomplete, leaving the entry waiting for a service.
3. `Cannot find module '@deepseek-ai/...'`:
   A host-package import may have been added to `plugin.mjs`. This is **prohibited**; see the file-header comments.
4. `ERR_REQUIRE_ESM`:
   `"type": "commonjs"` conflicts with the host's ESM environment. See new finding 1 in Part 10 of the handoff notes.
5. Check whether the same `id` was inserted twice in the personal patch layer under `$DSH_HOME`. Duplicate IDs across the two layers can cause loader composition to fail.

> The `id` in `cordis.patch.yml` does **not** have to equal the exported `name` in `plugin.mjs`. The `id` is the key used by the patch layer to locate/override a row; `name` is the module specifier (package name or file path). If the package is later published as `@<scope>/apk-devkit`, `name` must be updated accordingly; `id` can remain unchanged.

---

## 2. Dependencies

### Required

| Dependency | Version | Notes |
|---|---|---|
| Windows | 10 / 11 | **The only currently supported platform** |
| Node.js | ≥ 18 | **Node 20 LTS recommended.** Early Node 18 releases have a symlink-loop hang bug in `fs.cp`. |
| JDK | 17+ | `java -version` must work; all JAR-based dependencies rely on it. |

### External tools

Place tools in `apk-devkit/tools/windows/`, or set `APK_TOOLS_DIR` to the directory containing them (for example, Android SDK's `build-tools\<ver>\`).

Lookup order: `<tool>.exe` → `<tool>.bat` / `.cmd` → `<tool>.jar` (run through `java -jar`) → system PATH.

> `APK_TOOLS_DIR` must point directly to the directory containing the tools. The resolver does not append a `windows` subdirectory. For example, if it points to Android SDK's `build-tools\34.0.0\`, `aapt2.exe` is searched for directly in that directory.

| Tool | Purpose |
|---|---|
| `apktool` | Decode / rebuild APKs |
| `aapt2` | Read basic APK information |
| `apksigner` | Sign / verify signatures |
| `zipalign` | Align APKs |
| `baksmali` | DEX → smali |
| `smali` | smali → DEX |
| `d8` | JAR → DEX |
| `apkeditor` | Edit binary resources (ARSC/XML), without depending on aapt2 |

Get `apkeditor` from <https://github.com/REAndroid/APKEditor/releases>. Rename the downloaded file to lowercase `apkeditor.jar` before placing it in the tools directory; it will automatically be invoked through `java -jar`.

See [tools/README.md](./tools/README.md) for the complete tool list and placement rules.

If a tool is not installed, the corresponding call returns an explicit error and installation guidance instead of failing silently.

### Optional dependency

`sharp` is required by the image module (`img_convert` / `img_resize`). It is marked optional in `package.json`; the installation command below deliberately omits optional dependencies, so sharp is not installed by default.

Do not interpret this as “Windows has no prebuilt package”: sharp's official installation documentation lists prebuilt Windows x64 packages. This project has not individually verified every Windows architecture. See [sharp's official platform and prebuilt-binary documentation](https://sharp.pixelplumbing.com/install/). The official support list is not proof of this project's own test results on every environment.

```bash
npm install --omit=optional        # Skip sharp
npm i sharp                        # Install separately if image tools are needed
```

Without sharp, the other 36 tools are unaffected. The two image tools are still registered, but calls return an explicit message that sharp is missing. The Node.js runtime requirement for sharp 0.33.5 should be taken from its package metadata; on Node 18, at least the declared 18.17.0 requirement must be met.

---

## 3. Environment Variables

| Variable | Default | Description |
|---|---|---|
| `APK_WORKSPACE` | `./workspace` | Workspace root; all path operations are confined to it |
| `APK_TOOLS_DIR` | `./tools/windows` | External tool directory; when set, this directory is used directly without appending a subdirectory |
| `APK_KS_PASS` | — | Signing keystore password (optional; usually supplied as an argument) |
| `APK_KEY_PASS` | — | Signing private-key password |

File paths are checked lexically and against real paths by `lib/runner.js#guard`. The guard rejects `../` traversal and resolves existing path ancestors to prevent symlinks/junctions from pointing outside the workspace. ZIP extraction performs a complete preflight check and rechecks the destination before each write.

This is not a complete operating-system sandbox and cannot eliminate TOCTOU (time-of-check-to-time-of-use) races. Do not allow an untrusted local process to modify the workspace concurrently.

---

## 4. Tool Inventory (38 tools, 10 modules)

| Module | Count | Tools | Purpose |
|---|---:|---|---|
| apk | 3 | `apk_info` | Read package name, version, minSdk, and permissions |
| | | `apk_decode` | Decode into a directory (including smali) |
| | | `apk_build` | Rebuild an unsigned APK |
| apkedit | 7 | `apkedit_info` | Detailed information: resource table, DEX, signature, languages, file inventory |
| | | `apkedit_decode` | Decode binary resources into JSON/XML |
| | | `apkedit_build` | Rebuild APK (includes zipalign) |
| | | `apkedit_merge` | Merge split packages (directory form available; XAPK/APKM/APKS not yet tested) |
| | | `apkedit_refactor` | De-obfuscate resource names |
| | | `apkedit_xmlStrings` | Print the XML string pool |
| | | `apkedit_xmlTree` | Print compiled XML as a tree |
| sign | 3 | `sign_apk` | V1/V2/V3 signing |
| | | `sign_verify` | Verify signature and output certificate |
| | | `sign_align` | zipalign |
| dex | 3 | `dex_disassemble` | DEX → smali |
| | | `dex_assemble` | smali → DEX |
| | | `dex_jar2dex` | JAR → DEX |
| dex2jar | 1 | `dex2jar_jar` | DEX → JAR (d2j-dex2jar) |
| diff | 2 | `diff_files` | Compare text files line by line |
| | | `diff_dirs` | Recursively compare directories |
| zip | 4 | `zip_list` / `zip_extract` / `zip_add` / `zip_remove` | Inspect and modify archives |
| file | 12 | `file_read` / `file_write` | Read/write text (automatically strips BOM) |
| | | `file_list` | List directories (the AI's “eyes” for locating files) |
| | | `file_stat` | Existence, type, size, and mtime |
| | | `file_delete` / `file_mkdir` | Delete / create directories |
| | | `file_copy` / `file_move` / `file_rename` / `file_batchRename` | Copy / move / rename |
| | | `file_readHex` / `file_patch` | Hexadecimal read/write |
| img | 2 | `img_convert` / `img_resize` | Convert / resize images |
| hash | 1 | `hash_compute` | md5 / sha1 / sha256 |

Run `npm run list-tools` to print the full inventory, including each tool's `inputSchema`.

> If you see `[apk-devkit/apkedit] Notice: ...` at runtime, this is an **expected module-load warning** (the APKEditor CLI arguments have not yet been verified on a real device), not an error. JSON results are still written normally to stdout. The warning is printed only once per process.

---

## 5. Typical Workflows

**Modify code (smali):**

```
1. apk_decode          Decode into unpacked/
2. file_list           Find the smali file to modify
3. file_read / write   Edit its contents
4. apk_build           Rebuild an unsigned APK
5. sign_align → sign_apk → sign_verify
```

**Modify resources (strings/icons/ARSC):**

```
1. apkedit_decode      Decode into editable JSON
2. file_read / write   Edit values-*/strings and related files
3. apkedit_build       Rebuild (includes zipalign)
4. sign_apk → sign_verify
```

You can ask DSH in natural language, for example:
“Decode app.apk in the workspace, modify AndroidManifest, then rebuild and sign it.”

---

## 6. Two Entry Points

| | plugin.mjs (primary) | server.js (fallback) |
|---|---|---|
| Type | Native Cordis plugin | MCP stdio server |
| Tool name | `apk_decode` | `mcp__apk-devkit__apk_decode` |
| Mounting | Active after installation | Requires a manually written patch.yml or MCP panel configuration |
| Rendering | Supports `output.render` | Plain text only |

Both use the same `orchestrator` and `modules`, and provide equivalent capabilities. They can coexist. `server.js` is retained as a fallback when bundle support is incomplete.

MCP protocol version: `2024-11-05`; implemented methods: `initialize`, `tools/list`, and `tools/call`.

---

## 7. Known Limitations

**Functional gaps**

- `file_read` supports only `utf8`, `utf16le`, and `latin1`. **GBK / GB18030 will be decoded incorrectly**, which matters for `res/values/strings.xml` in some legacy projects.
- Split-package merging in `apkedit_merge`: **directory form works**; XAPK / APKM / APKS are claimed by the upstream APKEditor README but **have not been tested here**.

**Not provided**

- Visual editor panels, audio/video playback, or image preview: these require a GUI and are outside the scope of command-line tools.
- Linux scripts or arbitrary command execution: these would break the workspace sandbox boundary.
- DEX / RES obfuscation or anti-obfuscation.

**Engineering limitations**

- Large ZIP files (>100 MB) can create memory pressure because `adm-zip` reads the archive into memory.
- Path checks reject symlinks/junctions that resolve outside the workspace, but this is not an OS-level sandbox and concurrent TOCTOU races remain possible.
- Cross-drive `file_move` operations (C: ↔ D:) fall back to copy-and-delete.
- `file_list` returns at most 5,000 entries per call.

See Parts 6, 9, and 10 of the handoff document for details.

---

## 8. Compliance Statement

This tool is intended for developers to debug, repackage, sign, and edit resources in Android APK projects **for which they own the relevant rights or have explicit authorization**.

**Prohibited uses**

1. Cracking, tampering with, or redistributing third-party apps without authorization;
2. Removing or bypassing technical protection measures, signature/license checks, or account verification without authorization;
3. Infringing intellectual property, damaging computer information systems, or engaging in other unlawful conduct.

Whether a particular action is unlawful depends on the scope of authorization, the nature of the technical measure, the purpose of the action, and its actual impact. This project statement is not legal advice and does not determine that a particular action necessarily falls under a specific law.

> ⚠️ **Open-source tools do not mean you may process someone else's APK.**
> The underlying components called by this tool (APKEditor, Apktool, smali, etc.) are open-source software under permissive licenses such as Apache-2.0 and BSD. That addresses **whether you may use the tool**. Whether **you may use it on a particular APK** is governed by applicable laws (including software-protection regulations) and the target app's terms of service; it is unrelated to whether the tool itself is open source.

---

## 9. License and Acknowledgements

The project's own code (`orchestrator.js`, `server.js`, `plugin.mjs`, `lib/`, and `modules/`) is licensed under **MIT**. See [LICENSE](./LICENSE).

The underlying capabilities come from the following open-source projects. This project **invokes only their officially released executables or JAR files through child processes**; it does not copy, translate, or modify their source code, and does not redistribute them with this package.

| Project | License | Purpose |
|---|---|---|
| [REAndroid/APKEditor](https://github.com/REAndroid/APKEditor) | Apache-2.0 | Binary resource decode/rebuild/merge/de-obfuscation |
| [REAndroid/ARSCLib](https://github.com/REAndroid/ARSCLib) | Apache-2.0 | Distributed with APKEditor; not called directly by this project |
| [iBotPeaches/Apktool](https://github.com/iBotPeaches/Apktool) | Apache-2.0 | Decode / rebuild |
| [JesusFreke/smali](https://github.com/JesusFreke/smali) | BSD-3-Clause | DEX ↔ smali |
| AOSP (apksigner / zipalign / aapt2 / d8) | Apache-2.0 | Signing / alignment / information / JAR-to-DEX |

See [NOTICE](./NOTICE) for complete notices and acknowledgements.

---

## 10. Security Constraints

- `lib/runner.js#guard` checks both lexical paths and the real paths of existing ancestors. It blocks common symlink/junction escapes, but is not an OS-level sandbox and cannot fully eliminate TOCTOU races.
- `file_delete`, `file_move`, and `file_copy` refuse to operate on the workspace root.
- `file_rename` and `file_batchRename` reject rename results containing path separators.
- Signing passwords are passed to child processes through environment variables and do not appear in the process command line.
- On Windows, calls to `.bat/.cmd` quote arguments and reject cmd metacharacters such as `& | < > ^ ( ) % !`, quotes, and newlines. This prevents filenames/arguments from being interpreted as shell commands. If rejected, rename the file or use an `.exe/.jar` tool instead.
- `server.js` implements only the allowlisted methods: `initialize`, `ping`, `tools/list`, and `tools/call`.
- Child-process concurrency is capped at 2 to prevent apktool / d8 from exhausting memory.

**Hardening covered by automated tests**

- `zip_extract` / `zip_add` validate archive entry names. Malicious entries containing `../`, absolute paths, drive prefixes (such as `C:\\`), and **symbolic-link entries** (where `external_attr` contains `S_IFLNK`) are rejected as a whole. The archive is fully validated before extraction, so partial output is not left behind. The `suspicious` / `isSymlink` fields in `zip_list` can be used for inspection before extraction.
- When extracting selected `entries`, matching uses the original archive entry name (and also accepts the normalized name). Note: adm-zip's `getEntry()` cannot find some non-minimal names such as those containing `./`; this module uses its own index and writes files itself to avoid that limitation.
- Child-process output has an 8 MB hard limit. Excess output sets the `truncated` flag, preventing verbose tools from flooding the plugin process with tens of megabytes.
- Signing passwords are merged into the child process environment through `opts.env`, **not written to global `process.env`**. Concurrent signing tasks therefore do not interfere. The command still uses `--ks-pass env:APK_KS_PASS`; the password does not appear in argv.

**Remaining boundaries**

- Path checks are not an OS-level sandbox and cannot completely eliminate TOCTOU races. Do not let untrusted local processes modify the workspace concurrently.
- `file_rename` / `file_batchRename` reject path separators in rename results, but do not eliminate TOCTOU races or conflicts caused by another process creating a same-named file first.

**Concurrency and queueing**

- While long-running tasks (`apk_build`, `apkedit_build`, `dex_disassemble`; potentially up to 10 minutes) are running, short tasks (`hash_compute`, `file_read`) wait in the queue. Keep this in mind when requesting multiple operations in one session.

---

## 11. License

MIT — see [LICENSE](./LICENSE).
