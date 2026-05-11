# 25 Intent Recognition P0 Lite

定义 P0 的 Intent Recognition。

## P0 原则
- generation-first
- Claude structured output + fallback rules
- 不做 embedding router
- 不做 autonomous planner

## Intent 流程
User Message → Intent Extract → Candidate Skill Match → Missing Params → Schema Render
