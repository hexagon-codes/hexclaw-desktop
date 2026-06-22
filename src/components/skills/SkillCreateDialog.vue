<script setup lang="ts">
/**
 * SkillCreateDialog —— 与 AI 对话创建 Skill（P1.3）。
 * 流程：自然语言描述 → 后端 LLM 生成 SKILL.md 草稿 → 可编辑预览 → 保存落盘安装。
 * 产物始终是标准 SKILL.md（守可移植性，非私有插件）。
 */
import { ref, watch, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { Wand2, Loader2, ArrowLeft, X, Pencil, Eye, Sparkles } from 'lucide-vue-next'
import { generateSkill, installSkillContent } from '@/api/skills'
import { useToast } from '@/composables/useToast'
import SkillMarkdownPreview from '@/components/skills/SkillMarkdownPreview.vue'

const props = defineProps<{ visible: boolean }>()
const emit = defineEmits<{ close: []; created: [name: string] }>()

const { t } = useI18n()
const toast = useToast()

type Step = 'describe' | 'preview'
const step = ref<Step>('describe')
/** Step2 内：编辑（裸 SKILL.md）vs 预览（渲染 + frontmatter 卡）。 */
const previewTab = ref<'edit' | 'preview'>('edit')
const description = ref('')
const content = ref('')
const generating = ref(false)
const saving = ref(false)
const error = ref('')
/** Step2 内「按反馈重新生成」：避免「重新描述」清空一切、无法迭代。 */
const refineInput = ref('')
const refining = ref(false)

watch(
  () => props.visible,
  (v) => {
    if (v) {
      step.value = 'describe'
      previewTab.value = 'edit'
      description.value = ''
      content.value = ''
      error.value = ''
      refineInput.value = ''
      generating.value = false
      saving.value = false
      refining.value = false
    }
  },
)

async function handleGenerate() {
  const desc = description.value.trim()
  if (!desc || generating.value) return
  generating.value = true
  error.value = ''
  try {
    const md = await generateSkill(desc)
    if (!md.trim()) throw new Error(t('skills.create.emptyResult', '生成结果为空，请重试'))
    content.value = md
    previewTab.value = 'edit'
    step.value = 'preview'
    nextTick(() => {})
  } catch (e) {
    error.value = e instanceof Error ? e.message : t('skills.create.genFailed', '生成失败')
  } finally {
    generating.value = false
  }
}

/**
 * 按反馈在当前草稿基础上重新生成（保持在 Step2，不清空）。
 * 不需要后端新端点：把「当前 SKILL.md + 调整要求」组合成更丰富的 prompt 复用 generate。
 */
async function handleRefine() {
  const fb = refineInput.value.trim()
  if (!fb || refining.value || saving.value) return
  refining.value = true
  error.value = ''
  try {
    const prompt = `在下面这份现有 SKILL.md 基础上按要求调整，输出完整的新 SKILL.md（保留标准 frontmatter 结构，只返回 SKILL.md 本身）。\n\n调整要求：${fb}\n\n现有 SKILL.md：\n${content.value}`
    const md = await generateSkill(prompt)
    if (!md.trim()) throw new Error(t('skills.create.emptyResult', '生成结果为空，请重试'))
    content.value = md
    refineInput.value = ''
    previewTab.value = 'preview'
  } catch (e) {
    error.value = e instanceof Error ? e.message : t('skills.create.genFailed', '生成失败')
  } finally {
    refining.value = false
  }
}

async function handleSave() {
  const md = content.value.trim()
  if (!md || saving.value) return
  saving.value = true
  error.value = ''
  try {
    const res = await installSkillContent(md)
    toast.success(t('skills.create.saved', '技能已创建'))
    emit('created', res.name)
    emit('close')
  } catch (e) {
    error.value = e instanceof Error ? e.message : t('skills.create.saveFailed', '保存失败')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="visible"
      class="fixed inset-0 z-50 flex items-center justify-center"
      @click.self="emit('close')"
    >
      <div class="absolute inset-0 bg-black/50 backdrop-blur-sm" @click="emit('close')" />
      <div
        class="relative z-10 max-w-[92vw] rounded-xl border p-6 shadow-xl transition-[width] duration-200"
        :style="{
          width: step === 'preview' ? '760px' : '560px',
          background: 'var(--hc-bg-elevated)',
          borderColor: 'var(--hc-border)',
        }"
      >
        <!-- Header -->
        <div class="flex items-center justify-between mb-4">
          <h3 class="flex items-center gap-2 text-base font-semibold" :style="{ color: 'var(--hc-text-primary)' }">
            <Wand2 :size="18" :style="{ color: 'var(--hc-accent)' }" />
            {{ t('skills.create.title', '与 AI 对话创建 Skill') }}
          </h3>
          <button class="p-1 rounded-md" :style="{ color: 'var(--hc-text-muted)' }" @click="emit('close')">
            <X :size="16" />
          </button>
        </div>

        <!-- Step 1: describe -->
        <template v-if="step === 'describe'">
          <p class="text-xs mb-2" :style="{ color: 'var(--hc-text-muted)' }">
            {{ t('skills.create.descHint', '用一句话描述你想要的技能，AI 会生成一份可安装的 SKILL.md。') }}
          </p>
          <textarea
            v-model="description"
            rows="4"
            :placeholder="t('skills.create.descPlaceholder', '例如：一个能把会议纪要整理成行动项清单的技能')"
            class="w-full px-3 py-2 rounded-lg border text-sm resize-none"
            :style="{ background: 'var(--hc-bg-primary)', borderColor: 'var(--hc-border)', color: 'var(--hc-text-primary)' }"
            :disabled="generating"
            @keydown.meta.enter="handleGenerate"
          />
          <p v-if="error" class="text-xs mt-2 px-1" style="color: var(--hc-error)">{{ error }}</p>
          <div class="flex justify-end gap-2 mt-4">
            <button
              class="px-4 py-1.5 rounded-lg text-sm font-medium border transition-colors"
              :style="{ borderColor: 'var(--hc-border)', color: 'var(--hc-text-secondary)' }"
              @click="emit('close')"
            >
              {{ t('common.cancel', '取消') }}
            </button>
            <button
              class="px-4 py-1.5 rounded-lg text-sm font-medium text-white inline-flex items-center gap-1.5 transition-opacity hover:opacity-90"
              :style="{ background: !description.trim() || generating ? 'var(--hc-text-muted)' : 'var(--hc-accent)' }"
              :disabled="!description.trim() || generating"
              @click="handleGenerate"
            >
              <Loader2 v-if="generating" :size="14" class="animate-spin" />
              <Wand2 v-else :size="14" />
              {{ generating ? t('skills.create.generating', '生成中…') : t('skills.create.generate', '生成') }}
            </button>
          </div>
        </template>

        <!-- Step 2: preview + edit -->
        <template v-else>
          <div class="flex items-center justify-between mb-2">
            <p class="text-xs" :style="{ color: 'var(--hc-text-muted)' }">
              {{ t('skills.create.previewHint', '可直接编辑后再保存。保存即安装为本地 Skill。') }}
            </p>
            <!-- 编辑 / 预览 切换 -->
            <div
              class="inline-flex items-center rounded-lg border p-0.5 text-xs shrink-0"
              :style="{ borderColor: 'var(--hc-border)', background: 'var(--hc-bg-main)' }"
            >
              <button
                type="button"
                class="inline-flex items-center gap-1 px-2 py-0.5 rounded-md transition-colors"
                :style="
                  previewTab === 'edit'
                    ? { background: 'var(--hc-bg-elevated)', color: 'var(--hc-text-primary)' }
                    : { color: 'var(--hc-text-muted)' }
                "
                @click="previewTab = 'edit'"
              >
                <Pencil :size="12" />
                {{ t('skills.create.editTab', '编辑') }}
              </button>
              <button
                type="button"
                class="inline-flex items-center gap-1 px-2 py-0.5 rounded-md transition-colors"
                :style="
                  previewTab === 'preview'
                    ? { background: 'var(--hc-bg-elevated)', color: 'var(--hc-text-primary)' }
                    : { color: 'var(--hc-text-muted)' }
                "
                @click="previewTab = 'preview'"
              >
                <Eye :size="12" />
                {{ t('skills.create.previewTab', '预览') }}
              </button>
            </div>
          </div>
          <textarea
            v-if="previewTab === 'edit'"
            v-model="content"
            rows="14"
            spellcheck="false"
            class="w-full px-3 py-2 rounded-lg border text-xs font-mono resize-none"
            :style="{ background: 'var(--hc-bg-primary)', borderColor: 'var(--hc-border)', color: 'var(--hc-text-primary)' }"
            :disabled="saving"
          />
          <div
            v-else
            class="rounded-lg border p-3 h-[19rem] overflow-y-auto"
            :style="{ background: 'var(--hc-bg-primary)', borderColor: 'var(--hc-border)' }"
          >
            <SkillMarkdownPreview :content="content" :show-frontmatter="true" :allow-raw-toggle="false" />
          </div>

          <!-- 按反馈重新生成（保持在 Step2，不清空草稿） -->
          <div class="mt-3 flex items-center gap-2">
            <input
              v-model="refineInput"
              :placeholder="t('skills.create.refinePlaceholder', '告诉 AI 怎么改，例如：增加错误处理步骤')"
              class="flex-1 min-w-0 px-2.5 py-1.5 rounded-lg border text-xs"
              :style="{ background: 'var(--hc-bg-primary)', borderColor: 'var(--hc-border)', color: 'var(--hc-text-primary)' }"
              :disabled="refining || saving"
              @keydown.enter.prevent="handleRefine"
            />
            <button
              type="button"
              class="px-3 py-1.5 rounded-lg text-xs font-medium inline-flex items-center gap-1.5 border shrink-0 transition-opacity hover:opacity-90"
              :style="{
                borderColor: 'var(--hc-border)',
                color: !refineInput.trim() || refining || saving ? 'var(--hc-text-muted)' : 'var(--hc-accent)',
              }"
              :disabled="!refineInput.trim() || refining || saving"
              @click="handleRefine"
            >
              <Loader2 v-if="refining" :size="13" class="animate-spin" />
              <Sparkles v-else :size="13" />
              {{ refining ? t('skills.create.refining', '优化中…') : t('skills.create.refine', '重新生成') }}
            </button>
          </div>

          <p v-if="error" class="text-xs mt-2 px-1" style="color: var(--hc-error)">{{ error }}</p>
          <div class="flex justify-between items-center mt-4">
            <button
              class="px-3 py-1.5 rounded-lg text-sm inline-flex items-center gap-1.5 transition-colors"
              :style="{ color: 'var(--hc-text-secondary)' }"
              :disabled="saving"
              @click="step = 'describe'"
            >
              <ArrowLeft :size="14" />
              {{ t('skills.create.back', '重新描述') }}
            </button>
            <button
              class="px-4 py-1.5 rounded-lg text-sm font-medium text-white inline-flex items-center gap-1.5 transition-opacity hover:opacity-90"
              :style="{ background: !content.trim() || saving ? 'var(--hc-text-muted)' : 'var(--hc-accent)' }"
              :disabled="!content.trim() || saving"
              @click="handleSave"
            >
              <Loader2 v-if="saving" :size="14" class="animate-spin" />
              {{ saving ? t('skills.create.saving', '保存中…') : t('skills.create.save', '保存并安装') }}
            </button>
          </div>
        </template>
      </div>
    </div>
  </Teleport>
</template>
