# `src/contracts/generated/`（codegen 目标目录）

架构 §6.5 / §8.4：本目录保存由后端 `api/view_contracts/` 中的 versioned JSON Schema
确定性生成的 TypeScript wire 类型与运行时 validator。

当前已提交生成物：

- `k12-image-task.v1.ts`：来自
  `../hexclaw/api/view_contracts/k12-image-task.v1.schema.json` 的 ImageTask v1 契约。

生成物是唯一的 ImageTask wire exact-set 来源，禁止手工编辑。更新 schema 后在 Desktop
仓库运行：

```sh
pnpm contracts:generate
pnpm contracts:check
```

`contracts:check` 会重新生成并逐字节比较已提交文件；任何 schema 或生成物单边漂移都必须
失败。API 适配层直接从 `@/contracts/generated/k12-image-task.v1` 导入 validator，并仅在
该边界叠加不属于 wire shape 的领域语义校验。
