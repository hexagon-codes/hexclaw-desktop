# Changelog

## Unreleased

暂无。

## v0.5.0 (2026-07-08)

### K12 场景包
- 新增内置 **作业辅导助手** 场景包：在智能体模板库中建档，采集孩子称呼、年级学期和教材版本，自动生成专属辅导老师 Agent 实例。
- 作业辅导实例默认绑定辅导技能：教学法、拍照识题、数学 / 语文 / 英语辅导、知识点讲解、变式出题，并把年级边界、批改和复习工具作为基础设施技能挂载。
- 聊天页按场景实例增强：辅导 / 错题本顶部 Tab、场景化空态、后端 descriptor 下发的 composer chips、家长备课卡右侧停靠面板，以及“作业辅导不等于独立 UI 模式”的通用 shell 接线。
- 智能体卡新增场景扩展：错题数、待复习数、进入辅导、直达错题本、打开备课卡和编辑孩子档案。
- 新增错题本 / 积累本 / 学情视图：错题状态机、到期复习队列、再练一道、他会了、错题卷打印 / PDF / Word 导出、薄弱知识点 TOP3、复习完成率、连续挫败提示和学习时长。
- 新增家庭学习档案备份 / 恢复：`.hexbak` 归档带版本头和 checksum，恢复路径按幂等合并预留。
- 新增事件驱动家长备课卡：按错题、学情和选定科目生成一页“怎么教”，每段显示课本 / 本地记录 / 程序验算 / AI 归纳等来源标注，支持打印和复制到手机 IM。

### 场景扩展架构
- 新增 `src/contracts/`：`InstanceViewDescriptor`、`RecordSchema`、`RecordItem`、`VerifyResult` 等前端契约，作为后端 JSON Schema codegen 前的手写兼容层。
- 新增 `src/shell/scenario/registry.ts`：场景包通过 descriptor resolver、record schema、chat enhancement、agent-card extension 和 template registration 注入，不修改通用 shell 领域语义。
- 新增通用消息装饰：`VerifyBadge` 和 `RecordChip` 只认契约数据，不内联 K12 领域词；聊天页从 `message.metadata.verify` / `solve_verdict` / `record` 渲染验证和入库状态。
- 新增通用记录视图接线，K12 错题本和积累本复用同一 `RecordSchema` / `RecordCollectionView` 原语。

### API 契约
- 新增 `/api/k12/*` 前端客户端类型：view descriptor、识题、批改、错题列表、复习队列、mark-mastered、review retry、备课卡、学习时长、学情报告、孩子档案、cold-start、积累本、备份恢复、导出、tutor-turn、IM 绑定和 cron provision。
- K12 API 隔离键统一为 `agent`，不依赖 `user_id`；多孩隔离按不可变 Agent 实例名完成。

### 聊天与渲染
- Markdown 渲染新增 KaTeX 数学公式和 mhchem 化学式支持，非法公式以正文色降级，不用红色错误样式；块级公式在消息气泡内横向滚动，不撑破页面。
- 场景实例会话自动置顶；当会话标题仍是内部 Agent ID 时，列表优先展示 Agent 的 `display_name`。
- 聊天页新增场景侧栏锚点、composer 上方锚点和页脚锚点，供场景包 Teleport 停靠面板、预设 chips 和扩展桥接内容。

### UI / 修复
- `HcSelect` 禁用态不再使用原生 `disabled` 按钮外观，避免 macOS WKWebView 下被 UA 样式撑成胶囊；MCP 新增服务器 transport 下拉改用 `HcSelect`。
- 侧边栏分组只有存在导航项时才渲染分割线和组标题，避免空组留下视觉噪声。
- 作业辅导相关多处 2026-07-08 现场问题补回归：建档弹窗 Teleport、备课卡停靠层级、错题本头部重复、composer chips 锚点、空态可操作科目选择、发送手机走真实剪贴板动作。

### 工程
- 桌面端版本升至 `0.5.0`（`package.json` / `src-tauri/tauri.conf.json` / `src-tauri/Cargo.toml` / lockfile）。
- 新增依赖 `@mdit/plugin-katex`、`katex`，并将 `markdown-it` 升至 `14.3.0`。
- 新增 K12、scenario shell、契约、Markdown KaTeX、HcSelect、SessionList、ChatView 和 WebKit 相关回归测试；新增浏览器现场 E2E 覆盖 K12 流程与 WebKit 下拉盒视觉问题。

## v0.4.5 (2026-06-23)

### 连接中心
- **连接（二分法）**：通道与账号 / 数据连接器。通道卡片流复用 IM 实例 + 邮箱（SMTP/IMAP 按域名自动配）；本地加密徽标、状态图例、「一处存处处引」说明。
- **数据连接器（GitHub / Notion）**：token 只读接入，真实测试连接 + 浏览资源（真列仓库 / 页面）；token 经后端加密落盘，前端不留明文。

### 自动化
- **工作流（线性画布）**：真实编辑器——新建 / 增删步骤 / 排序 / 编辑（角色 · 提示 · 模型 · 工具）/ 保存 / 试运行，运行结果与逐节点状态实时回填（后端图执行器 + 真实轮询）。
- **定时任务**：创建弹层新增「投递目标」选择器——通用渠道 + 从连接库下拉选已配置实例（按 id 引用）。

### 智能体
- **编辑人设（SOUL）**：默认助理「小蟹」人设编辑器，读写 `~/.hexclaw/SOUL.md`，纯文本编辑，支持恢复内置默认、引擎降级优雅处理。

### 设置 / 外观
- **系统设置页精简**：去掉与顶部 Tab 重复的「系统设置」大标题；外观分区直接呈现主题卡（移除「主题模式」小标题）；语言改为行内右侧下拉（简体中文）；「关于河蟹」文案带 🦀 图标。
- **左下角引擎状态**：显示 Hexagon 框架版本号；点击引擎名打开「关于」窗口。

### 能力 / 交互
- Prompt 库（一库三 type · `/` 召唤 · `$ARGUMENTS` 填参）；输入框拖拽 / 粘贴图片走 vision；首配向导、命令面板 ⌘K、引擎未连接全局降级 banner。
- 网格卡 hover 抬起统一动效；品牌令牌全量传导（浅色中性近白 + 蓝点缀 / 深色深海蓝）。
- 简中 / English / 维吾尔语（RTL）三语全覆盖。

### 本地模型（Ollama）
- 模型目录更新：视觉白名单补 `qwen3-vl`（保留 `qwen2.5-vl`）；编码位 `devstral` 替换为按可跑性分层的 GLM（精选 `glm4:9b`，旗舰云端不入本地目录）。

### 修复
- 左下角「Hexagon engine」版本号显示：改读 hexagon 框架版本（`engine_version`），发布构建显示真实版本而非 `(devel)` 占位。
- 日志详情面板 `trace_id` 标签与值重叠（不再复用表格列宽样式，独立 flex 样式）。
- 补 `common.saving` 三语键，避免英文 / 维语界面回退中文。

## v0.4.2 (2026-06-17)

### 页面结构与导航
- **导航 IA 重构**：Chat 独立置顶 + 构建/连接/系统三组分区。
- **页面结构重组**：新增 ModelManager 模态框，channels 组件化；模型目录与设置存储两层化。
- 修复左下角引擎版本号显示；任务运行历史与知识库刷新体验修复。

### 技能 / 知识库
- **技能详情只读查看 `SKILL.md`**，术语统一为「技能」。
- **知识库文档查看器渲染 markdown**；代码块渲染优化（折行 / 裸围栏轻装饰 / hover 复制）。

### Webhook / 会话
- Webhook 处理功能未启用状态 + 导航路由同步。
- 会话写接口契约统一与自动化进度链路加固。

### i18n
- 专业术语统一英文，智能体保留中文。

### 构建 / 发版
- pandoc / typst 改为 Tauri sidecar + 下载强校验，补 render 资产与 render-bundle 落盘；`render-bundle.sh` 兼容 Windows git-bash，修复 Windows 发版构建。
- 三平台版本号对齐 v0.4.2（`package.json` / `tauri.conf.json` / `Cargo.toml` + lock）。

## v0.4.1 (2026-06-03)

### 文档渲染
- **代码视图渲染下载** + 捆绑 pandoc / typst 渲染链。

### 定时任务
- **cron 定时任务统一架构** + 端到端 SSE 流式编译。

### 发版
- bump v0.4.0 → v0.4.1（含 sidecar ref 与 Homebrew 修复）。

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
