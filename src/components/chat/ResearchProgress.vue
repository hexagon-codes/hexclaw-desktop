<script setup lang="ts">
import { ref, watch, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronDown, ChevronRight, Search, BookOpen, Layers, FileText, Check } from 'lucide-vue-next'

const { t } = useI18n()

const props = defineProps<{
  /** Whether research is actively streaming */
  active: boolean
  /** Current streaming content length — used to auto-advance phases */
  contentLength: number
}>()

interface ResearchPhase {
  key: string
  labelKey: string
  icon: typeof Search
  doneLabelKey: string
}

const phases: ResearchPhase[] = [
  { key: 'search', labelKey: 'research.searching', icon: Search, doneLabelKey: 'research.searching' },
  { key: 'analyze', labelKey: 'research.analyzing', icon: BookOpen, doneLabelKey: 'research.analyzing' },
  { key: 'synthesize', labelKey: 'research.synthesizing', icon: Layers, doneLabelKey: 'research.synthesizing' },
  { key: 'report', labelKey: 'research.generating', icon: FileText, doneLabelKey: 'research.generating' },
]

const currentPhaseIndex = ref(0)
const collapsed = ref(false)
let phaseTimer: ReturnType<typeof setTimeout> | null = null

function scheduleNextPhase(delayMs: number) {
  clearPhaseTimer()
  if (currentPhaseIndex.value < phases.length - 1) {
    phaseTimer = setTimeout(() => {
      if (props.active && currentPhaseIndex.value < phases.length - 1) {
        currentPhaseIndex.value++
        // Schedule next phase with increasing delay
        const nextDelay = delayMs * 1.3
        scheduleNextPhase(nextDelay)
      }
    }, delayMs)
  }
}

function clearPhaseTimer() {
  if (phaseTimer) {
    clearTimeout(phaseTimer)
    phaseTimer = null
  }
}

// Auto-advance based on content length milestones
watch(() => props.contentLength, (len) => {
  if (!props.active) return
  if (len > 2000 && currentPhaseIndex.value < 3) currentPhaseIndex.value = 3
  else if (len > 800 && currentPhaseIndex.value < 2) currentPhaseIndex.value = 2
  else if (len > 200 && currentPhaseIndex.value < 1) currentPhaseIndex.value = 1
})

// When research starts, reset and begin phase progression
watch(() => props.active, (active) => {
  if (active) {
    currentPhaseIndex.value = 0
    collapsed.value = false
    scheduleNextPhase(4000)
  } else {
    clearPhaseTimer()
    // Mark all phases as done
    currentPhaseIndex.value = phases.length - 1
  }
}, { immediate: true })

onUnmounted(clearPhaseTimer)
</script>

<template>
  <div class="hc-research-progress">
    <button class="hc-research-progress__header" @click="collapsed = !collapsed">
      <component :is="collapsed ? ChevronRight : ChevronDown" :size="14" />
      <span class="hc-research-progress__title">{{ t('research.title') }}</span>
      <span v-if="active" class="hc-research-progress__badge">{{ t('research.inProgress') }}</span>
      <span v-else class="hc-research-progress__badge hc-research-progress__badge--done">{{ t('research.completed') }}</span>
    </button>

    <div v-if="!collapsed" class="hc-research-progress__phases">
      <div
        v-for="(phase, idx) in phases"
        :key="phase.key"
        class="hc-research-progress__phase"
        :class="{
          'hc-research-progress__phase--active': idx === currentPhaseIndex && active,
          'hc-research-progress__phase--done': idx < currentPhaseIndex || !active,
          'hc-research-progress__phase--pending': idx > currentPhaseIndex && active,
        }"
      >
        <div class="hc-research-progress__phase-icon">
          <Check v-if="idx < currentPhaseIndex || !active" :size="12" />
          <component v-else :is="phase.icon" :size="12" />
        </div>
        <span class="hc-research-progress__phase-label">
          {{ t(idx < currentPhaseIndex || !active ? phase.doneLabelKey : phase.labelKey) }}
        </span>
        <span v-if="idx === currentPhaseIndex && active" class="hc-research-progress__spinner" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.hc-research-progress {
  border-radius: var(--hc-radius-md);
  border: 1px solid var(--hc-border);
  background: var(--hc-bg-card);
  margin-bottom: 8px;
  overflow: hidden;
}

.hc-research-progress__header {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 8px 12px;
  border: none;
  background: transparent;
  color: var(--hc-text-primary);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s;
}

.hc-research-progress__header:hover {
  background: var(--hc-bg-hover);
}

.hc-research-progress__title {
  flex: 1;
  text-align: left;
}

.hc-research-progress__badge {
  font-size: 10px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 8px;
  background: var(--hc-accent);
  color: #fff;
  animation: hc-research-pulse 2s ease-in-out infinite;
}

.hc-research-progress__badge--done {
  background: #34c759;
  animation: none;
}

@keyframes hc-research-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.6; }
}

.hc-research-progress__phases {
  padding: 0 12px 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.hc-research-progress__phase {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--hc-text-muted);
  transition: color 0.2s;
}

.hc-research-progress__phase--active {
  color: var(--hc-accent);
  font-weight: 500;
}

.hc-research-progress__phase--done {
  color: #34c759;
}

.hc-research-progress__phase--pending {
  opacity: 0.4;
}

.hc-research-progress__phase-icon {
  width: 18px;
  height: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  flex-shrink: 0;
}

.hc-research-progress__phase--active .hc-research-progress__phase-icon {
  background: var(--hc-accent-subtle);
}

.hc-research-progress__phase--done .hc-research-progress__phase-icon {
  background: rgba(52, 199, 89, 0.12);
}

.hc-research-progress__phase-label {
  flex: 1;
}

.hc-research-progress__spinner {
  width: 10px;
  height: 10px;
  border: 1.5px solid var(--hc-accent-subtle);
  border-top-color: var(--hc-accent);
  border-radius: 50%;
  animation: hc-research-spin 0.8s linear infinite;
}

@keyframes hc-research-spin {
  to { transform: rotate(360deg); }
}
</style>
