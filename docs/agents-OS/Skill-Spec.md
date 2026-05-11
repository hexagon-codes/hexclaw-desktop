# Skill Spec

> 定义：
> Skill Package
> skill.json
> SKILL.md
> Skill Runtime

---

# 一、Skill 定义

Skill：

不是：

- 插件
- Workflow 节点
- 微服务

Skill：

是：

# Experience Package（经验包）

---

# 二、Skill Package

```txt
skills/
  ecommerce-image/
    skill.json
    SKILL.md
    references/
```

---

# 三、skill.json

定义：

- 元数据
- Capability
- 入口

---

# 示例

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

# 四、SKILL.md

定义：

- Workflow
- Rules
- Examples
- References

---

# 示例结构

```md
# Description

Skill 用途。

# Workflow

任务流程。

# Rules

规则限制。

# Examples

示例。

# Gotchas

风险与注意事项。
```

---

# 五、references/

用于：

- 示例
- SOP
- 平台规则
- Prompt 参考

---

# 六、Skill Runtime

Runtime：

负责：

- Skill Match
- Skill Load
- Context Inject

---

# 七、Skill 原则

## 1. Skill 不控制 Runtime

Skill：

只是经验层。

---

## 2. Skill 不直接操作系统

必须：

通过 Capability。

---

## 3. Skill 可热更新

Skill：

允许：

版本更新。

---

# 八、Skill Match

Runtime：

根据：

- Task
- Intent
- Context

匹配 Skill。

---

# 九、系统定位

Skill：

是：

# AI-native Experience Package