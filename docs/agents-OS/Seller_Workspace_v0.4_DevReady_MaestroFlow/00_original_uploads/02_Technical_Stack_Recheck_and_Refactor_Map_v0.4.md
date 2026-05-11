# 02 Technical Stack Recheck and Refactor Map v0.4

> 文档定位：技术栈复审与“哪些需要修改/重构”的明确清单。  
> 核心结论：不推翻当前 Tauri/Vue/Go/React Admin 技术基座。

---

# 1. 最终技术栈口径

## 1.1 用户端

```txt
Tauri 2.0
Vue 3
Naive UI
Pinia
Tailwind CSS
TypeScript
```

不得在文档中再写成 Electron，除非项目未来明确迁移。

---

## 1.2 公司后台

```txt
React
Ant Design
TypeScript
```

---

## 1.3 后端

```txt
Go
Gin
PostgreSQL
Redis
S3/本地对象存储
```

---

# 2. Runtime 技术口径

当前 Runtime 不应重写为全本地 Runtime。

正确口径：

```txt
当前：Go 后端 SkillRuntime 为主
用户端：Tauri 桌面壳 + Chat UI + 动态参数卡 + 本地资源接入
未来：逐步增强本地 Runtime 能力
```

---

# 3. 当前已具备的 Runtime 基础

当前后端已有：

- SkillExecutor 接口
- ExecutorRegistry
- SkillRuntime.ExecuteSkill()
- ImagePipelineExecutor
- SkillDefinition
- runtime_type
- executor_type
- required_capabilities
- 前端 dynamic parameter_schema
- ProgressStages 动态进度文案基础设施

---

# 4. 需要修改/重构清单

## 4.1 必须立刻修改

### 修改 1：v0.3 文档里的 Electron

```txt
全部改为 Tauri 2.0 + Vue 3
```

影响文件：

- 技术架构文档
- 用户端 UI 文档
- 安全文档
- 本地 Runtime 文档

---

### 修改 2：Local-first Runtime 的表述

错误表述：

```txt
Runtime 完全在用户端本地运行
```

修正为：

```txt
当前 Runtime 主体在 Go 后端 SkillRuntime。
用户端承担 Chat-first UI、桌面资源接入、本地资产承接。
未来逐步增强 Local-first 能力。
```

---

### 修改 3：分销商面板阶段

错误表述：

```txt
分销商面板是当前三端完整实现
```

修正为：

```txt
分销商面板 P1 实现。
P0 只在数据模型和公司后台预留。
```

---

### 修改 4：Marketplace

错误表述：

```txt
当前做完整 Marketplace
```

修正为：

```txt
P0 不做 Marketplace。
P0 只做 Skill Registry / 后台配置 / Runtime 执行闭环。
P2 再做 Marketplace。
```

---

## 4.2 近期需要补齐

### 补齐 1：后台真实 API

需要完成：

- SkillEditModal 接入真实 API
- parameter_schema 编辑
- operational_params 编辑
- runtime_type 编辑
- executor_type 编辑
- required_capabilities 编辑
- GET /skills/all
- GET /skills/:id/versions
- PUT /skills/:id/parameter-schema

---

### 补齐 2：用户端 Chat 参数卡

Chat 参数卡必须使用后端 parameter_schema。

不要：

```txt
在 Chat 组件里写死 productName/category/style/count
```

要：

```txt
Chat → Intent → Skill Match → 缺参识别 → Schema 渲染参数卡
```

---

### 补齐 3：上传资产协议

当前需要补统一 Chat 附件协议：

```txt
asset_id
file_name
file_type
file_size
hash
source_path
upload_order
role_guess
user_role
task_binding
```

---

### 补齐 4：权限联动

P0 当前若 Entitlement 未完全实现，至少要预留统一检查点：

```txt
Skill 可见
Skill 可执行
参数是否可编辑
套餐是否允许
设备是否有效
```

---

## 4.3 后续重构

### 重构 1：不要把 export_pack / upload_confirm Runtime 化

保持独立 REST。

```txt
POST /tasks/:id/export
POST /tasks/:id/upload-confirm
```

不注册为 SkillExecutor。

---

### 重构 2：不要做复杂 Workflow DSL

P0 使用内置 ExecutorRegistry，不做外部 DSL。

---

### 重构 3：不要动态加载 Go plugin

Windows 不支持 Go plugin 的现实约束下，不做动态 Go plugin。

---

# 5. 安全技术口径

## 5.1 Tauri 权限边界

Tauri v2 使用 permissions/capabilities 控制前端能访问哪些命令和插件能力。

项目应使用：

- 最小权限
- 文件访问 scope
- 禁止渲染层任意读本地路径
- Rust/Tauri command 作为本地资源接入网关

---

## 5.2 更新签名

Tauri updater 更新包必须签名，用于验证更新来源。项目应建立：

- updater 签名密钥
- Windows 代码签名
- 灰度发布
- 强制更新策略

---

# 6. Skill 安全阶段

## P0

- 前端不放 Prompt
- 前端不放核心 Skill 逻辑
- 后台 Skill 配置进入数据库
- 用户端只拿可执行 schema 与展示信息
- 关键权限后端校验

## P1

- Skill 包签名
- 官方 Skill 加密包
- License 短期 Token
- 设备异常风控

## P2

- 高价值 Skill 云端短令牌
- Prompt Fragment / Strategy Fragment
- 外部 Skill 导入沙箱
- Marketplace 审核

---

# 7. 结论

v0.4 技术策略：

```txt
保留当前 Go 后端 SkillRuntime
保留 Tauri + Vue 用户端
保留 React Admin
围绕 SkillRuntime MVP 补齐后台真实配置与用户端动态参数卡
把 Local-first、Skill 加密、Marketplace、分销商面板放到明确后续阶段
```
