# 10 Security / Visibility / Prompt Protection v0.4

## 1. P0 安全底线

P0 不做复杂加密包系统，但必须做到：

```txt
前端不放 Prompt
前端不放 Skill 核心逻辑
用户端不硬编码 Skill 表单
后端统一校验 Skill 权限
后台配置进入数据库
```

## 2. 用户端可见 / 不可见

### 可见

- Skill 名称
- 描述
- 适用任务
- 示例效果
- 权限状态
- 参数表单
- 任务进度
- 任务结果

### 不可见

- Prompt 模板
- Prompt 拼装逻辑
- Workflow 内部节点细节
- Strategy 参数
- Context 构造
- operational_params 敏感字段

## 3. 后端保护点

| 位置 | 要求 |
|---|---|
| runtime-schema API | 只返回可执行 schema 和安全默认值 |
| task execute API | 重新校验权限和参数，不信任前端 |
| logs | 不默认保存完整 Prompt/Context |
| admin API | 需要后台权限 |
| provider key | 只存在服务端或安全配置中 |

## 4. Tauri 权限边界

用户端通过 Tauri command 访问本地资源，渲染层不应拥有任意文件读取能力。

P0 策略：

- 最小权限
- 文件访问 scope
- 禁止任意路径读取
- 上传目录必须经用户显式选择或输入
- 日志不记录完整本地路径

## 5. Skill 加密路线

| 阶段 | 能力 |
|---|---|
| P0 | 服务端执行、前端不放 Prompt、后端权限校验 |
| P1 | Skill 包签名、官方 Skill 配置加密存储、License 短期 Token |
| P2 | 高价值 Skill 云端短令牌、外部 Skill 导入沙箱、Marketplace 审核 |

## 6. 防绕过规则

禁止：

- Agent 自动创建替代 Skill 绕过套餐
- 前端隐藏按钮替代后端权限检查
- Chat 命中隐藏 Skill 后仍执行
- 用户端显示官方核心 Skill 内容
- operational_params 直接返回用户端
