# 01 Definition of Ready / Definition of Done v0.4

## 1. 文档可交付开发的判断标准

当前文档达到以下条件，才允许交给 AI 编程工作流：

| 检查项 | 必须满足 | 未满足时处理 |
|---|---|---|
| P0 范围 | 明确 P0/P1/P2/V2，不把远期能力写成当前任务 | 先改范围文档 |
| 角色 | 用户、超管、公司后台、分销商、系统服务边界清楚 | 先补权限矩阵 |
| 页面 | 每个 P0 页面有入口、状态、操作、成功/失败反馈 | 先补 UI 状态 |
| 接口 | 每个 P0 功能有请求、响应、错误码、权限点 | 先补 API Contract |
| 数据 | 每个核心实体有字段、状态机、索引建议 | 先补 Data Model |
| 异常 | 空值、重复、过期、无权限、网络错误均有处理 | 先补 Error Spec |
| 验收 | 每个功能有可执行验收用例 | 先补 UAT Case |
| AI 边界 | 明确“不允许改什么” | 先补 Guardrails |

## 2. P0 开发前 Definition of Ready

AI 开发前必须完成：

```txt
1. 已读取 README_START_HERE.md
2. 已读取 Master PRD
3. 已读取相关端的功能规格
4. 已读取 API/Data Model/Acceptance Tests
5. 已确认 P0 只做 SkillRuntime + image_pipeline + 激活授权 + 参数治理闭环
6. 已生成 analyze report，列出与当前代码库不一致之处
7. 已生成 plan，明确分阶段文件修改清单
8. 用户或项目负责人确认 plan 后，才进入 execute
```

## 3. P0 完成 Definition of Done

P0 不能只以“页面能打开”作为完成标准。必须满足：

```txt
1. 未激活设备首次打开进入激活页
2. 激活成功后进入 Chat 首页
3. Chat 可上传文件/目录，并生成 asset_id
4. Chat 可根据用户意图匹配 image_pipeline Skill
5. 缺参时渲染后端 parameter_schema 驱动的动态参数卡
6. 点击开始任务后创建 Task，并经过 SkillRuntime.ExecuteSkill
7. image_pipeline 结果能在用户端展示
8. 后台可编辑 Skill 基本信息、parameter_schema、operational_params
9. 后台修改参数后，用户端下一次任务表单自动变化
10. 无权限、过期、设备不匹配、任务失败均有明确提示
11. verify/review/test 阶段无 BLOCK 级问题
```

## 4. 禁止把这些当成完成

- 只有静态按钮，没有点击行为
- 只有前端假数据，没有后端 API
- 用户端硬编码 image_pipeline 表单
- 权限只在前端隐藏按钮，后端不校验
- 激活码没有唯一性和状态机
- 任务进度写死百分比
- 导出发布包被错误注册为 SkillExecutor
- P0 混入完整 Marketplace 或 Browser Runtime
