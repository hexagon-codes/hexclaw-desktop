[English](CONTRIBUTING.en.md) | **中文**

# 参与 HexClaw Desktop

欢迎通过 [Issues](https://github.com/hexagon-codes/hexclaw-desktop/issues) 报告问题、讨论方案，通过 [Pull Requests](https://github.com/hexagon-codes/hexclaw-desktop/pulls) 提交改动。本文说明从公开仓库开始开发的方法，以及各类验证所需的环境。

## 报告问题

使用 [Bug 报告表单](https://github.com/hexagon-codes/hexclaw-desktop/issues/new?template=bug_report.yml)，提供已有信息即可：

- 应用版本、操作系统与架构。
- 使用本机还是云端服务。
- 涉及模型时的 Provider 和模型。
- 复现步骤、期望结果和实际结果。

日志与截图请移除 API Key、访问令牌和个人数据。图片、文件或 IM 问题请说明实际结果是否收到，便于区分连接、处理和交付问题。

## 准备开发环境

| 工具 | 要求 |
| --- | --- |
| Node.js | 推荐 22.12.0 及以上；支持范围以 `package.json` 的 `engines` 为准。 |
| pnpm | 10.30.3，由 `package.json` 锁定。 |
| Rust | 1.94.0，由 `rust-toolchain.toml` 锁定。 |
| Go | 当前主线后端需要 1.25.13 及以上；其他后端版本以其 `go.mod` 为准。 |
| 系统工具 | Git、Make、Python 3、curl。 |
| 原生依赖 | 按 [Tauri 2 前置要求](https://v2.tauri.app/start/prerequisites/) 安装所用平台的依赖。 |

当前随包的本地推理与文档渲染组件需要 macOS 14 及以上。Linux 发布构建使用 Ubuntu 22.04，并依赖 WebKitGTK 4.1。用户安装方式见 [README](README.md#安装)。

```bash
git clone https://github.com/hexagon-codes/hexclaw-desktop.git
cd hexclaw-desktop
pnpm install --frozen-lockfile
```

## macOS 原生开发

准备 Sidecar 和随包组件，再启动桌面窗口：

```bash
make sidecar
make render-bundle
make ollama
make dev
```

`make sidecar` 从公开 HexClaw 仓库构建 `Makefile` 中 `HEXCLAW_REF` 指定的后端版本；它不会自动选择最新主分支。需要最新后端时，改用 `make sidecar HEXCLAW_REF=origin/main`，并确认前后端契约对应。

`make render-bundle` 的当前快捷目标适用于 macOS。Windows 和 Linux 的原生依赖与组件准备步骤见 [Release 工作流](.github/workflows/release.yml)。

只启动前端可运行 `pnpm dev`，但实际任务仍需要可访问的 HexClaw 服务。验证原生文件、预览、导出、打印或安装行为时，应使用对应桌面链路。

## 同时修改后端与桌面

将 `hexclaw`、`ai-core`、`hexagon`、`toolkit` 放在桌面仓库同级目录，在父目录的 `go.work` 中引用这些模块，再运行：

```bash
make sidecar-local
make render-bundle
make ollama
make dev
```

`make sidecar-local` 包含本地工作区的已提交代码与未提交改动；Go 代码变化后需要重建 Sidecar。`make package-local` 用于完整本地生态工作区的 macOS 安装产物，不是单独克隆桌面仓库后的默认起点。

## 选择与改动相关的验证

以下前端检查只需要当前公开仓库及已安装的 Node.js 依赖：

```bash
pnpm lint
pnpm type-check
pnpm build-only
```

这对应 CI 的代码检查、类型检查和前端构建。`pnpm build` 也可用于组合执行类型检查与前端构建。

| 验证 | 环境与证据范围 |
| --- | --- |
| 有关的独立单元测试 | 选择已有测试文件执行；例如下方知识库重试契约测试使用仓库内代码与 API 替身，不需要真实模型或 IM。其通过仅证明对应程序契约。 |
| 全量 `pnpm test:unit` | 部分用例依赖维护者提供的参考资料或素材；干净公开 clone 不包含所有这些依赖。 |
| 合同生成与检查 | `pnpm contracts:check` 需要同级 HexClaw 后端源码及对应 Go 环境。 |
| Rust 与原生构建 | 需要平台依赖、Rust 工具链和已准备的 Sidecar、渲染引擎与资源。 |
| 视觉、真实 API、模型、IM 与安装验收 | 按改动准备相应参考、当前服务、模型、已绑定通道或原生应用；前端构建和替身结果不能代替实际产物。 |

独立测试命令示例：

```bash
pnpm exec vitest run src/api/__tests__/knowledge-retry-intent.test.ts
```

完整命令清单在 [package.json](package.json)。测试缺少参考资料或环境时，说明缺少什么，并与维护者协调对应检查；不要通过删掉断言或跳过失败来宣称已通过。仓库既有 CI 门禁保持不变，fork 缺少维护者资源时，不保证全部 CI 检查可直接运行或通过。

## 提交 Pull Request

说明改动解决的问题、影响范围、验证方法和结果；尚未核对的原生、模型或交付边界应明确标注。公开 API 或任务行为变化时，同步相关使用说明与契约。

同一 Pull Request 中同步对应中英文文档；README 保留使用摘要，详细契约链接到后端或场景 API 文档。发布说明对应实际 Tag，分别标明安装包、后端与截图的适用版本；源码文档更新不代表安装包或官网已经发布。

保持改动集中，保留无关代码和有效检查。共享能力沿既有组件与模块维护，避免为单个页面另建任务流程。

## 参考资源

- [中文使用指南](docs/guide.md) / [English guide](docs/guide.en.md)。
- [Claude Code 开发实战 SOP](docs/claude-code-practices/README.md)：设计驱动、验证与多 Agent 协作方法，以及可复用命令和模板。
- [许可证](LICENSE) / [第三方组件](THIRD_PARTY.md)。
