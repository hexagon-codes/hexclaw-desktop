# 07 SkillRuntime & ImagePipeline Contract v0.4

## 1. 目标

把 `image_pipeline` 从“写死的电商生图流程”收敛为统一 SkillRuntime 下的第一个 Executor 实现。

## 2. 核心调用链

```txt
POST /api/v1/tasks/execute
→ TaskService.CreateTask
→ WorkflowService.ExecuteTask
→ SkillService.GetSkillDefinition
→ EntitlementService.AssertExecutable
→ SkillRuntime.ExecuteSkill(ctx, definition, input)
→ ExecutorRegistry.Get(definition.executor_type)
→ ImagePipelineExecutor.Execute(ctx, input)
→ Task Progress Update
→ Result Manifest
```

## 3. SkillDefinition

```go
type SkillDefinition struct {
    SkillID              string
    Name                 string
    Description          string
    Category             string
    RuntimeType          string
    ExecutorType         string
    RequiredCapabilities []string
    ParameterSchema      map[string]any
    UISchema             map[string]any
    OperationalParams    map[string]any
    Status               string
    Version              string
}
```

必填：

- skill_id
- runtime_type
- executor_type
- required_capabilities
- parameter_schema
- status

## 4. SkillExecutor 接口

```go
type SkillExecutor interface {
    Type() string
    Validate(ctx context.Context, input SkillInput) error
    Execute(ctx context.Context, input SkillInput, progress ProgressReporter) (SkillResult, error)
}
```

## 5. ImagePipelineExecutor 输入

```json
{
  "task_id": "tsk_001",
  "skill_id": "image_pipeline",
  "assets": [
    {
      "asset_id": "ast_001",
      "file_type": "image",
      "user_role": "product_image",
      "storage_url": "s3://..."
    }
  ],
  "parameters": {
    "productName": "运动鞋",
    "category": "鞋服",
    "outputMode": "detail",
    "style": "高级感",
    "imageCount": 4
  },
  "operational_params": {
    "provider": { "default": "gpt-image" },
    "imageCount": { "min": 1, "max": 9, "default": 4 }
  }
}
```

## 6. ImagePipelineExecutor 输出

```json
{
  "task_id": "tsk_001",
  "status": "succeeded",
  "results": [
    {
      "result_id": "res_001",
      "type": "image",
      "url": "https://...",
      "width": 1024,
      "height": 1024,
      "role": "detail_image"
    }
  ],
  "manifest": {
    "generated_count": 4,
    "provider": "gpt-image"
  }
}
```

## 7. 进度阶段

P0 用户端展示阶段：

| stage | progress | 用户可见文案 |
|---|---:|---|
| queued | 0 | 已创建任务 |
| validating | 10 | 正在检查素材与参数 |
| preparing_context | 20 | 正在准备任务上下文 |
| generating_prompt | 35 | 正在准备生成方案 |
| calling_provider | 55 | 正在生成图片 |
| post_processing | 80 | 正在整理结果 |
| saving_results | 90 | 正在保存结果 |
| succeeded | 100 | 已完成 |

不向用户展示内部 Prompt、Strategy、Context。

## 8. 参数校验规则

- imageCount 必须在 operational_params.imageCount.min/max 范围内
- productName 为空时必须缺参补齐
- product_image 至少 1 个
- reference_image 可选
- 输出模式必须属于 parameter_schema enum
- provider 错误要转换为统一 error_code

## 9. 错误码

| code | 说明 | 用户文案 |
|---|---|---|
| SKILL_DISABLED | Skill 停用 | 当前 Skill 暂不可用 |
| SKILL_NOT_ENTITLED | 无权限 | 当前激活码暂不包含该 Skill |
| PARAM_VALIDATION_FAILED | 参数校验失败 | 参数不完整，请检查后重试 |
| ASSET_MISSING | 缺少素材 | 请至少上传一张商品图 |
| PROVIDER_TIMEOUT | Provider 超时 | 图片生成超时，请稍后重试 |
| PROVIDER_FAILED | Provider 失败 | 图片生成失败，请稍后重试 |
| TASK_CANCELLED | 用户取消 | 任务已取消 |

## 10. 禁止实现方式

- 不允许在前端拼 Prompt
- 不允许把 image_pipeline 字段写死在 Chat 表单里
- 不允许绕过 SkillRuntime 直接调用 Provider
- 不允许把 export_pack/upload_confirm 注册为 SkillExecutor
- 不允许 P0 使用 Go plugin 动态加载 Executor
