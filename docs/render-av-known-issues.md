# 文档渲染：杀毒软件 (AV) 已知误报清单

HexClaw 桌面端为了支持 markdown → docx/pdf/epub 等导出，捆绑了两个静态链接的第三方二进制：

- **pandoc** (Haskell, GPL-2.0+)
- **typst** (Rust, Apache-2.0)

这两个二进制本身是 100% 公开开源的（GitHub release 直接拉取），不含任何 HexClaw 自有代码。但部分杀毒软件历史上对它们有过误报。本文档列出已知情况 + 用户处置建议。

详见架构文档 `hexclaw/.claude/doc-generation-architecture.md` §7 风险与缓解 / §8 威胁模型。

---

## 已知误报情况

| AV 引擎 | 二进制 | 误报概率 | 状态 |
|---|---|---|---|
| Windows Defender | pandoc.exe | 极低（<1%） | 偶发 false-positive 报"Trojan:Win32/Wacatac"，已多次提交白名单；最近 12 个月无新报告 |
| Avast / AVG | pandoc.exe | 历史曾发生 | 2022 年 pandoc 2.18 release 期间 Avast 误报 PUP；现已修复 |
| 360 / 火绒 | typst.exe | 偶发 | Rust 编译产物 + 静态链接特征触发启发式扫描；非真实威胁 |

## 验证渠道

- **VirusTotal 报告**：每次 release 提交 binary → VirusTotal 扫描，链接附在 release notes
  - Pandoc: https://www.virustotal.com/gui/file/<sha256>（具体 hash 见 `release/scripts/versions.json`）
  - Typst: 同上
- **GPG / minisign 签名**：pandoc 自身的 release artifact 由维护者 GPG 签名；HexClaw 在 Makefile 中通过 SHA256 双重校验
- **代码审计**：两者均为活跃维护开源项目，可在 GitHub 公开审计

## 用户遇到误报时的处置

1. **首先确认 SHA256 与 versions.json 一致**：
   ```bash
   shasum -a 256 ~/Library/Application\ Support/HexClaw/sidecar/render-bundle/pandoc
   ```
   对比 `release/scripts/versions.json` 中对应平台的 sha256。一致 = 来源可信。

2. **临时白名单**：
   - macOS：默认 Gatekeeper 不会拦（HexClaw 整包已 notarize）
   - Windows：把 `<HexClaw 安装目录>\sidecar\render-bundle\` 加入 Windows Defender 白名单
   - 360/火绒：右键二进制选"信任此文件"

3. **报告给上游**：如确认是误报，可向 AV 厂商提交白名单申请：
   - Pandoc：https://www.microsoft.com/en-us/wdsi/filesubmission
   - Typst：同上

## 如何避免误报

- 不在公司 EDR / IDS 严管环境部署（这类环境通常对未签名二进制持零信任）
- HexClaw 计划在 v0.5.x 引入 EV 证书签名 Windows 二进制，进一步降低误报率

---

**最后更新**：2026-05-07
**关联文档**：[doc-generation-architecture.md §7 风险与缓解](../../hexclaw/.claude/doc-generation-architecture.md)
