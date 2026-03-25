[English](updates.en.md) | **中文**

# 自动更新发布说明

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
- `Release` 工作流现在会在缺少 `TAURI_SIGNING_PRIVATE_KEY` 时直接失败
- 发布成功后，GitHub Release 里需要包含 `latest.json` 和对应平台的签名更新包

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

如果要构建可正常分发的 macOS 安装包，还要配置 Apple 代码签名 secrets：

- `APPLE_CERTIFICATE`
- `APPLE_CERTIFICATE_PASSWORD`

并提供一组 notarization 认证方式：

- Apple ID：`APPLE_ID`、`APPLE_PASSWORD`、`APPLE_TEAM_ID`
- App Store Connect：`APPLE_API_KEY`、`APPLE_API_ISSUER`、`APPLE_API_PRIVATE_KEY`（workflow 会自动生成 `private_keys/AuthKey_<APPLE_API_KEY>.p8`）

如果你的私钥没有密码，第二项可以留空或不设置。

如果你已经拿到 `.p12` 和 `AuthKey_*.p8` 文件，可以直接用仓库里的脚本把它们写入 GitHub secrets：

```bash
bash ./scripts/ci/set-github-macos-secrets.sh \
  --repo hexagon-codes/hexclaw-desktop \
  --certificate ~/Downloads/developer-id.p12 \
  --certificate-password '***' \
  --api-key-id ABC123XYZ9 \
  --api-issuer 11111111-2222-3333-4444-555555555555 \
  --api-private-key ~/Downloads/AuthKey_ABC123XYZ9.p8
```

如果你想先确认参数，不实际写入 secrets，可以追加 `--dry-run`。

Apple 平台侧的完整准备步骤见 [macOS 正式发布准备](./macos-release.md)。

## 发布流程

1. 更新版本号，保持这些文件一致：
   - `package.json`
   - `src-tauri/tauri.conf.json`
   - `src-tauri/Cargo.toml`
2. 提交代码并推送
3. 创建并推送 tag，例如：

```bash
git tag v0.0.3
git push origin v0.0.3
```

4. 等待 GitHub Actions 的 `Release` 工作流完成
5. 确认 Release 附件里包含：
   - `latest.json`
   - macOS / Windows / Linux 对应安装包
   - 对应平台的 updater 签名产物

## 应用内体验

当前桌面端已经补齐这两条链路：

- 应用启动后会静默检查更新
- 用户可在 **关于** 页面手动检查和安装更新

如果你发布的是未签名包，界面仍然会显示检查更新入口，但不会拿到可安装的正式 updater 包。

## 常见问题

### 为什么本地 `pnpm tauri build` 会报私钥缺失？

因为 [src-tauri/tauri.conf.json](../src-tauri/tauri.conf.json) 开启了：

```json
"createUpdaterArtifacts": true
```

这表示构建时会额外生成 updater 制品并尝试签名。如果当前 shell 没有导出 `TAURI_SIGNING_PRIVATE_KEY`，就会报错。

### 这会影响 `.app` / `.dmg` 手动安装吗？

Tauri updater 私钥不会。它影响的是自动更新制品签名，不影响普通安装包的手动分发。

但 macOS 的 Apple 签名 / notarization 会影响。缺少这组 secrets 时，浏览器下载的 `.dmg` / `.app` 很可能会被 Gatekeeper 提示为“已损坏，无法打开”。

### workflow 现在会自动验证什么？

- 构建前检查 macOS 签名 / notarization secrets 是否齐全
- 构建后在 macOS runner 上执行 `codesign --verify`
- 构建后执行 `spctl -a -vv`
- 如果有 `.dmg`，额外执行 `xcrun stapler validate`

### 预发布版本会自动更新吗？

当前 updater endpoint 指向 GitHub Releases 的 `latest/download/latest.json`，默认走稳定版本通道。预发布版本是否参与自动更新，取决于你后续是否要单独做预发布通道。
