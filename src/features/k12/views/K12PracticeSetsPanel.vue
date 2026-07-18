<!--
  K12 练习集面板（PRD §3.8 购物车模型 · 2026-07-18 收敛 / §4.13 呈现物规范）。
  页面固定两段：**待打印篮**（单一 draft，按学科分组、阻断沉底、逐题移除）+ **打印历史**（倒序，三态呈现）。
  打印/发送即家长确认（finalize 一步固化，逐题跳过阻断题）；界面不展示六态时间轴（三态：待打印/待完成/已批改）。
-->
<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useToast } from '@/composables/useToast'
import {
  k12ListPracticeSets,
  k12FinalizePracticeSet,
  k12RemoveFromBasket,
  k12AdvancePracticeSet,
  k12CancelPracticeSet,
  k12GetPracticePaper,
  type PracticeSetDTO,
  type PracticeItemDTO,
  type PracticePaperResp,
} from '@/api/k12'
import MarkdownRenderer from '@/components/chat/MarkdownRenderer.vue'
import { printPracticePaper } from '../export'

const props = defineProps<{ agentId: string }>()
const { t } = useI18n()
const toast = useToast()

const sets = ref<PracticeSetDTO[]>([])
const loading = ref(false)
const error = ref('')
const busy = ref('') // record_id（或 record_id:item_id）级操作锁

async function load() {
  if (!props.agentId) return
  loading.value = true
  error.value = ''
  try {
    const resp = await k12ListPracticeSets(props.agentId)
    sets.value = resp.items ?? []
  } catch (e) {
    error.value = (e as Error).message || t('k12.practice.loadError')
  } finally {
    loading.value = false
  }
}
onMounted(load)
watch(() => props.agentId, load)
defineExpose({ load })

// ── 待打印篮（单 Learner 单篮：draft 态练习集，§3.8）──
const basket = computed(() => sets.value.find((s) => s.status === 'draft') ?? null)

// §4.13 卷面学科分组顺序：数学→语文→英语→科学→信息科技→未分科；阻断题沉底独立组。
const SUBJECT_ORDER = ['数学', '语文', '英语', '科学', '信息科技']
interface BasketGroup { key: string; label: string; blocked: boolean; items: PracticeItemDTO[] }
const basketGroups = computed<BasketGroup[]>(() => {
  const b = basket.value
  if (!b) return []
  const verified = b.items.filter((it) => it.verification_status === 'verified')
  const blocked = b.items.filter((it) => it.verification_status !== 'verified')
  const groups: BasketGroup[] = []
  for (const subj of [...SUBJECT_ORDER, '']) {
    const items = verified.filter((it) => (it.subject ?? '') === subj)
    if (items.length) groups.push({ key: subj || 'other', label: subj || '其他', blocked: false, items })
  }
  if (blocked.length) groups.push({ key: 'blocked', label: t('k12.practice.blockedGroup'), blocked: true, items: blocked })
  return groups
})
const verifiedCount = computed(() => basket.value?.items.filter((it) => it.verification_status === 'verified').length ?? 0)
const blockedCount = computed(() => (basket.value?.items.length ?? 0) - verifiedCount.value)
const canFinalize = computed(() => verifiedCount.value > 0)

// 篮内连续题号（§4.13 paper_seq 镜像）：只给 verified 题按分组顺序编号；阻断题无题号。
const seqOf = computed(() => {
  const m = new Map<string, number>()
  let n = 0
  for (const g of basketGroups.value) {
    if (g.blocked) continue
    for (const it of g.items) m.set(it.item_id, ++n)
  }
  return m
})

// added_via → 来源小字（§3.8 装篮入口三个）。
function viaLabel(via?: string): string {
  switch (via) {
    case 'weekly': return '每周自动加入'
    case 'single_variant': return '错题再练加入'
    case 'custom': return '组卷加入'
    case 'accumulation': return '积累默写加入'
    case 'manual': return '手工加入'
    default: return ''
  }
}

async function removeItem(it: PracticeItemDTO) {
  const b = basket.value
  if (!b) return
  busy.value = `${b.record_id}:${it.item_id}`
  try {
    await k12RemoveFromBasket(props.agentId, b.record_id, it.item_id)
    await load()
  } catch (e) {
    toast.error((e as Error).message)
  } finally {
    busy.value = ''
  }
}

async function finalize(via: 'print' | 'send') {
  const b = basket.value
  if (!b) return
  busy.value = b.record_id
  try {
    const resp = await k12FinalizePracticeSet(props.agentId, b.record_id, via, via === 'send' ? '手机私聊' : undefined)
    const base = via === 'print' ? t('k12.practice.print') : t('k12.practice.assign')
    toast.success(
      resp.skipped_blocked_count > 0
        ? `${base} · ${t('k12.practice.skipped', { n: resp.skipped_blocked_count })}`
        : base,
    )
    await load()
  } catch (e) {
    toast.error((e as Error).message)
  } finally {
    busy.value = ''
  }
}

// ── 打印历史（非 draft；finalized_at 倒序，§4.13 唯一排序依据）──
const history = computed(() =>
  sets.value
    .filter((s) => s.status !== 'draft')
    .sort((a, b) => (b.finalized_at ?? 0) - (a.finalized_at ?? 0)),
)

// 三态呈现（§3.8 状态机映射）：待完成（confirmed/assigned/submitted）/ 已批改（graded/closed）/ 已取消。
function displayState(s: PracticeSetDTO): { label: string; tone: string } {
  if (s.status === 'cancelled') return { label: s.status_label, tone: 'muted' }
  if (s.status === 'graded' || s.status === 'closed') return { label: '已批改', tone: 'got' }
  return { label: '待完成', tone: 'todo' }
}

async function advance(s: PracticeSetDTO, step: 'submit' | 'grade' | 'close', okMsg: string) {
  busy.value = s.record_id
  try {
    await k12AdvancePracticeSet(props.agentId, s.record_id, step)
    toast.success(okMsg)
    await load()
  } catch (e) {
    toast.error((e as Error).message)
  } finally {
    busy.value = ''
  }
}
// ── 题目卷/答案卷查看（§4.13 呈现物真实渲染，2026-07-18）──
// 历史卡片：正卷（页眉/页脚含卷面号）；待打印区：draft 预览走后端同一渲染器
// （诚实预览：预览口径 = 固化产物口径，无卷面号、明示“打印或发送后分配”）。
const paper = ref<{ open: boolean; loading: boolean; error: string; resp: PracticePaperResp | null }>({
  open: false, loading: false, error: '', resp: null,
})
async function openPaper(recordId: string, kind: 'question' | 'answer') {
  paper.value = { open: true, loading: true, error: '', resp: null }
  try {
    const resp = await k12GetPracticePaper(props.agentId, recordId, kind)
    paper.value = { open: true, loading: false, error: '', resp }
  } catch (e) {
    paper.value = { open: true, loading: false, error: (e as Error).message || t('k12.practice.paperLoadError'), resp: null }
  }
}
function closePaper() {
  paper.value = { open: false, loading: false, error: '', resp: null }
}
// 打印只对正卷开放：预览无卷面号，纸质卷必须走「打印题目卷」固化通道（打印即确认），
// 预览通道不得成为绕过固化的旁路。
async function printPaper() {
  const p = paper.value.resp
  if (!p || p.preview) return
  await printPracticePaper(p.markdown, p.title + (p.kind === 'answer' ? ' · ' + t('k12.practice.paperAnswer') : ''))
}

async function cancelSet(s: PracticeSetDTO) {
  busy.value = s.record_id
  try {
    await k12CancelPracticeSet(props.agentId, s.record_id)
    toast.success(t('k12.practice.cancel'))
    await load()
  } catch (e) {
    toast.error((e as Error).message)
  } finally {
    busy.value = ''
  }
}
</script>

<template>
  <section class="k12ps">
    <div v-if="error" class="k12ps__err" data-testid="ps-error">{{ error }}</div>

    <!-- ═══ 待打印篮 ═══ -->
    <section class="k12ps__basket" aria-label="待打印" data-testid="ps-basket">
      <header class="k12ps__bhead">
        <div class="k12ps__bhead-copy">
          <h3 class="k12ps__btitle">
            {{ t('k12.practice.basketTitle') }}
            <span class="k12ps__pill k12ps__pill--todo" data-testid="ps-basket-count">{{ t('k12.practice.itemCount', { n: basket?.items.length ?? 0 }) }}</span>
          </h3>
          <p class="k12ps__bmeta">{{ t('k12.practice.basketMeta') }}</p>
          <p class="k12ps__bhint">{{ t('k12.practice.basketHint') }}</p>
        </div>
        <div class="k12ps__bactions">
          <button
            v-if="canFinalize && basket"
            class="k12ps__btn"
            data-testid="ps-paper-preview"
            :title="t('k12.practice.paperPreviewTitle')"
            @click="openPaper(basket.record_id, 'question')"
          >{{ t('k12.practice.paperPreview') }}</button>
          <button
            class="k12ps__btn k12ps__btn--primary"
            :disabled="!canFinalize || busy === basket?.record_id"
            :title="!canFinalize ? t('k12.practice.publishBlocked') : ''"
            data-testid="ps-finalize-print"
            @click="finalize('print')"
          >{{ t('k12.practice.print') }}</button>
          <button
            class="k12ps__btn"
            :disabled="!canFinalize || busy === basket?.record_id"
            data-testid="ps-finalize-send"
            @click="finalize('send')"
          >{{ t('k12.practice.assign') }}</button>
        </div>
      </header>

      <div v-if="!basket || basket.items.length === 0" class="k12ps__bempty" data-testid="ps-basket-empty">
        {{ t('k12.practice.basketEmpty') }}
      </div>
      <template v-else>
        <div class="k12ps__groups">
          <template v-for="g in basketGroups" :key="g.key">
            <div class="k12ps__group" :class="{ 'k12ps__group--blocked': g.blocked }" :data-testid="g.blocked ? 'ps-blocked-group' : undefined">
              {{ g.label }}
            </div>
            <div
              v-for="it in g.items"
              :key="it.item_id"
              class="k12ps__item"
              :class="{ 'k12ps__item--blocked': g.blocked }"
            >
              <i class="k12ps__seq">{{ g.blocked ? '–' : seqOf.get(it.item_id) }}</i>
              <div class="k12ps__qwrap">
                <b class="k12ps__q">{{ it.question_markdown }}</b>
                <small class="k12ps__qmeta">{{ [viaLabel(it.added_via), g.blocked ? it.blocked_reason : it.verification_evidence].filter(Boolean).join(' · ') }}</small>
              </div>
              <span v-if="g.blocked" class="k12ps__vbadge k12ps__vbadge--na">{{ t('k12.practice.blocked') }}</span>
              <span v-else class="k12ps__vbadge k12ps__vbadge--ok">{{ t('k12.practice.verified') }}</span>
              <button
                class="k12ps__rm"
                :disabled="busy === `${basket!.record_id}:${it.item_id}`"
                :title="t('k12.practice.removeTitle')"
                data-testid="ps-remove-item"
                @click="removeItem(it)"
              >{{ t('k12.practice.remove') }}</button>
            </div>
          </template>
        </div>
        <p v-if="blockedCount > 0 && canFinalize" class="k12ps__skiphint">{{ t('k12.practice.willSkip', { n: blockedCount }) }}</p>
        <p v-else-if="!canFinalize" class="k12ps__skiphint">{{ t('k12.practice.publishBlocked') }}</p>
      </template>
    </section>

    <!-- ═══ 打印历史 ═══ -->
    <section class="k12ps__history" aria-label="打印历史" data-testid="ps-history">
      <div class="k12ps__hhead">
        <h3 class="k12ps__htitle">{{ t('k12.practice.historyTitle') }}</h3>
        <span class="k12ps__hdesc">{{ t('k12.practice.historyDesc') }}</span>
      </div>
      <p v-if="history.length === 0" class="k12ps__hempty" data-testid="ps-history-empty">{{ t('k12.practice.historyEmpty') }}</p>
      <ul v-else class="k12ps__hlist" data-testid="ps-history-list">
        <li v-for="s in history" :key="s.record_id" class="k12ps__hcard" :class="{ 'k12ps__hcard--cancelled': s.status === 'cancelled' }">
          <header class="k12ps__hcardtop">
            <b class="k12ps__htitle2">{{ s.title }}</b>
            <span v-if="s.paper_no" class="k12ps__paperno" data-testid="ps-paper-no">{{ s.paper_no }}</span>
            <span :class="`k12ps__pill k12ps__pill--${displayState(s).tone}`">{{ displayState(s).label }}</span>
          </header>
          <div class="k12ps__hmeta">
            <span>{{ t('k12.practice.itemCount', { n: s.items.filter((it) => it.verification_status === 'verified').length }) }}</span>
            <span v-if="s.skipped_blocked_count">{{ t('k12.practice.skipped', { n: s.skipped_blocked_count }) }}</span>
            <span v-if="s.delivery_target">→ {{ s.delivery_target }}</span>
          </div>
          <footer class="k12ps__hactions">
            <!-- 题目卷/答案卷查看入口（§4.13）：固化过（有卷面号）的卷才有 -->
            <template v-if="s.paper_no">
              <button class="k12ps__btn k12ps__btn--ghost" :disabled="busy === s.record_id" data-testid="ps-paper-question" @click="openPaper(s.record_id, 'question')">
                {{ t('k12.practice.paperQuestion') }}
              </button>
              <button class="k12ps__btn k12ps__btn--ghost" :disabled="busy === s.record_id" data-testid="ps-paper-answer" @click="openPaper(s.record_id, 'answer')">
                {{ t('k12.practice.paperAnswer') }}
              </button>
            </template>
            <!-- 三态推进：待完成(assigned)→回传；已回传(submitted)→复批；已批改(graded)→关闭(manual) -->
            <button v-if="s.status === 'assigned'" class="k12ps__btn" :disabled="busy === s.record_id" @click="advance(s, 'submit', t('k12.practice.submit'))">
              {{ t('k12.practice.submit') }}
            </button>
            <button v-else-if="s.status === 'submitted'" class="k12ps__btn" :disabled="busy === s.record_id" @click="advance(s, 'grade', t('k12.practice.grade'))">
              {{ t('k12.practice.grade') }}
            </button>
            <button v-else-if="s.status === 'graded'" class="k12ps__btn k12ps__btn--ghost" :disabled="busy === s.record_id" @click="advance(s, 'close', t('k12.practice.close'))">
              {{ t('k12.practice.close') }}
            </button>
            <button v-if="s.status === 'confirmed' || s.status === 'assigned'" class="k12ps__btn k12ps__btn--ghost" :disabled="busy === s.record_id" @click="cancelSet(s)">
              {{ t('k12.practice.cancel') }}
            </button>
          </footer>
        </li>
      </ul>
    </section>

    <!-- ═══ 题目卷/答案卷查看弹层（§4.13 详情/预览类：单「关闭」+ 右上 ✕）═══ -->
    <div v-if="paper.open" class="k12ps__modal" data-testid="ps-paper-modal" @click.self="closePaper">
      <div class="k12ps__mcard">
        <header class="k12ps__mhead">
          <b>{{ paper.resp ? (paper.resp.kind === 'answer' ? t('k12.practice.paperAnswer') : t('k12.practice.paperQuestion')) : t('k12.practice.paperQuestion') }}</b>
          <span v-if="paper.resp?.paper_no" class="k12ps__paperno">{{ paper.resp.paper_no }}</span>
          <span v-else-if="paper.resp?.preview" class="k12ps__pill k12ps__pill--muted">{{ t('k12.practice.paperPreviewTag') }}</span>
          <span class="k12ps__msp" />
          <button class="k12ps__rm" :aria-label="t('k12.practice.paperClose')" @click="closePaper">✕</button>
        </header>
        <p v-if="paper.loading" class="k12ps__mhint">{{ t('k12.practice.paperLoading') }}</p>
        <p v-else-if="paper.error" class="k12ps__err">{{ paper.error }}</p>
        <div v-else-if="paper.resp" class="k12ps__mbody">
          <MarkdownRenderer :content="paper.resp.markdown" />
        </div>
        <footer class="k12ps__mfoot">
          <button
            v-if="paper.resp && !paper.resp.preview"
            class="k12ps__btn"
            data-testid="ps-paper-print"
            @click="printPaper"
          >{{ t('k12.practice.paperPrint') }}</button>
          <button class="k12ps__btn k12ps__btn--primary" data-testid="ps-paper-close" @click="closePaper">
            {{ t('k12.practice.paperClose') }}
          </button>
        </footer>
      </div>
    </div>
  </section>
</template>

<style scoped>
.k12ps { display: grid; gap: 16px; }
.k12ps__err { color: var(--hc-error); font-size: 13px; }

/* 待打印篮：单卡容器（原型 .practice-basket 语言） */
.k12ps__basket {
  border: .5px solid var(--hc-border); border-radius: 16px; background: var(--hc-bg-card);
  box-shadow: var(--hc-shadow-sm); overflow: hidden;
}
.k12ps__bhead {
  display: flex; align-items: flex-start; gap: 10px; flex-wrap: wrap; padding: 15px 18px;
  border-bottom: 1px solid var(--hc-border); background: linear-gradient(135deg, var(--hc-accent-subtle), var(--hc-bg-card));
}
.k12ps__bhead-copy { min-width: 240px; flex: 1; }
.k12ps__btitle { font-size: 14px; margin: 0 0 3px; color: var(--hc-text-primary); display: flex; align-items: center; gap: 8px; }
.k12ps__bmeta { font-size: 11.5px; color: var(--hc-text-muted); margin: 0; line-height: 1.55; }
.k12ps__bhint { font-size: 11.5px; color: var(--hc-accent); margin: 3px 0 0; }
.k12ps__bactions { display: flex; gap: 7px; flex-wrap: wrap; margin-left: auto; }
.k12ps__bempty { padding: 18px; font-size: 12.5px; color: var(--hc-text-muted); }
.k12ps__groups { padding: 12px 15px 4px; display: grid; gap: 7px; }
.k12ps__group { font-size: 10.5px; font-weight: 750; color: var(--hc-text-secondary); margin-top: 5px; }
.k12ps__group--blocked { color: var(--hc-text-muted); }
.k12ps__item {
  display: flex; align-items: center; gap: 9px; padding: 9px 11px;
  border-radius: var(--hc-radius-md); background: var(--hc-bg-input); font-size: 11.5px;
}
.k12ps__item--blocked { opacity: .62; }
.k12ps__seq {
  width: 21px; height: 21px; display: grid; place-items: center; flex-shrink: 0;
  border-radius: 6px; background: var(--hc-bg-card); color: var(--hc-accent);
  font-style: normal; font-size: 10px; font-weight: 800;
}
.k12ps__qwrap { flex: 1; min-width: 0; }
.k12ps__q { display: block; font-size: 12px; color: var(--hc-text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.k12ps__qmeta { display: block; margin-top: 2px; color: var(--hc-text-muted); font-size: 10.5px; }
.k12ps__vbadge { font-size: 10.5px; font-weight: 700; border-radius: 999px; padding: 2px 9px; white-space: nowrap; }
.k12ps__vbadge--ok { color: var(--hc-success); background: color-mix(in srgb, var(--hc-success) 10%, transparent); }
.k12ps__vbadge--na { color: var(--hc-text-muted); background: var(--hc-bg-active); }
.k12ps__rm {
  font: inherit; font-size: 10.5px; border: none; background: transparent; color: var(--hc-text-secondary);
  padding: 2px 8px; border-radius: var(--hc-radius-sm); cursor: pointer;
}
.k12ps__rm:hover:not(:disabled) { background: var(--hc-bg-hover); color: var(--hc-text-primary); }
.k12ps__skiphint { font-size: 10.5px; color: var(--hc-text-muted); padding: 0 15px 13px; margin: 6px 0 0; }

/* 打印历史 */
.k12ps__hhead { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; margin-bottom: 10px; }
.k12ps__htitle { font-size: 13.5px; margin: 0; color: var(--hc-text-primary); }
.k12ps__hdesc { font-size: 11.5px; color: var(--hc-text-muted); }
.k12ps__hempty { font-size: 12px; color: var(--hc-text-muted); padding: 8px 2px; }
.k12ps__hlist { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 10px; }
.k12ps__hcard {
  border: .5px solid var(--hc-border); border-radius: 14px; background: var(--hc-bg-card);
  box-shadow: var(--hc-shadow-sm); padding: 12px 13px;
}
.k12ps__hcard--cancelled { opacity: .6; }
.k12ps__hcardtop { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
.k12ps__htitle2 { font-size: 12.5px; color: var(--hc-text-primary); flex: 1; min-width: 0; }
.k12ps__paperno { font-size: 10px; font-weight: 800; color: var(--hc-accent); background: var(--hc-accent-subtle); border-radius: 5px; padding: 2px 7px; font-variant-numeric: tabular-nums; }
.k12ps__pill { font-size: 10.5px; font-weight: 700; border-radius: 999px; padding: 2px 9px; white-space: nowrap; }
.k12ps__pill--todo { color: var(--hc-error); background: color-mix(in srgb, var(--hc-error) 10%, transparent); }
.k12ps__pill--got { color: var(--hc-success); background: color-mix(in srgb, var(--hc-success) 10%, transparent); }
.k12ps__pill--muted { color: var(--hc-text-muted); background: var(--hc-bg-input); }
.k12ps__hmeta { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 7px; color: var(--hc-text-muted); font-size: 10.5px; }
.k12ps__hactions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 9px; }

/* 按钮 */
.k12ps__btn {
  font: inherit; font-size: 12px; font-weight: 500; border-radius: var(--hc-radius-md);
  padding: 6px 13px; border: .5px solid var(--hc-border); background: var(--hc-bg-card);
  color: var(--hc-text-primary); cursor: pointer;
  transition: background .15s, border-color .15s, opacity .15s, filter .15s;
}
.k12ps__btn:hover:not(:disabled) { background: var(--hc-bg-hover); border-color: var(--hc-border-hl); }
.k12ps__btn:disabled { opacity: .45; cursor: not-allowed; }
.k12ps__btn--primary {
  background: linear-gradient(180deg, #5fb3ea 0%, #4a9de0 100%); color: #fff; border-color: transparent;
  box-shadow: 0 4px 12px rgba(95,179,234,.24);
}
.k12ps__btn--primary:hover:not(:disabled) { filter: brightness(1.04); }
.k12ps__btn--ghost { background: transparent; border-color: transparent; color: var(--hc-text-secondary); }
.k12ps__btn--ghost:hover:not(:disabled) { background: var(--hc-bg-hover); }

/* 题目卷/答案卷查看弹层 */
.k12ps__modal {
  position: fixed; inset: 0; z-index: 60; display: grid; place-items: center;
  background: color-mix(in srgb, #000 42%, transparent); padding: 24px;
}
.k12ps__mcard {
  width: min(680px, 100%); max-height: 86vh; display: flex; flex-direction: column;
  border: .5px solid var(--hc-border); border-radius: 16px; background: var(--hc-bg-card);
  box-shadow: var(--hc-shadow-lg, 0 18px 48px rgba(0,0,0,.28)); overflow: hidden;
}
.k12ps__mhead {
  display: flex; align-items: center; gap: 8px; padding: 13px 16px;
  border-bottom: 1px solid var(--hc-border); font-size: 13px; color: var(--hc-text-primary);
}
.k12ps__msp { flex: 1; }
.k12ps__mhint { padding: 18px 16px; font-size: 12px; color: var(--hc-text-muted); margin: 0; }
.k12ps__mbody { padding: 14px 18px; overflow-y: auto; font-size: 13px; }
.k12ps__mfoot {
  display: flex; justify-content: flex-end; gap: 8px; padding: 11px 16px;
  border-top: 1px solid var(--hc-border);
}
</style>
