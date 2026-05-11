/**
 * TimelineSerializer — RuntimeEvent[] ↔ TimelineSnapshot 序列化
 *
 * RuntimeEvent 全 JSON-safe（string/number/boolean 标量 payload），
 * 无需特殊序列化处理。
 *
 * 红线：
 * - 不修改 TimelineStore
 * - 不修改 Timeline append-only 语义
 */

import type { RuntimeEvent } from '@/types/timeline'
import type { TimelineSnapshot } from '@/types/persistence'

/**
 * 序列化 RuntimeEvent[] → TimelineSnapshot。
 */
export function serializeTimeline(events: RuntimeEvent[]): TimelineSnapshot {
  return {
    formatVersion: '1.0',
    updatedAt: new Date().toISOString(),
    events: [...events],
  }
}

/**
 * 反序列化 TimelineSnapshot → RuntimeEvent[]。
 * 保留原始 id / timestamp，不做修改。
 */
export function deserializeTimeline(snapshot: TimelineSnapshot): RuntimeEvent[] {
  return [...snapshot.events]
}
