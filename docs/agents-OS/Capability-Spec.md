# Capability Spec

> 定义：
> Capability Runtime
> Capability API
> 权限边界
> Runtime 调用规则

---

# 一、Capability 定义

Capability：

是：

# Runtime 提供给 Skill 的系统能力。

---

# 二、架构关系

```txt
Skill
  ↓
Capability API
  ↓
Capability Runtime
  ↓
Sandbox
  ↓
System
```

---

# 三、设计原则

## 1. Skill 不直接操作系统

Skill：

只能：

调用 Capability。

---

## 2. Capability 是唯一系统入口

所有：

- 文件
- Browser
- 模型
- 生成

必须通过：

Capability Runtime。

---

## 3. Runtime 拥有最终控制权

Runtime：

决定：

- 是否允许
- 是否限制
- 是否需要确认

---

# 四、P0 Capability

## llm

作用：

文本生成与推理。

---

## image_generation

作用：

图像生成。

---

## filesystem.read

作用：

读取 Workspace 内文件。

限制：

仅允许：

workspace/ 范围。

---

# 五、未来 Capability（暂不实现）

- browser
- filesystem.write
- automation
- terminal
- script_runtime

---

# 六、Capability API 示例

## filesystem.read

```json
{
  "path": "workspace/assets/sku001"
}
```

---

## image_generation

```json
{
  "prompt": "护肤品电商主图"
}
```

---

# 七、Sandbox 规则

## Skill 永远不能：

- 直接执行 shell
- 访问系统目录
- 修改 Runtime Core

---

## Runtime 可以：

- 限制 Capability
- 中断执行
- 要求用户确认

---

# 八、Capability Policy

Runtime：

可动态限制：

```json
{
  "filesystem.read": "workspace-only",
  "filesystem.write": "denied"
}
```

---

# 九、系统定位

Capability Runtime：

是：

# AI-native System API