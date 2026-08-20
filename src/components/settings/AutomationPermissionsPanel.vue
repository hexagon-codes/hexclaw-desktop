<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { ShieldCheck, ShieldAlert, RefreshCw, X, Check, ArrowRight, ChevronDown, Lock } from 'lucide-vue-next'
import {
  getAutonomyProfile, updateAutonomyProfile, getAutonomySummary, listAutonomyDecisions,
  listAutonomyGrants, revokeAutonomyGrant,
  type AutonomyProfile, type MatrixView, type AutonomySummary, type AutonomyDecision, type AutonomyGrant,
} from '@/api/autonomy'
import { useToast } from '@/composables/useToast'
import { translateOpenIdentifier } from '@/utils/open-i18n-label'

/**
 * 设置页「自动化权限」分区 —— 治理入口，非一线审批。
 *
 * 只做四件事：全局自动化级别、待处理兜底、审计回看、生效策略矩阵（只读诊断）。
 * 一线审批发生在创建流和任务卡；任务粒度状态归「自动化」页，本页不重复陈列。
 * 单用户桌面定位：三档（功能优先/严格审批/全功能），无团队形态。
 */
const { t, te } = useI18n()
const toast = useToast()
const router = useRouter()

const profile = ref<AutonomyProfile>('function_first')
const matrix = ref<MatrixView | null>(null)
const summary = ref<AutonomySummary | null>(null)
const decisions = ref<AutonomyDecision[]>([])
const grants = ref<AutonomyGrant[]>([])
/** 审计区收敛（2026-07-04）：默认最近 3 条，展开看全部。 */
const DECISIONS_COLLAPSED_COUNT = 3
const decisionsExpanded = ref(false)
const visibleDecisions = computed(() =>
  decisionsExpanded.value ? decisions.value : decisions.value.slice(0, DECISIONS_COLLAPSED_COUNT))
const revokingId = ref<string | null>(null)
const loading = ref(false)
const switching = ref(false)
const unavailable = ref(false)
const fullAccessConfirmOpen = ref(false)
const matrixOpen = ref(false)

/**
 * 单用户桌面三档；balanced 引擎虽支持但不在 UI 暴露（避免档位过载）。
 * lead = 选择当口的一句差异化定性；desc = 完整能力清单，下沉到 tooltip（title）。
 * guard = 当前态锚点用的安全含义短句。
 */
const profileCards = computed(() => [
  {
    key: 'function_first' as AutonomyProfile,
    title: t('autonomy.profile.functionFirst', '功能优先'),
    badge: t('autonomy.profile.recommended', '推荐'),
    lead: t('autonomy.profile.functionFirstLead', '日常能力自动跑，高后果转审批'),
    desc: t('autonomy.profile.functionFirstDesc', '读取、浏览、沙箱执行、修改工作区、发送消息自动跑；宿主执行、连接器写入、发布内容、能力修改转审批。'),
    guard: t('autonomy.profile.functionFirstGuard', '高后果操作仍会先问你'),
    warn: false,
  },
  {
    key: 'strict' as AutonomyProfile,
    title: t('autonomy.profile.strict', '严格审批'),
    badge: '',
    lead: t('autonomy.profile.strictLead', '凡自动任务都先问你'),
    desc: t('autonomy.profile.strictDesc', '自动任务全部转人工确认。适合刚接入外部触发（Webhook）时先观察一段时间。'),
    guard: t('autonomy.profile.strictGuard', '所有自动任务都会先问你'),
    warn: false,
  },
  {
    key: 'full_access' as AutonomyProfile,
    title: t('autonomy.profile.fullAccess', '全功能'),
    badge: t('autonomy.profile.advanced', '高级'),
    lead: t('autonomy.profile.fullAccessLead', '全部放行，仅限可信本机'),
    desc: t('autonomy.profile.fullAccessDesc', '全部自动放行，仅限本机可信环境、压测或临时排障。启用需高后果确认，强制记录审计。'),
    guard: t('autonomy.profile.fullAccessGuard', '全部自动放行，无额外确认'),
    warn: true,
  },
])

/**
 * 当前态锚点：一句话回答「我现在处于什么保护态」。
 * BUG-20260703 P2a：balanced 引擎接受但 UI 不设第 4 卡——被配置/API 设为 balanced 时
 * 锚点须显示本地化名与准确 guard（对齐 balanced 矩阵：读/浏览/改文件/发消息自动跑，
 * 一切执行类含沙箱转审批），不裸显英文串、不留空 guard。
 */
const currentCard = computed(() => profileCards.value.find((c) => c.key === profile.value))
const currentIsCardless = computed(() => !currentCard.value)
const currentGuard = computed(() => {
  if (currentCard.value) return currentCard.value.guard
  if (profile.value === 'balanced') return t('autonomy.profile.balancedGuard', '读取、浏览、改文件、发消息自动跑；一切执行类（含沙箱）都会先问你')
  return ''
})
const currentTitle = computed(() => {
  if (currentCard.value) return currentCard.value.title
  if (profile.value === 'balanced') return t('autonomy.profile.balanced', '平衡')
  return profile.value
})

/**
 * 指标条：3 格讲一个完整故事——待处理（行动主角，置顶）、可无人值守（就绪/总数分数）、
 * 任务级授权。总任务数由分数分母承载，不再单列，避免与分母冗余。
 */
const metrics = computed(() => {
  const c = summary.value?.counts
  return [
    {
      key: 'pending',
      value: c ? String(c.pending) : '—',
      label: t('autonomy.settings.metricPending', '待处理'),
      warn: (c?.pending ?? 0) > 0,
    },
    {
      key: 'ready',
      value: c ? `${c.ready}/${c.tasks}` : '—',
      label: t('autonomy.settings.metricReady', '可无人值守运行（预估）'),
      warn: false,
    },
    {
      key: 'grants',
      value: c ? String(c.grants) : '—',
      label: t('autonomy.settings.metricGrants', '任务级授权生效中'),
      warn: false,
    },
  ]
})

/** 矩阵收起态摘要：每个来源自动放行的能力占比，一眼看清哪个来源被卡得最多。 */
const matrixSummary = computed(() => {
  const m = matrix.value
  if (!m) return []
  return m.rows.map((r) => {
    const auto = r.cells.filter((cell) => cell.state === 'auto').length
    return { source: r.source, auto, total: r.cells.length }
  })
})

/** 矩阵转置：行=能力、列=来源。来源恒 6 列，能力可扩到 11+ 行——窄容器里竖排比横排稳。 */
const matrixT = computed(() => {
  const m = matrix.value
  if (!m) return null
  return {
    sources: m.rows.map((r) => r.source),
    rows: m.categories.map((c) => ({
      category: c,
      cells: m.rows.map((r) => ({
        source: r.source,
        state: r.cells.find((cell) => cell.category === c)?.state ?? 'approval',
      })),
    })),
  }
})

function categoryLabel(key: string): string {
  return translateOpenIdentifier(t, te, 'autonomy.category', key)
}

function sourceLabel(key: string): string {
  return translateOpenIdentifier(t, te, 'autonomy.source', key)
}

function cellTitle(source: string, category: string, state: string): string {
  const s = state === 'auto'
    ? t('autonomy.settings.cellAuto', '自动')
    : t('autonomy.settings.cellApproval', '审批')
  return `${sourceLabel(source)} · ${categoryLabel(category)} — ${s}`
}

async function loadAll() {
  loading.value = true
  try {
    const [profileRes, summaryRes, decisionsRes, grantsRes] = await Promise.all([
      getAutonomyProfile(),
      getAutonomySummary().catch(() => null),
      listAutonomyDecisions({ limit: 8 }).catch(() => null),
      listAutonomyGrants().catch(() => null),
    ])
    profile.value = profileRes.profile
    matrix.value = profileRes.matrix
    summary.value = summaryRes
    decisions.value = decisionsRes?.decisions ?? []
    grants.value = grantsRes?.grants ?? []
    unavailable.value = false
  } catch {
    unavailable.value = true
  } finally {
    loading.value = false
  }
}

// FS-3：授权列表撤销——设置页此前只显示 grants 计数，用户无处查看/撤销具体授权。
async function onRevokeGrant(id: string) {
  revokingId.value = id
  try {
    await revokeAutonomyGrant(id)
    grants.value = grants.value.filter((g) => g.id !== id)
    // 撤销影响 counts.grants 与任务态，刷新总览保持一致。
    await loadAll()
    toast.success(t('autonomy.grants.revoked', '已撤销授权'))
  } catch (e: unknown) {
    toast.error((e as Error)?.message || t('autonomy.grants.revokeFailed', '撤销授权失败'))
  } finally {
    revokingId.value = null
  }
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && fullAccessConfirmOpen.value) fullAccessConfirmOpen.value = false
}

onMounted(() => {
  void loadAll()
  window.addEventListener('keydown', onKeydown)
})
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))

/** 选级别：全功能必须先过高后果确认弹层，确认前不切换。 */
function onSelectProfile(next: AutonomyProfile) {
  if (next === profile.value || switching.value) return
  if (next === 'full_access') {
    fullAccessConfirmOpen.value = true
    return
  }
  void applyProfile(next)
}

async function applyProfile(next: AutonomyProfile) {
  switching.value = true
  try {
    const res = await updateAutonomyProfile(next)
    profile.value = res.profile
    matrix.value = res.matrix
    toast.success(t('autonomy.profile.switched', '自动化级别已切换，即时生效'))
    void loadAll()
  } catch (e: unknown) {
    toast.error((e as Error)?.message || t('autonomy.profile.switchFailed', '切换失败'))
  } finally {
    switching.value = false
    fullAccessConfirmOpen.value = false
  }
}

function goAutomation() {
  void router.push('/automation')
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}
</script>

<template>
  <div class="auto-perm">
    <p class="auto-perm__lede">
      {{ t('autonomy.settings.lede', '决定自动化任务在无人值守时能自动做什么。一线审批发生在创建流和任务卡；这里只做全局级别、待处理兜底、审计回看和生效策略。自愈权限只允许生成恢复候选，必须经过下一次真实执行验证；鉴权、数据源或外部服务故障不会因权限放行而自动消失。') }}
    </p>

    <div v-if="unavailable" class="auto-perm__unavailable">
      <ShieldAlert :size="20" />
      {{ t('autonomy.settings.unavailable', '自动化权限治理不可用（引擎未连接或版本过旧）') }}
    </div>

    <template v-else>
      <!-- 当前态锚点：一句话让「我现在处于什么保护态」始终可见 -->
      <div class="auto-perm__anchor" data-testid="current-state">
        <ShieldCheck :size="14" class="auto-perm__anchor-icon" />
        <span>
          {{ t('autonomy.settings.currentLabel', '当前') }}：<b>{{ currentTitle }}</b>
          <span class="auto-perm__anchor-sep">·</span>
          {{ currentGuard }}
        </span>
      </div>

      <!-- 自动化级别三档 -->
      <section class="auto-perm__group">
        <h3 class="auto-perm__section-title">{{ t('autonomy.settings.profileTitle', '自动化级别') }}</h3>
        <div class="auto-perm__profiles" role="radiogroup" :aria-label="t('autonomy.settings.profileTitle', '自动化级别')">
          <button
            v-for="card in profileCards"
            :key="card.key"
            class="auto-perm__profile"
            :class="{
              'auto-perm__profile--on': profile === card.key,
              'auto-perm__profile--warn': card.warn,
            }"
            role="radio"
            :aria-checked="profile === card.key"
            :data-testid="`profile-${card.key}`"
            :title="card.desc"
            :disabled="switching"
            @click="onSelectProfile(card.key)"
          >
            <span class="auto-perm__profile-head">
              <b>{{ card.title }}</b>
              <span
                v-if="card.badge"
                class="auto-perm__badge"
                :class="card.warn ? 'auto-perm__badge--adv' : 'auto-perm__badge--rec'"
              >{{ card.badge }}</span>
            </span>
            <span class="auto-perm__profile-lead">{{ card.lead }}</span>
            <Transition name="check">
              <span v-if="profile === card.key" class="auto-perm__check" aria-hidden="true">
                <Check :size="10" :stroke-width="3.5" />
              </span>
            </Transition>
            <!-- 全功能行为不同（点开是配置引导而非切换）：未选中时用锁标记先暗示 -->
            <span
              v-if="card.warn && profile !== card.key"
              class="auto-perm__profile-lock"
              aria-hidden="true"
            >
              <Lock :size="11" />
            </span>
          </button>
        </div>
        <!-- BUG-20260703 P2a：当前档不在三卡中（balanced 等）时的兜底说明——不加第 4 卡 -->
        <p v-if="currentIsCardless" class="auto-perm__cardless-note" data-testid="profile-fallback-note">
          {{ t('autonomy.settings.cardlessNote', { name: currentTitle }) }}
        </p>
      </section>

      <!-- 当前影响 -->
      <section class="auto-perm__group">
        <h3 class="auto-perm__section-title">{{ t('autonomy.settings.impactTitle', '当前影响') }}</h3>
        <div class="auto-perm__metrics">
          <div v-for="m in metrics" :key="m.key" class="auto-perm__metric">
            <b :class="{ 'auto-perm__metric-num--warn': m.warn }">{{ m.value }}</b>
            <span>{{ m.label }}</span>
          </div>
        </div>
      </section>

      <!-- 待处理动作 -->
      <section class="auto-perm__group">
        <h3 class="auto-perm__section-title">{{ t('autonomy.settings.pendingTitle', '待处理动作') }}</h3>
        <div v-if="(summary?.pending?.length ?? 0) === 0" class="auto-perm__allclear" data-testid="all-clear">
          <ShieldCheck :size="15" />
          {{ t('autonomy.settings.allClear', '没有需要处理的权限动作；高后果能力仍按任务级授权或运行时审批执行。') }}
        </div>
        <div v-else class="auto-perm__pending-list">
          <div v-for="task in summary!.pending" :key="task.task_ref" class="auto-perm__pending" data-testid="pending-task">
            <ShieldAlert :size="14" class="auto-perm__pending-icon" />
            <div class="auto-perm__pending-main">
              <b>{{ task.name }}</b>
              <span>
                {{ sourceLabel(task.kind) }}
                <template v-if="task.needs_decision?.length">
                  · {{ task.needs_decision.map(categoryLabel).join('、') }}
                </template>
              </span>
            </div>
            <button class="hc-btn hc-btn-primary auto-perm__pending-action" @click="goAutomation">
              {{ t('autonomy.settings.pendingAction', '去处理') }}
              <ArrowRight :size="12" />
            </button>
          </div>
        </div>
      </section>

      <!-- 最近权限决策 -->
      <section class="auto-perm__group">
        <h3 class="auto-perm__section-title">
          {{ t('autonomy.settings.logTitle', '最近权限决策（本地持久化审计）') }}
          <button
            class="auto-perm__refresh"
            :disabled="loading"
            :aria-label="t('common.refresh', '刷新')"
            @click="loadAll"
          >
            <RefreshCw :size="12" :class="{ 'auto-perm__spin': loading }" />
          </button>
        </h3>
        <div v-if="decisions.length === 0" class="auto-perm__muted">
          {{ t('autonomy.settings.noLog', '还没有权限决策记录——自动化任务运行后这里会持续留档。') }}
        </div>
        <!-- 收敛（2026-07-04 PM 评审）：家长用户默认只看最近 3 条（macOS「近期使用」同型），
             治理闭环内容不减；>3 条时给「显示全部 (N)」展开。 -->
        <div v-else class="auto-perm__log">
          <div v-for="d in visibleDecisions" :key="d.id" class="auto-perm__log-row" data-testid="decision-row">
            <span class="auto-perm__log-time">{{ formatTime(d.at) }}</span>
            <span class="auto-perm__log-text">
              {{ sourceLabel(d.source) }} / {{ d.tool }}<template v-if="d.capability"> · {{ categoryLabel(d.capability) }}</template>
            </span>
            <span
              class="auto-perm__pill"
              :class="{
                'auto-perm__pill--ok': d.decision === 'allow',
                'auto-perm__pill--warn': d.decision === 'pending',
                'auto-perm__pill--danger': d.decision === 'deny',
              }"
            >{{ t(`autonomy.decision.${d.decision}`, d.decision) }}</span>
          </div>
          <button
            v-if="decisions.length > DECISIONS_COLLAPSED_COUNT"
            class="auto-perm__showall"
            data-testid="decisions-show-all"
            @click="decisionsExpanded = !decisionsExpanded"
          >
            {{ decisionsExpanded
              ? t('autonomy.settings.collapseLog', '收起')
              : t('autonomy.settings.showAllLog', { n: decisions.length }) }}
          </button>
        </div>
      </section>

      <!-- FS-3：任务级授权列表 + 撤销。此前只有 grants 计数，无处查看/撤销具体授权。 -->
      <section v-if="grants.length" class="auto-perm__group">
        <h3 class="auto-perm__section-title">
          {{ t('autonomy.grants.title', '任务级授权（生效中）') }}
        </h3>
        <div class="auto-perm__log">
          <div v-for="g in grants" :key="g.id" class="auto-perm__log-row" data-testid="grant-row">
            <span class="auto-perm__log-text">
              {{ g.task_ref }}<template v-if="g.entries?.length"> · {{ g.entries.map(categoryLabel).join(' / ') }}</template>
            </span>
            <button
              class="auto-perm__pill auto-perm__pill--danger"
              :disabled="revokingId === g.id"
              data-testid="grant-revoke"
              @click="onRevokeGrant(g.id)"
            >
              <X :size="11" /> {{ t('autonomy.grants.revoke', '撤销') }}
            </button>
          </div>
        </div>
      </section>

      <!-- 生效策略矩阵（只读诊断）：默认收起，收起态给每来源自动放行占比摘要 -->
      <section class="auto-perm__group">
        <h3 class="auto-perm__section-title">
          <button
            class="auto-perm__disclosure"
            :aria-expanded="matrixOpen"
            data-testid="matrix-toggle"
            @click="matrixOpen = !matrixOpen"
          >
            <ChevronDown :size="13" class="auto-perm__chevron" :class="{ 'auto-perm__chevron--open': matrixOpen }" />
            {{ t('autonomy.settings.matrixTitle', '生效策略矩阵（只读诊断）') }}
          </button>
          <span v-show="matrixOpen" class="auto-perm__legend">
            <span class="auto-perm__legend-item">
              <span class="auto-perm__dot auto-perm__dot--auto" />
              {{ t('autonomy.settings.legendAuto', '自动放行') }}
            </span>
            <span class="auto-perm__legend-item">
              <span class="auto-perm__dot auto-perm__dot--approval" />
              {{ t('autonomy.settings.legendApproval', '需审批') }}
            </span>
          </span>
        </h3>

        <!-- 收起态：每来源「自动放行 N/总数」一眼看清谁被卡得最多 -->
        <div v-show="!matrixOpen" class="auto-perm__matrix-chips" data-testid="matrix-summary">
          <span
            v-for="s in matrixSummary"
            :key="s.source"
            class="auto-perm__chip"
            :class="{
              'auto-perm__chip--full': s.auto === s.total,
              'auto-perm__chip--none': s.auto === 0,
            }"
          >
            {{ sourceLabel(s.source) }}
            <b>{{ s.auto }}/{{ s.total }}</b>
          </span>
        </div>

        <p v-show="matrixOpen" class="auto-perm__muted">
          {{ t('autonomy.settings.matrixNote', '回答「为什么被拦 / 为什么放行」：沙箱执行与宿主执行是两级信任——外部来源只自动放行沙箱执行。连接器（MCP）工具无内置类别，无人值守下需任务级授权。自愈权限不等于可以修复鉴权、数据源或外部服务故障。') }}
        </p>
        <div v-if="matrixOpen && matrixT" class="auto-perm__matrix-box">
          <table class="auto-perm__matrix" data-testid="policy-matrix">
            <thead>
              <tr>
                <th>{{ t('autonomy.settings.matrixCapability', '能力') }}</th>
                <th v-for="s in matrixT.sources" :key="s">{{ sourceLabel(s) }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in matrixT.rows" :key="row.category">
                <td>{{ categoryLabel(row.category) }}</td>
                <td v-for="cell in row.cells" :key="cell.source">
                  <span
                    class="auto-perm__dot"
                    :class="cell.state === 'auto' ? 'auto-perm__dot--auto' : 'auto-perm__dot--approval'"
                    :title="cellTitle(cell.source, row.category, cell.state)"
                    role="img"
                    :aria-label="cellTitle(cell.source, row.category, cell.state)"
                  />
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </template>

    <!-- 全功能高后果确认弹层：确认前级别不切换 -->
    <Teleport to="body">
      <Transition name="modal">
        <div
          v-if="fullAccessConfirmOpen"
          class="fixed inset-0 z-50 flex items-center justify-center bg-black/45 backdrop-blur-sm"
          data-testid="full-access-confirm"
          @click.self="fullAccessConfirmOpen = false"
        >
          <div
            class="auto-perm__modal w-full max-w-lg rounded-2xl border flex flex-col overflow-hidden"
            :style="{ background: 'var(--hc-bg-elevated)', borderColor: 'var(--hc-border)' }"
            role="dialog"
            aria-modal="true"
            :aria-label="t('autonomy.fullAccess.title', '启用全功能？')"
          >
            <div class="flex items-center gap-3 px-5 py-4 border-b" :style="{ borderColor: 'var(--hc-border)' }">
              <span class="auto-perm__modal-icon"><ShieldAlert :size="16" /></span>
              <h2 class="flex-1 text-[15px] font-semibold m-0" :style="{ color: 'var(--hc-text-primary)' }">
                {{ t('autonomy.fullAccess.title', '启用全功能？') }}
              </h2>
              <button class="p-1 rounded-md hover:bg-white/5" :style="{ color: 'var(--hc-text-muted)' }" @click="fullAccessConfirmOpen = false">
                <X :size="17" />
              </button>
            </div>
            <div class="auto-perm__confirm-body">
              <p>{{ t('autonomy.fullAccess.desc', '启用后，Cron、Webhook、Heartbeat、Workflow、Spawn 将自动执行全部能力——包括在本机直执行命令、写外部系统与发布内容。显式 deny 规则仍保持最高优先级；所有决策强制记录审计。') }}</p>
              <div class="auto-perm__confirm-row">
                <b>{{ t('autonomy.fullAccess.envTitle', '运行环境') }}</b>
                <span>{{ t('autonomy.fullAccess.envDesc', '确认这是本机单用户可信环境，不建议在他人可触达的机器上开启。') }}</span>
              </div>
              <div class="auto-perm__confirm-alt">
                <b>{{ t('autonomy.fullAccess.altTitle', '通常你其实想要的是') }}</b>
                <span>{{ t('autonomy.fullAccess.altDesc', '在创建流或任务卡上做任务级授权——范围最小，删除任务即回收。') }}</span>
              </div>
            </div>
            <div class="flex items-center justify-end gap-2 px-5 py-3.5 border-t" :style="{ borderColor: 'var(--hc-border)' }">
              <button class="hc-btn hc-btn-ghost" :disabled="switching" @click="fullAccessConfirmOpen = false">
                {{ t('common.cancel', '取消') }}
              </button>
              <button
                class="hc-btn auto-perm__danger-btn"
                data-testid="confirm-full-access"
                :disabled="switching"
                @click="applyProfile('full_access')"
              >
                {{ t('autonomy.fullAccess.confirm', '我确认，启用全功能') }}
              </button>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.auto-perm { display: flex; flex-direction: column; gap: 22px; }
.auto-perm__lede { margin: 0; font-size: 13px; line-height: 1.6; color: var(--hc-text-secondary); }

/* ─── 当前态锚点 ───────────────────────────────── */
.auto-perm__anchor {
  display: flex; align-items: center; gap: 7px; margin-top: -12px;
  padding: 8px 12px; border-radius: var(--hc-radius-md);
  font-size: 12.5px; color: var(--hc-text-secondary);
  background: var(--hc-accent-subtle, rgba(95, 179, 234, 0.14));
  border: 0.5px solid var(--hc-border-hl, rgba(95, 179, 234, 0.24));
}
.auto-perm__anchor-icon { flex-shrink: 0; color: var(--hc-accent); }
.auto-perm__anchor b { color: var(--hc-text-primary); font-weight: 600; }
.auto-perm__anchor-sep { margin: 0 5px; color: var(--hc-text-muted); }

.auto-perm__unavailable {
  display: flex; flex-direction: column; align-items: center; gap: 8px;
  padding: 40px 24px; text-align: center; font-size: 13px; color: var(--hc-text-muted);
  border: 0.5px dashed var(--hc-border); border-radius: var(--hc-radius-lg);
}

.auto-perm__group { display: flex; flex-direction: column; gap: 9px; }
.auto-perm__section-title {
  display: flex; align-items: center; gap: 8px;
  margin: 0; font-size: 11px; font-weight: 700; letter-spacing: 0.05em;
  text-transform: uppercase; color: var(--hc-text-muted);
}
.auto-perm__refresh {
  display: inline-flex; align-items: center; justify-content: center;
  width: 24px; height: 24px; margin: -6px 0; border: none; background: transparent;
  color: var(--hc-text-muted); cursor: pointer; border-radius: var(--hc-radius-sm);
  transition: color 0.15s var(--hc-ease-smooth), background 0.15s var(--hc-ease-smooth);
}
.auto-perm__refresh:hover { color: var(--hc-accent); background: var(--hc-bg-hover); }
.auto-perm__spin { animation: auto-perm-spin 0.8s linear infinite; }
@keyframes auto-perm-spin { to { transform: rotate(360deg); } }

/* ─── 自动化级别三档 ───────────────────────────── */
.auto-perm__profiles { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
.auto-perm__profile {
  position: relative; display: flex; flex-direction: column; gap: 6px;
  text-align: start; cursor: pointer;
  min-height: 84px; padding: 13px 15px; border-radius: 12px;
  border: 0.5px solid var(--hc-border); background: var(--hc-bg-card);
  transition:
    border-color 0.15s var(--hc-ease-smooth),
    background 0.15s var(--hc-ease-smooth),
    transform 0.15s var(--hc-ease-smooth),
    box-shadow 0.15s var(--hc-ease-smooth);
}
.auto-perm__profile:hover:not(:disabled) { transform: translateY(-1px); box-shadow: var(--hc-shadow-sm); }
.auto-perm__profile:focus-visible { outline: 2px solid var(--hc-accent); outline-offset: 2px; }
.auto-perm__profile:disabled { opacity: 0.7; cursor: default; }
.auto-perm__profile--on {
  border-color: var(--hc-border-hl, rgba(95, 179, 234, 0.32));
  background: var(--hc-accent-subtle, rgba(95, 179, 234, 0.14));
}
.auto-perm__profile--warn { border-color: rgba(240, 180, 41, 0.32); }
.auto-perm__profile--warn.auto-perm__profile--on { background: rgba(240, 180, 41, 0.13); }
.auto-perm__profile-head {
  display: flex; align-items: center; gap: 6px; padding-inline-end: 20px; min-width: 0;
}
.auto-perm__profile-head b { font-size: 13px; color: var(--hc-text-primary); }
.auto-perm__profile-lead { font-size: 12px; line-height: 1.5; color: var(--hc-text-secondary); }
.auto-perm__profile-lock {
  position: absolute; top: 12px; inset-inline-end: 12px;
  display: flex; color: var(--hc-text-muted); opacity: 0.55;
}
.auto-perm__cardless-note {
  margin: 0; padding: 8px 12px; border-radius: var(--hc-radius-md);
  font-size: 12px; line-height: 1.55; color: var(--hc-text-secondary);
  background: var(--hc-bg-input); border: 0.5px dashed var(--hc-border);
}
.auto-perm__badge {
  flex-shrink: 0; padding: 1.5px 6px; border-radius: 999px;
  font-size: 10px; font-weight: 600; letter-spacing: 0.02em;
}
.auto-perm__badge--rec { color: var(--hc-accent); background: var(--hc-accent-subtle, rgba(95, 179, 234, 0.14)); }
.auto-perm__badge--adv { color: var(--hc-warning, #e69500); background: rgba(240, 180, 41, 0.14); }
.auto-perm__check {
  position: absolute; top: 11px; inset-inline-end: 11px;
  display: flex; align-items: center; justify-content: center;
  width: 16px; height: 16px; border-radius: 50%;
  background: var(--hc-accent); color: var(--hc-text-inverse, #fff);
}
.auto-perm__profile--warn .auto-perm__check { background: var(--hc-warning, #e69500); }
.check-enter-active { animation: auto-perm-pop 0.25s var(--hc-spring); }
.check-leave-active { transition: opacity 0.1s ease-out; }
.check-leave-to { opacity: 0; }
@keyframes auto-perm-pop {
  from { opacity: 0; transform: scale(0.5); }
  to { opacity: 1; transform: scale(1); }
}

/* ─── 当前影响：单卡三列 stat strip（待处理置顶、就绪用分数） ── */
.auto-perm__metrics {
  display: grid; grid-template-columns: repeat(3, minmax(0, 1fr));
  border: 0.5px solid var(--hc-border); border-radius: 12px;
  background: var(--hc-bg-card); overflow: hidden;
}
.auto-perm__metric {
  display: flex; flex-direction: column; gap: 3px;
  padding: 13px 14px; border-inline-start: 0.5px solid var(--hc-divider, rgba(255, 255, 255, 0.06));
}
.auto-perm__metric:first-child { border-inline-start: 0; }
.auto-perm__metric b {
  font-size: 20px; font-weight: 700; line-height: 1.1;
  color: var(--hc-text-primary); font-variant-numeric: tabular-nums;
}
.auto-perm__metric b.auto-perm__metric-num--warn { color: var(--hc-warning, #e69500); }
.auto-perm__metric span { font-size: 11.5px; line-height: 1.4; color: var(--hc-text-secondary); }

/* ─── 待处理动作 ───────────────────────────────── */
.auto-perm__allclear {
  display: flex; align-items: center; gap: 7px;
  font-size: 12.5px; color: var(--hc-success, #28a745);
}
.auto-perm__pending-list { display: flex; flex-direction: column; gap: 8px; }
.auto-perm__pending {
  display: flex; align-items: center; gap: 10px;
  padding: 10px 12px; border-radius: var(--hc-radius-md);
  border: 0.5px solid rgba(240, 180, 41, 0.3); background: rgba(240, 180, 41, 0.07);
}
.auto-perm__pending-icon { flex-shrink: 0; color: var(--hc-warning, #e69500); }
.auto-perm__pending-main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.auto-perm__pending-main b { font-size: 13px; color: var(--hc-text-primary); }
.auto-perm__pending-main span { font-size: 12px; color: var(--hc-text-secondary); }
/* 动作用高对比蓝按钮：琥珀=「这里要注意」，蓝=「点这里解决」，两个角色不同色 */
.auto-perm__pending-action {
  flex-shrink: 0; gap: 4px; padding: 5px 12px; font-size: 12px; font-weight: 600;
}

/* ─── 决策日志 ─────────────────────────────────── */
.auto-perm__muted { margin: 0; font-size: 12px; line-height: 1.55; color: var(--hc-text-muted); }
.auto-perm__showall {
  align-self: flex-start; margin-top: 4px; padding: 3px 8px; font-size: 11.5px;
  color: var(--hc-accent); background: transparent; border: none; cursor: pointer; border-radius: 6px;
}
.auto-perm__showall:hover { background: var(--hc-bg-hover); }
.auto-perm__log { display: flex; flex-direction: column; }
.auto-perm__log-row {
  display: flex; align-items: center; gap: 8px; min-width: 0;
  padding: 8px 0; border-top: 1px solid var(--hc-divider, rgba(63, 143, 212, 0.1));
}
.auto-perm__log-row:first-child { border-top: 0; }
.auto-perm__log-time { flex-shrink: 0; font-size: 11px; color: var(--hc-text-muted); font-variant-numeric: tabular-nums; }
.auto-perm__log-text {
  flex: 1; min-width: 0; font-size: 12px; color: var(--hc-text-secondary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.auto-perm__pill { flex-shrink: 0; font-size: 11px; font-weight: 600; padding: 2px 7px; border-radius: 7px; }
.auto-perm__pill--ok { background: rgba(40, 167, 69, 0.12); color: var(--hc-success, #28a745); }
.auto-perm__pill--warn { background: rgba(240, 180, 41, 0.14); color: var(--hc-warning, #e69500); }
.auto-perm__pill--danger { background: rgba(255, 59, 48, 0.1); color: var(--hc-error, #ff3b30); }

/* ─── 策略矩阵：默认收起 disclosure + 收起态来源摘要 chips ── */
.auto-perm__disclosure {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 0; border: none; background: transparent; cursor: pointer;
  font: inherit; letter-spacing: inherit; text-transform: inherit;
  color: var(--hc-text-muted);
  transition: color 0.15s var(--hc-ease-smooth);
}
.auto-perm__disclosure:hover { color: var(--hc-text-secondary); }
.auto-perm__disclosure:focus-visible { outline: 2px solid var(--hc-accent); outline-offset: 3px; border-radius: 3px; }
.auto-perm__chevron { transition: transform 0.2s var(--hc-ease-smooth); }
.auto-perm__chevron--open { transform: rotate(180deg); }
.auto-perm__matrix-chips { display: flex; flex-wrap: wrap; gap: 7px; }
.auto-perm__chip {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 4px 10px; border-radius: 999px;
  font-size: 11.5px; color: var(--hc-text-secondary);
  background: var(--hc-bg-input); border: 0.5px solid var(--hc-border);
}
.auto-perm__chip b { font-size: 11.5px; font-weight: 700; color: var(--hc-text-primary); font-variant-numeric: tabular-nums; }
.auto-perm__chip--full { background: rgba(40, 167, 69, 0.1); border-color: rgba(40, 167, 69, 0.22); }
.auto-perm__chip--full b { color: var(--hc-success, #28a745); }
.auto-perm__chip--none { background: rgba(240, 180, 41, 0.1); border-color: rgba(240, 180, 41, 0.24); }
.auto-perm__chip--none b { color: var(--hc-warning, #e69500); }

.auto-perm__legend { display: inline-flex; align-items: center; gap: 12px; margin-inline-start: auto; text-transform: none; letter-spacing: normal; }
.auto-perm__legend-item {
  display: inline-flex; align-items: center; gap: 5px;
  font-size: 11px; font-weight: 500; color: var(--hc-text-secondary);
}
.auto-perm__dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; }
.auto-perm__dot--auto { background: var(--hc-success, #28a745); }
.auto-perm__dot--approval { background: transparent; border: 1.5px solid var(--hc-warning, #e69500); }
.auto-perm__matrix-box { overflow-x: auto; border: 0.5px solid var(--hc-border); border-radius: var(--hc-radius-md); }
.auto-perm__matrix { width: 100%; border-collapse: collapse; font-size: 12px; }
.auto-perm__matrix th, .auto-perm__matrix td {
  padding: 7px 8px; text-align: center; vertical-align: middle;
  border-inline-end: 1px solid var(--hc-divider, rgba(63, 143, 212, 0.1));
  border-bottom: 1px solid var(--hc-divider, rgba(63, 143, 212, 0.1));
}
.auto-perm__matrix th {
  font-size: 11px; color: var(--hc-text-secondary); font-weight: 600;
  background: var(--hc-bg-input); white-space: nowrap;
}
.auto-perm__matrix th:first-child, .auto-perm__matrix td:first-child {
  text-align: start; font-weight: 500; color: var(--hc-text-primary);
  min-width: 96px; white-space: nowrap;
}
.auto-perm__matrix tr:last-child td { border-bottom: 0; }
.auto-perm__matrix th:last-child, .auto-perm__matrix td:last-child { border-inline-end: 0; }

/* ─── 全功能高后果确认弹层 ─────────────────────── */
.auto-perm__modal { box-shadow: var(--hc-shadow-lg); }
.auto-perm__modal-icon {
  flex-shrink: 0; display: flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; border-radius: 8px;
  color: var(--hc-warning, #e69500); background: rgba(240, 180, 41, 0.14);
}
.auto-perm__confirm-body { padding: 16px 20px; display: flex; flex-direction: column; gap: 12px; }
.auto-perm__confirm-body p { margin: 0; font-size: 13px; line-height: 1.6; color: var(--hc-text-secondary); }
.auto-perm__confirm-row { display: flex; flex-direction: column; gap: 2px; }
.auto-perm__confirm-row b { font-size: 12.5px; color: var(--hc-text-primary); }
.auto-perm__confirm-row span { font-size: 12px; line-height: 1.55; color: var(--hc-text-secondary); }
.auto-perm__confirm-alt {
  display: flex; flex-direction: column; gap: 2px;
  padding: 10px 12px; border-radius: var(--hc-radius-md);
  background: var(--hc-accent-subtle, rgba(95, 179, 234, 0.14));
  border: 0.5px solid var(--hc-border-hl, rgba(95, 179, 234, 0.24));
}
.auto-perm__confirm-alt b { font-size: 12.5px; color: var(--hc-text-primary); }
.auto-perm__confirm-alt span { font-size: 12px; line-height: 1.55; color: var(--hc-text-secondary); }
.auto-perm__danger-btn {
  padding: var(--hc-space-2) var(--hc-space-4); font-size: 13px;
  color: #fff; background: var(--hc-error, #ff3b30);
}
.auto-perm__danger-btn:hover:not(:disabled) { filter: brightness(1.07); }
.modal-enter-active { transition: opacity 0.25s var(--hc-ease-out, ease-out); }
.modal-leave-active { transition: opacity 0.15s ease-in; }
.modal-enter-from, .modal-leave-to { opacity: 0; }
.modal-enter-active .auto-perm__modal { animation: auto-perm-modal-in 0.3s var(--hc-ease-out, ease-out); }
@keyframes auto-perm-modal-in {
  from { opacity: 0; transform: scale(0.96) translateY(8px); }
  to { opacity: 1; transform: none; }
}

@media (max-width: 900px) {
  .auto-perm__profiles { grid-template-columns: 1fr; }
  /* 三格指标够窄仍可并排，保持 stat strip 完整；仅级别卡降为单列 */
}
</style>
