<script setup lang="ts">
/**
 * 技能预览弹窗（市场 / 已安装 共用 · 方案 C 抽单一真相）。
 *
 * 同一个壳,footer 按上下文自适应：
 *  - mode='hub'（市场）：转化面 → [关闭] [安装]（已安装则禁用态「已安装」）
 *  - mode='installed'（已安装）：信任+管理面 → [删除] [启停] [关闭]
 * 头部/正文（触发词 + 描述 + SKILL.md）两端同构。Apple 级细节：Esc 关闭、scale 弹入、背板毛玻璃、
 * 正文加载走骨架屏而非「加载中…」文字。
 */
import { watch, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import { X, Download, CheckCircle2, Trash2 } from 'lucide-vue-next'
import SkillIcon from '@/components/common/SkillIcon.vue'
import SkillMarkdownPreview from '@/components/skills/SkillMarkdownPreview.vue'

/** 两端共有的最小形状（Skill / ClawHubSkill 都满足）。SkillIcon 需要 icon/name/tags，故整对象透传。 */
interface PreviewSkill {
  name: string
  display_name?: string
  description?: string
  author?: string
  version?: string
  icon?: string
  triggers?: string[]
  tags?: string[]
  category?: string
}

const props = withDefaults(
  defineProps<{
    skill: PreviewSkill | null
    content: string
    loading: boolean
    error: string
    mode: 'hub' | 'installed'
    /** 已安装：运行态/本地偏好 文案 */
    scopeLabel?: string
    /** 已安装：当前启用态 */
    enabled?: boolean
    /** 市场：是否已安装（决定安装按钮禁用） */
    installed?: boolean
    /** 安装/启停 进行中 */
    busy?: boolean
  }>(),
  { scopeLabel: '', enabled: true, installed: false, busy: false },
)

const emit = defineEmits<{
  close: []
  install: []
  'toggle-enabled': []
  delete: []
}>()

const { t } = useI18n()

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close')
}
watch(
  () => props.skill,
  (s) => {
    if (s) window.addEventListener('keydown', onKeydown)
    else window.removeEventListener('keydown', onKeydown)
  },
  { immediate: true },
)
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <Teleport to="body">
    <Transition name="skill-preview">
      <div
        v-if="skill"
        class="fixed inset-0 z-50 flex items-center justify-center p-4"
        role="dialog"
        aria-modal="true"
        @click.self="emit('close')"
      >
        <div class="skill-preview__backdrop absolute inset-0" @click="emit('close')" />
        <div
          class="skill-preview__panel relative z-10 w-[720px] max-w-[92vw] max-h-[85vh] flex flex-col rounded-xl border shadow-xl"
          :style="{ background: 'var(--hc-bg-elevated)', borderColor: 'var(--hc-border)' }"
        >
          <!-- 头部：图标 + 名称 + 元信息（作者 · 版本 · 作用域） -->
          <div class="flex items-start justify-between gap-3 p-5 border-b" :style="{ borderColor: 'var(--hc-border)' }">
            <div class="flex items-start gap-3 min-w-0">
              <div
                class="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0"
                :style="{ background: 'var(--hc-bg-hover)' }"
              >
                <SkillIcon :skill="skill" :size="20" />
              </div>
              <div class="min-w-0">
                <h3 class="text-base font-semibold truncate" :style="{ color: 'var(--hc-text-primary)' }">
                  {{ skill.display_name || skill.name }}
                </h3>
                <p class="text-xs mt-0.5 truncate" :style="{ color: 'var(--hc-text-muted)' }">
                  <template v-if="skill.author">{{ skill.author }}</template>
                  <template v-if="skill.author && skill.version"> · </template>
                  <template v-if="skill.version">v{{ skill.version }}</template>
                  <template v-if="scopeLabel"> · {{ scopeLabel }}</template>
                </p>
              </div>
            </div>
            <button class="p-1 rounded-md shrink-0" :style="{ color: 'var(--hc-text-muted)' }" :aria-label="t('common.close', '关闭')" @click="emit('close')">
              <X :size="16" />
            </button>
          </div>

          <!-- 正文：触发词 + 描述 + SKILL.md -->
          <div class="flex-1 overflow-y-auto p-5">
            <!-- 价值前置：触发词 chips（若有） -->
            <div v-if="skill.triggers?.length" class="flex flex-wrap gap-1.5 mb-3">
              <span
                v-for="trigger in skill.triggers"
                :key="trigger"
                class="text-xs px-1.5 py-0.5 rounded-md"
                :style="{ background: 'var(--hc-bg-hover)', color: 'var(--hc-accent)' }"
              >/{{ trigger }}</span>
            </div>
            <p v-if="skill.description" class="text-sm mb-4" :style="{ color: 'var(--hc-text-secondary)' }">
              {{ skill.description }}
            </p>

            <!-- 加载：骨架屏（Apple 级质感,非「加载中…」文字） -->
            <div v-if="loading" class="space-y-2.5" aria-hidden="true">
              <div class="skill-preview__skeleton h-4 rounded" style="width: 42%" />
              <div class="skill-preview__skeleton h-3 rounded" style="width: 92%" />
              <div class="skill-preview__skeleton h-3 rounded" style="width: 88%" />
              <div class="skill-preview__skeleton h-3 rounded" style="width: 70%" />
              <div class="skill-preview__skeleton h-3 rounded" style="width: 80%" />
            </div>
            <div v-else-if="error" class="text-sm" :style="{ color: 'var(--hc-error)' }">
              {{ error }}
            </div>
            <SkillMarkdownPreview v-else :content="content" />
          </div>

          <!-- 底部：footer 按上下文 -->
          <div class="flex items-center gap-2 p-4 border-t" :style="{ borderColor: 'var(--hc-border)' }">
            <!-- 已安装：删除靠左（次要、危险色 ghost） -->
            <button
              v-if="mode === 'installed'"
              class="px-3 py-1.5 rounded-lg text-sm inline-flex items-center gap-1.5 transition-colors hover:bg-red-50"
              :style="{ color: 'var(--hc-error)' }"
              @click="emit('delete')"
            >
              <Trash2 :size="14" />
              {{ t('common.delete', '删除') }}
            </button>

            <span class="flex-1" />

            <!-- 已安装：启停 -->
            <button
              v-if="mode === 'installed'"
              class="px-3 py-1.5 rounded-lg text-sm border inline-flex items-center gap-2"
              :style="{ borderColor: 'var(--hc-border)', color: 'var(--hc-text-secondary)', opacity: busy ? 0.6 : 1 }"
              :disabled="busy"
              @click="emit('toggle-enabled')"
            >
              <span
                class="relative w-8 h-4 rounded-full transition-colors"
                :style="{ background: enabled ? 'var(--hc-accent)' : 'var(--hc-text-muted)' }"
              >
                <span class="absolute top-0.5 w-3 h-3 rounded-full bg-white shadow transition-transform" :style="{ transform: enabled ? 'translateX(16px)' : 'translateX(2px)' }" />
              </span>
              {{ enabled ? t('skills.enabled', '已启用') : t('skills.disabled', '已禁用') }}
            </button>

            <button
              class="px-4 py-1.5 rounded-lg text-sm border"
              :style="{ borderColor: 'var(--hc-border)', color: 'var(--hc-text-secondary)' }"
              @click="emit('close')"
            >
              {{ t('common.close', '关闭') }}
            </button>

            <!-- 市场：安装 / 已安装 -->
            <button
              v-if="mode === 'hub' && installed"
              class="px-4 py-1.5 rounded-lg text-sm font-medium inline-flex items-center gap-1.5"
              :style="{ background: 'var(--hc-bg-hover)', color: 'var(--hc-text-muted)' }"
              disabled
            >
              <CheckCircle2 :size="14" />
              {{ t('skills.hub.installed', '已安装') }}
            </button>
            <button
              v-else-if="mode === 'hub'"
              class="px-4 py-1.5 rounded-lg text-sm font-medium text-white inline-flex items-center gap-1.5 transition-opacity hover:opacity-90"
              :style="{ background: 'var(--hc-accent)', opacity: busy ? 0.6 : 1 }"
              :disabled="busy"
              @click="emit('install')"
            >
              <Download :size="14" />
              {{ t('skills.hub.install', '安装') }}
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.skill-preview__backdrop {
  background: rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
}
/* Apple 级弹入：克制的 scale + opacity（cubic-bezier 物理感） */
.skill-preview-enter-active,
.skill-preview-leave-active {
  transition: opacity 0.2s ease;
}
.skill-preview-enter-active .skill-preview__panel,
.skill-preview-leave-active .skill-preview__panel {
  transition: transform 0.24s cubic-bezier(0.32, 0.72, 0, 1), opacity 0.24s cubic-bezier(0.32, 0.72, 0, 1);
}
.skill-preview-enter-from,
.skill-preview-leave-to {
  opacity: 0;
}
.skill-preview-enter-from .skill-preview__panel,
.skill-preview-leave-to .skill-preview__panel {
  transform: scale(0.96);
  opacity: 0;
}
/* 骨架屏微光 */
.skill-preview__skeleton {
  background: linear-gradient(90deg, var(--hc-bg-hover) 25%, var(--hc-bg-elevated) 50%, var(--hc-bg-hover) 75%);
  background-size: 200% 100%;
  animation: skill-preview-shimmer 1.3s ease-in-out infinite;
}
@keyframes skill-preview-shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
</style>
