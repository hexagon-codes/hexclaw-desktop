/**
 * K12 实例视图描述符（features/k12）· 架构 §8.4。
 *
 * 这份声明就是原型里 k12chat/records 头部 + composer 预设的**契约化落点**——
 * shell 只渲染本描述符，不认识"错题本"。（20260709：辅导要点侧栏退役，辅导要点内联进识题流，故本描述符
 * 不再声明 tutoring-tips 侧栏/头部动作。）后端 view descriptor 端点就绪后，
 * 本静态声明由 `getInstanceViewDescriptor(agentId)` 的真实响应替换（fallback 保留）。
 */
import type { InstanceViewDescriptor } from '@/contracts'
import { MISTAKE_SCHEMA, ACCUMULATION_SCHEMA } from './schemas'

export const K12_SCENARIO_ID = 'k12-tutor'

export const K12_VIEW_DESCRIPTOR: InstanceViewDescriptor = {
  schemaVersion: '1',
  i18nNamespace: 'k12',
  // IA 定稿（PRD §1.5，2026-07-18 迁移）：顶栏三段「辅导｜学习档案｜学情」，学情=一等 Tab（kind: report）。
  headerTabs: [
    { id: 'chat', labelKey: 'k12.tabs.chat', kind: 'chat', icon: '💬' },
    {
      id: 'records',
      labelKey: 'k12.tabs.records',
      kind: 'records',
      collection: MISTAKE_SCHEMA.collection,
      icon: '📚',
    },
    { id: 'insights', labelKey: 'k12.tabs.insights', kind: 'report', icon: '📈' },
  ],
  messageBadges: ['verify', 'record-chip'],
  // composer chips 由后端 descriptor.composer_chips 下发（契约缺口，后端补），前端从 descriptor 渲染，
  // 不在此静态硬编码 K12 chip（避免场景字面量进通用 composer · AP-1）。
  composer: {
    placeholderKey: 'k12.composer.placeholder',
    hint: {
      emphasisKey: 'k12.composer.formulaHintLead',
      detailKey: 'k12.composer.formulaHintDetail',
    },
  },
  // 权威原型 app.html 的 K12 辅导页没有额外空态卡；保持通用会话区，不注入原型外入口。
  recordCollections: [
    {
      collection: MISTAKE_SCHEMA.collection,
      labelKey: 'k12.collections.mistakes',
      schemaVersion: MISTAKE_SCHEMA.schemaVersion,
    },
    {
      collection: ACCUMULATION_SCHEMA.collection,
      labelKey: 'k12.collections.accumulation',
      schemaVersion: ACCUMULATION_SCHEMA.schemaVersion,
    },
  ],
  // 20260709：辅导要点侧栏退役 → 辅导要点内联进识题流（RecognizeGuardPanel），故无 tutoring-tips 侧栏/头部动作。
  sidePanels: [],
  // 学习档案中的导出/备份入口由 RecordsView 唯一承载，不再保留未消费的重复动作声明。
  actions: [],
}
