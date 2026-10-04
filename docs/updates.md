[English](updates.en.md) | **中文**

# 自动更新发布说明

## v0.5.0-beta.1（2026-10-04）

本次版本同步 CI 修复与发布说明，变更见 [Changelog](../CHANGELOG.md)。普通 CI 检查源码；`Package` 手动生成安装包；版本 tag 才触发 `Release`。这些阶段的结果分别记录，不将本地检查通过写成 GitHub Release 已发布。

HexClaw Desktop 使用 Tauri updater。要让应用内“检查更新 / 下载并安装”真正可用，需要同时满足下面 4 个条件：

1. `src-tauri/tauri.conf.json` 中配置了稳定可访问的 `plugins.updater.endpoints`
2. `src-tauri/tauri.conf.json` 中提交了与私钥匹配的 `plugins.updater.pubkey`
3. GitHub Actions `Release` 工作流拿到了 `TAURI_SIGNING_PRIVATE_KEY`
4. 正式版本通过 tag 触发发布，生成已签名的 updater 制品和 `latest.json`

## 本地打包 vs 正式发布

### 本地打包

适合 UI 调试、内部测试、手动安装。

- 可以没有 updater 私钥
- `Package` 工作流会在缺少私钥时自动关闭 updater 制品生成
- 产物仍然可以手动安装
- 但应用内自动更新不会生效

### 正式发布

适合让应用内自动更新真正可用。

- 必须配置 updater 私钥
- `Release` 工作流在缺少 `TAURI_SIGNING_PRIVATE_KEY` 时会自动关闭 updater 制品生成，仍会产出可手动安装的未签名包，但应用内自动更新不会生效
- 要让自动更新可用，GitHub Release 里需要包含 `latest.json` 和对应平台的签名更新包

## 一次性初始化

### 1. 生成 updater 签名密钥

```bash
pnpm tauri signer generate -w ~/.tauri/hexclaw-updater.key
```

执行后你会得到：

- 一份私钥文件
- 一段 public key 文本

### 2. 提交 public key

把生成出来的 public key 写入 [src-tauri/tauri.conf.json](../src-tauri/tauri.conf.json) 的：

```json
"plugins": {
  "updater": {
    "pubkey": "..."
  }
}
```

### 3. 配置 GitHub Secrets

在仓库 Secrets 里配置：

- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`

如果你的私钥没有密码，第二项可以留空或不设置。

> **关于 macOS 代码签名**：当前发布流程构建的是 **未签名 DMG**，不做 Apple 代码签名 / notarization。`TAURI_SIGNING_PRIVATE_KEY` 仅用于 updater 制品签名，与 Apple 代码签名无关。

## 发布流程

1. 更新版本号，保持这些文件一致：
   - `package.json`
   - `src-tauri/tauri.conf.json`
   - `src-tauri/Cargo.toml`
   - `src-tauri/Cargo.lock` 中 `hexclaw-desktop` 的根包版本
   - `Makefile` 中的 `HEXCLAW_REF`（应为 `refs/tags/v<版本号>`）
2. 提交代码并推送
3. 核对待发布版本及对应后端 tag，再创建并推送本次 tag；已推送的 tag 不删除或移动。以下命令仅说明入口：

```bash
git tag v0.5.0-beta.1
git push origin v0.5.0-beta.1
```

4. 等待 GitHub Actions 的 `Release` 工作流完成
5. 确认 Release 附件里包含：
   - `latest.json`
   - macOS / Windows / Linux 对应安装包
   - 对应平台的 updater 签名产物

### Homebrew Cask 与 Beta 发布

`Release` 的 `update-tap` 只自动更新稳定版本。含 `-` 的预发布 tag（包括 `v0.5.0-beta.1`）会跳过该任务，Beta 的 Cask 需要单独更新。

先发布并确认 Desktop 的两种 macOS DMG 均可下载，再更新 [Homebrew Cask](https://github.com/hexagon-codes/homebrew-tap/blob/main/Casks/hexclaw.rb)：版本应对应 Desktop Release；ARM 与 Intel 的 SHA256 分别来自实际发布的 `HexClaw_<版本>_aarch64.dmg` 和 `HexClaw_<版本>_x64.dmg`；核对两种架构的 URL 均指向该版本的正确安装包。后端 tag 发布成功不能代替 Desktop 安装包与 Cask 的验证。macOS 继续使用未签名 DMG，不增加 Apple 代码签名或 notarization。

## 应用内体验

当前桌面端已经补齐这两条链路：

- 应用启动后会静默检查更新
- 用户可在 **关于** 页面手动检查和安装更新

如果发布包没有生成带 Tauri updater 签名的更新制品，界面仍然会显示检查更新入口，但不会拿到可安装的正式 updater 包。macOS 未做 Apple 代码签名不等于缺少 updater 签名。

## 常见问题

### 为什么本地 `pnpm tauri build` 会报私钥缺失？

因为 [src-tauri/tauri.conf.json](../src-tauri/tauri.conf.json) 开启了：

```json
"createUpdaterArtifacts": true
```

这表示构建时会额外生成 updater 制品并尝试签名。如果当前 shell 没有导出 `TAURI_SIGNING_PRIVATE_KEY`，就会报错。

### 这会影响 `.app` / `.dmg` 手动安装吗？

Tauri updater 私钥不会。它影响的是自动更新制品签名，不影响普通安装包的手动分发。

由于当前发布的是未签名 DMG（不做 Apple 代码签名 / notarization），浏览器下载的 `.dmg` / `.app` 很可能会被 Gatekeeper 提示为“已损坏，无法打开”，用户需要手动放行（如 `xattr -dr com.apple.quarantine`）。

### workflow 现在会自动验证什么？

- 普通 `CI` 保留 lint、type-check、既有单测、web build 与 `cargo check`；单测以只读凭据获取私有原型和素材，不把真实模型、IM 或原生窗口验收放入普通 CI。
- `Package` 和 `Release` 在缺少 `TAURI_SIGNING_PRIVATE_KEY` 时自动关闭 updater 制品生成，仍产出可手动安装的未签名包。
- `Release` 校验版本号（`package.json` / `tauri.conf.json` / `Cargo.toml`）及 `Makefile` 的 `HEXCLAW_REF` 与 tag 一致。

### 预发布版本会自动更新吗？

当前 updater endpoint 指向 GitHub Releases 的 `latest/download/latest.json`，默认走稳定版本通道。预发布版本是否参与自动更新，取决于你后续是否要单独做预发布通道。
