# 12 Acceptance Test / UAT Cases v0.4

## 1. 激活流程

| 用例 ID | 前置条件 | 步骤 | 期望 |
|---|---|---|---|
| ACT-001 | 新设备 | 打开客户端 | 进入激活页，显示设备码 |
| ACT-002 | unused 激活码 | 输入正确激活码并提交 | 绑定设备，进入 Chat |
| ACT-003 | 无效激活码 | 输入不存在激活码 | 显示“激活码无效” |
| ACT-004 | expired 激活码 | 输入过期激活码 | 显示“激活码已过期” |
| ACT-005 | 已绑定其他设备 | 在新设备输入已绑定码 | 显示“已绑定其他设备” |
| ACT-006 | 已激活设备 | 重启客户端 | 直接进入 Chat |

## 2. Chat + 上传

| 用例 ID | 前置条件 | 步骤 | 期望 |
|---|---|---|---|
| CHAT-001 | 已激活 | 进入 Chat | 显示空状态引导 |
| CHAT-002 | 已激活 | 上传 1 张图片 | 出现资产确认卡 |
| CHAT-003 | 已激活 | 上传 8 张图片 | 每张图有 asset_id/role_guess/user_role |
| CHAT-004 | 已激活 | 输入本地目录路径 | 目录素材被识别并列出 |
| CHAT-005 | 已上传素材 | 修改素材角色 | 提交时以 user_role 为准 |

## 3. 动态参数卡

| 用例 ID | 前置条件 | 步骤 | 期望 |
|---|---|---|---|
| PARAM-001 | 后台 schema 有 productName | Chat 缺少商品名 | 参数卡显示商品名字段 |
| PARAM-002 | 后台修改 imageCount max=9 | 用户打开任务卡 | 数字输入最大值为 9 |
| PARAM-003 | 后台新增 enum style | 用户打开任务卡 | 下拉选项同步变化 |
| PARAM-004 | 参数缺失 | 点击开始任务 | 前端阻止并提示，后端也校验失败 |

## 4. SkillRuntime

| 用例 ID | 前置条件 | 步骤 | 期望 |
|---|---|---|---|
| RUN-001 | 有权限 | POST /tasks/execute | 创建 task，status=queued |
| RUN-002 | 有权限 | 执行 image_pipeline | 经过 SkillRuntime.ExecuteSkill |
| RUN-003 | Skill disabled | 执行任务 | 返回 SKILL_DISABLED |
| RUN-004 | 无权限 | Chat 命中 Skill | 返回 SKILL_NOT_ENTITLED，不执行 Provider |
| RUN-005 | Provider timeout | 模拟超时 | Task failed，错误码 PROVIDER_TIMEOUT |
| RUN-006 | 成功生成 | 执行完成 | result_manifest 有图片结果 |

## 5. 后台

| 用例 ID | 前置条件 | 步骤 | 期望 |
|---|---|---|---|
| ADM-001 | 管理员登录 | 打开 Skill 列表 | 看到 image_pipeline |
| ADM-002 | 打开 SkillEditModal | 修改 name/status | 保存后刷新仍生效 |
| ADM-003 | 输入非法 JSON Schema | 点击保存 | 不能保存，显示错误 |
| ADM-004 | 修改 parameter_schema | 用户端打开参数卡 | 新字段出现 |
| ADM-005 | 生成 100 个激活码 | 查看列表 | 100 个唯一 code |
| ADM-006 | 停用设备 | 用户端执行任务 | 被拒绝 |

## 6. 回归验收命令建议

```txt
后端：go test ./...
前端用户端：npm run test && npm run build
后台：npm run test && npm run build
E2E：激活 → Chat 上传 → 参数卡 → 执行 → 结果 → 后台统计
```

如果实际项目命令不同，以 package.json / Makefile / CI 为准。
