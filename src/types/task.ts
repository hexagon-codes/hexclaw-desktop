/** 编译后的可执行规约（hexclaw 后端 v2 架构产物） */
export interface JobSpec {
  /**
   * 'python3': compiled script executed in sandbox.
   * 'agent': AI reasoning per run — script is empty and compiled.at is the
   * zero time ("0001-01-01T00:00:00Z"), so the UI must not render script info.
   */
  runtime: 'python3' | 'agent'
  script: string
  deps: string[]
  inputs?: Record<string, unknown>
  timeout_s: number
  compiled: {
    model: string
    at: string
    tokens_in: number
    tokens_out: number
    hash: string
  }
}

/** 定时任务 */
export interface CronJob {
  id: string
  name: string
  type: 'cron' | 'once'
  schedule: string       // Cron expression: "0 9 * * *", "@daily", "@every 5m"
  user_id: string
  status: 'active' | 'paused' | 'done'
  last_run_at: string
  next_run_at: string
  run_count: number
  created_at: string

  /** v2: 用户原始需求（仅供 UI 展示） */
  source_prompt: string
  /** v2: 编译后的可执行规约；null 表示旧任务被清理（理论上不应出现） */
  spec: JobSpec | null

  /**
   * 投递目标列表（后端 Job.Deliver，meta JSON 持久化）。
   * 每项是 "chat"（桌面 chat 流）或一个连接引用——按 Manager.Send 解析顺序
   * 匹配 IM 实例 id → name → provider(type)。空/缺省时后端回退 ["chat"]。
   */
  deliver?: string[]
}

/** 创建任务请求 */
export interface CronJobInput {
  name: string
  schedule: string
  prompt: string
  type?: 'cron' | 'once'
  /**
   * 显式投递目标（通用渠道类型 chat/push/feishu/discord/wechat，或已配置连接实例 id/name）。
   * 留空 → 后端按 prompt 由 LLM 推导（默认 ["chat"]）；非空 → 直接覆盖（§5 一处存处处引）。
   */
  deliver?: string[]
  /**
   * IM/连接投递目标的会话/群组 ID。后端 Deliverer（cmd/hexclaw/main.go:1341）对 IM 目标
   * 在 chat_id 为空时硬失败（"has no chat_id for IM target"）。chat/push 不需要。
   */
  chat_id?: string
  /**
   * 持续型任务：长目标分多次累积推进，每 tick 只做下一个增量、带跨 tick 进度存档（重启可续），
   * 目标完成 / 连续无进展 / 达上限自动收工。强制 agent 模式（每 tick 需推理"下一个增量"）。
   */
  continuous?: boolean
  /**
   * 初始暂停态创建：权限预检命中「需审批」且用户选择任务级授权时，先以暂停态冻结任务意图
   * （入库不入调度），授权写入后 resume 启用——避免「创建即跑」把未授权动作跑进拦截。
   */
  paused?: boolean
}
