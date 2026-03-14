<script setup lang="ts">
import { ref } from 'vue'
import { X, FileText, Mail, Search, Code, Shield, Database } from 'lucide-vue-next'

const emit = defineEmits<{
  select: [template: WorkflowTemplate]
  close: []
}>()

export interface WorkflowTemplate {
  id: string
  name: string
  description: string
  category: string
  icon: any
  nodes: { id: string; type: string; label: string; x: number; y: number; config: Record<string, string> }[]
  edges: { id: string; from: string; to: string }[]
}

const templates: WorkflowTemplate[] = [
  {
    id: 'daily-digest',
    name: '每日摘要',
    description: '自动收集当日信息并生成结构化摘要报告',
    category: '效率',
    icon: FileText,
    nodes: [
      { id: 'n1', type: 'agent', label: '信息收集', x: 100, y: 100, config: { prompt: '收集今日重要信息' } },
      { id: 'n2', type: 'agent', label: '分类整理', x: 350, y: 100, config: { prompt: '按主题分类整理' } },
      { id: 'n3', type: 'agent', label: '生成报告', x: 600, y: 100, config: { prompt: '生成结构化摘要' } },
      { id: 'n4', type: 'output', label: '输出摘要', x: 850, y: 100, config: {} },
    ],
    edges: [
      { id: 'e1', from: 'n1', to: 'n2' },
      { id: 'e2', from: 'n2', to: 'n3' },
      { id: 'e3', from: 'n3', to: 'n4' },
    ],
  },
  {
    id: 'email-triage',
    name: '邮件分类处理',
    description: '自动分类邮件并根据优先级执行不同操作',
    category: '邮件',
    icon: Mail,
    nodes: [
      { id: 'n1', type: 'agent', label: '读取邮件', x: 100, y: 150, config: {} },
      { id: 'n2', type: 'condition', label: '优先级判断', x: 350, y: 150, config: { condition: 'priority' } },
      { id: 'n3', type: 'agent', label: '紧急处理', x: 600, y: 50, config: { prompt: '立即回复紧急邮件' } },
      { id: 'n4', type: 'agent', label: '常规归档', x: 600, y: 250, config: { prompt: '分类归档' } },
    ],
    edges: [
      { id: 'e1', from: 'n1', to: 'n2' },
      { id: 'e2', from: 'n2', to: 'n3' },
      { id: 'e3', from: 'n2', to: 'n4' },
    ],
  },
  {
    id: 'research-pipeline',
    name: '深度研究流程',
    description: '多步骤研究：搜索 → 分析 → 交叉验证 → 生成报告',
    category: '研究',
    icon: Search,
    nodes: [
      { id: 'n1', type: 'agent', label: '主题搜索', x: 100, y: 100, config: {} },
      { id: 'n2', type: 'agent', label: '深度分析', x: 350, y: 50, config: {} },
      { id: 'n3', type: 'tool', label: '知识库检索', x: 350, y: 200, config: { tool: 'knowledge_search' } },
      { id: 'n4', type: 'agent', label: '交叉验证', x: 600, y: 100, config: {} },
      { id: 'n5', type: 'output', label: '研究报告', x: 850, y: 100, config: {} },
    ],
    edges: [
      { id: 'e1', from: 'n1', to: 'n2' },
      { id: 'e2', from: 'n1', to: 'n3' },
      { id: 'e3', from: 'n2', to: 'n4' },
      { id: 'e4', from: 'n3', to: 'n4' },
      { id: 'e5', from: 'n4', to: 'n5' },
    ],
  },
  {
    id: 'code-review',
    name: '代码审查流水线',
    description: '安全检查 → 代码质量 → 性能分析 → 综合报告',
    category: '开发',
    icon: Code,
    nodes: [
      { id: 'n1', type: 'tool', label: '获取 PR', x: 100, y: 150, config: { tool: 'github_pr' } },
      { id: 'n2', type: 'agent', label: '安全审查', x: 350, y: 50, config: { prompt: '检查安全漏洞' } },
      { id: 'n3', type: 'agent', label: '代码质量', x: 350, y: 150, config: { prompt: '检查代码质量' } },
      { id: 'n4', type: 'agent', label: '性能分析', x: 350, y: 250, config: { prompt: '分析性能影响' } },
      { id: 'n5', type: 'agent', label: '综合报告', x: 600, y: 150, config: {} },
    ],
    edges: [
      { id: 'e1', from: 'n1', to: 'n2' },
      { id: 'e2', from: 'n1', to: 'n3' },
      { id: 'e3', from: 'n1', to: 'n4' },
      { id: 'e4', from: 'n2', to: 'n5' },
      { id: 'e5', from: 'n3', to: 'n5' },
      { id: 'e6', from: 'n4', to: 'n5' },
    ],
  },
  {
    id: 'security-scan',
    name: '安全巡检',
    description: '定期安全检查和合规性审计',
    category: '安全',
    icon: Shield,
    nodes: [
      { id: 'n1', type: 'agent', label: '收集系统状态', x: 100, y: 100, config: {} },
      { id: 'n2', type: 'agent', label: '漏洞扫描', x: 350, y: 100, config: {} },
      { id: 'n3', type: 'condition', label: '有风险?', x: 600, y: 100, config: {} },
      { id: 'n4', type: 'agent', label: '生成告警', x: 850, y: 50, config: {} },
      { id: 'n5', type: 'output', label: '报告归档', x: 850, y: 200, config: {} },
    ],
    edges: [
      { id: 'e1', from: 'n1', to: 'n2' },
      { id: 'e2', from: 'n2', to: 'n3' },
      { id: 'e3', from: 'n3', to: 'n4' },
      { id: 'e4', from: 'n3', to: 'n5' },
    ],
  },
  {
    id: 'data-pipeline',
    name: '数据处理流水线',
    description: '数据采集 → 清洗 → 分析 → 可视化',
    category: '数据',
    icon: Database,
    nodes: [
      { id: 'n1', type: 'tool', label: '数据采集', x: 100, y: 100, config: {} },
      { id: 'n2', type: 'agent', label: '数据清洗', x: 350, y: 100, config: {} },
      { id: 'n3', type: 'agent', label: '数据分析', x: 600, y: 100, config: {} },
      { id: 'n4', type: 'output', label: '生成图表', x: 850, y: 100, config: {} },
    ],
    edges: [
      { id: 'e1', from: 'n1', to: 'n2' },
      { id: 'e2', from: 'n2', to: 'n3' },
      { id: 'e3', from: 'n3', to: 'n4' },
    ],
  },
]

const categories = ['全部', '效率', '邮件', '研究', '开发', '安全', '数据']
const activeCategory = ref('全部')

const filtered = ref(templates)

function filterByCategory(cat: string) {
  activeCategory.value = cat
  filtered.value = cat === '全部' ? templates : templates.filter(t => t.category === cat)
}
</script>

<template>
  <Teleport to="body">
    <div class="hc-tpl-overlay" @click.self="emit('close')">
      <div class="hc-tpl">
        <div class="hc-tpl__header">
          <h2 class="hc-tpl__title">工作流模板</h2>
          <button class="hc-tpl__close" @click="emit('close')">
            <X :size="17" />
          </button>
        </div>

        <div class="hc-tpl__cats">
          <button
            v-for="cat in categories"
            :key="cat"
            class="hc-tpl__cat"
            :class="{ 'hc-tpl__cat--active': activeCategory === cat }"
            @click="filterByCategory(cat)"
          >
            {{ cat }}
          </button>
        </div>

        <div class="hc-tpl__grid">
          <button
            v-for="tpl in filtered"
            :key="tpl.id"
            class="hc-tpl__card"
            @click="emit('select', tpl)"
          >
            <div class="hc-tpl__card-icon">
              <component :is="tpl.icon" :size="20" />
            </div>
            <div class="hc-tpl__card-info">
              <span class="hc-tpl__card-name">{{ tpl.name }}</span>
              <span class="hc-tpl__card-desc">{{ tpl.description }}</span>
            </div>
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.hc-tpl-overlay {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(4px);
}

.hc-tpl {
  width: 100%;
  max-width: 640px;
  max-height: 80vh;
  border-radius: var(--hc-radius-xl);
  background: var(--hc-bg-elevated);
  border: 1px solid var(--hc-border);
  box-shadow: var(--hc-shadow-float);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  animation: hc-scale-in 0.2s cubic-bezier(0.25, 0.1, 0.25, 1);
}

.hc-tpl__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--hc-divider);
}

.hc-tpl__title {
  font-size: 15px;
  font-weight: 600;
  color: var(--hc-text-primary);
  margin: 0;
}

.hc-tpl__close {
  padding: 4px;
  border-radius: var(--hc-radius-sm);
  border: none;
  background: transparent;
  color: var(--hc-text-muted);
  cursor: pointer;
}

.hc-tpl__cats {
  display: flex;
  gap: 4px;
  padding: 12px 20px;
  border-bottom: 1px solid var(--hc-divider);
  overflow-x: auto;
}

.hc-tpl__cat {
  padding: 4px 12px;
  border-radius: 100px;
  border: none;
  background: var(--hc-bg-hover);
  color: var(--hc-text-secondary);
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.15s, color 0.15s;
}

.hc-tpl__cat--active {
  background: var(--hc-accent);
  color: #fff;
}

.hc-tpl__grid {
  flex: 1;
  overflow-y: auto;
  padding: 16px 20px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.hc-tpl__card {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 14px 16px;
  border-radius: var(--hc-radius-md);
  border: 1px solid var(--hc-border);
  background: var(--hc-bg-card);
  cursor: pointer;
  text-align: left;
  transition: border-color 0.15s, box-shadow 0.15s;
}

.hc-tpl__card:hover {
  border-color: var(--hc-accent);
  box-shadow: var(--hc-shadow-sm);
}

.hc-tpl__card-icon {
  width: 40px;
  height: 40px;
  border-radius: var(--hc-radius-md);
  background: var(--hc-accent-subtle);
  color: var(--hc-accent);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.hc-tpl__card-info {
  flex: 1;
  display: flex;
  flex-direction: column;
}

.hc-tpl__card-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--hc-text-primary);
}

.hc-tpl__card-desc {
  font-size: 12px;
  color: var(--hc-text-muted);
  margin-top: 2px;
}
</style>
