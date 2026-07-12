<script setup lang="ts">
/**
 * 嵌入模型状态横幅（BUG-20260712-B1 · 三态机制，20260712 产品评审定案，原型 app.html 知识库屏同步）。
 *
 * 能力型模型走「静默预置 + 失败才打扰」（对标 Apple 本地模型/Cursor 索引/Chrome 翻译模型）：
 *  - 成功路径（后端首启后台自动安装）→ 本组件**永不渲染**，用户零感知零新概念；
 *  - pulling=true（静默安装进行中）→ 零打扰，仅静默轮询等它变 ready；
 *  - ready=false 且非 pulling（自动安装失败：离线/被墙/已禁用自动安装）→ 此时才浮出横幅：
 *    一句人话 + 手动安装（复用 ollama pull SSE 进度）——异常驱动披露；
 *  - 未配置 / 云端 provider / 旧引擎无端点 → 不渲染（向后兼容）。
 * ⚠️ 勿改回「常驻直到解决」的横幅——那是把工程状态泄漏给家长（认知负担）。
 */
import { ref, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { getKnowledgeEmbeddingStatus, type KnowledgeEmbeddingStatus } from '@/api/knowledge'
import { pullOllamaModel, type OllamaPullProgress } from '@/api/ollama'

const { t } = useI18n()

const status = ref<KnowledgeEmbeddingStatus | null>(null)
const installing = ref(false)
const progressPct = ref<number | null>(null)
const error = ref('')
let pollTimer: ReturnType<typeof setTimeout> | null = null

async function refresh() {
  try {
    status.value = await getKnowledgeEmbeddingStatus()
  } catch {
    status.value = null // 旧引擎无端点 → 静默不渲染（向后兼容）
    return
  }
  // 静默安装进行中：零打扰，轮询到终态（ready 或失败浮横幅）
  const s = status.value
  if (s && s.enabled && s.configured && s.local && !s.ready && s.pulling) {
    pollTimer = setTimeout(() => void refresh(), 5000)
  }
}
onMounted(refresh)
onUnmounted(() => { if (pollTimer) clearTimeout(pollTimer) })

function showBanner(): boolean {
  const s = status.value
  return !!s && s.enabled && s.configured && s.local && !s.ready && !s.pulling
}

async function install() {
  const model = status.value?.model
  if (!model || installing.value) return
  installing.value = true
  error.value = ''
  progressPct.value = 0
  try {
    await pullOllamaModel(model, (p: OllamaPullProgress) => {
      if (p.total && p.completed != null) {
        progressPct.value = Math.min(100, Math.round((p.completed / p.total) * 100))
      }
    }, undefined)
    await refresh() // 装完重查 → ready 即横幅消失（装完即活）
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    installing.value = false
    progressPct.value = null
  }
}
</script>

<template>
  <div v-if="showBanner()" class="hc-embed-banner" data-testid="embedding-banner">
    <span class="hc-embed-banner__icon">💤</span>
    <div class="hc-embed-banner__body">
      <b>{{ t('knowledge.embedding.inactiveTitle', '语义检索未激活') }}</b>
      <span class="hc-embed-banner__desc">
        {{ t('knowledge.embedding.inactiveDesc', '自动安装未完成（可能网络不通），会话里的知识库自动引用暂时休眠——文档管理与手动搜索不受影响。') }}
      </span>
      <span v-if="error" class="hc-embed-banner__err">{{ error }}</span>
    </div>
    <button
      class="hc-btn hc-btn-primary"
      data-testid="embedding-install"
      :disabled="installing"
      @click="install"
    >
      {{ installing
        ? t('knowledge.embedding.installing', '安装中') + (progressPct != null ? ` ${progressPct}%` : '…')
        : t('knowledge.embedding.installCta', '立即安装') }}
    </button>
  </div>
</template>

<style scoped>
.hc-embed-banner {
  display: flex; align-items: center; gap: 10px;
  margin: 0 0 12px; padding: 10px 14px;
  border: 0.5px solid var(--hc-border); border-radius: var(--hc-radius-md);
  background: var(--hc-bg-input); font-size: 12.5px; color: var(--hc-text-secondary);
}
.hc-embed-banner__icon { font-size: 16px; flex-shrink: 0; }
.hc-embed-banner__body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.hc-embed-banner__body b { color: var(--hc-text-primary); font-size: 13px; }
.hc-embed-banner__desc { line-height: 1.5; }
.hc-embed-banner__err { color: var(--hc-error); font-size: 12px; }
</style>
