<script setup lang="ts">
import { ChevronRight } from 'lucide-vue-next'
import { materialPreparationSummary, type MaterialPreparation } from '@/api/k12-materials'
import MarkdownRenderer from '@/components/chat/MarkdownRenderer.vue'
defineProps<{ preparation: MaterialPreparation; title: string; pdf: boolean }>()
const emit = defineEmits<{ source: [page: number] }>()
const labels: Record<string, string> = { ready: 'Ready', preparing: 'Preparing', needs_review: 'Needs review', failed: 'Failed', outcome_unknown: 'Result unknown', stopped: 'Stopped' }
</script>
<template>
  <section class="material-preparation" aria-label="Questions">
    <h3>Questions</h3>
    <p class="material-preparation__summary">{{ materialPreparationSummary(preparation) }}</p>
    <details v-for="(item, index) in preparation.items ?? []" :key="item.candidate_id" class="material-preparation__question">
      <summary><ChevronRight :size="14" /><span class="material-preparation__number">{{ index + 1 }}</span><span class="material-preparation__stem">{{ item.stem }}</span><span class="material-preparation__state">{{ labels[item.state] ?? item.state }}</span></summary>
      <div class="material-preparation__body">
        <MarkdownRenderer :content="item.stem" />
        <p v-if="item.state === 'ready' && item.answer" class="material-preparation__answer">Answer: {{ item.answer }}</p>
        <p v-if="item.reason">{{ item.reason }}</p>
        <button v-if="pdf" type="button" class="material-preparation__source" @click="emit('source', item.page || 1)">{{ title }}<template v-if="item.page"> · {{ item.page }}</template></button>
        <span v-else class="material-preparation__source">{{ title }}<template v-if="item.line"> · Line {{ item.line }}</template></span>
      </div>
    </details>
  </section>
</template>
<style scoped>
.material-preparation { border:1px solid var(--hc-border); border-radius:12px; padding:16px; color:var(--hc-text-secondary); }
.material-preparation h3 { font-size:13px; font-weight:600; color:var(--hc-text-primary); margin:0 0 4px; }
.material-preparation__summary { font-size:12px; margin:4px 0 14px; color:var(--hc-text-muted); }
.material-preparation__question { border-bottom:1px solid var(--hc-divider); }
.material-preparation__question summary { display:flex; align-items:center; gap:12px; list-style:none; padding:12px 0; font-size:13px; cursor:pointer; }
.material-preparation__question summary::-webkit-details-marker { display:none; }
.material-preparation__question summary svg { flex:none; color:var(--hc-text-muted); }
.material-preparation__question[open] summary svg { transform:rotate(90deg); }
.material-preparation__number { width:20px; flex:none; color:var(--hc-text-muted); }
.material-preparation__stem { min-width:0; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.material-preparation__state { color:var(--hc-text-muted); flex:none; font-size:12px; }
.material-preparation__body { padding:0 0 14px 32px; font-size:13px; line-height:1.7; overflow-wrap:anywhere; }
.material-preparation__answer { font-weight:600; color:var(--hc-text-primary); margin:5px 0; }
.material-preparation__source { display:inline-block; color:var(--hc-text-secondary); font-size:12px; margin-top:7px; text-align:left; background:none; border:0; padding:0; }
button.material-preparation__source:hover { text-decoration:underline; }
</style>
