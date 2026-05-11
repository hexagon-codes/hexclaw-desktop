# 13 Implementation Task Breakdown Waterfall v0.4

## 1. 执行策略

采用“文档瀑布 + AI 小步执行”。不要一次让 AI 开发整个项目。

```txt
Analyze codebase
→ Confirm gap map
→ Plan phase
→ Execute phase
→ Verify phase
→ Review phase
→ Business test
→ Milestone audit
```

## 2. Milestone M0：代码库扫描与差异报告

目标：确认当前代码与文档差异。

交付：

- `analysis_report.md`
- `gap_map.md`
- `file_change_plan.md`

禁止：M0 不写功能代码。

## 3. Milestone M1：激活码与设备授权闭环

任务：

1. 设备码生成与本地持久化
2. 设备状态 API
3. 激活 API
4. activation_codes / devices 表
5. 用户端激活页
6. 后台激活码批量生成
7. 后台设备解绑/停用
8. UAT ACT-001 ~ ACT-006

完成标准：新设备能激活，已激活设备重启进入 Chat。

## 4. Milestone M2：SkillRuntime 与 image_pipeline Contract

任务：

1. SkillDefinition 字段补齐
2. ExecutorRegistry 确认/补齐
3. SkillRuntime.ExecuteSkill 权限前置
4. ImagePipelineExecutor 输入输出标准化
5. Task 进度更新
6. Error code 统一
7. UAT RUN-001 ~ RUN-006

完成标准：任务从 POST /tasks/execute 进入 SkillRuntime 并生成结果。

## 5. Milestone M3：用户端 Chat-first + 上传 + 动态参数卡

任务：

1. Chat 首页默认入口
2. 统一上传弹层
3. asset_id 资产确认卡
4. Intent → Skill Match 接口衔接
5. runtime-schema 拉取
6. 参数卡由 schema 渲染
7. 任务进度卡
8. 结果卡
9. UAT CHAT/PARAM 全部用例

完成标准：用户不进 Skill 中心，也能完成 image_pipeline 任务。

## 6. Milestone M4：公司后台 Skill 参数治理

任务：

1. Skill 列表接真实 API
2. SkillEditModal 接真实 API
3. ParameterSchema 编辑/校验/保存
4. OperationalParams 编辑/保存
5. Skill 停用影响用户端执行
6. Dashboard 基础统计
7. UAT ADM-001 ~ ADM-006

完成标准：后台修改 schema/params 后用户端新任务同步变化。

## 7. Milestone M5：安全、错误、回归测试

任务：

1. 后端权限统一检查点
2. 用户端无权限提示
3. 日志脱敏
4. 错误码映射
5. 端到端回归测试
6. 文档更新

完成标准：无 BLOCK，核心流程稳定。

## 8. AI 每次执行的输出要求

每个 Milestone 结束必须输出：

```txt
1. 改了哪些文件
2. 为什么改
3. 已跑哪些测试
4. 哪些测试没跑，原因是什么
5. 和文档还有哪些差距
6. 是否可以进入下一 Milestone
```
