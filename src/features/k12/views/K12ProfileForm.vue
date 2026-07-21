<script setup lang="ts">
/**
 * 作业辅导助手建档表单（features/k12）· M1-2 · PRD §5.2.2。
 *
 * 采集 称呼/年级学期/分科教材 → agents.metadata（六科为 Desktop 兼容暂存，数学同步 legacy /profile 字段）。
 * 显示名自动生成「{称呼}的辅导助手 · {年级}」；provider/model 留空=跟随全局默认强推理模型。
 * 回归锁：不按学段×学科拆分老师卡——一张模板一份实例，多孩靠多实例结构隔离。
 */
import { ref, reactive, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { nanoid } from 'nanoid'
import { registerAgent, updateAgent, unregisterAgent } from '@/api/agents'
import { k12UpdateProfile } from '@/api/k12'
import { useK12Store } from '../store'
import { useAgentsStore } from '@/stores/agents'
import { useSettingsStore } from '@/stores/settings'
import { useToast } from '@/composables/useToast'
import HcSelect from '@/components/common/HcSelect.vue'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'
import { GRADES, gradeShort } from '../curriculum'
import { K12_SCENARIO_ID } from '../descriptor'
import { K12_INFRA_SKILLS, defaultBoundSkills } from '../manifest'

/** 建档/改档同构：传 agent 即进「改档」模式（预填 + updateAgent），否则「建档」（registerAgent） */
const props = defineProps<{
  agent?: {
    name: string
    display_name?: string
    description?: string
    metadata?: Record<string, string>
    skills?: string[]
    system_prompt?: string
    provider?: string
    model?: string
  }
}>()

const emit = defineEmits<{
  (e: 'created', name: string): void
  (e: 'close'): void
  (e: 'removed', name: string): void
  (e: 'back'): void
  (e: 'preview'): void
}>()

const { t } = useI18n()
const toast = useToast()
const agentsStore = useAgentsStore()
const k12Store = useK12Store()

const isEdit = computed(() => !!props.agent)
// Learner owner 与可改的 child_name/display_name 解耦：新建时独立生成一次；改档复用既有 metadata，
// 且 updateAgent 不写 metadata，因此改名/升年级不会轮换 owner。
const learnerID = props.agent?.metadata?.['k12.learner_id'] || `learner-${nanoid(12)}`

// 档案存在 agent metadata 的 k12.* 键（后端契约）
const childName = ref(props.agent?.metadata?.['k12.child_name'] ?? '')
const grade = ref(props.agent?.metadata?.['k12.grade_term'] ?? '五年级上')
const TEXTBOOK_SUBJECTS = [
  {
    key: 'math',
    labelKey: 'k12.profile.subjects.math',
    fallback: '人教版',
    options: ['人教版', '北师大版', '苏教版'],
  },
  {
    key: 'chinese',
    labelKey: 'k12.profile.subjects.chinese',
    fallback: '人教版',
    options: ['人教版', '统编版'],
  },
  {
    key: 'english',
    labelKey: 'k12.profile.subjects.english',
    fallback: '人教PEP版',
    options: ['人教PEP版', '外研版', '译林版'],
  },
  {
    key: 'science',
    labelKey: 'k12.profile.subjects.science',
    fallback: '教科版',
    options: ['教科版', '苏教版', '人教鄂教版'],
  },
  {
    key: 'information_technology',
    labelKey: 'k12.profile.subjects.informationTechnology',
    fallback: '浙教版',
    options: ['浙教版', '粤教版', '电子工业版'],
  },
  {
    key: 'art',
    labelKey: 'k12.profile.subjects.art',
    fallback: '人美版',
    options: ['人美版', '湘美版', '岭南版'],
  },
] as const
type TextbookSubject = (typeof TEXTBOOK_SUBJECTS)[number]['key']
const BUILTIN_SKILL_KEYS = [
  'k12.profile.builtinSkills.photo',
  'k12.profile.builtinSkills.progressive',
  'k12.profile.builtinSkills.mistakes',
  'k12.profile.builtinSkills.works',
  'k12.profile.builtinSkills.subjects',
] as const

const textbookMetaKey = (subject: TextbookSubject) => `k12.textbook_edition.${subject}`
const textbookEditions = reactive<Record<TextbookSubject, string>>(
  Object.fromEntries(
    TEXTBOOK_SUBJECTS.map((subject) => {
      const explicit = props.agent?.metadata?.[textbookMetaKey(subject.key)]
      // 现有 /profile 仅支持单教材字段；它只作为数学兼容 fallback，其他学科绝不静默套用数学版本。
      const legacyMath =
        subject.key === 'math' ? props.agent?.metadata?.['k12.textbook_edition'] : undefined
      return [subject.key, explicit || legacyMath || subject.fallback]
    }),
  ) as Record<TextbookSubject, string>,
)
const textbook = computed(() => textbookEditions.math)
const submitting = ref(false)
const error = ref('')

// BUG-20260710 ①：删除档案下沉到编辑弹层（原型 K12 卡动作行无删除，卡面孤行删除是漂移）。
// 删除必须进入平台 ConfirmDialog（alertdialog）确认，不能把第二次点击伪装成行内确认按钮。
const deleteConfirming = ref(false)
const deleting = ref(false)
async function removeProfile() {
  if (!props.agent || deleting.value) return
  deleting.value = true
  error.value = ''
  try {
    await unregisterAgent(props.agent.name)
    toast.success(t('k12.profile.deleted', { name: displayName.value }))
    emit('removed', props.agent.name)
    emit('close')
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    deleting.value = false
  }
}

/** 原型只展示自带能力，不提供技术 skill 清单。新建仍绑定模板默认集；编辑不改既有 skills。 */
function boundSkills(): string[] {
  if (props.agent?.skills?.length) return [...props.agent.skills]
  const s = new Set(defaultBoundSkills())
  for (const infra of K12_INFRA_SKILLS) s.add(infra)
  return [...s]
}

function metadataWithSubjectTextbooks(base: Record<string, string> = {}): Record<string, string> {
  const metadata = { ...base }
  for (const subject of TEXTBOOK_SUBJECTS) {
    metadata[textbookMetaKey(subject.key)] = textbookEditions[subject.key]
  }
  // Desktop 兼容暂存：领域后端的 k12_subject_textbooks 尚未完成；legacy 字段始终镜像数学。
  metadata['k12.textbook_edition'] = textbookEditions.math
  return metadata
}

const displayName = computed(() =>
  t('k12.profile.autoName', {
    child: childName.value.trim() || t('k12.profile.namePlaceholder'),
    grade: gradeShort(grade.value),
  }),
)

// 卡片副标题严格采用原型口径，说明分科绑定事实；改年级时与 display_name 同步派生。
const cardDescription = computed(() => t('k12.profile.cardDesc', { grade: grade.value }))

// HcSelect 选项（替代原生 <select>；WKWebView 下原生 select 显 macOS Aqua 样式 · BUG-20260708 B2）
const gradeOptions = computed(() => GRADES.map((g) => ({ value: g, label: g })))
function textbookOptions(subject: (typeof TEXTBOOK_SUBJECTS)[number]) {
  return subject.options.map((edition) => ({ value: edition, label: edition }))
}

// 模型选择（高级折叠·BUG-20260711-H，对齐原型 tutorForm「模型 · 默认已配好强推理模型，可不管」）：
// ''=跟随全局默认强推理模型；与 AgentsView 同数据源（settingsStore.availableModels），
// 服务商 → 模型 两级级联，切服务商即复位模型（防跨 provider 悬空 model）。
const settingsStore = useSettingsStore()
const provider = ref(props.agent?.provider ?? '')
const model = ref(props.agent?.model ?? '')
watch(provider, () => {
  model.value = ''
})
const providerOptions = computed(() => {
  const seen = new Map<string, string>()
  for (const m of settingsStore.availableModels) {
    if (!seen.has(m.providerKey)) seen.set(m.providerKey, m.providerName)
  }
  return [
    { value: '', label: t('agents.useGlobalDefault') },
    ...[...seen].map(([value, label]) => ({ value, label })),
  ]
})
const modelOptions = computed(() => [
  { value: '', label: t('agents.useGlobalDefault') },
  ...settingsStore.availableModels
    .filter((m) => m.providerKey === provider.value)
    .map((m) => ({ value: m.modelId, label: m.modelName })),
])

// 辅导助手人设(SOUL)：只挂 skill 不设 system_prompt → 身份回落默认助理「小蟹」（BUG-20260708 F2，真机
// qwen3.5:9b 取证）。据档案派生身份 + 讲题边界，随年级/教材跟随；建档/改档均回写，使 tutor 自我认同为
// 「{孩子}的辅导助手」而非小蟹。K12 领域文案，内联于 features/k12（AP-1 允许）。
const legacyTutorSoul = computed(() => {
  const child = childName.value.trim() || t('k12.profile.namePlaceholder')
  return `你是${child}的${grade.value}辅导助手，帮家长辅导孩子——像老师一样有耐心、懂教学法，但教的是家长怎么教，不是通用助手。被问到身份时，明确回答你是「${child}的辅导助手」。始终按${textbook.value} · ${grade.value}的教材范围讲题，绝不超纲用初中/高中说法；用渐进提示引导孩子自己想，不直接报答案；先肯定孩子做对的部分再纠错，多鼓励。家长找你要辅导要点、出题、看学情时照常配合。`
})
const subjectTextbookScope = computed(() =>
  TEXTBOOK_SUBJECTS.map(
    (subject) => `${t(subject.labelKey)}：${textbookEditions[subject.key]}`,
  ).join('、'),
)
const tutorSoul = computed(() => {
  const child = childName.value.trim() || t('k12.profile.namePlaceholder')
  return `你是${child}的${grade.value}辅导助手，帮家长辅导孩子——像老师一样有耐心、懂教学法，但教的是家长怎么教，不是通用助手。被问到身份时，明确回答你是「${child}的辅导助手」。始终按${grade.value}各学科对应教材范围讲题（${subjectTextbookScope.value}），绝不超纲用初中/高中说法；用渐进提示引导孩子自己想，不直接报答案；先肯定孩子做对的部分再纠错，多鼓励。家长找你要辅导要点、出题、看学情时照常配合。`
})

// 「辅导语气」可编辑人设（D3·原型建档设计有此编辑框，app 曾漏实现→tutor 无人设回落小蟹）：
// 预填派生人设、家长可微调。未编辑 → 随档案（年级/教材）跟随；编辑后 → 保留自定义。改档优先用实例已有
// system_prompt。最终 soulText 回写 system_prompt（真正让 tutor 认同为辅导助手，见 F2/D3/D4 链）。
// 「已有 system_prompt」不能当自定义信号——建档必写派生人设，那样判会让改档永远 dirty、
// 改年级人设不重派生、tutor 自称旧年级（BUG-20260711-A）。只有 ≠ 按当前档案派生的模板才算家长自定义。
const storedSoul = props.agent?.system_prompt?.trim() || ''
// 兼容由旧单教材模板自动生成的人设：它不是家长自定义，打开改档时应无损迁移为分科边界。
const storedSoulIsAutomatic =
  !storedSoul || storedSoul === tutorSoul.value || storedSoul === legacyTutorSoul.value
const soulDirty = ref(!storedSoulIsAutomatic)
const soulText = ref(storedSoulIsAutomatic ? tutorSoul.value : storedSoul)
watch(tutorSoul, (v) => {
  if (!soulDirty.value) soulText.value = v
})
function resetSoul() {
  soulDirty.value = false
  soulText.value = tutorSoul.value
}

async function refreshAgentsAfterPersistence() {
  const refreshed = await agentsStore.loadAgents()
  if (!refreshed) toast.warning(t('k12.profile.refreshFailed'))
}

async function submit() {
  submitting.value = true
  error.value = ''
  try {
    if (isEdit.value && props.agent) {
      // 改档：六科教材先并入现有 metadata 作 Desktop 兼容暂存；官方 /profile 仍只接收数学 legacy 字段。
      await updateAgent(props.agent.name, {
        display_name: displayName.value,
        description: cardDescription.value,
        system_prompt: soulText.value, // 改档回写人设（家长可编辑的「辅导语气」，未改则随档案派生，F2/D3）
        provider: provider.value, // 模型高级折叠（BUG-20260711-H）：''=跟随全局默认
        model: model.value,
        metadata: metadataWithSubjectTextbooks(props.agent.metadata),
      })
      try {
        await k12UpdateProfile({
          agent: props.agent.name,
          child_name: childName.value.trim(),
          grade_term: grade.value,
          textbook_edition: textbook.value,
        })
      } catch (profileError) {
        // Agent 与 Profile 是两个后端命令：第二步失败时恢复第一步，避免“新显示名/模型 + 旧年级”。
        try {
          await updateAgent(props.agent.name, {
            display_name: props.agent.display_name || props.agent.name,
            description: props.agent.description ?? '',
            system_prompt: props.agent.system_prompt ?? '',
            provider: props.agent.provider ?? '',
            model: props.agent.model ?? '',
            metadata: { ...props.agent.metadata },
          })
        } catch (rollbackError) {
          const original =
            profileError instanceof Error ? profileError.message : String(profileError)
          const rollback =
            rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
          throw new Error(`${original}; rollback failed: ${rollback}`)
        }
        throw profileError
      }
      await refreshAgentsAfterPersistence()
      toast.success(t('k12.profile.saved'))
      emit('created', props.agent.name)
      emit('close')
      return
    }
    // 建档：先注册 agent（scenario 标记驱动前端 registry 解析增强视图），再经 /profile 写档案 k12.*
    const name = `${K12_SCENARIO_ID}-${nanoid(8)}`
    await registerAgent({
      name,
      display_name: displayName.value,
      description: cardDescription.value, // 原型卡片副标题：年级 · 分科教材独立绑定 · 年级边界
      system_prompt: soulText.value, // 辅导助手人设（家长可编辑「辅导语气」，未改则派生）：身份+讲题边界（F2/D3）
      model: model.value, // ''=跟随全局默认强推理模型；高级折叠可指定（BUG-20260711-H）
      provider: provider.value,
      // 默认 skill 从模板 manifest 全挂好（P0 必备 + P1 默认 + k12_grade 基础设施）
      skills: boundSkills(),
      metadata: metadataWithSubjectTextbooks({
        scenario: K12_SCENARIO_ID,
        avatar: '🎓',
        'k12.learner_id': learnerID,
      }),
    })
    try {
      await k12UpdateProfile({
        agent: name,
        child_name: childName.value.trim(),
        grade_term: grade.value,
        textbook_edition: textbook.value,
      })
    } catch (profileError) {
      // register 已成功而档案写入失败时，补偿删除刚注册的半成品，避免卡片无年级/无孩子地残留。
      try {
        await unregisterAgent(name)
      } catch (rollbackError) {
        const original = profileError instanceof Error ? profileError.message : String(profileError)
        const rollback =
          rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
        throw new Error(`${original}; rollback failed: ${rollback}`)
      }
      throw profileError
    }
    await refreshAgentsAfterPersistence()
    // 建档即初始化四个默认工作流。失败不回滚已成功的档案，但必须等待真实结果并显式告警，
    // 不能 fire-and-forget 后仍宣称提醒已注册（架构 §3.13：不支持时需可见提示）。
    let provisioned: Awaited<ReturnType<typeof k12Store.setupAutomation>> = []
    try {
      provisioned = await k12Store.setupAutomation(name)
    } catch {
      provisioned = []
    }
    toast.success(t('k12.profile.created', { name: displayName.value }))
    const expectedWorkflowKinds = new Set([
      'weekly-sheet',
      'return-reminder',
      'semester-spring',
      'semester-fall',
    ])
    const actualWorkflowKinds = new Set(provisioned.map((job) => job.kind))
    const automationComplete =
      actualWorkflowKinds.size === expectedWorkflowKinds.size &&
      [...expectedWorkflowKinds].every((kind) => actualWorkflowKinds.has(kind))
    if (automationComplete) {
      toast.success(t('k12.profile.automationReady'))
    } else {
      toast.warning(t('k12.profile.automationIncomplete', { count: actualWorkflowKinds.size }))
    }
    emit('created', name)
    emit('close')
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <!-- Teleport 到 body：本弹窗内联渲染在智能体卡内，overlay 的 position:fixed 会被卡片的 transform
       祖先破坏（fixed 变成相对该祖先定位）→ 弹窗错位/footer 截断。Teleport 后回到视口坐标。 -->
  <Teleport to="body">
    <div class="k12pf-overlay" @click.self="emit('close')">
      <div class="k12pf" role="dialog" aria-modal="true">
        <div class="k12pf__head">
          <b>{{
            isEdit
              ? t('k12.profile.editTitle', { name: childName || t('k12.profile.namePlaceholder') })
              : t('k12.profile.createTitle')
          }}</b>
          <button class="k12pf__x" :aria-label="t('k12.profile.cancel')" @click="emit('close')">
            ✕
          </button>
        </div>

        <div class="k12pf__body">
          <p v-if="!isEdit" class="k12pf__intro">
            {{ t('k12.profile.intro', { name: displayName }) }}
          </p>

          <label class="k12pf__field">
            <span>{{ t('k12.profile.childName') }}</span>
            <HcClearableField>
              <input
                v-model="childName"
                class="k12pf__input"
                :placeholder="t('k12.profile.childNamePlaceholder')"
              />
            </HcClearableField>
          </label>

          <div class="k12pf__row k12pf__row--single">
            <div class="k12pf__field">
              <span>{{ t('k12.profile.grade') }}</span>
              <HcSelect v-model="grade" :options="gradeOptions" />
            </div>
          </div>
          <p class="k12pf__hint">{{ t('k12.profile.gradeSupportNote') }}</p>

          <div class="k12pf__field">
            <span>{{ t('k12.profile.textbookBySubject') }}</span>
            <div class="k12pf__textbook-grid">
              <div
                v-for="subject in TEXTBOOK_SUBJECTS"
                :key="subject.key"
                class="k12pf__textbook-row"
                data-testid="k12-textbook-row"
                :data-subject="subject.key"
              >
                <span>{{ t(subject.labelKey) }}</span>
                <div :data-testid="`k12-textbook-${subject.key}`">
                  <HcSelect
                    v-model="textbookEditions[subject.key]"
                    class="k12pf__textbook-select"
                    :options="textbookOptions(subject)"
                  />
                </div>
              </div>
            </div>
          </div>
          <p class="k12pf__hint">
            {{ t(isEdit ? 'k12.profile.textbookEditNote' : 'k12.profile.textbookCreateNote') }}
          </p>
          <p v-if="isEdit" class="k12pf__intro">{{ t('k12.profile.editNote') }}</p>

          <!-- 顶层：能力（人话·只读·安心感），不是让家长勾选的技能清单 -->
          <div v-if="!isEdit" class="k12pf__field">
            <span>{{ t('k12.profile.skillsLabel') }}</span>
            <div class="k12pf__skillchips">
              <span v-for="key in BUILTIN_SKILL_KEYS" :key="key" class="k12pf__skillchip">{{
                t(key)
              }}</span>
            </div>
          </div>

          <!-- 辅导语气(人设)：预填据档案派生的人设，家长可微调（D3·原型建档有此编辑框，app 曾漏→tutor 回落小蟹）。
             未改则随年级/教材跟随；改了则保留自定义。回写 agent.system_prompt。 -->
          <details class="k12pf__adv">
            <summary>{{ t('k12.profile.toneAdvanced') }}</summary>
            <div class="k12pf__soul">
              <HcClearableField>
                <textarea
                  v-model="soulText"
                  class="k12pf__soultext"
                  data-testid="k12-soul-text"
                  rows="4"
                  @input="soulDirty = true"
                />
              </HcClearableField>
              <button v-if="soulDirty" type="button" class="k12pf__soulreset" @click="resetSoul">
                {{ t('k12.profile.toneReset') }}
              </button>
            </div>
          </details>

          <!-- 模型（高级折叠·BUG-20260711-H，对齐原型 tutorForm）：默认跟随全局强推理模型，可不管；
             极客/多 Provider 家庭可为辅导实例单独指定（服务商→模型级联，与通用智能体编辑同通道）。 -->
          <details class="k12pf__adv" data-testid="k12pf-model">
            <summary>
              {{ t('k12.profile.modelAdvanced', '模型 · 默认已配好强推理模型，可不管') }}
            </summary>
            <div class="k12pf__row">
              <div class="k12pf__field">
                <span>{{ t('k12.profile.providerLabel', '服务商') }}</span>
                <HcSelect
                  v-model="provider"
                  :options="providerOptions"
                  data-testid="k12pf-provider"
                />
              </div>
              <div class="k12pf__field">
                <span>{{ t('k12.profile.modelLabel', '模型') }}</span>
                <HcSelect
                  v-model="model"
                  :options="modelOptions"
                  data-testid="k12pf-model-select"
                />
              </div>
            </div>
          </details>

          <div v-if="!isEdit" class="k12pf__note">{{ t('k12.profile.twoChildHint') }}</div>
          <p v-if="error" class="k12pf__err">{{ error }}</p>
        </div>

        <div class="k12pf__foot" :class="{ 'k12pf__foot--create': !isEdit }">
          <template v-if="isEdit">
            <button
              class="k12pf__btn k12pf__btn--danger"
              data-testid="k12pf-delete"
              @click="deleteConfirming = true"
            >
              {{ t('k12.profile.delete') }}
            </button>
            <span class="k12pf__footsp" />
            <button class="k12pf__btn" @click="emit('close')">{{ t('k12.profile.cancel') }}</button>
            <button class="k12pf__btn k12pf__btn--primary" :disabled="submitting" @click="submit">
              {{ t('k12.profile.save') }}
            </button>
          </template>
          <template v-else>
            <button class="k12pf__btn" data-testid="k12pf-back" @click="emit('back')">
              {{ t('k12.profile.back') }}
            </button>
            <button class="k12pf__btn" data-testid="k12pf-preview" @click="emit('preview')">
              {{ t('k12.profile.preview') }}
            </button>
            <button class="k12pf__btn k12pf__btn--primary" :disabled="submitting" @click="submit">
              {{ t('k12.profile.create') }}
            </button>
          </template>
        </div>
      </div>
    </div>
  </Teleport>

  <ConfirmDialog
    :open="deleteConfirming"
    :title="t('k12.profile.deleteConfirmTitle')"
    :message="
      t('k12.profile.deleteConfirmMessage', {
        name: t('k12.profile.assistantName', {
          child: childName || t('k12.profile.namePlaceholder'),
        }),
      })
    "
    :confirm-text="t('k12.profile.deleteConfirmAction')"
    :cancel-text="t('k12.profile.cancel')"
    :danger="true"
    @confirm="removeProfile"
    @cancel="deleteConfirming = false"
  />
</template>

<style scoped>
.k12pf-overlay {
  /* modal 层（9100）——须低于 popover（9200），否则内部 HcSelect 下拉被遮罩压住不可见（BUG-20260708）。 */
  position: fixed;
  inset: 0;
  z-index: var(--hc-z-modal);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 11vh;
  background: rgba(8, 18, 32, 0.4);
  backdrop-filter: blur(3px) saturate(120%);
  -webkit-backdrop-filter: blur(3px) saturate(120%);
}
.k12pf {
  width: 478px;
  max-width: 92vw;
  background: var(--hc-bg-elevated);
  border: 0.5px solid var(--hc-border);
  border-radius: 16px;
  box-shadow: var(--hc-shadow-float);
  overflow: hidden;
}
.k12pf__head {
  display: flex;
  align-items: center;
  padding: 16px 18px;
  border-bottom: 0.5px solid var(--hc-border);
  font-size: 15px;
}
.k12pf__x {
  margin-left: auto;
  width: 28px;
  height: 28px;
  border-radius: 8px;
  border: none;
  background: transparent;
  color: var(--hc-text-muted);
  cursor: pointer;
  font-size: 13px;
}
.k12pf__x:hover {
  background: var(--hc-bg-hover);
  color: var(--hc-text-primary);
}
.k12pf__body {
  padding: 18px;
  max-height: 62vh;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.k12pf__intro {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--hc-text-secondary);
  background: var(--hc-bg-card);
  border: 0.5px solid var(--hc-border);
  border-radius: 12px;
  padding: 11px 13px;
}
.k12pf__field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex: 1;
}
.k12pf__field > span {
  font-size: 13px;
  color: var(--hc-text-primary);
}
.k12pf__row {
  display: flex;
  gap: 12px;
}
.k12pf__row--single {
  display: block;
}
.k12pf__input {
  padding: 9px 12px;
  border-radius: 10px;
  border: 0.5px solid var(--hc-border);
  background: var(--hc-bg-input);
  font: inherit;
  font-size: 13px;
  color: var(--hc-text-primary);
  outline: none;
}
.k12pf__input:focus {
  border-color: var(--hc-accent);
  box-shadow: 0 0 0 3px var(--hc-accent-subtle);
}
.k12pf__textbook-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.k12pf__textbook-row {
  display: grid;
  grid-template-columns: 68px minmax(0, 1fr);
  align-items: center;
  gap: 8px;
}
.k12pf__textbook-row > span {
  font-size: 12px;
  color: var(--hc-text-secondary);
  text-align: right;
}
.k12pf__skillchips {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin: 2px 0;
}
.k12pf__skillchip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 0.5px solid var(--hc-border);
  background: var(--hc-bg-input);
  border-radius: 9px;
  padding: 5px 8px;
  font-size: 12px;
  color: var(--hc-text-secondary);
}
.k12pf__adv {
  border: 0.5px solid var(--hc-border);
  border-radius: 10px;
  padding: 2px 4px;
}
.k12pf__adv > summary {
  cursor: pointer;
  list-style: none;
  padding: 8px 8px;
  font-size: 12.5px;
  color: var(--hc-text-secondary);
}
.k12pf__adv > summary::-webkit-details-marker {
  display: none;
}
.k12pf__adv[open] > summary {
  color: var(--hc-text-primary);
}
.k12pf__soul {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 6px 8px 8px;
}
.k12pf__soultext {
  width: 100%;
  box-sizing: border-box;
  font: inherit;
  font-size: 12.5px;
  line-height: 1.6;
  resize: vertical;
  padding: 8px 10px;
  border-radius: 8px;
  border: 0.5px solid var(--hc-border);
  background: var(--hc-bg-input);
  color: var(--hc-text-primary);
  outline: none;
}
.k12pf__soultext:focus {
  border-color: var(--hc-accent);
  box-shadow: 0 0 0 3px var(--hc-accent-subtle);
}
.k12pf__soulreset {
  align-self: flex-start;
  font-size: 11.5px;
  padding: 4px 10px;
  border-radius: 7px;
  cursor: pointer;
  border: 0.5px solid var(--hc-border);
  background: transparent;
  color: var(--hc-text-secondary);
}
.k12pf__soulreset:hover {
  background: var(--hc-bg-hover);
  color: var(--hc-text-primary);
}
.k12pf__hint {
  margin: 0;
  font-size: 11.5px;
  color: var(--hc-text-muted);
}
.k12pf__note {
  font-size: 12px;
  color: var(--hc-text-secondary);
  background: var(--hc-bg-card);
  border: 0.5px solid var(--hc-border);
  border-radius: 10px;
  padding: 10px 12px;
}
.k12pf__err {
  margin: 0;
  font-size: 12.5px;
  color: var(--hc-error);
}
.k12pf__foot {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 18px;
  border-top: 0.5px solid var(--hc-border);
}
.k12pf__foot--create {
  justify-content: flex-end;
}
.k12pf__footsp {
  flex: 1;
}
.k12pf__btn--danger {
  color: var(--hc-error);
  border-color: color-mix(in srgb, var(--hc-error) 35%, var(--hc-border));
}
.k12pf__btn--danger:hover {
  background: color-mix(in srgb, var(--hc-error) 10%, transparent);
}
.k12pf__btn {
  padding: 8px 14px;
  border-radius: 10px;
  font-size: 13px;
  cursor: pointer;
  border: 0.5px solid var(--hc-border);
  background: var(--hc-bg-input);
  color: var(--hc-text-primary);
}
.k12pf__btn--primary {
  background: linear-gradient(180deg, #5fb3ea 0%, #4a9de0 100%);
  color: #fff;
  border-color: transparent;
}
.k12pf__btn:disabled {
  opacity: 0.6;
  cursor: default;
}
@media (max-width: 600px) {
  .k12pf__textbook-grid {
    grid-template-columns: 1fr;
  }
}
</style>
