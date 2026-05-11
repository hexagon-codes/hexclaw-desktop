```txt
# Runtime Boundary

> 定义：
> 什么在本地 Runtime
> 什么在云端 Control Plane

---

# 一、架构原则

系统采用：

# Local-first Runtime
+
# Cloud Control Plane

架构。

---

# 二、Cloud Control Plane（云控制平面）

云端只负责：

## 1. Account

- 登录
- 用户身份
- 设备授权

---

## 2. License

- 激活码
- 订阅状态
- License 校验

---

## 3. Skill Registry

- 官方 Skill 索引
- Skill 元数据
- Skill 更新信息

---

## 4. API Gateway（可选）

统一：

- OpenAI
- Claude
- Gemini
- 第三方模型

API 中转。

---

## 5. Analytics（轻量）

仅上传：

- Skill 使用次数
- Runtime 崩溃日志
- 匿名统计

不上传：

- Context
- Memory
- 用户资产

---

# 三、Local Runtime Plane（本地运行平面）

用户本地 EXE：

负责：

## 1. Chat Workspace

用户交互入口。

---

## 2. Task Runtime

管理：

- Task 生命周期
- Task 状态
- Timeline

---

## 3. Skill Runtime

加载：

- skill.json
- SKILL.md
- references/

---

## 4. Context Runtime

维护：

- 当前任务上下文
- 当前 Skill 上下文
- 执行状态

---

## 5. Memory

本地保存：

- Task Memory
- Execution Memory

---

## 6. Asset Workspace

管理：

- 图片
- 视频
- 文件
- SKU 资产

---

## 7. Browser Runtime（未来）

本地浏览器自动化。

---

# 四、数据边界

## 永远本地：

- Context
- Memory
- Assets
- Browser State
- 用户文件

---

## 可同步（可选）：

- Workspace 配置
- 用户偏好
- Skill 列表

---

## 永不上传：

- Prompt Context
- Runtime State
- Browser Session
- 本地资产

---

# 五、设计原则

## 1. Runtime 在本地

真正 Agent Runtime：

始终运行于用户设备。

---

## 2. 云端不是 Runtime

云端：

不是：

Agent 执行位置。

---

## 3. 用户拥有 Runtime

用户：

拥有：

- 数据
- Context
- Memory
- Asset

控制权。

---

# 六、系统定位

本系统：

不是：

云端 Agent SaaS。

而是：

# Local-first Agent Runtime Platformxxxxxxxxxx Cloud Control Plane├── Login├── License├── Skill Registry├── Skill Update└── API Gateway            ↓Local Runtime Plane├── Chat Workspace├── Task Runtime├── Skill Runtime├── Context Runtime├── Memory├── Asset Workspace└── Browser Runtimetxt
