/**
 * HexClaw Desktop 类型定义统一入口
 *
 * 所有领域模型、API DTO、UI 类型从此处集中导出，
 * 各模块统一从 @/types 导入，避免类型定义散落。
 */

// ─── 领域模型 ───────────────────────────────────────

export type { ChatMessage, ToolCall, ChatSession, ChatRequest, ChatAttachment, Artifact, ChatMode, ExecMode } from './chat'
export type { AgentRole, AgentConfig } from './agent'
export type { LogEntry, LogQuery, LogStats } from './log'
export type { MemoryData } from './memory'
export type { McpServer, McpTool } from './mcp'
export type { Skill, ClawHubSkill } from './skill'
export type { CronJob, CronJobInput } from './task'
export type { KnowledgeDoc, KnowledgeSearchResult } from './knowledge'
export type {
  CanvasNode,
  CanvasEdge,
  Workflow,
  WorkflowRunStatus,
  WorkflowRun,
} from './canvas'
export type {
  AppConfig,
  LLMConfig,
  SecurityConfig,
  GeneralConfig,
  NotificationConfig,
  MCPConfig,
  ProviderConfig,
  ProviderType,
  ProviderPreset,
  ModelOption,
  ModelCapability,
  ChatParams,
  BackendLLMProvider,
  BackendLLMConfig,
} from './settings'
export type { SystemStats, PlatformInfo } from './system'

// ─── UI 类型 ─────────────────────────────────────────

export type { Toast } from './ui'

// ─── 通用类型 ────────────────────────────────────────

export type { ApiError, ApiErrorCode } from './error'
