<script setup lang="ts">
/**
 * 验算徽章（通用消息装饰 · 架构 §7.1/§8.1/AP-5）。
 *
 * 领域无关：只认 VerifyResult 数据契约，三态诚实呈现。范围说明等语义经 `scopeNote`
 * 数据流入，本组件零场景领域字面量。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { VerifyResult } from '@/contracts'
import { isStrongEvidence } from '@/contracts'

const props = defineProps<{ result: VerifyResult }>()
const { t } = useI18n()

type Tone = 'ok' | 'warn' | 'muted'

const view = computed<{ tone: Tone; icon: string; label: string }>(() => {
  const r = props.result
  switch (r.verdict) {
    case 'agree':
      return {
        tone: 'ok',
        icon: '✅',
        label: isStrongEvidence(r) ? t('verify.programVerified') : t('verify.checked'),
      }
    case 'out_of_scope':
      return { tone: 'warn', icon: '⛔', label: t('verify.outOfScope') }
    case 'disagree':
      return { tone: 'warn', icon: '⚠️', label: t('verify.disagree') }
    default:
      return { tone: 'muted', icon: 'ℹ️', label: t('verify.unverifiable') }
  }
})

const scopeSuffix = computed(() => {
  const r = props.result
  if (r.verdict === 'out_of_scope' && r.outOfScope?.detected) return r.outOfScope.detected
  return r.scopeNote || ''
})
</script>

<template>
  <div class="verify-badge" :class="`verify-badge--${view.tone}`">
    <span class="verify-badge__chip">
      <span aria-hidden="true">{{ view.icon }}</span>
      <span>{{ view.label }}</span>
      <span v-if="scopeSuffix" class="verify-badge__scope">· {{ scopeSuffix }}</span>
    </span>

    <!-- disagree：诚实并列双答 + 不装懂提示（AP-5） -->
    <div v-if="result.verdict === 'disagree'" class="verify-badge__detail">
      <ul v-if="result.answers?.length" class="verify-badge__answers">
        <li v-for="(a, i) in result.answers" :key="i">{{ a }}</li>
      </ul>
      <p class="verify-badge__hint">{{ t('verify.disagreeHint') }}</p>
    </div>
  </div>
</template>

<style scoped>
.verify-badge {
  margin-bottom: 7px;
}
.verify-badge__chip {
  display: inline-flex;
  gap: 5px;
  align-items: center;
  font-size: 11px;
  font-weight: 700;
  border-radius: 6px;
  padding: 3px 8px;
  line-height: 1.4;
}
.verify-badge__scope {
  font-weight: 600;
}
.verify-badge--ok .verify-badge__chip {
  color: var(--hc-success);
  background: color-mix(in srgb, var(--hc-success) 12%, transparent);
}
.verify-badge--warn .verify-badge__chip {
  color: var(--hc-warning);
  background: color-mix(in srgb, var(--hc-warning) 14%, transparent);
  border: 1px solid color-mix(in srgb, var(--hc-warning) 45%, transparent);
}
.verify-badge--muted .verify-badge__chip {
  color: var(--hc-text-muted);
  background: var(--hc-bg-input);
}
.verify-badge__detail {
  margin-top: 6px;
}
.verify-badge__answers {
  margin: 0 0 4px;
  padding-left: 1.2em;
  font-size: 12.5px;
  color: var(--hc-text-primary);
}
.verify-badge__answers li {
  margin: 1px 0;
}
.verify-badge__hint {
  margin: 0;
  font-size: 11.5px;
  color: var(--hc-text-secondary);
  line-height: 1.6;
}
</style>
