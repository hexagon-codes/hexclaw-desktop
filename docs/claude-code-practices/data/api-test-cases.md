# API 全量回归测试用例集（模板）

> 本文件是 API 回归测试的用例模板，包含常见业务接口的测试用例。
> 实际使用时根据项目接口文档补充完整用例。

## 使用方式

```bash
# 同步接口
curl -s "$HOST/api/v1/auth/login" \
  -H "Content-Type: application/json" \
  -d '<JSON>'

# 需要鉴权的接口
curl -s "$HOST/api/v1/users/profile" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json"

# 异步任务（提交）
curl -s "$HOST/api/v1/tasks" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '<JSON>'

# 查询任务状态
curl -s "$HOST/api/v1/tasks/$TASK_ID" -H "Authorization: Bearer $TOKEN"
```

---

## 目录

- [用户认证](#用户认证)
- [用户管理](#用户管理)
- [订单管理](#订单管理)
- [异步任务](#异步任务)
- [系统管理](#系统管理)

---

## 用户认证

> 端点前缀：`/api/v1/auth`

<details>
<summary>用例 1 — 用户登录（正常）</summary>

```json
// POST /api/v1/auth/login
{
  "username": "testuser@example.com",
  "password": "Test123456!"
}
```

**判定标准**：状态码 200，响应包含 `token` 和 `expires_at` 字段
</details>

<details>
<summary>用例 2 — 用户登录（密码错误）</summary>

```json
// POST /api/v1/auth/login
{
  "username": "testuser@example.com",
  "password": "WrongPassword"
}
```

**判定标准**：状态码 401，响应包含 `error` 字段，`message` 为"用户名或密码错误"
</details>

<details>
<summary>用例 3 — Token 刷新</summary>

```json
// POST /api/v1/auth/refresh
{
  "refresh_token": "eyJhbGciOiJIUzI1NiIs..."
}
```

**判定标准**：状态码 200，返回新的 `token`，旧 token 失效
</details>

---

## 用户管理

> 端点前缀：`/api/v1/users`

<details>
<summary>用例 4 — 获取当前用户信息</summary>

```json
// GET /api/v1/users/profile
// Header: Authorization: Bearer $TOKEN
```

**判定标准**：状态码 200，响应包含 `id`、`username`、`email`、`role` 字段
</details>

<details>
<summary>用例 5 — 修改用户信息</summary>

```json
// PUT /api/v1/users/profile
{
  "nickname": "测试用户",
  "avatar_url": "https://example.com/avatar.png"
}
```

**判定标准**：状态码 200，返回更新后的用户对象，`nickname` 已变更
</details>

<details>
<summary>用例 6 — 用户列表（分页+搜索）</summary>

```json
// GET /api/v1/users?page=1&page_size=10&keyword=test&status=active
// Header: Authorization: Bearer $ADMIN_TOKEN
```

**判定标准**：状态码 200，响应包含 `list`（数组）、`total`、`page`、`page_size`，`total >= 1`
</details>

---

## 订单管理

> 端点前缀：`/api/v1/orders`

<details>
<summary>用例 7 — 创建订单</summary>

```json
// POST /api/v1/orders
{
  "product_id": "prod_001",
  "quantity": 2,
  "payment_method": "alipay",
  "coupon_code": ""
}
```

**判定标准**：状态码 201，响应包含 `order_id`、`status`（应为 `pending`）、`total_amount`
</details>

<details>
<summary>用例 8 — 查询订单详情</summary>

```json
// GET /api/v1/orders/{order_id}
// Header: Authorization: Bearer $TOKEN
```

**判定标准**：状态码 200，响应包含 `order_id`、`status`、`items`（数组）、`created_at`
</details>

---

## 异步任务

> 端点前缀：`/api/v1/tasks`

<details>
<summary>用例 9 — 提交异步任务</summary>

```json
// POST /api/v1/tasks
{
  "type": "export",
  "params": {
    "format": "csv",
    "date_range": ["2026-01-01", "2026-03-31"],
    "fields": ["order_id", "user_id", "amount", "status"]
  }
}
```

**判定标准**：状态码 202，响应包含 `task_id` 且 `status` 为 `processing`
</details>

<details>
<summary>用例 10 — 查询任务状态</summary>

```json
// GET /api/v1/tasks/{task_id}
// Header: Authorization: Bearer $TOKEN
```

**判定标准**：
- 处理中：`status` = `processing`
- 成功：`status` = `success`，`result_url` 非空
- 失败：`status` = `failed`，`error` 包含错误信息
</details>

---

## 系统管理

> 端点前缀：`/api/v1/system`（仅管理员）

<details>
<summary>用例 11 — 健康检查</summary>

```json
// GET /api/v1/system/health
// 无需鉴权
```

**判定标准**：状态码 200，响应包含 `status`（应为 `ok`）、`version`、`uptime`
</details>

<details>
<summary>用例 12 — 系统配置查询</summary>

```json
// GET /api/v1/system/config
// Header: Authorization: Bearer $ADMIN_TOKEN
```

**判定标准**：状态码 200，响应包含配置项列表，敏感字段（密码/密钥）已脱敏
</details>

---

## 用例编写规范

新增用例时请遵循以下规范：

1. **每个接口至少 1 条正常用例 + 1 条异常用例**
2. **覆盖场景**：正常流程 / 参数校验失败 / 鉴权失败 / 权限不足 / 资源不存在
3. **判定标准必须明确**：状态码 + 关键字段 + 预期值
4. **敏感数据使用占位符**：`$TOKEN`、`$HOST`、`$ADMIN_TOKEN`
5. **异步任务**：提交后通过轮询或数据库查询验证最终状态
6. **幂等验证**：重复提交同一请求，确认不会产生重复数据
