# 03 Roles / Permissions / Entitlement Matrix v0.4

## 1. 角色定义

| 角色 | 说明 | P0 状态 |
|---|---|---|
| 普通用户 | 使用 Tauri 客户端，通过 Chat 执行任务 | 必做 |
| 公司后台管理员 | 管理 Skill、用户、设备、激活码、数据统计 | 必做 |
| 超级管理员 | 拥有所有后台权限，管理系统配置 | 必做，可与后台管理员合并实现 |
| 分销商 | 管理自己的配额、客户、发码 | P1，P0 仅预留字段 |
| 系统服务 | 后端 Runtime、任务调度、对象存储、Provider | 必做 |

## 2. 权限矩阵

| 功能 | 普通用户 | 公司后台管理员 | 超级管理员 | 分销商 P1 | 系统服务 |
|---|---:|---:|---:|---:|---:|
| 查看可用 Skill | 按套餐可见 | 全部 | 全部 | 授权范围 | 全部 |
| 执行 Skill | 按套餐执行 | 可代测 | 可代测 | 不直接执行用户任务 | 执行 |
| 查看 Prompt | 否 | P0 默认否，P1 可受控 | 可 | 否 | 可读取服务端配置 |
| 编辑 parameter_schema | 否 | 是 | 是 | 否 | 读取 |
| 编辑 operational_params | 否 | 是 | 是 | 否 | 读取 |
| 生成激活码 | 否 | 是 | 是 | P1 有配额 | 否 |
| 设备解绑 | 发起申请/联系客服 | 是 | 是 | P1 范围内 | 否 |
| 查看任务日志 | 仅自己的结果 | 匿名/必要日志 | 全部 | P1 归属范围 | 写入 |
| 查看用户完整输入 | 仅自己 | 默认不展示完整 Context | 可按审计查看 | 否 | 运行时读取 |

## 3. Entitlement 检查顺序

所有 Skill 执行必须经过：

```txt
1. Device Active Check
2. Activation Code Status Check
3. User/Device Plan Check
4. Skill Visibility Check
5. Skill Executable Check
6. Runtime Capability Check
7. Rate/Quota Check
8. Execute
```

## 4. 关键状态

### activation_code.status

| 状态 | 说明 | 是否可激活 |
|---|---|---:|
| unused | 已生成未使用 | 是 |
| bound | 已绑定设备 | 否，除非同设备续期 |
| expired | 已过期 | 否 |
| disabled | 管理员停用 | 否 |
| revoked | 风控吊销 | 否 |

### device.status

| 状态 | 说明 |
|---|---|
| inactive | 未激活 |
| active | 正常 |
| pending_rebind | 换绑申请中 |
| disabled | 停用 |
| risk_locked | 风控锁定 |

### skill_entitlement.status

| 状态 | 说明 |
|---|---|
| allowed | 可见可执行 |
| visible_only | 可见但不可执行，提示升级 |
| hidden | 不展示 |
| disabled | 管理员停用 |

## 5. 无权限提示文案

- 无 Skill 权限：`当前激活码暂不包含该 Skill，请联系管理员开通。`
- 激活码过期：`当前激活码已过期，请联系管理员续期。`
- 设备不匹配：`该激活码已绑定其他设备，如需换绑请联系管理员。`
- 额度不足：`当前套餐额度不足，任务暂无法继续。`
