# 05 Admin React + Ant Design Spec v0.4

## 1. 技术栈冻结

```txt
React
Ant Design
TypeScript
```

## 2. P0 菜单结构

```txt
Dashboard
Skill 管理
  - Skill 列表
  - Skill 编辑
  - Parameter Schema
  - Operational Params
激活码管理
设备管理
用户/客户管理
任务日志
系统设置
```

分销商管理 P0 只显示基础预留或隐藏，完整面板为 P1。

## 3. Dashboard

展示：

| 卡片 | 说明 |
|---|---|
| 今日任务数 | created_at 为今天的任务 |
| 成功率 | succeeded / completed |
| 激活设备数 | active devices |
| Skill 调用数 | 按 skill_id 统计 |
| 异常任务 | failed / cancelled / provider_error |

## 4. Skill 管理列表

字段：

| 字段 | 说明 |
|---|---|
| skill_id | 唯一标识，例如 image_pipeline |
| name | 商品套图生成 |
| category | image/generation/browser 等 |
| runtime_type | generation 当前可用，未来扩展 |
| executor_type | image_pipeline |
| required_capabilities | JSON array |
| status | draft/enabled/disabled |
| version | 当前版本 |
| updated_at | 更新时间 |

操作：

- 编辑
- 版本
- 参数 Schema
- Operational Params
- 启用/停用

## 5. SkillEditModal

字段必须接入真实后端 API，不允许只改前端 mock。

请求：

```txt
GET /api/v1/admin/skills/{skill_id}
PUT /api/v1/admin/skills/{skill_id}
```

校验：

- skill_id 不可空，不建议修改
- runtime_type 不可空
- executor_type 不可空
- status 只能为 draft/enabled/disabled
- required_capabilities 必须是 array

## 6. Parameter Schema 编辑页

### 6.1 功能

- JSON 编辑器
- 格式化
- 校验
- 保存
- 查看当前生效版本
- 回滚预留

### 6.2 API

```txt
GET /api/v1/admin/skills/{skill_id}/parameter-schema
PUT /api/v1/admin/skills/{skill_id}/parameter-schema
POST /api/v1/admin/skills/{skill_id}/parameter-schema/validate
```

### 6.3 保存规则

- 校验失败不能保存
- 保存后记录 version
- 保存后不影响已创建任务，只影响新任务

## 7. Operational Params 编辑页

用于管理不适合暴露给用户的运行参数。

示例：

```json
{
  "imageCount": { "min": 1, "max": 9, "default": 4 },
  "provider": { "default": "gpt-image" },
  "timeoutSeconds": 300,
  "retry": { "max": 1 }
}
```

用户端只能拿到必要的安全映射，不直接拿敏感配置。

## 8. 激活码管理

### 8.1 列表字段

| 字段 | 说明 |
|---|---|
| code | 激活码 |
| batch_id | 批次 |
| plan_type | 套餐 |
| status | unused/bound/expired/disabled/revoked |
| device_code | 绑定设备 |
| reseller_id | P0 预留 |
| expires_at | 过期时间 |
| activated_at | 激活时间 |
| created_by | 创建人 |

### 8.2 批量生成

参数：

- 套餐
- 数量
- 有效期
- 归属：公司直营 / 预留分销商
- 备注

规则：

- 每个激活码唯一
- 一批次属性统一
- 不能一批用户共用一个激活码

## 9. 设备管理

功能：

- 按设备码搜索
- 查看绑定激活码
- 查看套餐/到期时间
- 停用设备
- 解绑/换绑

换绑默认规则：

```txt
管理员手动解绑旧设备 → 激活码状态允许新设备绑定 → 新设备激活
```

P0 不做自动风控换绑审批流。

## 10. 后台自测清单

- SkillEditModal 保存后刷新仍存在
- parameter_schema 非法 JSON 不能保存
- operational_params 修改后用户端下一次任务取到新默认值
- 生成 100 个激活码无重复
- 已绑定激活码不能被不同设备再次激活
- 后台停用 Skill 后用户端不可执行
