# 21 Future Browser Runtime P2

# 1. 文档目标

定义 Browser Runtime 的未来边界。

---

# 2. Browser Runtime 不属于 P0

P0：

- image_pipeline
- generation runtime

P2/P3：

- browser automation
- RPA
- autonomous agent

---

# 3. Browser Runtime 风险

包括：

- Prompt Injection
- Tool Injection
- Browser Hijack
- 无限自治
- 权限逃逸

---

# 4. Browser Runtime 原则

必须：

- 沙箱
- 权限隔离
- URL 白名单
- 用户确认
- Token 限制

---

# 5. GenericAgent 定位

GenericAgent：

- Browser Task
- Research Task
- Long-running Task

不进入：

- 核心 generation runtime

---

# 6. Browser Runtime 生命周期

Plan
→ Browser Open
→ Observe
→ Tool Call
→ Human Confirm
→ Continue
→ Export

---

# 7. 当前禁止

禁止：

- 默认后台运行 Browser Agent
- 无确认自动下单
- 自动读取本地敏感文件

---

# 8. 长期目标

未来：

- BrowserExecutor
- Sandboxed Runtime
- Agent Session Memory
- Multi-Agent Collaboration
