# TASK-TRB-002 Summary: Go backend system_prompt 接口契约

## Status: ✅ 已完成

## 改动内容

**文件**: `docs/system-prompt-contract.md`（新建）

契约文档包含：
1. **背景**: system_prompt 字段的作用和使用场景
2. **接口定义**: POST /api/v1/chat 请求体字段语义（message, system_prompt, request_id）
3. **契约规则 4 条**:
   - 规则 1: system_prompt 不嵌入 messages 数组，作为 LLM API 独立参数
   - 规则 2: system_prompt 不参与缓存 key 计算
   - 规则 3: system_prompt 值原文传递，不转义/截断
   - 规则 4: 可选向后兼容（message 中不含 system role）
4. **Go backend Handler 改动指南**: 当前行为 → 期望行为代码对比
5. **验证方法**: 3 个测试场景
6. **状态追踪**:
   - 前端 providerAdapter.ts: ✅ 已兼容
   - 前端 backendLLMClient.ts: ✅ 已支持
   - Tauri commands.rs: ✅ 已支持
   - Go backend (hexclaw): ❌ 待修复（外部仓库）

## 约束遵守

- ✅ 只创建 docs/system-prompt-contract.md
- ✅ 未声称 Go backend 已修复
- ✅ 状态追踪明确区分 3 层
