/**
 * K12 家长辅导助手场景包（features/k12）· **前端唯一 K12 领域词落点**（架构 §6.5）。
 * 对外只暴露装配入口与内部件；通用 shell 通过 scenarioRegistry 消费，不 import 本模块。
 */
export { registerK12Scenario, isK12Instance, __resetK12Registration } from './register'
export { K12_VIEW_DESCRIPTOR, K12_SCENARIO_ID } from './descriptor'
export { MISTAKE_SCHEMA, ACCUMULATION_SCHEMA, MISTAKE_COLLECTION, K12_SCHEMAS } from './schemas'
export { useK12Store } from './store'
export { mistakeToRecord, mistakesToView, gradeToResult, gradeToVerify } from './mappers'
export type { GradeViewResult } from './mappers'
