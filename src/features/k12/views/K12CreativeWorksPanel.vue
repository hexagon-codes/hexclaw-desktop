<!--
  K12 作品面板（PRD §3.10）· 学习档案「作品」对象 Tab。
  语文写作 / 美术作品统一承载成长版本：draft→已点评→已修改→再点评（可归档）。
  只给证据化点评，不打分、不代写、不排名（INV-011）——点评内容由家长/Skill 提供，此处只做流转与展示。
  自包含：直连 /api/k12/creative-works*，本地状态，按 agentId 隔离拉取。
-->
<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useToast } from '@/composables/useToast'
import {
  k12ListCreativeWorks,
  k12CreateCreativeWork,
  k12AttachWorkFeedback,
  k12SubmitWorkRevision,
  k12ArchiveCreativeWork,
  k12AddAccumulation,
  k12RecordMistake,
  k12UploadAsset,
  k12AssetURL,
  k12SendWorkFeedback,
  k12MarkPracticeCardDone,
  type CreativeWorkDTO,
  type WorkVersionDTO,
  type WorkType,
} from '@/api/k12'
import { printPracticePaper } from '../export'

const props = defineProps<{ agentId: string }>()
const { t } = useI18n()
const toast = useToast()

const works = ref<CreativeWorkDTO[]>([])
const loading = ref(false)
const error = ref('')
const busyId = ref('')
const typeFilter = ref<'' | WorkType>('')
// 点评/修改稿的行内输入：按 record_id 存草稿文本。
const feedbackDraft = ref<Record<string, string>>({})
const revisionDraft = ref<Record<string, string>>({})

const filtered = computed(() =>
  typeFilter.value ? works.value.filter((w) => w.work_type === typeFilter.value) : works.value,
)

// ── KPI（原型 2570-2576）：从列表计算，不另拉端点 ─────────────
// 「已点评」以证据判定：任一版本带 feedback 即算（status 会随修改稿回到待点评态，证据不回退）。
function isReviewed(w: CreativeWorkDTO): boolean {
  return w.versions.some((v) => !!v.feedback)
}
const kpiTotal = computed(() => works.value.length)
const kpiReviewed = computed(() => works.value.filter(isReviewed).length)
const kpiPending = computed(() => kpiTotal.value - kpiReviewed.value)

// ── 添加作品弹窗（原型 5326-5361）─────────────
const addOpen = ref(false)
const addType = ref<WorkType>('writing')
const addTitle = ref('')
const addTask = ref('')
const addDraft = ref('') // 语文写作：原稿文字
const addIntent = ref('') // 美术作品：创作意图（可留空）
const addBusy = ref(false)

// ── 作品照片真实上传（任务1：最小资产服务 POST /assets）─────────────
// 选图即传：预览缩略 + 真实进度 + 失败提示/重试；成功得 asset://<agent>/<sha256>.<ext>，
// 保存作品时写入 source_asset_id。照片仅保存在本机（§3.12 桌面直传隐私口径）。
const photoInput = ref<HTMLInputElement | null>(null)
const photoAssetId = ref('')
const photoPreview = ref('') // objectURL 本地预览（与上传解耦，失败也能看到选了什么）
const photoPct = ref(-1) // -1=未上传；0-99=上传中；100=完成
const photoError = ref('')
let photoFile: File | null = null

const photoUploading = computed(() => photoPct.value >= 0 && photoPct.value < 100 && !photoError.value)

function resetPhoto() {
  if (photoPreview.value) URL.revokeObjectURL(photoPreview.value)
  photoAssetId.value = ''
  photoPreview.value = ''
  photoPct.value = -1
  photoError.value = ''
  photoFile = null
  if (photoInput.value) photoInput.value.value = ''
}

function onPhotoPick(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (file) acceptPhotoFile(file)
}

// 点击选择与拖放共用一条管线（20260718 控件统一，原型 creativeWorkDropzone）：
// 校验类型/体积 → 本地预览 → 立即真实上传。
function acceptPhotoFile(file: File) {
  if (!file.type.startsWith('image/')) {
    toast.error(t('k12.works.photoNotImage'))
    return
  }
  if (file.size > 10 * 1024 * 1024) {
    toast.error(t('k12.works.photoTooLarge'))
    return
  }
  if (photoPreview.value) URL.revokeObjectURL(photoPreview.value)
  photoFile = file
  photoPreview.value = URL.createObjectURL(file)
  void uploadPhoto()
}

// 拖放态：dragover 描边转实线示可投放；drop 取首个文件走同一管线。
const photoDragOver = ref(false)
function onPhotoDrop(e: DragEvent) {
  photoDragOver.value = false
  const file = e.dataTransfer?.files?.[0]
  if (file) acceptPhotoFile(file)
}

async function uploadPhoto() {
  if (!photoFile) return
  photoError.value = ''
  photoPct.value = 0
  try {
    const resp = await k12UploadAsset(props.agentId, photoFile, (p) => {
      photoPct.value = Math.min(p, 99) // 100 留给服务端确认返回
    })
    photoAssetId.value = resp.asset_id
    photoPct.value = 100
  } catch (e) {
    photoError.value = (e as Error).message || t('k12.works.photoFailed')
    photoPct.value = -1
  }
}

// 必填：名称 + 题目/任务；语文写作另需原稿（原型 mockAddCreativeWork 同口径）。
// 照片上传中不允许保存（防 source_asset_id 竞态半截落库）。
const addValid = computed(() =>
  !!addTitle.value.trim() && !!addTask.value.trim() &&
  (addType.value === 'art' || !!addDraft.value.trim()) &&
  !photoUploading.value,
)
function openAdd() {
  addType.value = 'writing'
  addTitle.value = ''
  addTask.value = ''
  addDraft.value = ''
  addIntent.value = ''
  resetPhoto()
  addOpen.value = true
}
async function submitAdd() {
  if (!addValid.value || addBusy.value) return
  addBusy.value = true
  try {
    await k12CreateCreativeWork({
      agent: props.agentId,
      work_type: addType.value,
      title: addTitle.value.trim(),
      task: addTask.value.trim(),
      intent: addType.value === 'art' ? addIntent.value.trim() || undefined : undefined,
      content_markdown: addType.value === 'writing' ? addDraft.value.trim() : undefined,
      source_asset_id: photoAssetId.value || undefined,
    })
    toast.success(t('k12.works.created'))
    addOpen.value = false
    resetPhoto()
    await load()
  } catch (e) {
    toast.error((e as Error).message)
  } finally {
    addBusy.value = false
  }
}

// ── 作品缩略图（任务1：美术卡片显缩略）────────────────────────
// 取最新携带 asset:// 资产的版本回图；data URL / 本地路径老载体不出缩略（GET 端点只认资产）。
function workThumbURL(w: CreativeWorkDTO): string {
  for (let i = w.versions.length - 1; i >= 0; i--) {
    const v = w.versions[i]
    if (!v) continue
    const id = v.source_asset_id || ''
    if (id.startsWith('asset://')) return k12AssetURL(props.agentId, id)
  }
  return ''
}

// ── 观察练习卡（任务2：§3.10 美术——练习必须有产物 + 打印/发送/打卡出口）────
// 卡文本由服务端从点评正文提炼（practice_card，单一事实源）；取最新带点评版本。
function practiceCardOf(w: CreativeWorkDTO): WorkVersionDTO | null {
  if (w.work_type !== 'art') return null
  for (let i = w.versions.length - 1; i >= 0; i--) {
    const v = w.versions[i]
    if (v?.practice_card) return v
  }
  return null
}

async function printCard(w: CreativeWorkDTO) {
  const ver = practiceCardOf(w)
  if (!ver?.practice_card) return
  const title = `${t('k12.works.practiceCardTitle')} · ${w.title}`
  const ok = await printPracticePaper(`# ${title}\n${ver.practice_card}`, title)
  if (!ok) toast.error(t('k12.works.printFailed'))
}

async function markCardDone(w: CreativeWorkDTO) {
  busyId.value = w.record_id
  try {
    await k12MarkPracticeCardDone(props.agentId, w.record_id)
    toast.success(t('k12.works.practiceCardDoneOk'))
    await load()
  } catch (e) {
    toast.error((e as Error).message)
  } finally {
    busyId.value = ''
  }
}

// ── 发送到手机（任务3：点评要点 / 观察练习卡 → 绑定私聊辅导延伸消息）────
// 未接线/未绑定诚实降级：复制文本到剪贴板 + 家长向提示，绝不虚标已发送。
function latestFeedbackOf(w: CreativeWorkDTO): string {
  for (let i = w.versions.length - 1; i >= 0; i--) {
    const fb = (w.versions[i]?.feedback || '').trim()
    if (fb) return fb
  }
  return ''
}

async function sendToPhone(w: CreativeWorkDTO, kind: 'feedback' | 'practice_card') {
  const text = kind === 'practice_card'
    ? practiceCardOf(w)?.practice_card || ''
    : latestFeedbackOf(w)
  if (!text) return
  busyId.value = w.record_id
  try {
    const resp = await k12SendWorkFeedback(props.agentId, w.record_id, kind)
    toast.success(t('k12.works.sendOk', { target: resp.target }))
  } catch (e) {
    // 诚实降级（§3.12 未绑定/未接线）：复制文本兜底 + 透传后端家长向原因。
    try {
      await navigator.clipboard.writeText(`《${w.title}》\n${text}`)
      toast.info(`${(e as Error).message} · ${t('k12.works.sendFallbackCopied')}`)
    } catch {
      toast.error((e as Error).message)
    }
  } finally {
    busyId.value = ''
  }
}

// ── 点评联动出口（§3.10，原型 5385-5464）：写作已点评卡 → 好句入积累 / 确认错处入错题 ──
// 只在 feedback_ready 的写作卡展示；内容由家长确认后填入（不自动摘取，点评是家长手写的）。
const accumOpenId = ref('')
const mistakeOpenId = ref('')
const accumDraft = ref<Record<string, string>>({})
const mistakeDraft = ref<Record<string, string>>({})
function toggleAccum(w: CreativeWorkDTO) {
  accumOpenId.value = accumOpenId.value === w.record_id ? '' : w.record_id
  mistakeOpenId.value = ''
}
function toggleMistake(w: CreativeWorkDTO) {
  mistakeOpenId.value = mistakeOpenId.value === w.record_id ? '' : w.record_id
  accumOpenId.value = ''
}
async function submitAccum(w: CreativeWorkDTO) {
  const content = (accumDraft.value[w.record_id] || '').trim()
  if (!content) return
  busyId.value = w.record_id
  try {
    await k12AddAccumulation({
      agent: props.agentId,
      subject: '语文',
      entry_type: '写作素材',
      content,
      source: `作品点评 · ${w.title}`,
    })
    accumDraft.value[w.record_id] = ''
    accumOpenId.value = ''
    toast.success(t('k12.works.accumSaved'))
  } catch (e) {
    toast.error((e as Error).message)
  } finally {
    busyId.value = ''
  }
}
async function submitMistake(w: CreativeWorkDTO) {
  const problem = (mistakeDraft.value[w.record_id] || '').trim()
  if (!problem) return
  busyId.value = w.record_id
  try {
    // grade 留空：后端 resolveGrade 从孩子档案回填（record_mistake handler 契约）。
    await k12RecordMistake({ agent: props.agentId, subject: '语文', grade: '', problem })
    mistakeDraft.value[w.record_id] = ''
    mistakeOpenId.value = ''
    toast.success(t('k12.works.mistakeSaved'))
  } catch (e) {
    toast.error((e as Error).message)
  } finally {
    busyId.value = ''
  }
}

async function load() {
  if (!props.agentId) return
  loading.value = true
  error.value = ''
  try {
    const resp = await k12ListCreativeWorks(props.agentId)
    works.value = resp.items ?? []
  } catch (e) {
    error.value = (e as Error).message || t('k12.works.loadError')
  } finally {
    loading.value = false
  }
}

onMounted(load)
watch(() => props.agentId, load)

function statusTone(s: string): string {
  if (s === 'draft') return 'todo'
  if (s === 'feedback_ready') return 'got'
  if (s === 'revised') return 'done'
  return 'muted'
}

async function submitFeedback(w: CreativeWorkDTO) {
  const fb = (feedbackDraft.value[w.record_id] || '').trim()
  if (!fb) return
  busyId.value = w.record_id
  try {
    await k12AttachWorkFeedback(props.agentId, w.record_id, fb)
    feedbackDraft.value[w.record_id] = ''
    toast.success(t('k12.works.addFeedback'))
    await load()
  } catch (e) {
    toast.error((e as Error).message)
  } finally {
    busyId.value = ''
  }
}

async function submitRevision(w: CreativeWorkDTO) {
  const content = (revisionDraft.value[w.record_id] || '').trim()
  if (!content) return
  busyId.value = w.record_id
  try {
    await k12SubmitWorkRevision(props.agentId, w.record_id, content)
    revisionDraft.value[w.record_id] = ''
    toast.success(t('k12.works.submitRevision'))
    await load()
  } catch (e) {
    toast.error((e as Error).message)
  } finally {
    busyId.value = ''
  }
}

async function archive(w: CreativeWorkDTO) {
  busyId.value = w.record_id
  try {
    await k12ArchiveCreativeWork(props.agentId, w.record_id)
    toast.success(t('k12.works.archive'))
    await load()
  } catch (e) {
    toast.error((e as Error).message)
  } finally {
    busyId.value = ''
  }
}

defineExpose({ load })
</script>

<template>
  <section class="k12cw">
    <div class="k12cw__top">
      <p class="k12cw__desc" style="margin: 0">{{ t('k12.works.desc') }}</p>
      <button class="k12cw__btn k12cw__btn--primary" data-testid="cw-add-open" @click="openAdd">
        {{ t('k12.works.addWork') }}
      </button>
    </div>

    <!-- KPI 行（原型 2570-2576）：全部 / 已点评 / 待点评，从列表计算 -->
    <div class="k12cw__kpis" data-testid="cw-kpis">
      <div class="k12cw__kpi"><b>{{ kpiTotal }}</b>{{ t('k12.works.kpiTotal') }}</div>
      <div class="k12cw__kpi"><b>{{ kpiReviewed }}</b>{{ t('k12.works.kpiReviewed') }}</div>
      <div class="k12cw__kpi"><b>{{ kpiPending }}</b>{{ t('k12.works.kpiPending') }}</div>
    </div>

    <!-- 点评规则说明（原型 2582）：证据化点评边界，不打分不代写 -->
    <div class="k12cw__rules" data-testid="cw-rules">
      <b>{{ t('k12.works.rulesTitle') }}</b>
      {{ t('k12.works.rulesBody') }}
    </div>

    <div class="k12cw__filter" role="tablist" aria-label="作品类型">
      <button :class="{ on: typeFilter === '' }" @click="typeFilter = ''">全部</button>
      <button :class="{ on: typeFilter === 'writing' }" @click="typeFilter = 'writing'">{{ t('k12.works.writing') }}</button>
      <button :class="{ on: typeFilter === 'art' }" @click="typeFilter = 'art'">{{ t('k12.works.art') }}</button>
    </div>

    <div v-if="error" class="k12cw__err" data-testid="cw-error">{{ error }}</div>
    <div v-else-if="loading && works.length === 0" class="k12cw__empty">…</div>
    <div v-else-if="filtered.length === 0" class="k12cw__empty" data-testid="cw-empty">
      {{ t('k12.works.empty') }}
    </div>

    <ul v-else class="k12cw__list" data-testid="cw-list">
      <li v-for="w in filtered" :key="w.record_id" class="k12cw__card">
        <header class="k12cw__head">
          <span class="k12cw__kind">{{ w.work_type === 'writing' ? t('k12.works.writing') : t('k12.works.art') }}</span>
          <b class="k12cw__title">{{ w.title }}</b>
          <span :class="`k12cw__pill k12cw__pill--${statusTone(w.status)}`">{{ w.status_label }}</span>
          <span class="k12cw__vers">{{ w.versions.length }} {{ t('k12.works.versionCount') }}</span>
        </header>
        <p class="k12cw__task">{{ w.task }}</p>

        <!-- 作品照片缩略（任务1）：最新 asset:// 资产回图；无资产不占位 -->
        <img
          v-if="workThumbURL(w)"
          :src="workThumbURL(w)"
          class="k12cw__thumb"
          :alt="w.title"
          data-testid="cw-thumb"
          loading="lazy"
        />

        <!-- 版本时间线：原稿 + 每次修改稿 + 各自点评 -->
        <ol class="k12cw__versions">
          <li v-for="ver in w.versions" :key="ver.version_id" class="k12cw__ver">
            <span class="k12cw__vid">{{ ver.version_id }}</span>
            <div class="k12cw__vbody">
              <p v-if="ver.content_markdown" class="k12cw__vcontent">{{ ver.content_markdown }}</p>
              <p v-if="ver.feedback" class="k12cw__vfeedback">💬 {{ ver.feedback }}</p>
            </div>
          </li>
        </ol>

        <!-- 发送点评要点（任务3，§3.10：点评可发送到手机）：失败诚实降级为复制文本 -->
        <div v-if="latestFeedbackOf(w) && w.status !== 'archived'" class="k12cw__sendrow">
          <button
            class="k12cw__btn k12cw__btn--ghost"
            data-testid="cw-send-feedback"
            :disabled="busyId === w.record_id"
            @click="sendToPhone(w, 'feedback')"
          >{{ t('k12.works.sendFeedback') }}</button>
        </div>

        <!-- 观察练习卡（任务2，§3.10 美术）：练习必须有产物——归档在版本记录，
             承诺即动作：打印 / 发送到手机 / 完成打卡；不进错题与练习集 -->
        <div v-if="practiceCardOf(w)" class="k12cw__pcard" data-testid="cw-practice-card">
          <b>{{ t('k12.works.practiceCardTitle') }}</b>
          <p class="k12cw__pcardtext">{{ practiceCardOf(w)!.practice_card }}</p>
          <p
            v-if="practiceCardOf(w)!.practice_card_done_at"
            class="k12cw__pcarddone"
            data-testid="cw-card-done-state"
          >✓ {{ t('k12.works.practiceCardDoneAt') }}</p>
          <div class="k12cw__linkbtns">
            <button class="k12cw__btn k12cw__btn--ghost" data-testid="cw-card-print" @click="printCard(w)">
              {{ t('k12.works.practiceCardPrint') }}
            </button>
            <button
              class="k12cw__btn k12cw__btn--ghost"
              data-testid="cw-card-send"
              :disabled="busyId === w.record_id"
              @click="sendToPhone(w, 'practice_card')"
            >{{ t('k12.works.practiceCardSend') }}</button>
            <button
              v-if="!practiceCardOf(w)!.practice_card_done_at"
              class="k12cw__btn"
              data-testid="cw-card-done"
              :disabled="busyId === w.record_id"
              @click="markCardDone(w)"
            >{{ t('k12.works.practiceCardMarkDone') }}</button>
          </div>
          <p class="k12cw__ainote">{{ t('k12.works.practiceCardHint') }}</p>
        </div>

        <!-- 待点评 / 已修改：写点评。AI 生成点评是后端 Skill 接线未完成——手写点评保留，不做假 AI。 -->
        <div v-if="w.status === 'draft' || w.status === 'revised'" class="k12cw__act">
          <textarea
            v-model="feedbackDraft[w.record_id]"
            class="k12cw__input"
            :placeholder="t('k12.works.addFeedback') + '（只给具体建议，不打分不代写）'"
            rows="2"
            data-testid="cw-feedback-input"
          ></textarea>
          <p class="k12cw__ainote" data-testid="cw-ai-pending">{{ t('k12.works.aiPendingNote') }}</p>
          <button class="k12cw__btn k12cw__btn--primary" :disabled="busyId === w.record_id || !(feedbackDraft[w.record_id] || '').trim()" data-testid="cw-feedback-submit" @click="submitFeedback(w)">
            {{ t('k12.works.addFeedback') }}
          </button>
        </div>

        <!-- 已点评：提交修改稿 -->
        <div v-else-if="w.status === 'feedback_ready'" class="k12cw__act">
          <textarea
            v-model="revisionDraft[w.record_id]"
            class="k12cw__input"
            :placeholder="t('k12.works.submitRevision')"
            rows="2"
            data-testid="cw-revision-input"
          ></textarea>
          <button class="k12cw__btn k12cw__btn--primary" :disabled="busyId === w.record_id || !(revisionDraft[w.record_id] || '').trim()" data-testid="cw-revision-submit" @click="submitRevision(w)">
            {{ t('k12.works.submitRevision') }}
          </button>
        </div>

        <!-- 点评联动出口（§3.10，仅写作 · 已点评）：好句入积累 / 确认错处入错题 -->
        <div v-if="w.work_type === 'writing' && w.status === 'feedback_ready'" class="k12cw__link">
          <div class="k12cw__linkbtns">
            <button class="k12cw__btn k12cw__btn--ghost" data-testid="cw-accum-open" @click="toggleAccum(w)">
              {{ t('k12.works.toAccum') }}
            </button>
            <button class="k12cw__btn k12cw__btn--ghost" data-testid="cw-mistake-open" @click="toggleMistake(w)">
              {{ t('k12.works.toMistake') }}
            </button>
          </div>
          <div v-if="accumOpenId === w.record_id" class="k12cw__linkform">
            <textarea
              v-model="accumDraft[w.record_id]"
              class="k12cw__input"
              :placeholder="t('k12.works.accumPlaceholder')"
              rows="2"
              data-testid="cw-accum-input"
            ></textarea>
            <button class="k12cw__btn k12cw__btn--primary" :disabled="busyId === w.record_id || !(accumDraft[w.record_id] || '').trim()" data-testid="cw-accum-submit" @click="submitAccum(w)">
              {{ t('k12.works.confirm') }}
            </button>
          </div>
          <div v-if="mistakeOpenId === w.record_id" class="k12cw__linkform">
            <textarea
              v-model="mistakeDraft[w.record_id]"
              class="k12cw__input"
              :placeholder="t('k12.works.mistakePlaceholder')"
              rows="2"
              data-testid="cw-mistake-input"
            ></textarea>
            <button class="k12cw__btn k12cw__btn--primary" :disabled="busyId === w.record_id || !(mistakeDraft[w.record_id] || '').trim()" data-testid="cw-mistake-submit" @click="submitMistake(w)">
              {{ t('k12.works.confirm') }}
            </button>
          </div>
        </div>

        <footer v-if="w.status !== 'archived'" class="k12cw__foot">
          <button class="k12cw__btn k12cw__btn--ghost" :disabled="busyId === w.record_id" @click="archive(w)">
            {{ t('k12.works.archive') }}
          </button>
        </footer>
      </li>
    </ul>

    <!-- 添加作品弹窗（原型 5326-5361）。z-index 走 modal 令牌，与 K12BackupModal 同层。 -->
    <div v-if="addOpen" class="k12cw-overlay" data-testid="cw-add-modal" @click.self="addOpen = false">
      <div class="k12cw-modal" role="dialog" aria-modal="true" :aria-label="t('k12.works.addModalTitle')">
        <div class="k12cw-modal__head">
          <b>{{ t('k12.works.addModalTitle') }}</b>
          <button class="k12cw-modal__x" :aria-label="t('k12.works.cancel')" @click="addOpen = false">✕</button>
        </div>
        <div class="k12cw-modal__body">
          <label class="k12cw-modal__field">
            <span>{{ t('k12.works.typeLabel') }}</span>
            <div class="k12cw__seg" role="radiogroup" :aria-label="t('k12.works.typeLabel')">
              <button
                type="button"
                :class="{ on: addType === 'writing' }"
                :aria-pressed="addType === 'writing'"
                data-testid="cw-add-type-writing"
                @click="addType = 'writing'"
              >{{ t('k12.works.writing') }}</button>
              <button
                type="button"
                :class="{ on: addType === 'art' }"
                :aria-pressed="addType === 'art'"
                data-testid="cw-add-type-art"
                @click="addType = 'art'"
              >{{ t('k12.works.art') }}</button>
            </div>
          </label>
          <!-- 作品照片（20260718 布局定案：英雄字段置首）：hc-drop 同款拖放区，拖放或点击选择；
               选图即真实上传（POST /assets），预览缩略 + 真实进度 + 失败重试。 -->
          <div class="k12cw-modal__field">
            <span>{{ t('k12.works.photoLabel') }}</span>
            <input
              ref="photoInput"
              type="file"
              accept="image/*"
              class="k12cw__file"
              data-testid="cw-add-photo-input"
              @change="onPhotoPick"
            />
            <div
              v-if="!photoPreview"
              class="k12cw__drop"
              :class="{ 'k12cw__drop--over': photoDragOver }"
              role="button"
              tabindex="0"
              data-testid="cw-add-photo"
              @click="photoInput?.click()"
              @keydown.enter.prevent="photoInput?.click()"
              @keydown.space.prevent="photoInput?.click()"
              @dragover.prevent="photoDragOver = true"
              @dragleave="photoDragOver = false"
              @drop.prevent="onPhotoDrop"
            >
              <span class="k12cw__dropicon" aria-hidden="true">📷</span>
              <b>{{ t('k12.works.photoChoose') }}</b>
            </div>
            <div v-else class="k12cw__photoprev" data-testid="cw-photo-preview">
              <img :src="photoPreview" alt="" />
              <div class="k12cw__photostate">
                <span v-if="photoUploading" data-testid="cw-photo-progress">
                  {{ t('k12.works.photoUploading') }} {{ photoPct }}%
                </span>
                <span v-else-if="photoError" class="k12cw__photoerr" data-testid="cw-photo-error">{{ photoError }}</span>
                <span v-else-if="photoAssetId" data-testid="cw-photo-ok">{{ t('k12.works.photoUploaded') }}</span>
                <button
                  v-if="photoError"
                  type="button"
                  class="k12cw__btn k12cw__btn--ghost"
                  data-testid="cw-photo-retry"
                  @click="uploadPhoto"
                >{{ t('k12.works.photoRetry') }}</button>
                <button
                  type="button"
                  class="k12cw__btn k12cw__btn--ghost"
                  data-testid="cw-photo-remove"
                  @click="resetPhoto"
                >{{ t('k12.works.photoRemove') }}</button>
              </div>
            </div>
            <p class="k12cw__ainote">{{ t('k12.works.photoHint') }}</p>
          </div>
          <label class="k12cw-modal__field">
            <span>{{ t('k12.works.nameLabel') }}</span>
            <input v-model="addTitle" class="k12cw__input" :placeholder="t('k12.works.namePlaceholder')" data-testid="cw-add-title" />
          </label>
          <label class="k12cw-modal__field">
            <span>{{ addType === 'writing' ? t('k12.works.taskLabelWriting') : t('k12.works.taskLabelArt') }}</span>
            <input v-model="addTask" class="k12cw__input" :placeholder="t('k12.works.taskPlaceholder')" data-testid="cw-add-task" />
          </label>
          <label v-if="addType === 'writing'" class="k12cw-modal__field">
            <span>{{ t('k12.works.draftLabel') }}</span>
            <textarea v-model="addDraft" class="k12cw__input" rows="4" :placeholder="t('k12.works.draftPlaceholder')" data-testid="cw-add-draft"></textarea>
          </label>
          <label v-else class="k12cw-modal__field">
            <span>{{ t('k12.works.intentLabel') }}</span>
            <textarea v-model="addIntent" class="k12cw__input" rows="3" :placeholder="t('k12.works.intentPlaceholder')" data-testid="cw-add-intent"></textarea>
          </label>
        </div>
        <div class="k12cw-modal__foot">
          <button class="k12cw__btn k12cw__btn--ghost" @click="addOpen = false">{{ t('k12.works.cancel') }}</button>
          <button
            class="k12cw__btn k12cw__btn--primary"
            :disabled="!addValid || addBusy"
            data-testid="cw-add-submit"
            @click="submitAdd"
          >{{ t('k12.works.save') }}</button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.k12cw__desc { color: var(--hc-text-muted); font-size: 12px; line-height: 1.6; margin: 0 0 12px; }
.k12cw__top { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
.k12cw__kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 10px; margin-bottom: 12px; }
.k12cw__kpi {
  border: .5px solid var(--hc-border); border-radius: var(--hc-radius-lg); background: var(--hc-bg-card);
  box-shadow: var(--hc-shadow-sm); padding: 11px 14px; font-size: 11.5px; color: var(--hc-text-secondary);
}
.k12cw__kpi b {
  display: block; font-size: 20px; font-weight: 700; letter-spacing: -.02em;
  color: var(--hc-text-primary); margin-bottom: 2px; font-variant-numeric: tabular-nums;
}
.k12cw__rules {
  border: .5px solid var(--hc-border); border-left: 3px solid var(--hc-accent); border-radius: var(--hc-radius-md);
  background: var(--hc-bg-card); padding: 10px 13px; font-size: 11.5px; line-height: 1.65;
  color: var(--hc-text-secondary); margin-bottom: 12px;
}
.k12cw__rules b { display: block; color: var(--hc-text-primary); margin-bottom: 2px; }
.k12cw__ainote { margin: 0; font-size: 10.5px; color: var(--hc-text-muted); line-height: 1.5; }
.k12cw__link { border-top: .5px dashed var(--hc-border); padding-top: 8px; margin-bottom: 8px; display: grid; gap: 7px; }
.k12cw__linkbtns { display: flex; gap: 7px; flex-wrap: wrap; }
.k12cw__linkbtns .k12cw__btn--ghost { border-color: var(--hc-border); }
.k12cw__linkform { display: grid; gap: 7px; }
.k12cw__seg { display: flex; gap: 4px; }
.k12cw__seg button {
  flex: 1; font: inherit; font-size: 12px; padding: 7px 0; border-radius: var(--hc-radius-md);
  border: .5px solid var(--hc-border); background: var(--hc-bg-input); color: var(--hc-text-secondary); cursor: pointer;
}
.k12cw__seg button.on { background: var(--hc-accent-subtle); color: var(--hc-accent); font-weight: 650; border-color: var(--hc-accent); }
/* hc-drop 同款拖放区（20260718 控件统一，原型 creativeWorkDropzone）：
   虚线待选 → hover/dragover 描边转 accent；drop 与点击共用上传管线。 */
.k12cw__drop {
  display: flex; flex-direction: column; align-items: center; gap: 5px;
  padding: 16px 12px; text-align: center; width: 100%; box-sizing: border-box;
  border: 1px dashed var(--hc-border); border-radius: 12px;
  background: var(--hc-bg-input); color: var(--hc-text-muted); cursor: pointer;
}
.k12cw__drop b { font-size: 12.5px; font-weight: 600; color: var(--hc-text-primary); }
.k12cw__drop:hover { border-color: var(--hc-accent); }
.k12cw__drop--over {
  border-style: solid;
  border-color: color-mix(in srgb, var(--hc-accent) 45%, transparent);
  background: var(--hc-accent-subtle);
}
.k12cw__dropicon { font-size: 24px; line-height: 1; }
.k12cw__file { display: none; }
.k12cw__photoprev { display: flex; gap: 10px; align-items: flex-start; }
.k12cw__photoprev img {
  width: 92px; height: 92px; object-fit: cover; border-radius: var(--hc-radius-md);
  border: .5px solid var(--hc-border); flex-shrink: 0;
}
.k12cw__photostate { display: grid; gap: 6px; font-size: 11.5px; color: var(--hc-text-secondary); justify-items: start; }
.k12cw__photoerr { color: var(--hc-error); }
.k12cw__thumb {
  max-width: 160px; max-height: 120px; object-fit: cover; border-radius: var(--hc-radius-md);
  border: .5px solid var(--hc-border); margin: 0 0 10px; display: block;
}
.k12cw__sendrow { display: flex; justify-content: flex-end; margin-bottom: 8px; }
.k12cw__sendrow .k12cw__btn--ghost { border-color: var(--hc-border); }
.k12cw__pcard {
  border: .5px solid var(--hc-border); border-left: 3px solid var(--hc-success);
  border-radius: var(--hc-radius-md); background: var(--hc-bg-input);
  padding: 10px 13px; margin-bottom: 10px; display: grid; gap: 7px;
}
.k12cw__pcard > b { font-size: 12px; color: var(--hc-text-primary); }
.k12cw__pcardtext { margin: 0; font-size: 11.5px; line-height: 1.7; color: var(--hc-text-secondary); white-space: pre-line; }
.k12cw__pcarddone { margin: 0; font-size: 11px; color: var(--hc-success); }
.k12cw-overlay {
  /* modal 层（9100）令牌，与 K12BackupModal 一致；须低于 popover（BUG-20260708） */
  position: fixed; inset: 0; z-index: var(--hc-z-modal);
  display: flex; align-items: flex-start; justify-content: center; padding-top: 9vh;
  background: rgba(8, 18, 32, 0.4);
  backdrop-filter: blur(3px) saturate(120%); -webkit-backdrop-filter: blur(3px) saturate(120%);
}
.k12cw-modal {
  width: 478px; max-width: 92vw; max-height: 82vh; overflow: auto; background: var(--hc-bg-elevated);
  border: .5px solid var(--hc-border); border-radius: 16px; box-shadow: var(--hc-shadow-float);
}
.k12cw-modal__head { display: flex; align-items: center; padding: 15px 18px; border-bottom: .5px solid var(--hc-border); font-size: 14.5px; color: var(--hc-text-primary); }
.k12cw-modal__x { margin-left: auto; width: 28px; height: 28px; border-radius: 8px; border: none; background: transparent; color: var(--hc-text-muted); cursor: pointer; }
.k12cw-modal__x:hover { background: var(--hc-bg-hover); color: var(--hc-text-primary); }
.k12cw-modal__body { padding: 16px 18px; display: grid; gap: 13px; }
.k12cw-modal__field { display: grid; gap: 6px; }
.k12cw-modal__field > span { font-size: 12.5px; color: var(--hc-text-primary); }
.k12cw-modal__foot { display: flex; justify-content: flex-end; gap: 8px; padding: 13px 18px; border-top: .5px solid var(--hc-border); }
.k12cw__filter { display: inline-flex; gap: 3px; margin-bottom: 12px; }
.k12cw__filter button {
  font: inherit; font-size: 12px; border: none; background: transparent; color: var(--hc-text-secondary);
  padding: 6px 12px; border-radius: var(--hc-radius-md); cursor: pointer; transition: background .15s, color .15s;
}
.k12cw__filter button:hover { background: var(--hc-bg-hover); color: var(--hc-text-primary); }
.k12cw__filter button.on { background: var(--hc-accent-subtle); color: var(--hc-accent); font-weight: 600; }
.k12cw__err { color: var(--hc-error); font-size: 13px; padding: 10px 0; }
.k12cw__empty { color: var(--hc-text-muted); font-size: 13px; padding: 24px 4px; line-height: 1.6; }
.k12cw__list { list-style: none; margin: 0; padding: 0; display: grid; gap: 12px; }
.k12cw__card {
  border: .5px solid var(--hc-border); border-radius: var(--hc-radius-lg);
  background: var(--hc-bg-card); box-shadow: var(--hc-shadow-sm); padding: 14px 15px;
}
.k12cw__head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.k12cw__kind { font-size: 10.5px; font-weight: 650; color: var(--hc-accent); background: var(--hc-accent-subtle); border-radius: 4px; padding: 2px 7px; }
.k12cw__title { font-size: 13.5px; color: var(--hc-text-primary); }
.k12cw__pill { font-size: 10.5px; font-weight: 700; border-radius: 999px; padding: 2px 9px; }
.k12cw__pill--todo { color: var(--hc-error); background: color-mix(in srgb, var(--hc-error) 10%, transparent); }
.k12cw__pill--got { color: var(--hc-success); background: color-mix(in srgb, var(--hc-success) 10%, transparent); }
.k12cw__pill--done { color: var(--hc-accent); background: var(--hc-accent-subtle); }
.k12cw__pill--muted { color: var(--hc-text-muted); background: var(--hc-bg-input); }
.k12cw__vers { color: var(--hc-text-muted); font-size: 11px; margin-left: auto; font-variant-numeric: tabular-nums; }
.k12cw__task { color: var(--hc-text-muted); font-size: 11.5px; line-height: 1.55; margin: 8px 0; }
.k12cw__versions { list-style: none; margin: 0 0 10px; padding: 0; display: grid; gap: 7px; }
.k12cw__ver { display: flex; gap: 9px; padding: 9px 11px; border-radius: var(--hc-radius-md); background: var(--hc-bg-input); }
.k12cw__vid { font-size: 10.5px; font-weight: 800; color: var(--hc-accent); flex-shrink: 0; }
.k12cw__vbody { min-width: 0; }
.k12cw__vcontent { font-size: 11.5px; color: var(--hc-text-primary); line-height: 1.6; margin: 0; }
.k12cw__vfeedback { font-size: 11px; color: var(--hc-text-secondary); line-height: 1.6; margin: 5px 0 0; }
.k12cw__act { display: grid; gap: 7px; margin-bottom: 8px; }
.k12cw__input {
  font: inherit; font-size: 12px; border: .5px solid var(--hc-border); border-radius: var(--hc-radius-md);
  background: var(--hc-bg-input); color: var(--hc-text-primary); padding: 8px 11px; resize: vertical; outline: none;
}
.k12cw__input:focus { border-color: var(--hc-accent); }
.k12cw__foot { display: flex; justify-content: flex-end; }
.k12cw__btn {
  font: inherit; font-size: 12px; font-weight: 500; border-radius: var(--hc-radius-md);
  padding: 6px 13px; border: .5px solid var(--hc-border); background: var(--hc-bg-card);
  color: var(--hc-text-primary); cursor: pointer; justify-self: end;
  transition: background .15s, opacity .15s, filter .15s;
}
.k12cw__btn:disabled { opacity: .45; cursor: not-allowed; }
.k12cw__btn--primary {
  background: linear-gradient(180deg, #5fb3ea 0%, #4a9de0 100%); color: #fff; border-color: transparent;
}
.k12cw__btn--primary:hover:not(:disabled) { filter: brightness(1.04); }
.k12cw__btn--ghost { background: transparent; border-color: transparent; color: var(--hc-text-secondary); }
.k12cw__btn--ghost:hover:not(:disabled) { background: var(--hc-bg-hover); }
</style>
