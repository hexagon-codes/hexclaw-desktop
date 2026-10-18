# 文档渲染：杀毒软件 (AV) 告警核对

HexClaw 桌面端为了支持 Markdown → DOCX/PDF/EPUB 等导出，随包提供两个独立运行的第三方二进制：

- **pandoc** (Haskell, GPL-2.0+)
- **typst** (Rust, Apache-2.0)

组件从上游发行产物获取，构建过程按固定摘要校验。收到安全软件告警时，需要核对具体版本、文件及检测结果，不能仅凭组件开源就认定是误报。

随包组件的来源和许可证见 [THIRD_PARTY.md](../THIRD_PARTY.md)，当前固定版本及平台摘要见 [versions.json](../release/scripts/versions.json)。这些文件随本仓库提供，不依赖维护者的私有目录。

---

## 记录边界

本仓库没有可核对的检测样本统计、各厂商白名单状态或逐版本扫描报告，因此不提供误报概率及“已经修复”的保证。报告问题时请记录应用版本、组件文件名、SHA256、检测引擎和告警名称，并移除日志中的个人信息。

## 验证渠道

- **发行记录**：核对所下载版本的发行说明及固定摘要；如该版本提供额外扫描报告，可按其实际链接查看，不将未执行的扫描写成每版必有的流程。
- **摘要**：将实际文件与 `versions.json` 中对应组件、版本和平台的 SHA256 比较；上游签名的可用性以该版本实际附件为准
- **代码审计**：两者均为活跃维护开源项目，可在 GitHub 公开审计

## 用户遇到误报时的处置

1. **首先确认 SHA256 与 versions.json 一致**：
   ```bash
   shasum -a 256 ~/Library/Application\ Support/HexClaw/sidecar/render-bundle/pandoc
   ```
   对比 `release/scripts/versions.json` 中对应版本及平台的 SHA256。一致只说明字节与固定产物相同，不能单独证明告警一定为误报；上方路径应替换为实际安装文件路径。

2. **区分安装警告与文件检测**：
   当前 macOS 发布为未签名 DMG（未做 Apple 签名 / notarization），Gatekeeper 安装提示的处理见[使用指南](guide.md#macos-安全提示)。具体文件的检测告警应按对应文件和检测引擎核对，不将整目录加入白名单作为默认步骤。

3. **报告给上游**：如确认是误报，可向 AV 厂商提交白名单申请：
   - Pandoc：https://www.microsoft.com/en-us/wdsi/filesubmission
   - Typst：同上

## 发行信息

- 签名状态以所用版本的实际发布产物为准；本文不承诺尚未交付的证书或签名计划。

---

**关联文档**：[第三方组件](../THIRD_PARTY.md) / [更新与发布产物](updates.md)
