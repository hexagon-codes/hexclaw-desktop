<script setup lang="ts">
/**
 * 智能体挂载 Skill 选择器（原型规模化方案落地，BUG-20260703 批次）：
 * 已选置顶（带 ✕）+「已挂载 N 个」计数 + 搜索过滤 + ✓ 选中态。
 * 保持既有测试契约：每个 chip data-testid=`agent-adv-skill-<name>`、aria-pressed、点击切换。
 */
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import SearchInput from '@/components/common/SearchInput.vue'

/** 选择器只需要的最小 skill 结构（与 AgentsView 懒加载的列表形状一致，不绑定完整 Skill 类型） */
interface PickerSkill {
  name: string
  description?: string
  icon?: string
}

const { t } = useI18n()

const props = defineProps<{
  available: PickerSkill[]
  modelValue: string[]
}>()

const emit = defineEmits<{ 'update:modelValue': [value: string[]] }>()

const filter = ref('')

const selectedSet = computed(() => new Set(props.modelValue))

const selectedSkills = computed<PickerSkill[]>(() =>
  props.modelValue
    .map((name) => props.available.find((s) => s.name === name) ?? { name, description: '' }),
)

const filteredSkills = computed(() => {
  const q = filter.value.trim().toLowerCase()
  if (!q) return props.available
  return props.available.filter(
    (s) => s.name.toLowerCase().includes(q) || (s.description ?? '').toLowerCase().includes(q),
  )
})

function toggle(name: string) {
  const next = selectedSet.value.has(name)
    ? props.modelValue.filter((n) => n !== name)
    : [...props.modelValue, name]
  emit('update:modelValue', next)
}

/** chip 图标：SKILL.md frontmatter icon 是 emoji 时直接用，否则不显（lucide 名交给列表页派生逻辑）。 */
function chipIcon(s: PickerSkill): string {
  const icon = s.icon
  if (icon && !/^[A-Za-z]/.test(icon)) return icon
  return ''
}
</script>

<template>
  <div class="flex flex-col gap-2">
    <div class="flex items-baseline gap-2">
      <span class="text-[12px] font-medium" :style="{ color: 'var(--hc-text-secondary)' }">
        {{ t('agents.skillsLabel', '挂载 Skill') }}
      </span>
      <span class="text-[11.5px] font-semibold" :style="{ color: 'var(--hc-accent)' }" data-testid="agent-skill-count">
        {{ modelValue.length ? t('agents.skillsMounted', { n: modelValue.length }) : t('agents.skillsNone', '未挂载') }}
      </span>
      <span class="text-[11.5px] ml-auto" :style="{ color: 'var(--hc-text-muted)' }">
        {{ t('agents.skillsHint', '对话中自动可用') }}
      </span>
    </div>

    <!-- 已选置顶（带 ✕ 快速移除） -->
    <div v-if="selectedSkills.length" class="flex flex-wrap gap-1.5" data-testid="agent-skill-selected">
      <button
        v-for="s in selectedSkills"
        :key="`sel-${s.name}`"
        type="button"
        class="px-2 py-1 rounded-md text-[12px] border inline-flex items-center gap-1"
        :style="{
          cursor: 'pointer',
          background: 'var(--hc-accent-subtle, rgba(95,179,234,.14))',
          borderColor: 'var(--hc-accent)',
          color: 'var(--hc-accent)',
        }"
        @click="toggle(s.name)"
      >
        <span v-if="chipIcon(s)">{{ chipIcon(s) }}</span>{{ s.name }}<span class="font-bold">✕</span>
      </button>
    </div>

    <SearchInput
      v-model="filter"
      fluid
      :placeholder="t('agents.skillsFilterPh', '搜索 Skill…')"
      input-test-id="agent-skill-filter"
    />

    <div v-if="available.length === 0" class="text-[12px]" :style="{ color: 'var(--hc-text-muted)' }">
      {{ t('agents.noSkillsAvailable', '暂无已安装的 Skill') }}
    </div>
    <div v-else-if="filteredSkills.length === 0" class="text-[12px]" :style="{ color: 'var(--hc-text-muted)' }">
      {{ t('agents.skillsNoMatch', { q: filter }) }}
    </div>
    <div v-else class="flex flex-wrap gap-1.5">
      <button
        v-for="s in filteredSkills"
        :key="s.name"
        type="button"
        class="px-2 py-1 rounded-md text-[12px] border inline-flex items-center gap-1"
        :data-testid="`agent-adv-skill-${s.name}`"
        :aria-pressed="selectedSet.has(s.name)"
        :title="s.description"
        :style="{
          cursor: 'pointer',
          background: selectedSet.has(s.name) ? 'var(--hc-accent-subtle, rgba(95,179,234,.14))' : 'var(--hc-bg-input)',
          borderColor: selectedSet.has(s.name) ? 'var(--hc-accent)' : 'var(--hc-border)',
          color: selectedSet.has(s.name) ? 'var(--hc-accent)' : 'var(--hc-text-secondary)',
        }"
        @click="toggle(s.name)"
      >
        <span v-if="selectedSet.has(s.name)" class="font-bold">✓</span>
        <span v-else-if="chipIcon(s)">{{ chipIcon(s) }}</span>
        {{ s.name }}
      </button>
    </div>
  </div>
</template>
