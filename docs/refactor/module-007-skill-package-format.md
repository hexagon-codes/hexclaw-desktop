# Module 007: Skill Package Format v0.1

> 日期：2026-05-15
> Priority：P2（005/006 完成后推进）
> Risk：中（涉及 SkillLoader + SkillRegistry 接口变更）

---

## 0. 现有系统基线

Module 007 不是从零开始。项目已有完整的 Skill 管理和市场基础设施：

### 已实现

| 能力 | 位置 | 状态 |
|------|------|------|
| ClawHub 技能市场 UI | `SkillsView.vue` (hub tab) | ✅ 前端完成 |
| 市场搜索 + 分类筛选 | `searchClawHub()` | ✅ 前端完成，后端待确认 |
| 三种安装方式 | `installSkill(source, type)` | ✅ 前端完成 |
| 本地文件安装 | `type: 'file'` → 选择 .md 文件 | ✅ 可用 |
| URL 安装 | `type: 'url'` → HTTPS URL | ✅ 前端可用 |
| ClawHub 一键安装 | `type: 'clawhub'` → `clawhub://skillName` | ✅ 前端可用 |
| 拖拽安装 | Tauri 原生拖拽 → .md 文件 | ✅ 可用 |
| 启用/禁用开关 | `setSkillEnabled()` | ✅ 前后端联调 |
| 卸载 | `uninstallSkill()` | ✅ 前后端联调 |
| 安装后引擎重启 | `restartSidecar()` | ✅ 可用 |
| 18 个 Mock Skill | `skills-marketplace.ts` | ✅ 降级可用 |

### 现有安装 API

```
GET    /api/v1/skills              → 已安装列表
POST   /api/v1/skills/install      → 安装（source + type）
PUT    /api/v1/skills/{name}/status → 启用/禁用
DELETE /api/v1/skills/{name}       → 卸载
GET    /api/v1/clawhub/search      → 市场搜索
```

### 现有 Skill 结构

当前 Skill **只有 SKILL.md，没有 skill.json**：

```
skills/summarize/
├── SKILL.md            ← 唯一必须文件
└── references/         ← 可选参考资料
    ├── example-input.md
    └── example-output.md
```

SkillRegistry 通过扫描 `skills/{skillId}/skill.json` 发现 Skill。**矛盾**：现有 Skill 没有 skill.json，但 Registry 期望它存在。

### 真正的缺口

| 缺口 | 说明 |
|------|------|
| Go Backend API 未实现 | `/api/v1/skills/install` 等端点需要 Go 侧实现 |
| GitHub URL 自动识别 | `url` 安装方式是否支持 `github.com/...` 自动转 raw URL |
| skill.json 缺失 | 现有 Skill 没有 skill.json，Registry 如何发现它们 |
| 无版本管理 | 安装后无法检查更新 |
| 无 skill.json schema | 没有标准格式定义 |

---

## 1. 问题陈述

基于现有系统，Module 007 需要解决的问题：

| 问题 | 现有系统状态 | 需要做什么 |
|------|------------|-----------|
| SkillLoader 只读 SKILL.md | ✅ 现状 | 扩展支持多层加载 |
| 无脚本执行机制 | ✅ 现状 | 新增 SkillExecutor |
| skill.json 缺失 | ⚠️ Registry 期望但 Skill 没有 | 定义 schema + 自动生成/兼容 |
| 外部导入 | ✅ 前端已有 file/url/clawhub | 修复后端 + GitHub URL 支持 |
| 渐进式披露 | ❌ 无 | 新增 layers 机制 |
| 版本管理 | ❌ 无 | 新增版本检查 |

核心矛盾：**Skill = 体验包 的定位，与当前 "只有 SKILL.md" 的实现不匹配。**

---

## 2. 目标

### Must Have

- [ ] 定义 skill.json schema（标准格式）
- [ ] 现有 Skill 兼容：无 skill.json 时自动生成或等效处理
- [ ] skill.json 支持声明多层内容（layers）
- [ ] SkillLoader 支持按触发条件加载指定层
- [ ] 修复 Go Backend Skill install API

### Should Have

- [ ] GitHub URL 自动识别（`github.com/user/repo` → raw URL）
- [ ] skill.json 支持声明脚本入口（scripts）
- [ ] SkillExecutor 安全沙箱执行脚本
- [ ] 已安装 Skill 版本检查（市场有新版时提示）

### Could Have

- [ ] Skill 依赖声明（depends on other skills）
- [ ] 社区 Skill 评分/评论
- [ ] Skill 开发者发布工具链

---

## 3. 设计

### 3.1 skill.json Schema（HexClaw Skill Constitution v1）

```jsonc
{
  // ── Schema 版本（必须，用于演进控制） ──
  "schema_version": "1.0",          // 必须：Schema 自身版本，与 Skill 版本独立

  // ── 基础信息 ──
  "name": "summarize",              // 必须：lowercase, no special chars
  "display_name": "Summarize",     // 可选：UI 显示名
  "version": "0.2.0",              // 必须：semver（Skill 自身版本）
  "description": "将文本总结为要点列表",
  "author": "hexclaw",
  "license": "MIT",
  "tags": ["summarize", "text"],

  // ── 入口 ──
  "entry": "SKILL.md",             // 必须：基础指令文件

  // ── Runtime 兼容性（可选） ──
  "runtime": {
    "min_version": "0.4.0",        // 最低 Runtime 版本
    "engine": ["hexclaw-runtime-v1"], // 支持的 Runtime 引擎
    "platform": ["desktop"]        // 支持的平台
  },

  // ── 层级声明（stable） ──
  "layers": [
    { "id": "base", "file": "SKILL.md", "trigger": "always" },
    { "id": "advanced", "file": "layers/advanced.md", "trigger": "user-deep-dive" }
  ],

  // ── 触发词（stable） ──
  "triggers": ["总结", "摘要", "summarize", "summary"],

  // ── 能力声明（stable） ──
  "capabilities": ["text-processing"],

  // ── 命令声明（stable，Claude Code 兼容已验证） ──
  "commands": [
    { "name": "summarize", "file": "commands/summarize.md", "description": "执行总结" }
  ],

  // ── 依赖声明（stable） ──
  "dependencies": {
    "skills": [],                   // 依赖的其他 Skill
    "runtime": [],                  // 依赖的 Runtime 特性
    "tools": []                     // 依赖的工具适配器
  },

  // ── 信任元数据（stable） ──
  "_trust": {
    "source": "clawhub",            // 来源：clawhub | github | local | claude-code
    "verified": false,              // 是否经过验证
    "risk": "low"                   // 风险等级：low | medium | high
  },

  // ── 实验性扩展（experimental，不承诺兼容） ──
  "experimental": {
    "scripts": {                    // 脚本执行（沙箱未实现）
      "validate": { "file": "scripts/validate.ts", "sandbox": "restricted" }
    },
    "hooks": [],                    // 生命周期钩子（运行时未实现）
    "agents": [],                   // 子代理配置（委托系统未实现）
    "interaction": {                // 交互声明（Task Runtime UI Projection）
      "actions": [
        { "id": "regenerate", "label": "重新生图", "intent": "image.regenerate" },
        { "id": "upload", "label": "一键上传", "intent": "ecommerce.upload" }
      ]
    }
  }
}
```

> **交互按钮的阶段归属**：
> `experimental.interaction.actions` 只做 **declarative hint**（告诉 Runtime 这个 Skill 支持哪些交互）。
> 真正的按钮渲染、状态同步、Task Resume、Asset Binding 属于 **Chat Workspace Runtime**，不属于 Module 007。
>
> | 功能 | 所属 Module | 说明 |
> |------|------------|------|
> | 按钮声明（`actions` 字段） | Module 007（experimental 预留） | 只做 declarative hint |
> | Task Result 渲染按钮 | Module 003（Result Surface） | 已在 P1 计划中 |
> | Intent Dispatcher | 后续 Module | 需要新建 Intent Runtime |
> | Task Resume / 参数修改 | 后续 Module | 依赖 Task Context 完善 |
> | Asset binding + upload flow | 后续 Module | 依赖 Workspace Asset 系统 |

### 3.2 向后兼容策略

**现有 Skill 没有 skill.json 怎么办？**

```
SkillRegistry 扫描 skills/{id}/
  ├─ skill.json 存在 → 读取完整元数据
  └─ skill.json 不存在 → 自动生成等效元数据：
       name = 目录名
       entry = SKILL.md
       version = "0.0.0"
       layers = [{ id: "base", file: "SKILL.md", trigger: "always" }]
```

这样现有 summarize/bulletize **不需要任何修改**就能继续工作。

### 3.3 标准目录结构（含 Claude Code 兼容）

```
skills/{skill-id}/
├── skill.json              ← 推荐但不强制（缺失时自动生成）
├── SKILL.md                ← 必须：基础指令
├── layers/                 ← 可选：进阶层
│   ├── advanced.md
│   └── reference.md
├── scripts/                ← 可选：可执行脚本
│   └── validate.ts
├── references/             ← 可选：静态参考资料
│   └── examples.md
├── assets/                 ← 可选：静态资源
│   └── template.txt
├── commands/               ← 可选：斜杠命令定义（Claude Code 兼容）
│   └── do-more.md
├── agents/                 ← 可选：子代理配置（Claude Code 兼容）
│   └── analyzer.md
└── hooks/                  ← 可选：自动化钩子（Claude Code 兼容）
    └── pre-commit.sh
```

> **Claude Code 技能目录映射**：
> 当导入 Claude Code 格式的 `.claude/skills/{name}/` 时，自动将内容映射到上述结构：
> - `.claude/skills/{name}/SKILL.md` → `skills/{name}/SKILL.md`
> - `.claude/commands/{cmd}.md` → `skills/{name}/commands/{cmd}.md`（按命令归属映射）
> - `.claude/agents/{agent}.md` → `skills/{name}/agents/{agent}.md`（按代理归属映射）
> - `.claude/hooks/{hook}.sh` → `skills/{name}/hooks/{hook}.sh`（按钩子归属映射）

### 3.4 层级触发条件

| trigger | 行为 | 场景 |
|---------|------|------|
| `always` | 注入 RuntimeContext | 所有 Skill 执行 |
| `user-deep-dive` | 用户追问细节时注入 | 用户说"详细说说" |
| `explicit` | 用户主动请求时注入 | 用户说"查看完整文档" |
| `on-error` | 执行出错时注入 | 自动注入错误处理指引 |
| `on-continue` | 续接执行时注入 | 用户说"继续" |

### 3.5 外部 Skill 导入（基于现有系统修复）

#### 现有三种方式 → 需要修复的点

| 方式 | 前端状态 | 后端状态 | 需要修复 |
|------|---------|---------|---------|
| `file` | ✅ 可用 | ❓ 待确认 | 后端安装逻辑 |
| `url` | ✅ 可用 | ❓ 待确认 | GitHub URL 自动识别 |
| `clawhub` | ✅ 可用 | ❓ 待确认 | 后端市场搜索 API |

#### GitHub URL 自动识别

```
输入：https://github.com/user/repo/blob/main/skills/my-skill/SKILL.md
  → 自动转为 raw URL：https://raw.githubusercontent.com/user/repo/main/skills/my-skill/SKILL.md
  → 下载到 skills/my-skill/SKILL.md

输入：https://github.com/user/repo/tree/main/skills/my-skill/
  → 识别为目录，逐文件下载
```

#### 导入校验（复用现有逻辑）

```
1. 目标目录 skills/{name}/ 创建
2. SKILL.md 存在？
3. skill.json 存在？不存在则自动生成
4. 无命名冲突（Official > Custom）
5. 注册到 SkillRegistry
6. 引擎重启（复用 restartSidecar）
```

### 3.6 接口变更

#### SkillLoader（修改）

```typescript
// 现有
loadSkill(skillId: string): Promise<string>

// 新增
loadSkillLayer(skillId: string, layerId: string): Promise<string>
loadSkillByTrigger(skillId: string, trigger: string): Promise<string>
loadAllLayers(skillId: string): Promise<SkillLayer[]>
```

#### SkillRegistry（修改）

```typescript
// 现有
resolveSkill(skillId: string): Promise<SkillMeta | undefined>

// 修改：无 skill.json 时自动生成元数据
// 新增
resolveSkillWithLayers(skillId: string): Promise<SkillPackageMeta | undefined>
```

#### 新增类型

```typescript
// ── Schema 版本 ──
const SCHEMA_VERSION = '1.0'

// ── 层级声明（stable） ──
interface SkillLayer {
  id: string
  file: string
  trigger: string
  description?: string
  content?: string  // 加载后填充
}

// ── 命令声明（stable，Claude Code 兼容） ──
interface SkillCommand {
  name: string
  file: string
  description?: string
  args?: Record<string, { type: string; required?: boolean; description?: string }>
}

// ── 依赖声明（stable） ──
interface SkillDependencies {
  skills?: string[]      // 依赖的其他 Skill
  runtime?: string[]     // 依赖的 Runtime 特性（如 hexclaw-runtime-v1）
  tools?: string[]       // 依赖的工具适配器（如 browser, filesystem）
}

// ── 信任元数据（stable） ──
interface SkillTrust {
  source: 'clawhub' | 'github' | 'local' | 'claude-code'
  verified: boolean
  risk: 'low' | 'medium' | 'high'
}

// ── 交互声明（experimental → Chat Workspace Runtime 消费） ──
interface SkillAction {
  id: string
  label: string
  intent: string          // Task Intent 标识（如 image.regenerate）
}

// ── 实验性扩展（experimental，不承诺兼容） ──
interface SkillExperimental {
  scripts?: Record<string, { file: string; sandbox: string }>
  hooks?: SkillHook[]
  agents?: SkillAgent[]
  interaction?: {
    actions?: SkillAction[]
  }
}

// ── 实验性子类型 ──
interface SkillAgent {
  name: string
  file: string
  description?: string
  model?: string
  tools?: string[]
}

interface SkillHook {
  name: string
  file: string
  event: 'pre-task' | 'post-task' | 'pre-invoke' | 'post-invoke'
}

// ── 完整 Skill Package 元数据 ──
interface SkillPackageMeta extends SkillMeta {
  schema_version: string            // Schema 版本（与 Skill 版本独立）
  runtime?: {
    min_version?: string
    engine?: string[]
    platform?: string[]
  }
  layers: SkillLayer[]
  commands?: SkillCommand[]
  dependencies?: SkillDependencies
  _trust?: SkillTrust
  experimental?: SkillExperimental
  // 继承字段
  author?: string
  license?: string
  tags?: string[]
  _source?: 'hexclaw' | 'claude-code' | 'mixed'
}
```

### 3.7 Claude Code Skill 格式兼容层

#### 为什么需要兼容

Claude Code 生态已有成熟的 Skill 格式（`.claude/skills/`、`.claude/commands/`、`.claude/agents/`、`.claude/hooks/`）。社区已积累大量可复用的 Skill（如数据分析、代码审查、测试生成等）。HexClaw 如果能直接导入这些 Skill，将大幅降低用户获取高质量 Skill 的门槛。

#### Claude Code Skill 结构分析

以 `liangdabiao/claude-data-analysis-ultra` 为例：

```
.claude/
├── skills/                    ← 技能目录
│   ├── excel-analysis/
│   │   └── SKILL.md           ← 指令文件（HexClaw 可直接读取）
│   ├── sql-analysis/
│   │   └── SKILL.md
│   └── ... (12 个分析技能)
├── commands/                  ← 斜杠命令
│   ├── do-more.md             ← /do-more 命令定义
│   ├── do-all.md              ← /do-all 命令定义
│   └── analyze.md             ← /analyze 命令定义
├── agents/                    ← 子代理配置
│   ├── analyzer.md            ← 分析代理
│   └── executor.md            ← 执行代理
└── hooks/                     ← 自动化钩子
    └── pre-commit.sh          ← 提交前钩子
```

**关键发现**：
- `SKILL.md`：纯指令文本，HexClaw 的 SkillLoader 已可直接读取
- `commands/*.md`：定义斜杠命令的触发词和参数，需要映射到 HexClaw 的命令系统
- `agents/*.md`：定义子代理的角色和工具，需要映射到 HexClaw 的委托系统
- `hooks/*.sh`：自动化脚本，需要映射到 HexClaw 的钩子系统

#### 格式检测与映射逻辑

```typescript
interface ClaudeCodeSkillManifest {
  skillsDir?: string       // .claude/skills/
  commandsDir?: string     // .claude/commands/
  agentsDir?: string       // .claude/agents/
  hooksDir?: string        // .claude/hooks/
}

function detectClaudeCodeFormat(path: string): ClaudeCodeSkillManifest | null {
  const manifest: ClaudeCodeSkillManifest = {}

  // 检测 .claude/skills/ 目录
  if (existsSync(join(path, '.claude', 'skills'))) {
    manifest.skillsDir = join(path, '.claude', 'skills')
  }

  // 检测其他组件目录
  if (existsSync(join(path, '.claude', 'commands'))) {
    manifest.commandsDir = join(path, '.claude', 'commands')
  }
  if (existsSync(join(path, '.claude', 'agents'))) {
    manifest.agentsDir = join(path, '.claude', 'agents')
  }
  if (existsSync(join(path, '.claude', 'hooks'))) {
    manifest.hooksDir = join(path, '.claude', 'hooks')
  }

  // 至少要有 skills 目录才认为是 Claude Code 格式
  return manifest.skillsDir ? manifest : null
}
```

#### 导入映射规则

| Claude Code 组件 | HexClaw 映射 | 说明 |
|-----------------|-------------|------|
| `.claude/skills/{name}/SKILL.md` | `skills/{name}/SKILL.md` | 直接复制，指令兼容 |
| `.claude/commands/{cmd}.md` | `skills/{name}/commands/{cmd}.md` | 按 Skill 归属映射 |
| `.claude/agents/{agent}.md` | `skills/{name}/agents/{agent}.md` | 按 Skill 归属映射 |
| `.claude/hooks/{hook}.sh` | `skills/{name}/hooks/{hook}.sh` | 按 Skill 归属映射 |

**归属判定规则**：
1. 如果命令/代理/钩子的文件名包含 Skill 名称（如 `excel-analyze.md`），归属到对应 Skill
2. 如果无法判定归属，放入第一个 Skill 的目录（单 Skill 导入时）或创建 `skills/_shared/` 目录（多 Skill 导入时）
3. 命令定义中的 `@skill` 引用用于辅助判定

#### skill.json 自动生成（Claude Code 格式）

当检测到 Claude Code 格式时，自动生成 skill.json：

```typescript
function generateFromClaudeCode(manifest: ClaudeCodeSkillManifest, skillName: string): SkillPackageMeta {
  const commands = manifest.commandsDir
    ? readdirSync(manifest.commandsDir)
        .filter(f => f.endsWith('.md'))
        .map(f => ({
          name: f.replace('.md', ''),
          file: `commands/${f}`,
          description: extractFirstLine(join(manifest.commandsDir, f))
        }))
    : []

  const agents = manifest.agentsDir
    ? readdirSync(manifest.agentsDir)
        .filter(f => f.endsWith('.md'))
        .map(f => ({
          name: f.replace('.md', ''),
          file: `agents/${f}`,
          description: extractFirstLine(join(manifest.agentsDir, f))
        }))
    : []

  const hooks = manifest.hooksDir
    ? readdirSync(manifest.hooksDir)
        .filter(f => f.endsWith('.sh') || f.endsWith('.js'))
        .map(f => ({
          name: f.replace(/\.(sh|js)$/, ''),
          file: `hooks/${f}`,
          event: guessHookEvent(f)  // 从文件名推测事件类型
        }))
    : []

  return {
    name: skillName,
    version: '0.0.0',  // Claude Code 格式无版本信息
    entry: 'SKILL.md',
    layers: [{ id: 'base', file: 'SKILL.md', trigger: 'always' }],
    commands,
    agents,
    hooks,
    _source: 'claude-code'  // 标记来源
  }
}
```

#### 运行时兼容

| Claude Code 概念 | HexClaw 运行时映射 |
|-----------------|------------------|
| `/command` 触发 | `SkillBridge.invokeCommand()` → 解析命令定义 → 加载对应 SKILL.md |
| `@agent` 调用 | `SkillBridge.invokeAgent()` → 读取代理配置 → 委托给对应引擎 |
| `hook` 触发 | `SkillBridge.onEvent()` → 执行钩子脚本（沙箱内） |
| `SKILL.md` 指令 | 直接注入 RuntimeContext（现有流程） |

#### 兼容边界

| 支持 | 不支持（需要适配层） |
|------|-------------------|
| ✅ SKILL.md 直接读取 | ⚠️ commands/*.md → 需要解析并注册到命令系统 |
| ✅ 目录结构映射 | ⚠️ agents/*.md → 需要解析并注册到委托系统 |
| ✅ skill.json 自动生成 | ⚠️ hooks/*.sh → 需要沙箱执行环境 |
| ✅ 基础指令注入 | ❌ Claude Code 特有的工具调用语法（需重写） |

#### 风险与缓解

| 风险 | 缓解 |
|------|------|
| Claude Code 的 SKILL.md 使用了 HexClaw 不支持的语法 | Phase 1 只做结构兼容，语法适配在 Phase 4 沙箱执行时处理 |
| 命令/代理定义格式不兼容 | 生成时做格式校验，不兼容的标记为 `unsupported` |
| 钩子脚本依赖 Claude Code 运行时 | 沙箱执行，隔离环境变量和文件系统访问 |

### 3.8 HexClaw Skill Constitution v1（基础契约）

#### Skill Declaration Contract（声明契约）

**skill.json 负责**：
- 元数据声明（name, version, author, license, tags）
- 层级声明（layers）
- 命令声明（commands）
- 依赖声明（dependencies）
- 信任标记（_trust）
- 实验性扩展声明（experimental）

**skill.json 不负责**：
- 执行策略（sync/async/detached 是 Runtime 决定的）
- 权限 enforcement（委托给 Capability Gate）
- 沙箱配置（委托给 SkillExecutor）
- 调度逻辑（委托给 Task Runtime）
- UI 渲染（委托给 Chat Workspace）

#### Runtime Capability Boundary（能力边界）

```text
Skill 声明能力    → Capability Gate 决定是否放行
Skill 声明依赖    → Runtime 检查是否满足
Skill 声明实验特性 → Runtime 可选择忽略
Skill 声明交互    → Chat Workspace 决定如何渲染
```

核心原则：**声明层与执行层分离**。

#### Compatibility Philosophy（兼容哲学）

1. **向后兼容优先**：新 Runtime 必须能运行旧 Skill
2. **Runtime MAY ignore unsupported fields**：未知字段 `ignore + warn`，不报错不中断
3. **experimental 不承诺兼容**：可随时修改结构，不做向后兼容保证
4. **`_` 前缀字段忽略**：`_source`、`_trust` 等不影响核心解析
5. **Stable 严格校验**：`layers`、`triggers`、`commands`、`dependencies` 必须符合 schema
6. **Experimental 允许 unknown**：`experimental` 命名空间内允许未知字段

#### Schema Evolution Strategy（演进策略）

```text
schema_version: "1.0"
  ↓
新增 stable 字段 → 新 minor 版本（1.1）
  ↓
废弃字段 → 标记 deprecated，保留 2 个 major 版本
  ↓
experimental → stable → 迁移路径明确后发布
```

---

## 4. 实施计划

### Phase 1: skill.json Schema + 兼容（不改 Loader）

- TypeScript 类型定义（SkillLayer, SkillPackageMeta, SkillCommand, SkillDependencies, SkillTrust, SkillExperimental）
- `skill.schema.json`（machine-readable contract）
- SkillRegistry 自动补全逻辑（无 skill.json 时生成）
- 现有 Skill 回归测试
- 验证：`schema_version: "1.0"` 解析正确

### Phase 2: SkillLoader 多层加载

- 新增 `loadSkillLayer()` / `loadSkillByTrigger()`
- SkillBridge 注入时支持按 trigger 选层
- 渐进式披露 MVP

### Phase 3: Go Backend API 修复

- `/api/v1/skills/install` 实现
- `/api/v1/clawhub/search` 接通
- GitHub URL 自动识别

### Phase 4: 脚本执行 + 沙箱

- SkillExecutor 安全沙箱
- experimental.scripts 字段解析和执行

### Phase 5: Claude Code 格式兼容（拆分为 5A-5D）

**Phase 5A：结构导入（依赖 Phase 1）** — Module 007 范围内

- 格式检测：`detectClaudeCodeFormat()` 实现
- 导入映射：`.claude/` → `skills/` 目录转换逻辑
- skill.json 自动生成：`generateFromClaudeCode()` 实现
- manifest.json 归属声明解析（优先于文件名推断）
- 验证：导入 `claude-data-analysis-ultra` 生成正确的 skill.json

**Phase 5B：command 运行时兼容（依赖 Phase 2 + SkillBridge）** — 后续 Module

- 解析 `commands/*.md` 并注册到 SkillBridge
- `/command` 触发路由

**Phase 5C：hook 运行时兼容（依赖 Phase 4 + Event System）** — 后续 Module

- 解析 `hooks/*.sh` 并注册到事件系统
- Hook lifecycle contract

**Phase 5D：agent 委托兼容（依赖 Delegation Runtime）** — 后续 Module

- 解析 `agents/*.md` 并注册到委托系统

### 开发期间禁止项

| 禁止 | 原因 |
|------|------|
| ❌ 新增 stable 顶层字段 | Schema Stabilization Window |
| ❌ 新增 runtime behavior | hooks/scheduler/orchestration/delegation |
| ❌ 扩大 commands scope | 保持 routing abstraction，不演化成 workflow engine |

---

## 5. 验收标准

- [ ] `schema_version: "1.0"` 定义完成，TypeScript 类型通过
- [ ] `skill.schema.json` 生成，machine-readable contract 可用
- [ ] 现有 Skill（summarize, bulletize）无 skill.json 也能正常工作
- [ ] SkillLoader 新增 `loadSkillLayer()` 方法
- [ ] 新建一个带 `layers` 的测试 Skill，验证分层加载
- [ ] `runtime` 兼容性字段解析正确
- [ ] `dependencies` 三类型声明解析正确
- [ ] `_trust` 元数据导入时自动生成
- [ ] `experimental` 命名空间 unknown 字段 `ignore + warn`
- [ ] Go Backend Skill install API 可用
- [ ] GitHub URL 安装可用
- [ ] Claude Code 5A 结构导入：`detectClaudeCodeFormat()` + `generateFromClaudeCode()` 可用
- [ ] Claude Code 导入：导入 `claude-data-analysis-ultra` 生成正确的 skill.json
- [ ] tsc 编译通过，无类型错误

---

## 6. 影响范围

| 文件 | 变更类型 |
|------|---------|
| `src/types/skill.ts` | 新增 SkillLayer, SkillPackageMeta, SkillCommand, SkillDependencies, SkillTrust, SkillExperimental 类型 |
| `src/schemas/skill.schema.json` | 新增：machine-readable JSON Schema contract |
| `src/services/skillRegistry.ts` | 自动补全 + resolveSkillWithLayers + Claude Code 格式检测 |
| `src/services/skillLoader.ts` | 新增多层加载方法 |
| `src/services/skillBridge.ts` | 注入时支持按 trigger 选层 |
| `src/services/claudeCodeImporter.ts` | 新增：Claude Code 格式导入映射逻辑 |
| `src/api/skills.ts` | 可能微调（后端 API 对齐） |
| Go Backend | Skill install/search API 实现 |

---

## 7. 依赖关系

```
Module 005 (Runtime LLM Contract) ✅
Module 006 (execMode Convergence) → 执行中
  ↓
Module 007 (Skill Package Format) ← 当前规划
  ↓
Module 008: Skill NL Trigger（自然语言触发）
  依赖 007 的 layers + triggers 机制
```

---

## 8. 风险

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| 现有 Skill 兼容性破坏 | 低 | 高 | 自动生成策略 + 回归测试 |
| Go Backend 工作量超预期 | 中 | 中 | Phase 3 单独排期，不阻塞 Phase 1/2 |
| 沙箱执行安全性 | 中 | 高 | Phase 4 再实现，先做静态层 |
| 过度设计 | 中 | 中 | Must Have 先行，Should/Could 后补 |
| Claude Code 格式解析复杂度 | 中 | 中 | Phase 5A 先做结构兼容，语法适配后续迭代 |
| Claude Code 特有语法不兼容 | 高 | 低 | 生成时标记 `unsupported`，用户可手动调整 |
| Schema Pre-runtime（schema 反向绑定 runtime） | 中 | 高 | experimental 命名空间隔离，不承诺兼容 |
| Skill Supply Chain（恶意 Skill / prompt injection） | 中 | 高 | `_trust.risk` 标记 + 安装时确认对话框 |
| Phase 5 名义完成但不可运行 | 中 | 中 | 5A-5D 明确拆分，5A 只做结构导入 |
