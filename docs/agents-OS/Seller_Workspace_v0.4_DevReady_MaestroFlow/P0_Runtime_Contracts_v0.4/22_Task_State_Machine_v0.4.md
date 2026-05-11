# 22 Task State Machine v0.4

定义 Task 生命周期状态机。

核心状态：draft → queued → preparing → running → post_processing → succeeded。
异常状态：failed / cancel_requested / cancelled / timeout / retrying。

## 核心规则
- progress 单调递增
- running 必须 heartbeat
- cancel_requested 必须传播 cancel token
- retry 仅允许 transient error

## P0 范围
- 单 Runtime
- generation runtime
- 不做 DAG/multi-agent
