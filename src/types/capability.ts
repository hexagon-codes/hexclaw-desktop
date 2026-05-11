/**
 * Capability — 权限声明类型系统
 *
 * Capability = Permission Declaration，不是 Tool 执行。
 * 运行时字符串约束（非超大 union type）。
 *
 * @see docs/agents-OS/Capability-Spec.md
 */

/** Capability 名称（运行时字符串约束） */
export type CapabilityName = string

/** Capability 描述 */
export interface CapabilityDescriptor {
  name: CapabilityName
  description: string
  riskLevel: 'low' | 'medium' | 'high'
}

/** 内置 Capability 列表 */
export const BUILTIN_CAPABILITIES: CapabilityDescriptor[] = [
  { name: 'llm',              description: '通用 LLM 调用',        riskLevel: 'medium' },
  { name: 'llm.chat',         description: '对话式 LLM',           riskLevel: 'low' },
  { name: 'llm.completion',   description: '补全式 LLM',           riskLevel: 'low' },
  { name: 'image_generation', description: '图像生成',             riskLevel: 'medium' },
  { name: 'video_generation', description: '视频生成',             riskLevel: 'medium' },
  { name: 'audio_generation', description: '音频生成',             riskLevel: 'medium' },
  { name: 'filesystem.read',  description: '读文件',               riskLevel: 'medium' },
  { name: 'filesystem.write', description: '写文件',               riskLevel: 'high' },
  { name: 'filesystem.delete',description: '删文件',               riskLevel: 'high' },
  { name: 'network.http',     description: 'HTTP 请求',            riskLevel: 'high' },
  { name: 'browser.navigate', description: '浏览器导航',           riskLevel: 'medium' },
  { name: 'browser.extract',  description: '浏览器内容提取',       riskLevel: 'low' },
  { name: 'system.shell',     description: 'Shell 执行',           riskLevel: 'high' },
  { name: 'system.clipboard', description: '剪贴板访问',           riskLevel: 'high' },
  { name: 'system.notification', description: '系统通知',          riskLevel: 'low' },
  { name: 'skill.execute',    description: 'Skill 执行',           riskLevel: 'medium' },
  { name: 'skill.discover',   description: 'Skill 发现',           riskLevel: 'low' },
  { name: 'skill.load',       description: 'Skill 加载',           riskLevel: 'low' },
]

/** 内置 Capability 名称集合（快速查找） */
export const BUILTIN_CAPABILITY_NAMES: ReadonlySet<CapabilityName> =
  new Set(BUILTIN_CAPABILITIES.map(c => c.name))

/** 默认允许的 Capability 列表（System Layer 默认 policy） */
export const DEFAULT_ALLOWED_CAPABILITIES: CapabilityName[] = [
  'llm',
  'image_generation',
  'filesystem.read',
]
