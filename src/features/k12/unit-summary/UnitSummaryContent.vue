<script setup lang="ts">
import MarkdownRenderer from '@/components/chat/MarkdownRenderer.vue'
import { computed } from 'vue'
import type { UnitSummaryResponse } from './types'
import { UNIT_SUBJECT_LABELS } from './types'
const props = defineProps<{ view: UnitSummaryResponse; busy?: boolean }>()
const content = computed(() => props.view.material?.content || props.view.job?.content)
const emit = defineEmits<{ action: [action: 'artifacts' | 'download' | 'print'] }>()
</script>
<template>
  <article
    v-if="content"
    class="unit-summary"
    :data-unit-revision="view.material?.revision_id"
    :data-scroll-anchor-id="view.material?.revision_id || view.job?.id"
  >
    <header class="unit-summary__head" data-reading-title>
      <p class="unit-summary__meta">
        {{ UNIT_SUBJECT_LABELS[content.subject] }}
        <template v-if="view.material?.grade_term"> {{ view.material.grade_term }}</template>
        <template v-if="view.material?.textbook_edition">
          · {{ view.material.textbook_edition }}</template
        >
        <template v-if="view.material?.unit_number">
          · 第{{ view.material.unit_number }}单元</template
        >
        <span v-if="content.coverage?.level === 'partial'"> · 部分资料</span>
      </p>
      <h3>{{ view.material?.title || content.title }}</h3>
      <div v-if="view.material" class="unit-summary__delivery">
        <span
          >生成日期 {{ view.material.generated_date }} · v{{
            String(view.material.version).padStart(2, '0')
          }}</span
        ><span v-if="view.delivery?.complete" role="status">已保存到产物 · PDF 已准备</span>
      </div>
      <p v-else class="unit-summary__delivery" role="status">
        Content prepared · PDF delivery is incomplete.
      </p>
      <div v-if="content.parent_plan?.length" class="unit-summary__plan">
        <b>这次可以这样带孩子复习</b>
        <p v-for="(step, index) in content.parent_plan" :key="index">{{ step }}</p>
        <p v-for="(guidance, index) in content.personal_guidance" :key="`personal-${index}`">
          {{ guidance.text }}
        </p>
      </div>
    </header>
    <div class="unit-summary__body">
      <section v-if="content.goals?.length">
        <h4>知识总览与联系</h4>
        <ul>
          <li v-for="goal in content.goals" :key="goal.id">{{ goal.text }}</li>
        </ul>
      </section>
      <section v-for="item in content.knowledge" :key="item.id">
        <h4>{{ item.title }}</h4>
        <MarkdownRenderer :content="item.body_md" />
      </section>
      <details v-for="(example, index) in content.examples" :key="example.id">
        <summary>
          代表例 {{ index + 1 }}<span v-if="example.origin === 'ai_created'"> · AI 创作</span>
        </summary>
        <MarkdownRenderer :content="example.prompt_md" /><MarkdownRenderer
          :content="example.demonstration_md"
        />
        <h4>家长讲解指南</h4>
        <p><b>先问：</b>{{ example.parent_guide.ask }}</p>
        <p><b>怎样解释：</b>{{ example.parent_guide.explain }}</p>
        <p><b>卡住时：</b>{{ example.parent_guide.hint }}</p>
        <p v-if="example.parent_guide.alternative">{{ example.parent_guide.alternative }}</p>
      </details>
      <details v-if="content.common_pitfalls?.length">
        <summary>容易混淆的地方</summary>
        <ul>
          <li v-for="(pitfall, index) in content.common_pitfalls" :key="index">
            {{ pitfall }}
          </li>
        </ul>
      </details>
      <details v-if="content.transfer_checks?.length">
        <summary>迁移检查</summary>
        <div v-for="(check, index) in content.transfer_checks" :key="check.id">
          <h4>试一试 {{ index + 1 }}</h4>
          <MarkdownRenderer :content="check.question_md" />
        </div>
      </details>
      <details v-if="content.reference_explanations?.length">
        <summary>参考解读 · 先尝试，再对照</summary>
        <div v-for="answer in content.reference_explanations" :key="answer.check_id">
          <MarkdownRenderer :content="answer.explanation_md" />
        </div>
      </details>
      <details class="unit-summary__source">
        <summary>内容与来源说明</summary>
        <p v-if="content.coverage?.level === 'partial'">
          本次为部分资料，未覆盖的内容：{{ content.coverage?.missing?.join('、') }}
        </p>
        <ul>
          <li v-for="source in content.sources" :key="source.ref">
            {{ source.label }}<span v-if="source.page"> · {{ source.page }}</span
            ><span v-if="source.locator"> · {{ source.locator }}</span>
          </li>
        </ul>
        <p>AI 归纳与原始材料分别保留；本产物不会自动写入知识库。</p>
      </details>
    </div>
    <footer v-if="view.delivery?.complete && view.material" class="unit-summary__actions">
      <button type="button" @click="emit('action', 'artifacts')">查看产物</button
      ><button
        type="button"
        :disabled="busy"
        :title="view.material.filename"
        @click="emit('action', 'download')"
      >
        下载 PDF</button
      ><button type="button" :disabled="busy" @click="emit('action', 'print')">打印</button>
    </footer>
  </article>
</template>
<style scoped>
.unit-summary {
  width: 100%;
  max-width: 780px;
  margin: 0 auto;
  border: 1px solid var(--hc-border);
  border-radius: 10px;
  background: var(--hc-bg-card);
  color: var(--hc-text-primary);
  font-size: 14px;
  line-height: 1.75;
  overflow: hidden;
}
.unit-summary__head {
  padding: 16px 24px 14px;
  border-bottom: 1px solid var(--hc-divider);
}
.unit-summary__meta,
.unit-summary__delivery {
  font-size: 12px;
  color: var(--hc-text-secondary);
}
.unit-summary h3 {
  margin: 5px 0 10px;
  font-size: 24px;
  line-height: 1.4;
}
.unit-summary__delivery {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 18px;
}
.unit-summary__plan {
  margin-top: 14px;
  padding: 14px 16px;
  background: var(--hc-bg-hover);
  border-left: 2px solid var(--hc-accent);
}
.unit-summary p {
  margin: 6px 0;
}
.unit-summary__body {
  padding: 14px 24px;
}
.unit-summary h4 {
  font-size: 14px;
  margin: 16px 0 8px;
  font-weight: 600;
}
.unit-summary details {
  padding: 12px 0;
  border-top: 1px solid var(--hc-divider);
}
.unit-summary summary {
  font-weight: 600;
  cursor: pointer;
}
.unit-summary summary span {
  font-weight: 400;
  font-size: 12px;
  color: var(--hc-text-muted);
}
.unit-summary__source {
  font-size: 12px;
  color: var(--hc-text-secondary);
}
.unit-summary__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 14px 24px;
  border-top: 1px solid var(--hc-divider);
}
.unit-summary button {
  min-height: 32px;
  padding: 5px 10px;
  border: 1px solid var(--hc-border);
  border-radius: 6px;
  background: var(--hc-bg-elevated);
  color: var(--hc-text-primary);
  font-size: 12px;
  cursor: pointer;
}
.unit-summary button:disabled {
  opacity: 0.5;
  cursor: wait;
}
.unit-summary :deep(.hc-markdown) {
  max-width: 100%;
  overflow-x: auto;
}
.unit-summary :deep(table) {
  font-size: 14px;
}
@media (max-width: 600px) {
  .unit-summary__head,
  .unit-summary__body,
  .unit-summary__actions {
    padding-left: 16px;
    padding-right: 16px;
  }
  .unit-summary h3 {
    font-size: 20px;
  }
}
</style>
