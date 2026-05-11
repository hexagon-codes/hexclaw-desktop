# 23 Entitlement Service Contract v0.4

定义 Runtime 层权限检查契约。

## 检查顺序
License → Device → Package → Visibility → Skill Enabled → Quota → Rate Limit。

## 核心接口
```go
Check(ctx, CheckRequest) (*CheckResult, error)
```

## 原则
- 权限必须 Runtime 校验
- 禁止只在前端/Handler 校验
- Runtime 不直接读 entitlement DB
