# Changelog

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
