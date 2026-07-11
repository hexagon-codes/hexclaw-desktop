/**
 * 前端契约层（L4 视图）· 架构 §6.5 `src/contracts/generated`。
 *
 * 「前端契约先行」：这里是手写的 L3↔L4 契约类型；后端 `api/view_contracts/`（JSON Schema）
 * 就绪后由 codegen 产出 `./generated/`，本 barrel 切换到生成类型。
 *
 * 领域无关红线：本目录零场景领域字面量。场景业务词只活在 `src/features/<scenario>/`。
 */
export * from './view-descriptor'
export * from './record-schema'
export * from './verify'
