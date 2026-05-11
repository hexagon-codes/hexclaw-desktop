# 20 Provider and Model Routing v0.4

# 1. 目标

定义模型层与 Runtime 解耦原则。

---

# 2. Provider 不等于 Runtime

Provider：

- Claude SDK
- OpenAI SDK
- Gemini SDK

负责：

- inference
- streaming
- structured output
- tool calling

不负责：

- business logic
- entitlement
- workflow
- permissions

---

# 3. Provider Adapter

统一：

- request
- response
- token usage
- error mapping
- retry policy

---

# 4. 推荐模型路由

generation：

- GPT Image
- Gemini Image
- SDXL

reasoning：

- Claude
- GPT-5.x

tool orchestration：

- Claude
- GPT-5.x

---

# 5. Routing Strategy

根据：

- runtime_type
- cost
- latency
- entitlement
- availability

动态路由。

---

# 6. 禁止事项

禁止：

- 前端直接调模型
- Prompt 写死前端
- 模型 SDK 直接写业务规则

---

# 7. P0 原则

P0：

- 单 Provider 可运行
- 预留多 Provider 抽象

不要提前过度抽象。
