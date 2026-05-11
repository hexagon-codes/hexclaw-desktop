# Context Contract

> 定义：
> Context Layer
> 生命周期
> 拼接规则
> Runtime 上下文边界

---

# 一、Context 定义

Context：

是：

# Runtime 当前工作状态。

不是：

聊天记录。

---

# 二、Context Layer

## 1. System Layer

Runtime 基础规则。

例如：

- 系统约束
- Runtime Policy

---

## 2. Skill Layer

当前 Skill：

- Workflow
- Rules
- References

---

## 3. Task Layer

当前 Task：

- 目标
- 状态
- 约束

---

## 4. Execution Layer

当前执行结果：

- Tool Result
- 中间状态

---

## 5. Memory Layer

Task Memory：

- 用户确认
- 历史结果
- 已生成资产

---

# 三、Context 生命周期

```txt
Task Create
  ↓
Skill Match
  ↓
Context Build
  ↓
Execution Update
  ↓
Memory Persist
  ↓
Task Complete
```

---

# 四、Context 拼接规则

## 1. Progressive Loading

只加载：

当前需要的：

- Skill
- Memory
- References

---

## 2. 禁止无限历史

不允许：

无限聊天记录拼接。

---

## 3. 禁止 Context 污染

Skill：

不能：

修改 System Layer。

---

## 4. Execution 隔离

Task：

拥有独立 Context。

---

# 五、Memory 规则

Memory：

属于：

Task Runtime。

不是：

长期人格系统。

---

# 六、Context Observability

Runtime：

必须支持：

- Context 查看
- Context Debug
- Context Trace

---

# 七、系统定位

Context Runtime：

是：

# Agent Runtime 的认知层