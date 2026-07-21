<script setup lang="ts">
/**
 * MemorySettingsPanel —「记忆行为设置 + 用户画像」暴露面（BUG-20260703 P2-2）。
 *
 * 此前 config.FileMemory 的 auto_memory / recall_min_score / active_recall / profile
 * 只能手改 yaml，画像蒸馏产物埋在记忆列表里无专门展示。
 * 后端 GET/PUT /api/v1/config/memory：前三项热生效；profile 蒸馏 goroutine boot 期
 * 接线 → 改动后按 restart_required 如实提示重启。
 * 画像卡：source=reflect_profile 的 Pinned 条（周期 LLM 蒸馏产物），只读展示。
 */
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronDown, Settings2, UserRound, RefreshCw } from 'lucide-vue-next'
import {
  getMemoryConfig,
  updateMemoryConfig,
  getMemoryEntries,
  type MemoryBehaviorConfig,
  type MemoryBehaviorUpdate,
  type MemoryEntry,
} from '@/api/memory'
import { formatTime } from '@/utils/time'
import { useToast } from '@/composables/useToast'

const { t } = useI18n()
const toast = useToast()

const open = ref(false)
const cfg = ref<MemoryBehaviorConfig | null>(null)
const unavailable = ref(false)
const savingField = ref<string | null>(null)
const restartHint = ref(false)

const profileEntry = ref<MemoryEntry | null>(null)
const profileExpanded = ref(false)
const profileLoading = ref(false)

const AUTO_MEMORY_MODES = ['inline', 'extract', 'off'] as const

async function loadConfig() {
  try {
    cfg.value = await getMemoryConfig()
    unavailable.value = false
  } catch {
    unavailable.value = true
  }
}

async function loadProfile() {
  profileLoading.value = true
  try {
    const res = await getMemoryEntries({ source: 'reflect_profile', limit: 5 })
    // source 双重过滤（请求参数 + 客户端）：不信任服务端一定应用了过滤，防普通条目冒充画像
    profileEntry.value = (res.entries ?? [])
      .find((e) => e.source === 'reflect_profile' && (e.status ?? 'active') === 'active') ?? null
  } catch {
    profileEntry.value = null
  } finally {
    profileLoading.value = false
  }
}

/** 单字段乐观提交；失败回滚 + toast（不静默吞错）。 */
async function apply(patch: MemoryBehaviorUpdate, field: string) {
  if (!cfg.value || savingField.value) return
  savingField.value = field
  const prev = { ...cfg.value }
  Object.assign(cfg.value, patch)
  try {
    const res = await updateMemoryConfig(patch)
    cfg.value = res.config
    if (res.restart_required?.length) restartHint.value = true
    toast.success(t('memory.settings.saved', '记忆设置已保存'))
  } catch (e) {
    cfg.value = prev
    toast.error(e instanceof Error ? e.message : t('memory.settings.saveFailed', '保存记忆设置失败'))
  } finally {
    savingField.value = null
  }
}

function onRecallFloorChange(event: Event) {
  const raw = Number((event.target as HTMLInputElement).value)
  if (Number.isNaN(raw)) return
  void apply({ recall_min_score: Math.min(1, Math.max(0, raw)) }, 'recall_min_score')
}

onMounted(() => {
  void loadConfig()
  void loadProfile()
})

defineExpose({ loadProfile })
</script>

<template>
  <div class="hc-memset">
    <!-- 用户画像卡（周期蒸馏产物；无画像/关闭蒸馏时不占位） -->
    <div v-if="profileEntry" class="hc-memset__profile" data-testid="memory-profile-card">
      <div class="hc-memset__profile-head">
        <UserRound :size="14" class="hc-memset__profile-icon" />
        <b>{{ t('memory.settings.profileTitle', '用户画像') }}</b>
        <span class="hc-memset__profile-meta">
          {{ t('memory.settings.profileMeta', '由周期蒸馏生成') }}
          <template v-if="profileEntry.updated_at"> · {{ formatTime(profileEntry.updated_at) }}</template>
        </span>
        <button
          class="hc-memset__profile-refresh"
          :disabled="profileLoading"
          :aria-label="t('common.refresh', '刷新')"
          @click="loadProfile"
        >
          <RefreshCw :size="12" :class="{ 'hc-memset__spin': profileLoading }" />
        </button>
      </div>
      <p
        class="hc-memset__profile-body"
        :class="{ 'hc-memset__profile-body--clamped': !profileExpanded }"
        @click="profileExpanded = !profileExpanded"
      >{{ profileEntry.content }}</p>
    </div>

    <!-- 行为设置（默认收起 disclosure） -->
    <section class="hc-memset__section">
      <button
        class="hc-memset__disclosure"
        :aria-expanded="open"
        aria-controls="memory-behavior-settings-body"
        data-testid="memset-toggle"
        @click="open = !open"
      >
        <Settings2 :size="13" />
        {{ t('memory.settings.title', '记忆行为设置') }}
        <ChevronDown :size="13" class="hc-memset__chevron" :class="{ 'hc-memset__chevron--open': open }" />
      </button>

      <div id="memory-behavior-settings-body" v-show="open">
        <div v-if="unavailable" class="hc-memset__muted">
          {{ t('memory.settings.unavailable', '记忆设置不可用（引擎未连接或版本过旧）') }}
        </div>

        <div v-else-if="cfg" class="hc-memset__body">
        <!-- 自动记忆方式 -->
        <div class="hc-memset__row">
          <div class="hc-memset__label">
            <b>{{ t('memory.settings.autoMemory', '对话自动进记忆') }}</b>
            <span>{{ t('memory.settings.autoMemoryHint', '模型如何把对话里的长期事实写进记忆') }}</span>
          </div>
          <div class="hc-memset__seg" role="radiogroup" :aria-label="t('memory.settings.autoMemory', '对话自动进记忆')">
            <button
              v-for="mode in AUTO_MEMORY_MODES"
              :key="mode"
              class="hc-memset__seg-btn"
              :class="{ 'hc-memset__seg-btn--on': cfg.auto_memory === mode }"
              role="radio"
              :aria-checked="cfg.auto_memory === mode"
              :data-testid="`memset-automemory-${mode}`"
              :disabled="savingField !== null"
              :title="t(`memory.settings.autoMemoryDesc.${mode}`)"
              @click="cfg.auto_memory !== mode && apply({ auto_memory: mode }, 'auto_memory')"
            >
              {{ t(`memory.settings.autoMemoryMode.${mode}`) }}
            </button>
          </div>
        </div>

        <!-- 召回相关性地板 -->
        <div class="hc-memset__row">
          <div class="hc-memset__label">
            <b>{{ t('memory.settings.recallFloor', '召回相关性地板') }}</b>
            <span>{{ t('memory.settings.recallFloorHint', '低于该相关度的记忆不注入回复；仅配置向量嵌入时生效，0 = 关闭') }}</span>
          </div>
          <div class="hc-memset__slider">
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              :value="cfg.recall_min_score"
              :disabled="savingField !== null"
              data-testid="memset-recall-floor"
              :aria-label="t('memory.settings.recallFloor', '召回相关性地板')"
              @change="onRecallFloorChange"
            />
            <span class="hc-memset__slider-val"><bdi>{{ cfg.recall_min_score.toFixed(2) }}</bdi></span>
          </div>
        </div>

        <!-- 主动会话召回 -->
        <div class="hc-memset__row">
          <div class="hc-memset__label">
            <b>{{ t('memory.settings.activeRecall', '主动会话召回') }}</b>
            <span>{{ t('memory.settings.activeRecallHint', '回复前自动翻查历史会话，把「该想起来」的旧上下文带进来') }}</span>
          </div>
          <label class="hc-memset__switch">
            <input
              type="checkbox"
              :checked="cfg.active_recall"
              :disabled="savingField !== null"
              data-testid="memset-active-recall"
              @change="apply({ active_recall: !cfg.active_recall }, 'active_recall')"
            />
            <span class="hc-memset__switch-track" aria-hidden="true" />
          </label>
        </div>

        <!-- 画像蒸馏 -->
        <div class="hc-memset__row">
          <div class="hc-memset__label">
            <b>{{ t('memory.settings.profileDistill', '周期画像蒸馏') }}</b>
            <span>{{ t('memory.settings.profileDistillHint', '定期把零碎记忆综合成稳定的用户画像（上方画像卡的来源）') }}</span>
          </div>
          <label class="hc-memset__switch">
            <input
              type="checkbox"
              :checked="cfg.profile"
              :disabled="savingField !== null"
              data-testid="memset-profile"
              @change="apply({ profile: !cfg.profile }, 'profile')"
            />
            <span class="hc-memset__switch-track" aria-hidden="true" />
          </label>
        </div>

          <p v-if="restartHint" class="hc-memset__restart" data-testid="memset-restart-hint">
            {{ t('memory.settings.restartHint', '画像蒸馏开关已保存，重启应用后生效。') }}
          </p>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.hc-memset { display: flex; flex-direction: column; gap: 10px; margin-bottom: 14px; }

/* ── 用户画像卡 ── */
.hc-memset__profile {
  padding: 12px 14px; border-radius: var(--hc-radius-lg);
  background: var(--hc-accent-subtle, rgba(95, 179, 234, 0.1));
  border: 0.5px solid var(--hc-border-hl, rgba(95, 179, 234, 0.24));
}
.hc-memset__profile-head { display: flex; align-items: center; gap: 7px; min-width: 0; }
.hc-memset__profile-icon { flex-shrink: 0; color: var(--hc-accent); }
.hc-memset__profile-head b { font-size: 13px; color: var(--hc-text-primary); }
.hc-memset__profile-meta { flex: 1; min-width: 0; font-size: 11px; color: var(--hc-text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hc-memset__profile-refresh {
  flex-shrink: 0; display: inline-flex; padding: 3px; border: none; background: transparent;
  color: var(--hc-text-muted); cursor: pointer; border-radius: var(--hc-radius-sm);
}
.hc-memset__profile-refresh:hover { color: var(--hc-accent); }
.hc-memset__spin { animation: hc-memset-spin 0.8s linear infinite; }
@keyframes hc-memset-spin { to { transform: rotate(360deg); } }
.hc-memset__profile-body {
  margin: 8px 0 0; font-size: 12.5px; line-height: 1.6; color: var(--hc-text-secondary);
  white-space: pre-wrap; cursor: pointer;
}
.hc-memset__profile-body--clamped {
  display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden;
}

/* ── 行为设置 ── */
.hc-memset__section { display: flex; flex-direction: column; gap: 10px; }
.hc-memset__disclosure {
  display: inline-flex; align-items: center; gap: 6px; align-self: flex-start;
  padding: 0; border: none; background: transparent; cursor: pointer;
  font-size: 12px; font-weight: 600; color: var(--hc-text-muted);
  transition: color 0.15s var(--hc-ease-smooth, ease);
}
.hc-memset__disclosure:hover { color: var(--hc-text-secondary); }
.hc-memset__chevron { transition: transform 0.2s var(--hc-ease-smooth, ease); }
.hc-memset__chevron--open { transform: rotate(180deg); }
.hc-memset__muted { font-size: 12px; color: var(--hc-text-muted); }

.hc-memset__body {
  display: flex; flex-direction: column; gap: 14px;
  padding: 14px; border-radius: var(--hc-radius-lg);
  background: var(--hc-bg-card); border: 0.5px solid var(--hc-border);
}
.hc-memset__row { display: flex; align-items: center; gap: 14px; }
.hc-memset__label { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.hc-memset__label b { font-size: 13px; color: var(--hc-text-primary); font-weight: 500; }
.hc-memset__label span { font-size: 11.5px; line-height: 1.5; color: var(--hc-text-muted); }

.hc-memset__seg { display: inline-flex; gap: 4px; padding: 3px; border-radius: 9px; background: var(--hc-bg-input); }
.hc-memset__seg-btn {
  padding: 4px 10px; border: none; border-radius: 7px; background: transparent;
  font-size: 12px; color: var(--hc-text-secondary); cursor: pointer;
}
.hc-memset__seg-btn--on { background: var(--hc-bg-elevated); color: var(--hc-text-primary); font-weight: 600; box-shadow: var(--hc-shadow-sm, 0 1px 2px rgba(0,0,0,.08)); }
.hc-memset__seg-btn:disabled { opacity: 0.6; cursor: default; }

.hc-memset__slider { display: flex; align-items: center; gap: 8px; }
.hc-memset__slider input[type='range'] { width: 140px; accent-color: var(--hc-accent); }
.hc-memset__slider-val { font-size: 12px; font-variant-numeric: tabular-nums; color: var(--hc-text-primary); min-width: 34px; text-align: end; }
/* 技术 token LTR 隔离（RTL 维语下数字不被重排） */
.hc-memset__slider-val > bdi { unicode-bidi: isolate; direction: ltr; }

.hc-memset__switch { position: relative; display: inline-flex; cursor: pointer; }
.hc-memset__switch input { position: absolute; opacity: 0; width: 100%; height: 100%; margin: 0; cursor: pointer; }
.hc-memset__switch-track {
  width: 34px; height: 20px; border-radius: 999px; background: var(--hc-bg-input);
  border: 0.5px solid var(--hc-border); position: relative; transition: background 0.15s ease;
}
.hc-memset__switch-track::after {
  content: ''; position: absolute; top: 2px; inset-inline-start: 2px; width: 14px; height: 14px;
  border-radius: 50%; background: var(--hc-text-muted); transition: transform 0.15s ease, background 0.15s ease;
}
.hc-memset__switch input:checked + .hc-memset__switch-track { background: var(--hc-accent); border-color: var(--hc-accent); }
.hc-memset__switch input:checked + .hc-memset__switch-track::after { transform: translateX(14px); background: #fff; }
.hc-memset__switch input:disabled + .hc-memset__switch-track { opacity: 0.6; }

.hc-memset__restart {
  margin: 0; padding: 8px 12px; border-radius: var(--hc-radius-md);
  font-size: 12px; color: var(--hc-warning, #e69500);
  background: rgba(240, 180, 41, 0.1); border: 0.5px dashed rgba(240, 180, 41, 0.35);
}
</style>
