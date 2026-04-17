# Changelog

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
