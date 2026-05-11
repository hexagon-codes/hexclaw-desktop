# Agent OS Runtime Blueprint v0.1 (P0)

> 面向：
> 极简 Agent Runtime
> Runtime-first Architecture
> Chat-first Workspace
> Skill-based Agent System

---

# 一、设计目标

当前阶段：

不是做：

- Marketplace
- Workflow 平台
- 企业治理系统
- 多租户 SaaS

而是：

# 验证：

“Skill Runtime 是否真的能让 Agent 更像会工作的系统”

---

# 二、P0 核心原则

## 1. Chat-first

聊天是入口。

不是节点编排。

---

## 2. Task-first

系统核心是：

任务（Task）

不是：

聊天记录。

---

## 3. Skill = Experience Package

Skill 不是插件。

不是节点。

不是 Workflow。

Skill 是：

“经验包”。

---

## 4. Runtime-first

真正核心：

不是 Prompt。

而是：

Runtime。

---

## 5. Progressive Loading

只加载：

当前真正需要的：

- Skill
- Context
- Capability

---

# 三、Agent OS 总架构图（文字版）

```txt
┌─────────────────────┐
│        User         │
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│   Chat Workspace    │
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│    Task Runtime     │
│  Task Create/State  │
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│ Coordinator Agent   │
│ Task Planning        │
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│    Skill Runtime    │
│ Match / Load Skill  │
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│ Capability Runtime  │
│ Dispatch Capability │
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│      Sandbox        │
│ Capability Boundary │
└─────────┬───────────┘
          │
 ┌────────┼─────────┐
 ▼        ▼         ▼
LLM   Image Gen   Filesystem
```

---

# 四、Deployment Architecture（部署架构）

系统采用：

# Local-first Runtime
+
# Cloud Control Plane

架构。

---

# Cloud Control Plane（云控制平面）

公司云端：

只负责：

- 登录
- License
- 激活码
- Skill Registry
- Skill 更新
- API Gateway（可选）
- Analytics（轻量）

注意：

云端：

不负责：

- Runtime
- Context
- Memory
- Browser
- 用户资产

---

# Local Runtime Plane（本地运行平面）

用户本地 EXE：

负责：

- Task Runtime
- Skill Runtime
- Context Runtime
- Memory
- Asset Workspace
- Browser Runtime

所有：

敏感 Runtime 数据：

默认保留在用户本地。

---

# Deployment Architecture Diagram

```txt
Cloud Control Plane
├── Login
├── License
├── Skill Registry
├── Skill Update
└── API Gateway

            ↓

Local Runtime Plane
├── Chat Workspace
├── Task Runtime
├── Skill Runtime
├── Context Runtime
├── Memory
├── Asset Workspace
└── Browser Runtime
```

# 五、Skill Runtime 架构图（文字版）

```txt
skills/
  ecommerce-image/
    skill.json
    SKILL.md

┌────────────────────┐
│   Skill Registry   │
└─────────┬──────────┘
          │
          ▼
┌────────────────────┐
│    Skill Match     │
│ Intent Recognition │
└─────────┬──────────┘
          │
          ▼
┌────────────────────┐
│     Skill Load     │
│ Progressive Load   │
└─────────┬──────────┘
          │
          ▼
┌────────────────────┐
│      SKILL.md      │
│ Workflow / Rules   │
└─────────┬──────────┘
          │
          ▼
┌────────────────────┐
│ Capability Request │
└────────────────────┘
```

---

# 六、Skill Package 标准（P0）

## skill.json

```json
{
  "name": "ecommerce-image",
  "display_name": "电商生图",
  "version": "0.1.0",
  "description": "生成电商营销图片",
  "capabilities": [
    "llm",
    "image_generation"
  ],
  "entry": "SKILL.md"
}
```

---

## SKILL.md

```md
# 电商生图 Skill

## Description

当用户需要生成：
- 电商主图
- 营销图
- 平台适配图

时使用。

---

## Workflow

1. 分析商品
2. 分析平台
3. 生成提示词
4. 生成图片

---

## Rules

- Amazon 主图禁止过度场景化
- 小红书封面必须预留标题区域

---

## Gotchas

- 不要直接复刻爆款
```

---

# 七、Task Runtime 流程图（文字版）

```txt
用户输入
    │
    ▼
Task Create
    │
    ▼
Intent Analysis
    │
    ▼
Skill Match
    │
    ▼
Context Build
    │
    ▼
Capability Plan
    │
    ▼
Agent Execute
    │
    ▼
Timeline Update
    │
    ▼
Result Output
```

---

# 八、Context Layer 图（文字版）

```txt
┌────────────────────┐
│    System Layer    │
│ Runtime Rules      │
└────────────────────┘

┌────────────────────┐
│     Skill Layer    │
│ Current Skill      │
└────────────────────┘

┌────────────────────┐
│      Task Layer    │
│ Current Task       │
└────────────────────┘

┌────────────────────┐
│ Capability Layer   │
│ Active Capability  │
└────────────────────┘

┌────────────────────┐
│  Execution Layer   │
│ Tool Result        │
└────────────────────┘

┌────────────────────┐
│    Memory Layer    │
│ Task Memory        │
└────────────────────┘
```

---

# 九、Capability Sandbox 图（文字版）

```txt
Skill
  │
  ▼
Capability API
  │
  ▼
Runtime Policy
  │
  ▼
Sandbox
  │
  ├── filesystem.read
  ├── image_generation
  └── llm
```

---

# 十、Workspace 结构图（文字版）

```txt
┌──────────────────────────┐
│      Chat Workspace      │
└──────────────────────────┘

┌──────────────────────────┐
│        Task Tree         │
└──────────────────────────┘

┌──────────────────────────┐
│     Runtime Timeline     │
└──────────────────────────┘

┌──────────────────────────┐
│      Asset Workspace     │
└──────────────────────────┘

┌──────────────────────────┐
│     Capability Status    │
└──────────────────────────┘
```

---

# 十、Runtime Timeline

Runtime Timeline：

用于：

展示 Agent Runtime 的执行过程。

---

# Timeline 示例

```txt
09:41
Task Created

09:41
Skill Matched:
ecommerce-image

09:42
Capability Activated:
image_generation

09:43
Generating Prompt

09:44
Generating Image

09:45
Waiting User Confirmation
```

---

# Runtime Timeline 作用

用于：

- Runtime Observability
- Task Debugging
- 用户确认
- Agent 可解释性

---

# Timeline 不属于聊天记录。

而属于：

# Runtime Execution History

# 十一、Asset Workspace

Asset Workspace：

用于：

管理：

- 图片
- 视频
- 文件
- SKU 资产
- 任务生成结果

---

# Asset 特性

## 1. 本地优先

所有资产：

默认保留本地。

---

## 2. Task Binding

资产：

自动绑定：

当前 Task。

---

## 3. Skill-aware

Skill：

可读取：

当前任务相关资产。

---

# Asset 示例

```txt
assets/
├── sku_001/
│   ├── raw/
│   ├── generated/
│   └── upload/
```

# 十一、P0 Capability 范围

当前只支持：

| Capability       | 状态 |
| ---------------- | ---- |
| llm              | ✅    |
| image_generation | ✅    |
| filesystem.read  | ✅    |

暂不支持：

- Browser Automation
- Filesystem Write
- Script Runtime
- RPA

---

# 十二、P0 Memory

当前只支持：

# Task Memory

例如：

- 当前平台
- 当前商品
- 用户确认结果
- 已生成资产

不支持：

- 长期人格
- 长期用户画像
- AI Companion

---

# 十三、P0 Sandbox

当前：

只支持：

workspace 范围隔离。

例如：

```txt
workspace/
assets/
tasks/
```

Skill 不允许：

- 任意读写系统目录
- 自动执行系统命令

---

# 十四、P0 不做的内容

当前不做：

- Marketplace
- Skill Economy
- Skill Pricing
- Community Skill
- 企业治理系统
- 多 Agent 集群
- 自动 Browser Agent

---

# 十五、当前真正目标

验证：

## 1. Skill Runtime 是否成立

---

## 2. 用户是否真的会使用 Skill

---

## 3. 用户是否愿意自己写 Skill

---

## 4. Agent 是否明显比 Chat 更像“会工作”

---

# 十六、当前系统定位

当前系统：

不是：

- Low-code Workflow
- BPMN 平台
- Chat Bot

而是：

# 极简 Agent OS Runtime
