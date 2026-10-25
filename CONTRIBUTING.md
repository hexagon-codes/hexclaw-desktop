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

当前 Desktop 源码版本为 `0.5.1`。`make sidecar` 从公开 HexClaw 仓库构建 `Makefile` 中 `HEXCLAW_REF` 指定的后端版本，当前固定来源为 `refs/tags/v0.5.1`，对应提交已通过后端 CI，[后端 Release](https://github.com/hexagon-codes/hexclaw/releases/tag/v0.5.1) 的五个平台包及校验和已发布。Desktop 安装包仍按自己的 CI 和发布流程独立验收，见[发布说明](docs/updates.md)。默认来源不随 main 浮动；开发时包含后端未提交修改的验证使用 `make sidecar-local` / `make build-local`。需要最新主分支时，可显式使用 `make sidecar HEXCLAW_REF=origin/main`，并确认前后端契约对应。

`make render-bundle` 的当前快捷目标适用于 macOS。Windows 和 Linux 的原生依赖与组件准备步骤见 [Release 工作流](.github/workflows/release.yml)。

渲染工具的固定官方归档缓存在目标目录旁的 `.render-bundle-cache/render-archives`；设置 `RENDER_BUNDLE_CACHE_ROOT` 时改用该缓存根目录。每次复用仍核验归档摘要、长度、成员及解包上限，损坏缓存重新下载，已验证输出在候选准备完成前保留。内容未变的二进制保留时间戳；缓存不替代版本清单，也不修改构建预算。

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

## 同步产品事实

关于页的生态链接读取 `src/generated/product-facts.json`。权威源是 HexClaw 后端的 `engine/product_facts.json`，修改事实时先改权威源，再从 Desktop 仓库执行：

```bash
node scripts/sync-product-facts.mjs
node scripts/sync-product-facts.mjs --check
```

默认读取相邻的 `../hexclaw`；其他源码位置通过 `HEXCLAW_SOURCE_ROOT` 指定。生成器递归排除 `visibility: internal` 对象、下划线字段及已有摘要字段，按稳定键序生成公开投影与 `facts_digest`。提交同步脚本和生成 JSON，避免直接修改生成结果。该命令不启动服务、不调用模型；当前未接入 package scripts 或 CI，不把手动检查写成已有自动门禁。

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

### 维护测试环境与当前合同

- jsdom 不等于浏览器。规范 API 的缺失在共享 [Vitest 环境](src/test/vitest-setup.ts) 中适配；例如 `CSS.escape` 使用规范 polyfill，不能修改生产选择器或返回未转义值来迁就夹具。`ResizeObserver` 的环境适配只提供生命周期，不证明布局或尺寸正确。
- 编写和维护测试必须遵守[当前 CI 工作流](.github/workflows/ci.yml)及本节测试规范，核对工具链、锁文件、实际命令、共享初始化和 `HEXCLAW_DOCS_TEST_REF` 固定参考。本机未提交原型不等于 CI 参考；交付前按对应入口验证并说明平台差异，不能只凭零散用例通过宣称 CI 就绪。
- 优先使用真实的纯函数、Markdown 解析器和净化器。必要的模块替身保留无关真实导出，只替换 HTTP、原生桥接等受控边界；新增导出不应因整模块假实现而在无关用例中缺失。
- 组件依赖路由、服务作用域或持久任务时，夹具应建立对应上下文。请求、归属、状态、幂等和回执断言继续保留；不要把真实合同失败当成可忽略的 mock 问题。
- 单测验证请求、身份、状态、幂等、数据与副作用。纯布局、字号、颜色、图标、固定文案、class 或源码目录清单没有独立业务检错价值时，删除对应用例，不随每次界面调整反复改断言；保留具体 HTTP 契约及操作行为验证。界面显示通过实际页面和原型验收，不用源码字符串或单测代替。
- 启动整体测试前说明局部验证为何不足；相关条件未变的有效证据继续复用。固定 CI 门禁照常保留，真实模型、IM 和原生操作按各自授权执行。本地通过只代表已记录环境中的结果，不能写成尚未运行的 GitHub Actions 已通过。

## 提交 Pull Request

说明改动解决的问题、影响范围、验证方法和结果；尚未核对的原生、模型或交付边界应明确标注。公开 API 或任务行为变化时，同步相关使用说明与契约。

同一 Pull Request 中同步对应中英文文档；README 保留使用摘要，详细契约链接到后端或场景 API 文档。发布说明对应实际 Tag，分别标明安装包、后端与截图的适用版本；源码文档更新不代表安装包或官网已经发布。

保持改动集中，保留无关代码和有效检查。共享能力沿既有组件与模块维护，避免为单个页面另建任务流程。

## 参考资源

- [中文使用指南](docs/guide.md) / [English guide](docs/guide.en.md)。
- [Claude Code 开发实战 SOP](docs/claude-code-practices/README.md)：设计驱动、验证与多 Agent 协作方法，以及可复用命令和模板。
- [许可证](LICENSE) / [第三方组件](THIRD_PARTY.md)。
