# AI_NATIVE_RUNTIME_VISION

> Product Vision for HexClaw Runtime Fusion  
> Version: v0.1  
> Date: 2026-05-14

---

## 1. 一句话愿景

把 HexClaw 从普通 Agent Desktop / Chat App，演化为：

**Chat-first、Task-aware、Skill-driven、Local-first 的 AI-native Runtime Workspace。**

---

## 2. 用户最终感受到什么

用户不是在使用一个“聊天机器人”。

用户感受到的是：

- 输入自然语言任务
- 系统自动识别是否需要 Skill
- 每次任务都有可见状态
- 输出不只是消息，而是 Runtime Result
- 可点击查看 Task / Context / Timeline
- 重要结果可沉淀为 Workspace 记录
- 后续可以复用 Skill、资产、上下文

理想体验：

```
用户：@summarize 这段材料
  ↓
Chat 中出现结构化结果
  ↓
旁边出现 TaskBadge：Summarize · completed · 1.8s
  ↓
点击进入 Workspace
  ↓
看到：
- 使用了哪个 Skill
- 输入是什么
- 执行状态
- 时间线
- 结果
- 相关资产/上下文
```

---

## 3. 为什么不是普通 Chat

普通 Chat 只有：

```
message in → message out
```

本项目需要：

```
intent → task → context → skill → execution → result → timeline → workspace
```

所以 Chat 是入口，而不是架构核心。

---

## 4. 为什么不是 Workflow

Workflow 强调：

```
节点 → 连线 → 参数 → 编排
```

本项目强调：

```
用户表达任务 → Runtime 组织执行 → Skill 注入经验 → Workspace 呈现过程
```

Workflow 会把用户推向“配置系统”。

本项目要把用户留在“表达目标”。

---

## 5. 为什么不是 Prompt 工具

Prompt 工具只解决：

```
怎么问模型
```

本项目解决：

```
怎么让模型成为 Runtime 的一个执行单元
```

Skill 不是 prompt，而是 Runtime 可消费的行为包。

---

## 6. 为什么 Local-first

Local-first 的原因：

- 用户数据、文件、上下文优先留在本地
- Desktop Runtime 能控制文件、资产、窗口、任务
- Skill 能与本地资源结合
- Cloud 只做必要服务，不控制完整上下文
- 未来可支持私有化、离线、企业内部部署

---

## 7. 当前产品阶段

当前阶段不是“功能扩张”。

当前阶段是：

**Runtime Product Surface v0.1**

关键目标：

1. 真实 Skill 能被 Registry 找到
2. Chat 能显示 Runtime task 状态
3. Workspace 能承接 Chat 中的任务
4. Skill 输出不再只是普通 message
5. 用户开始感知：这是一个 Runtime Workspace

---

## 8. 成功标准

### v0.1 成功

- `@summarize` 真正命中 Skill
- `@bulletize` 真正命中 Skill
- Chat 中显示 TaskBadge
- 点击进入 Workspace
- Workspace 能看到对应 task
- 普通 chat 不受影响

### v0.2 成功

- Skill 结果有 Result Surface
- Workspace Task Detail 可查看 Skill/Execution/Result
- Runtime LLM Contract 提取
- execMode 收敛路线明确

### v0.3 成功

- Asset Runtime 进入 UI
- Dashboard 接入 Runtime data
- Custom Skill 管理雏形
- Capability Runtime 更完整

---

## 9. 最大风险

### 风险 1：重新变成 Prompt Playground

表现：

- 不断调 summarize/bulletize prompt
- 新增很多文本 skill
- 但 Workspace 和 Runtime Surface 没有进展

避免方式：

- 每类 Skill 只验证一个 archetype
- 通过后转向 Product Surface

### 风险 2：重新变成 Workflow Builder

表现：

- 引入 DAG
- 引入 Planner
- 引入 Validator/Repair loop
- 引入多 agent 协作图

避免方式：

- 坚持 single task / single-pass / explicit capability

### 风险 3：Runtime 内核过度重构

表现：

- 不断整理 llmContract / executor / bridge
- 但用户体验没有变化

避免方式：

- P0 后优先 Workspace Surface
- 内部重构必须服务于可见产品能力

---

## 10. 当前最重要的下一步

不是继续设计抽象。

而是完成：

**Module 001: Skill Directory Alignment**

因为它会第一次真正激活：

```
Chat → SkillRegistry → SkillLoader → Runtime → TaskBadge → Workspace
```

这是 AI-native Runtime Workspace 的第一条真实产品链路。
