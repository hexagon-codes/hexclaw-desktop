import { computed, onBeforeUnmount, ref, watch, type Ref } from 'vue'
import { getAutomationStatus, type AutomationCapability, type AutomationCapabilityState } from '@/api/automation'
import { backendScopeKey, assertBackendActive } from '@/services/backend-context'

// 两个自动化列表共用能力和请求代次；未启用、故障和成功零条不能相互替代。
export function useAutomationList<T>(kind: AutomationCapability, readItems: () => Promise<T[]>) {
  const items = ref<T[]>([]) as Ref<T[]>
  const state = ref<AutomationCapabilityState | null>(null)
  const loading = ref(true)
  const error = ref('')
  const canCreate = computed(() => state.value === 'ready' && !loading.value && !error.value)
  let generation = 0

  async function load(): Promise<void> {
    const requestGeneration = ++generation
    const scope = backendScopeKey()
    const current = () => requestGeneration === generation && scope === backendScopeKey()
    loading.value = true
    state.value = null
    error.value = ''
    items.value = []
    try {
      const status = await getAutomationStatus()
      assertBackendActive(scope)
      if (!current()) return
      state.value = status[kind].state
      if (state.value !== 'ready') return
      const result = await readItems()
      assertBackendActive(scope)
      if (current()) items.value = result
    } catch (cause) {
      if (current()) error.value = (cause as Error)?.message || 'Failed to load automation'
    } finally {
      if (current()) loading.value = false
    }
  }

  watch(() => backendScopeKey(), () => void load(), { flush: 'sync' })
  onBeforeUnmount(() => { generation++ })
  return { items, state, loading, error, canCreate, load }
}
