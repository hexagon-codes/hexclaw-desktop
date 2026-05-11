# 06 Backend SkillRuntime API & Data Model v0.4

## 1. 技术栈冻结

```txt
Go
Gin
PostgreSQL
Redis
S3 或本地对象存储
```

当前 Runtime 主体在 Go 后端，不重写为全本地 Runtime。

## 2. 模块边界

```txt
API Layer / Gin
→ Auth & Device Middleware
→ Entitlement Service
→ Skill Service
→ Workflow Service
→ SkillRuntime
→ ExecutorRegistry
→ ImagePipelineExecutor
→ Provider Adapter
→ Storage / DB
```

## 3. 核心接口

### 3.1 设备状态

```http
GET /api/v1/devices/status?device_code=SW-DEVICE-XXXX
```

响应：

```json
{
  "device_code": "SW-DEVICE-XXXX",
  "status": "active",
  "plan_type": "pro",
  "expires_at": "2026-06-10T00:00:00Z"
}
```

### 3.2 激活

```http
POST /api/v1/activation/activate
Content-Type: application/json
```

请求：

```json
{
  "device_code": "SW-DEVICE-XXXX",
  "activation_code": "SW-XXXX-XXXX-XXXX"
}
```

成功响应：

```json
{
  "status": "active",
  "access_token": "...",
  "plan_type": "pro",
  "expires_at": "2026-06-10T00:00:00Z"
}
```

错误码：

| code | message |
|---|---|
| ACTIVATION_CODE_EMPTY | 请输入激活码 |
| ACTIVATION_CODE_INVALID | 激活码无效 |
| ACTIVATION_CODE_EXPIRED | 激活码已过期 |
| ACTIVATION_CODE_ALREADY_BOUND | 该激活码已绑定其他设备 |
| DEVICE_DISABLED | 当前设备已停用 |

### 3.3 获取 Skill Runtime Schema

```http
GET /api/v1/skills/{skill_id}/runtime-schema
```

响应：

```json
{
  "skill_id": "image_pipeline",
  "name": "商品套图生成",
  "description": "根据产品信息自动生成电商宣传图。",
  "parameter_schema": {},
  "ui_schema": {},
  "defaults": {},
  "visibility": "allowed"
}
```

### 3.4 执行任务

```http
POST /api/v1/tasks/execute
```

请求：

```json
{
  "skill_id": "image_pipeline",
  "device_code": "SW-DEVICE-XXXX",
  "assets": [
    { "asset_id": "ast_001", "user_role": "product_image" }
  ],
  "parameters": {
    "productName": "运动鞋",
    "category": "鞋服",
    "style": "高级感",
    "imageCount": 4
  }
}
```

响应：

```json
{
  "task_id": "tsk_001",
  "status": "queued"
}
```

### 3.5 任务状态

```http
GET /api/v1/tasks/{task_id}
```

响应：

```json
{
  "task_id": "tsk_001",
  "status": "running",
  "progress": 63,
  "current_stage": "生成图片",
  "results": []
}
```

### 3.6 导出发布包

```http
POST /api/v1/tasks/{task_id}/export
```

注意：该能力保持独立 REST，不注册为 SkillExecutor。

## 4. 后台 API

```txt
GET    /api/v1/admin/skills/all
GET    /api/v1/admin/skills/{skill_id}
PUT    /api/v1/admin/skills/{skill_id}
GET    /api/v1/admin/skills/{skill_id}/versions
GET    /api/v1/admin/skills/{skill_id}/parameter-schema
PUT    /api/v1/admin/skills/{skill_id}/parameter-schema
POST   /api/v1/admin/skills/{skill_id}/parameter-schema/validate
GET    /api/v1/admin/skills/{skill_id}/operational-params
PUT    /api/v1/admin/skills/{skill_id}/operational-params
POST   /api/v1/admin/activation-codes/batch
GET    /api/v1/admin/activation-codes
GET    /api/v1/admin/devices
PUT    /api/v1/admin/devices/{device_code}/disable
POST   /api/v1/admin/devices/{device_code}/unbind
```

## 5. 数据表建议

### 5.1 skills

| 字段 | 类型 | 说明 |
|---|---|---|
| id | uuid | 主键 |
| skill_id | text unique | image_pipeline |
| name | text | 展示名 |
| description | text | 描述 |
| category | text | image/generation |
| runtime_type | text | generation |
| executor_type | text | image_pipeline |
| required_capabilities | jsonb | 能力要求 |
| status | text | draft/enabled/disabled |
| current_version | text | 版本 |
| created_at | timestamptz | 创建时间 |
| updated_at | timestamptz | 更新时间 |

### 5.2 skill_versions

| 字段 | 类型 | 说明 |
|---|---|---|
| id | uuid | 主键 |
| skill_id | text | 外键逻辑 |
| version | text | 版本号 |
| parameter_schema | jsonb | 参数 schema |
| ui_schema | jsonb | 前端展示 schema |
| operational_params | jsonb | 后台运行参数 |
| prompt_template_ref | text | 服务端引用，不给前端 |
| status | text | draft/published/archived |
| created_at | timestamptz | 创建时间 |

### 5.3 activation_codes

| 字段 | 类型 | 说明 |
|---|---|---|
| id | uuid | 主键 |
| code | text unique | 激活码 |
| batch_id | text | 批次 |
| plan_type | text | 套餐 |
| status | text | unused/bound/expired/disabled/revoked |
| device_code | text nullable | 绑定设备 |
| reseller_id | uuid nullable | P0 预留 |
| expires_at | timestamptz | 过期时间 |
| activated_at | timestamptz | 激活时间 |
| created_by | uuid | 创建人 |
| created_at | timestamptz | 创建时间 |

### 5.4 devices

| 字段 | 类型 | 说明 |
|---|---|---|
| id | uuid | 主键 |
| device_code | text unique | 设备码 |
| status | text | inactive/active/disabled/risk_locked |
| activation_code_id | uuid nullable | 绑定激活码 |
| fingerprint_hash | text nullable | 硬件指纹 hash |
| last_seen_at | timestamptz | 最近在线 |
| created_at | timestamptz | 创建时间 |

### 5.5 assets

| 字段 | 类型 | 说明 |
|---|---|---|
| id | uuid | 主键 |
| asset_id | text unique | ast_xxx |
| task_id | uuid nullable | 绑定任务 |
| file_name | text | 文件名 |
| file_type | text | image/video/audio/document/folder |
| file_size | bigint | 大小 |
| hash | text | 内容 hash |
| source_path_hash | text | 本地路径 hash，不默认存明文 |
| role_guess | text | 系统识别 |
| user_role | text | 用户确认 |
| storage_url | text | 存储地址 |
| created_at | timestamptz | 创建时间 |

### 5.6 tasks

| 字段 | 类型 | 说明 |
|---|---|---|
| id | uuid | 主键 |
| task_id | text unique | tsk_xxx |
| skill_id | text | image_pipeline |
| device_code | text | 设备 |
| status | text | queued/running/succeeded/failed/cancelled |
| parameters | jsonb | 用户确认参数 |
| progress | int | 0-100 |
| current_stage | text | 展示阶段 |
| error_code | text nullable | 错误码 |
| error_message | text nullable | 错误信息 |
| result_manifest | jsonb | 结果索引 |
| created_at | timestamptz | 创建时间 |
| updated_at | timestamptz | 更新时间 |

## 6. 后端实现约束

- 所有 Skill 执行前必须调用 Entitlement Service
- parameter_schema 保存前必须 JSON Schema 校验
- operational_params 敏感字段不能原样返回用户端
- Prompt 不返回前端
- 导出包、上传确认独立 REST，不走 ExecutorRegistry
- P0 不做 Go plugin 动态加载
