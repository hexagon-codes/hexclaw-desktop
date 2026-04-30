# Changelog

## v0.4.0 (2026-05-01)

### 重大重构 — 统一文本对话框（K12 友好 / 通用 Agent 范式）
- **删除独立模式 composer**：移除 `ImageGenComposer.vue` / `VideoGenComposer.vue`，所有路径统一到唯一 `ChatInput`。前台不再因模型 capability 切换不同输入框，对齐 ChatGPT / Claude / Gemini 范式。
- **删除生成模型切换浮条**：原 `hc-gen-modebar`（与底部 model selector 重复）整段删除。
- **删除生成参数面板（GenerationInspector）**：图像/视频生成走默认参数（图像 1024×1024 / 1 张；视频 1280×720 / 5s / 含音轨），用户感知归零；ChatInput 按当前模型 capability 内联调用 `generateImage` / `submitVideoGeneration`。
- **历史 base64 脏数据兜底**：旧版本写进 `content` 字段的 base64 长串，在气泡渲染时替换为 `[图像数据 · 历史消息已截断]` 占位，避免视觉炸场。

### 维语 (ug-CN) RTL 支持
- **i18n 全量翻译**（1330 key 与 zh-CN 1:1 对齐）+ `isRTLLocale` + `setLocale` 自动设 `<html dir=rtl lang=ug>`。
- **W3C 标准 unicode-bidi: plaintext 全局兜底**（CSS 等价 `dir="auto"`）：在 `[dir='rtl']` 下对 `:is(p, div, span, li, h1-h6, pre, textarea, button, ...)` 统一加 plaintext，覆盖日志页 / 消息气泡 / 会话标题 / titlebar 等所有内容容器；中文/英文/数字/emoji 混排各自方向正确，不再被反向重排。
- `code` / `pre` / `kbd` 强制 LTR（编程符号永不反向）。
- 测试：`i18n-ug-rtl.test.ts` 5 用例 + `bug-20260501-rtl-bidi-global.test.ts` 3 用例 regression。

### Apple HIG 5 维度全面对齐
- **border** 全部 ≤1.5px（spinner / drop-hint / avatar halo / 引用块 / sub-option 等多处从 2px 降到 1-1.5px；删除 `[dir=rtl] .hc-thinking__content border-right: 2px` 死代码）。
- **shadow** alpha ≤0.12（图片预览 / IM modal / About modal / popup / toggle thumb 等多处从 0.2-0.4 降到 spec `--shadow-lg/md/sm`）。
- **transition** 显式列属性（删除 `transition: all`）；`cubic-bezier(0.16, 1, 0.3, 1)` 缓动。
- **font** 移除 `Helvetica Neue` 兜底，纯 Apple 系字体链。
- **accent glow** alpha ≤0.18（按钮发光柔和）。

### 媒体下载 + 预览
- 图片/视频统一 `.hc-msg__media-download` 按钮，**一直可见 0.85 透明度**（不再 hover-only），hover 加深至 1.0 + scale 1.08。
- 使用 `inset-inline-end` 取代 `right`，RTL 安全定位。
- 视频新增 `.hc-msg__video-wrap` 包裹层，与图片相同的下载按钮交互。
- 图片点击触发全屏 lightbox 预览（HIG `--shadow-lg` 柔和阴影）。

### 后台生成 → 本地落盘 → URL 引用（架构验证）
- backend `handleImageGenGenerate` 落盘到 `{DataDir}/generated/`，回填 `file_path`。
- frontend `imageToSrc` 优先 `/api/v1/files/generated/{path}` URL（永不过期，DB 不撑爆），回退 Provider URL，最后才 base64。
- 视频同模式（`videoToSrc`）。

### Bug 修复
- **BUG-20260501 G2 闭环 `~` 路径未展开**：`cmd/hexclaw/main.go` skillDraftDir 计算把 `~/.hexclaw/skills/` 当字面路径传给 `os.MkdirAll` → `mkdir ~: read-only file system`。后端抽 `computeSkillDraftDir(skillsDir, home string) string` 函数显式展 `~`，单测覆盖（已合入后端 v0.4.0）。
- **BUG-20260501 RTL bidi 中文日志倒序**：维语界面下日志条目 emoji + 版本号被推到行末（如 `🦀 HexClaw v0.3.12 启动` 显示成 `启动 — 自研引擎 · ... 🦀 HexClaw v0.3.12`）。global.css 加全局兜底规则解决。

### Interactive 通用组件（v0.4.0 G3/E6 协议）
- 新增 `InteractiveButtons` / `Select` / `Approval` / `Card` / `Block` 5 组件 + 单测。
- 新协议 `message.interactive` 优先，旧路径 `metadata.interactive_buttons` fallback。

### ContextBar / 元数据 / capabilities
- `ContextBar.vue` 改为通过 `chat-request-metadata` store 渲染。
- 新增 `src/api/capabilities.ts` 模型能力探测客户端。
- 新增 `chat-request-metadata` store + 单测。

### 工程
- 版本号 0.3.12 → 0.4.0（package.json / tauri.conf.json / Cargo.toml / Cargo.lock / homebrew 同步）。
- `HEXCLAW_REF` 升至 `refs/tags/v0.4.0`，CI/release 工作流自动拉新后端 sidecar。
- 包含后端 v0.4.0 全部内容：Feature Flag / Skill Pipeline / 模型能力探测协议 / 事件传输 v1 / 模型网关 v1 / 工具生命周期 v2 / Hexagon engine 0.4.7。

### 测试
- 199 文件 / 3751 PASS / 3 todo / 0 fail。
- vue-tsc --build 0 errors / lint 0 errors / build-only 0 errors / Playwright api-chain + streaming-chain E2E 25 PASS。
- 11 种高级测试方法矩阵：govulncheck 0 漏洞 / gosec HIGH 17 全部已 mitigated / gitleaks 18 全部 false positive / `go test -race ./...` 0 race。

## v0.3.12 (2026-04-18)

### 新功能
- **图像/视频/语音生成三件套**：`ImageGenComposer` / `VideoGenComposer` / `VoiceChatComposer`，按模型能力自动切换输入框；生成结果持久化到会话。
- **原生保存对话框**：图像下载走 Tauri `dialog.save()` + Rust 命令写盘（`save_file_from_url` / `save_bytes_to_path`）。默认文件名 `HexClaw-yyyymmdd-hhmmss-XXXX.{ext}`，避免同名冲突。
- **生成模式模型切换**：选中图像/视频/语音模型后，右上角 text-only chip 可切回 chat 模型。

### Bug 修复
- **会话消息持久化 403**：`appendSessionMessage` / `appendSessionMessagesBatch` 把 `user_id` 放到 URL query（后端 `sessionUserIDFromRequest` 只读 query）。修复图像生成消息重启会话后不显示的根因。
- **`deleteMessage` 缺 `user_id`**：同上修复。
- **生成模式切不回 chat 模型**：新增 `hc-gen-modebar` 右上角 chip。
- **Ollama 预热 tag 匹配**：4 级 fallback（tag 精确 → base 去 tag → provider.selectedModelId → downloaded[0]）。

### UI / HIG
- 三件套 Composer padding 12→20、gap 8→14、字号 11→13–14、圆角 10/16、0.5px 边框、focus 0 0 0 3px 蓝光环，符合 Apple HIG。
- `hc-gen-modebar` 右对齐、无背景边框、text-only chip，hover 蓝色高亮。
- 左下角引擎标签改为 `Hexagon engine`。
- 图片生成水印、Composer 标题去掉重复模型名。

### 工程
- 版本号 0.3.9 → 0.3.12（package.json / tauri.conf.json / Cargo.toml / Cargo.lock 同步）。
- `HEXCLAW_REF` 升至 `refs/tags/v0.3.12`，CI 拉最新后端 sidecar。
- Tauri 新增 `dialog:allow-save` 权限、`base64 0.22` 依赖。
- `src/api/chat.ts` `sessionPost/Patch/Put` 包装器 + 结构性防护测试防止裸 `apiPost`。
- CI 修复：`beforeEach` 未使用、`imageToSrc` 未使用、`logger` 未导入。

### 测试
- 3720/3720 PASS（含新增 63 条错误路径测试：cron-errors / skills-errors / mcp-errors）。

## v0.3.9 (2026-04-17)

### Bug 修复
- **思考计时器精确到 reasoning 阶段**：新增 `reasoningEndTime` 字段，收到 content 且无 reasoning 时冻结计时。修复前计时一直跑到输出结束，把"输出时间"也算进"思考时长"。
- **复制代码按钮 Tauri 兼容 + 视觉反馈**：三层 fallback（Tauri 后端 API → `navigator.clipboard` → `execCommand`）。成功显示"✓ 已复制"1.5 秒。修复 Tauri WebView 下 `navigator.clipboard` 静默失败。
- **聊天输入框支持粘贴图片**：textarea 新增 `@paste` 事件处理，剪贴板图片自动附加为上传文件（含预览）。

### 测试
- 新增 `src/__tests__/bugfix-regression.test.ts`，17 例 before/after 对比全部通过。
- 适配既有测试对新增字段/函数的断言。

### 工程
- 版本号 0.3.8 → 0.3.9（package.json / tauri.conf.json / Cargo.toml 同步）。
