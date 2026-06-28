<script setup lang="ts">
import { onMounted, onUnmounted, watch } from 'vue'
import TitleBar from './TitleBar.vue'
import Sidebar from './Sidebar.vue'
import DetailPanel from './DetailPanel.vue'
import EngineBanner from './EngineBanner.vue'
// v0.4.0 UI 优化：删除 ContextBar 引用，参见 <template> 中的注释
import InspectorContext from '@/components/inspector/InspectorContext.vue'
import CommandPalette from '@/components/common/CommandPalette.vue'
import { useAppStore } from '@/stores/app'

const appStore = useAppStore()

async function syncIMInstancesWhenReady() {
  try {
    const { ensureIMInstancesSyncedToBackend } = await import('@/api/im-channels')
    await ensureIMInstancesSyncedToBackend()
  } catch (e) {
    console.warn('[IM] 启动同步实例失败:', e)
  }
}

async function refreshChatSessionsWhenReady() {
  // BUG（2026-06-28 用户反馈）：冷启动首屏就是会话页，但 ChatView 首挂载时 sidecar 往往尚未就绪，
  // 其 onMounted 的 loadSessions 会静默失败（loadSessions 内部 try/catch 吞错）→ 会话列表空，
  // 必须切到别的页再切回触发重挂载才加载。sidecar 就绪后在此（跨导航常驻的 AppLayout）补载一次，
  // 让首屏会话列表自动出现，无需用户手动切页。loadSessions 幂等，与 ChatView 自身加载不冲突。
  try {
    const { useChatStore } = await import('@/stores/chat')
    await useChatStore().loadSessions()
  } catch (e) {
    console.warn('[AppLayout] sidecar 就绪后补载会话列表失败:', e)
  }
}

async function warmupOllamaModel() {
  try {
    const { getOllamaStatus, getOllamaRunning, loadOllamaModel } = await import('@/api/ollama')
    const status = await getOllamaStatus()
    if (!status?.running || !status.models?.length) return

    const running = await getOllamaRunning()
    if (running.length > 0) return // 已有模型在跑

    // Ollama 运行中 + 有已下载模型 + 无模型在跑 → 预热第一个模型
    const modelToLoad = status.models[0]!.name
    console.log('[AppLayout] Ollama 自动预热:', modelToLoad)
    await loadOllamaModel(modelToLoad)
    console.log('[AppLayout] Ollama 预热完成')
  } catch (e) {
    console.warn('[AppLayout] Ollama 预热失败:', e)
  }
}

function dismissSplash() {
  const splash = document.getElementById('splash-screen')
  if (splash) {
    splash.classList.add('fade-out')
    splash.addEventListener('transitionend', () => splash.remove(), { once: true })
  }
}

onMounted(() => {
  appStore.startHealthCheck()
  // 如果 sidecar 30 秒内未就绪，也移除 splash 避免永远卡住
  const splashTimeout = setTimeout(dismissSplash, 30000)
  watch(
    () => appStore.sidecarReady,
    (ready, wasReady) => {
      if (ready && !wasReady) {
        clearTimeout(splashTimeout)
        dismissSplash()
        void refreshChatSessionsWhenReady() // 冷启动补载会话列表（首屏会话页不再空）
        void syncIMInstancesWhenReady()
        void warmupOllamaModel()
      }
    },
    { immediate: true },
  )
})

onUnmounted(() => {
  appStore.stopHealthCheck()
})
</script>

<template>
  <div class="hc-app">
    <TitleBar />
    <div class="hc-app__body">
      <Sidebar />
      <main class="hc-app__content">
        <!-- 引擎降级 banner：引擎未连接时顶部常驻（锚点 prototype #engineBanner） -->
        <EngineBanner />
        <div class="hc-app__view">
          <slot />
        </div>
      </main>
      <DetailPanel :open="appStore.detailPanelOpen" @close="appStore.toggleDetailPanel">
        <InspectorContext />
      </DetailPanel>
    </div>
    <!-- v0.4.0 UI 优化：移除 ContextBar 整条
         理由：5 个 chip 全部是只读重复信息（引擎状态与 Sidebar 重复 / model
         与输入框 selector 重复 / Agent 与 sidebar 入口重复 / Provider 可推断），
         违反 Apple HIG "Clarity" + "Deference" 原则。释放 32px 屏幕高度。
         相关功能（Agent 切换 / model 切换）下沉到输入框旁的"操作密集区"。 -->
    <CommandPalette />
  </div>
</template>

<style scoped>
.hc-app {
  height: 100vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--hc-bg-main);
}

.hc-app__body {
  flex: 1;
  display: flex;
  overflow: hidden;
}

.hc-app__content {
  flex: 1;
  overflow: hidden;
  position: relative;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

/* 视图包裹：banner 占自然高度后，视图填满剩余高度（每个视图自带 height:100%/flex） */
.hc-app__view {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
</style>
