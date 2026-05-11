# 04 User Client Tauri + Vue Spec v0.4

## 1. 技术栈冻结

```txt
Tauri 2.0
Vue 3
Naive UI
Pinia
Tailwind CSS
TypeScript
```

禁止把客户端写成 Electron。

## 2. 页面路由

| 路由 | 页面 | P0 | 进入条件 |
|---|---|---:|---|
| `/activation` | 激活页 | 是 | device 未激活 |
| `/chat` | Chat 首页 | 是 | device 已激活 |
| `/skills` | Skill 中心 | 是，备用 | device 已激活 |
| `/tasks/:id` | 任务详情 | 是 | 任务存在且属于当前设备/用户 |
| `/settings` | 设置页 | 是 | device 已激活 |
| `/custom-skills` | 自定义 Skill | 否，P1 | P0 显示未开放 |

## 3. App 启动流程

```txt
App start
→ load local device_code
→ if missing generate device_code
→ GET /api/v1/devices/status?device_code=xxx
→ active: route /chat
→ inactive/expired/unknown: route /activation
→ network_error: show retry + offline explanation
```

## 4. 激活页组件

### 4.1 元素

- Logo / 产品名
- 当前设备码
- 复制设备码按钮
- 客服微信说明区
- 激活码输入框
- 激活并进入聊天页按钮
- 错误提示区

### 4.2 交互

| 操作 | 行为 |
|---|---|
| 点击复制设备码 | 写入剪贴板，提示“已复制设备码” |
| 输入激活码 | 自动去除空格，转大写，保留分隔符 |
| 点击激活 | POST /api/v1/activation/activate |
| 激活成功 | 保存 token/activation state，跳转 `/chat` |
| 激活失败 | 显示后端错误文案 |

## 5. Chat 首页

Chat 是默认主入口，不要求用户进入 Skill 中心。

### 5.1 布局

```txt
左侧：任务历史 / Skill 备用入口 / 设置
中间：聊天消息流
底部：输入框 + 统一上传按钮 + 发送按钮
右侧：当前任务上下文卡，可折叠
```

### 5.2 消息类型

| 类型 | 用途 |
|---|---|
| user_text | 用户自然语言任务 |
| user_assets | 用户上传素材摘要 |
| system_understanding | 系统理解卡 |
| parameter_card | 动态参数卡 |
| progress_card | 任务进度 |
| result_card | 结果展示 |
| error_card | 错误/修复建议 |

## 6. 统一上传弹层

一个上传入口承接：

- 单张/多张图片
- 视频/音频预留
- 文件
- 文件夹
- 手动输入本地目录路径

### 6.1 上传后必须生成

```ts
interface ClientAssetDraft {
  local_temp_id: string
  file_name: string
  file_type: 'image' | 'video' | 'audio' | 'document' | 'folder' | 'unknown'
  file_size?: number
  hash?: string
  source_path?: string
  upload_order: number
  role_guess?: 'product_image' | 'reference_image' | 'logo' | 'background' | 'other'
  user_role?: string
  preview_url?: string
}
```

### 6.2 资产确认卡

用户必须能确认或修改素材角色。Runtime 不使用“第几张图”，只使用后端返回的 `asset_id` 和用户确认后的 `user_role`。

## 7. 动态参数卡

### 7.1 禁止

```txt
禁止在 Chat 组件内写死 productName/category/style/count/referenceImage 等字段。
```

### 7.2 正确流程

```txt
Intent Result
→ Candidate Skill
→ GET /api/v1/skills/{skill_id}/runtime-schema
→ Render by parameter_schema
→ Fill defaults from operational_params
→ Validate locally
→ Submit to task execute
```

### 7.3 支持控件

| schema 类型 | UI 控件 |
|---|---|
| string | 输入框 |
| string + enum | Select |
| number/integer | 数字输入 |
| boolean | Switch/Checkbox |
| array | 多选/标签 |
| asset_ref | 素材选择器 |
| object | 分组表单 |

## 8. 任务进度卡

用户端只显示：

- 当前阶段
- 百分比
- 简短错误
- 取消按钮

不显示：

- Prompt Fragment
- Strategy Weight
- Context Rule
- Workflow 内部节点细节

## 9. 结果卡

结果卡显示：

- 图片缩略图
- 单图查看
- 下载单张
- 下载全部
- 导出发布包
- 重新生成

导出发布包调用独立 REST：

```txt
POST /api/v1/tasks/{task_id}/export
```

不要封装为 SkillExecutor。

## 10. 前端自测清单

- 未激活设备不能进入 `/chat`
- 激活成功后刷新仍进入 `/chat`
- 上传 1 张图片、8 张图片、目录均能出现确认卡
- 修改素材角色后提交，后端收到 user_role
- 后台修改 schema 后，前端卡片字段变化
- 无权限 Skill 不展示执行按钮
- Chat 命中无权限 Skill 时不能执行
