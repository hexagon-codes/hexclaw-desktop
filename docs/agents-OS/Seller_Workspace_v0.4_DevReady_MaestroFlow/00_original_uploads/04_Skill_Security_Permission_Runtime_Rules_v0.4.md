# 04 Skill Security Permission Runtime Rules v0.4

> 文档定位：贴合当前项目阶段的 Skill 安全、权限和 Runtime 规则。  
> 当前阶段：P0 以 Go 后端 SkillRuntime MVP 为主。

---

# 1. P0 Skill 安全原则

P0 不做复杂加密包系统，但必须做到：

```txt
前端不放 Prompt
前端不放 Skill 核心逻辑
用户端不硬编码 Skill 表单
后端统一校验 Skill 权限
后台配置进入数据库
```

---

# 2. 官方 Skill 可见性

## 用户端可见

- Skill 名称
- 描述
- 适用任务
- 示例效果
- 权限状态
- 参数表单
- 任务结果

## 用户端不可见

- Prompt 模板
- Prompt 拼装逻辑
- Workflow 内部节点细节
- Strategy 参数
- Context 构造
- 后台 operational_params 敏感字段

---

# 3. Description 与适用任务区别

```txt
Description = 这个 Skill 是什么
适用任务 = 什么时候用它
```

示例：

```txt
Description：
根据产品信息自动生成电商宣传图。

适用任务：
商品主图、商品详情图、场景图、卖点图、套图生成。
```

---

# 4. 无权限 Skill 防误用

P0 即使 Entitlement 还未完全实现，也必须保留统一校验点：

```txt
Intent
→ Candidate Skill
→ Skill Visibility Check
→ Skill Executable Check
→ Plan/License Check
→ Execute
```

无权限时：

```txt
当前激活码暂不包含该 Skill。
请联系管理员开通。
```

禁止：

- Agent 自动创建替代 Skill 绕过限制
- 前端直接显示隐藏 Skill 的执行入口
- 用 Chat 绕过套餐
- 在前端仅靠按钮隐藏实现权限

---

# 5. Draft Skill 阶段

P0 不做完整自定义 Skill。

P1/P2 自定义 Skill 时：

- 公司后台可见完整 Draft
- 分销商只见摘要、置信度、Simulation 结果
- 高级用户只见摘要、置信度、Simulation 结果
- 用户不看 Skill 生成原理

---

# 6. Strategy 显示规则

用户端不显示 Strategy 详情。

可显示：

```txt
风格：高级感
平台：小红书
输出：详情图
```

不可显示：

```txt
Prompt Fragment
Strategy Weight
Context Rule
Skill Core
```

---

# 7. Timeline / Progress 规则

用户端只显示：

- 当前阶段
- 百分比
- 简短错误
- 是否可取消

公司后台显示：

- 任务状态
- 错误类型
- Provider 错误
- 调用统计
- 匿名日志

不默认显示用户完整 Context。

---

# 8. Skill 加密阶段路线

## P0

- 不在前端放 Prompt
- 后端统一执行 Skill
- 用户端只拿 schema 和展示信息
- License 与套餐由后端校验

## P1

- Skill 包签名
- 官方 Skill 配置加密存储
- 设备绑定
- License 短期 Token

## P2

- 高价值 Skill 云端短令牌
- Prompt Fragment / Strategy Fragment
- 外部 Skill 导入沙箱
- Marketplace 审核

---

# 9. 激活码规则

批量激活码：

```txt
每个激活码唯一
批次属性统一
```

不建议一批用户共用同一个激活码。

原因：

- 可追踪
- 可吊销
- 可统计
- 可结算
- 可风控

---

# 10. 飞书接入阶段

P0 可做：

- 激活码批次生成通知
- 异常激活通知
- 系统错误通知

P1/P2 可做：

- 分销商发码通知
- Skill 发布通知
- 风控告警
- 运行日志摘要
