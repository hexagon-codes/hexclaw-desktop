# `src/contracts/generated/`（codegen 目标目录 · 占位）

架构 §6.5 / §8.4：本目录是**后端 `api/view_contracts/`（JSON Schema）生成 TS 类型**的落点。

当前状态：**空占位**。前端采用「契约先行」，手写契约类型在 `src/contracts/*.ts`。
后端 `api/view_contracts/` 定稿后：

1. 引入 codegen（如 `json-schema-to-typescript`）把 JSON Schema 生成到本目录；
2. 让 `src/contracts/index.ts` 从 `./generated` re-export，手写类型收敛为兼容/适配层；
3. 校验 `schemaVersion` 一致性（IA 四方一致性门，发版 checklist）。

在此之前，业务代码统一从 `@/contracts` 导入，不直接依赖本目录，切换零改调用方。
