# 09 Activation / Device / License Spec v0.4

## 1. 认证策略

P0 不做注册登录。授权方式为：

```txt
客户端自动生成设备码
→ 用户复制设备码发给管理员
→ 管理员后台生成激活码
→ 用户输入激活码
→ 后端绑定激活码与设备码
→ 客户端进入 Chat 首页
```

## 2. 设备码生成

建议格式：

```txt
SW-DEVICE-{short_hash}
```

生成原则：

- 同一设备稳定
- 不直接上传硬件明文信息
- 可结合硬件指纹 hash + 安装随机 salt
- 本地存储时注意 Tauri 安全边界

## 3. 激活码格式

建议格式：

```txt
SW-{XXXX}-{XXXX}-{XXXX}
```

规则：

- 每个激活码唯一
- 批次属性统一
- 不建议多人共用一个激活码
- 已绑定的激活码默认不能绑定其他设备

## 4. 激活流程状态机

```txt
unused → bound → expired
unused → disabled
bound → disabled
bound → revoked
bound → unbound_for_rebind → bound
```

## 5. 换绑规则 P0

P0 采用管理员手动换绑：

```txt
用户联系客服
→ 管理员搜索旧 device_code
→ 管理员确认旧设备与激活码
→ 点击解绑
→ 激活码允许绑定新设备
→ 用户在新设备输入激活码
```

不做自动审批流，不做复杂风控模型。

## 6. 激活码后台批量生成

请求：

```json
{
  "plan_type": "pro",
  "count": 100,
  "valid_days": 30,
  "owner_type": "direct",
  "reseller_id": null,
  "remark": "5月直营批次"
}
```

响应：

```json
{
  "batch_id": "BATCH-20260510-001",
  "count": 100,
  "codes": ["SW-XXXX-XXXX-XXXX"]
}
```

## 7. 套餐 P0 建议

| plan_type | Skill | imageCount max | 备注 |
|---|---|---:|---|
| trial | image_pipeline | 2 | 体验 |
| basic | image_pipeline | 4 | 基础 |
| pro | image_pipeline | 9 | 专业 |

## 8. 安全规则

- 激活码校验必须在后端
- 客户端不应自行判断套餐可执行性
- 过期后不允许继续执行新任务
- 历史结果是否可看由业务决定，P0 默认可看不可新建
