import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest'
import { createPinia, defineStore } from 'pinia'
import { createApp, nextTick, ref } from 'vue'
import { createPersistPlugin } from '../plugins/persist'

describe('createPersistPlugin', () => {
  let mockStorage: Record<string, string>
  const ls = globalThis.localStorage

  beforeAll(() => {
    vi.spyOn(ls, 'getItem').mockImplementation(() => null)
    vi.spyOn(ls, 'setItem').mockImplementation(() => {})
    vi.spyOn(ls, 'removeItem').mockImplementation(() => {})
    vi.spyOn(ls, 'clear').mockImplementation(() => {})
  })

  beforeEach(() => {
    mockStorage = {}
    vi.mocked(ls.getItem).mockImplementation((key: string) => mockStorage[key] ?? null)
    vi.mocked(ls.setItem).mockImplementation((key: string, val: string) => {
      mockStorage[key] = val
    })
    vi.mocked(ls.removeItem).mockImplementation((key: string) => {
      delete mockStorage[key]
    })
    vi.mocked(ls.clear).mockImplementation(() => {
      for (const k of Object.keys(mockStorage)) delete mockStorage[k]
    })
  })

  /** 创建带 persist 插件的 pinia 并挂载到 Vue app */
  function setupPiniaWithApp() {
    const pinia = createPinia()
    pinia.use(createPersistPlugin())
    const app = createApp({ template: '<div />' })
    app.use(pinia)
    // 模拟挂载（让插件生效）
    const el = document.createElement('div')
    app.mount(el)
    return { pinia, app, cleanup: () => app.unmount() }
  }

  it('persists state to localStorage via $patch', async () => {
    const { cleanup } = setupPiniaWithApp()
    const useTestStore = defineStore(
      'test-persist',
      () => {
        const count = ref(0)
        return { count }
      },
      // @ts-expect-error -- test-only: injecting persist option
      { persist: true },
    )

    const store = useTestStore()
    store.$patch({ count: 5 })
    await nextTick()

    const saved = mockStorage['hc-store-test-persist']
    expect(saved).toBeDefined()
    const parsed = JSON.parse(saved!)
    expect(parsed.d.count).toBe(5)
    expect(parsed.v).toBe(1)
    cleanup()
  })

  it('restores state from localStorage', () => {
    mockStorage['hc-store-test-restore'] = JSON.stringify({
      v: 1,
      d: { count: 42 },
    })

    const { cleanup } = setupPiniaWithApp()
    const useTestStore = defineStore(
      'test-restore',
      () => {
        const count = ref(0)
        return { count }
      },
      // @ts-expect-error -- test-only: injecting persist option
      { persist: true },
    )

    const store = useTestStore()
    expect(store.count).toBe(42)
    cleanup()
  })

  it('discards data when version mismatches', () => {
    mockStorage['hc-store-test-version'] = JSON.stringify({
      v: 1,
      d: { count: 99 },
    })

    const { cleanup } = setupPiniaWithApp()
    const useTestStore = defineStore(
      'test-version',
      () => {
        const count = ref(0)
        return { count }
      },
      // @ts-expect-error -- test-only: injecting persist option
      { persist: { version: 2 } },
    )

    const store = useTestStore()
    expect(store.count).toBe(0)
    expect(mockStorage['hc-store-test-version']).toBeUndefined()
    cleanup()
  })

  it('persists only picked fields via $patch', async () => {
    const { cleanup } = setupPiniaWithApp()
    const useTestStore = defineStore(
      'test-pick',
      () => {
        const name = ref('hello')
        const secret = ref('sensitive')
        return { name, secret }
      },
      // @ts-expect-error -- test-only: injecting persist option
      { persist: { pick: ['name'] } },
    )

    const store = useTestStore()
    store.$patch({ name: 'world', secret: 'new-secret' })
    await nextTick()

    const saved = mockStorage['hc-store-test-pick']
    expect(saved).toBeDefined()
    const parsed = JSON.parse(saved!)
    expect(parsed.d.name).toBe('world')
    expect(parsed.d.secret).toBeUndefined()
    cleanup()
  })

  it('does nothing when persist option is absent', async () => {
    const { cleanup } = setupPiniaWithApp()
    const useTestStore = defineStore('test-nopersist', () => {
      const count = ref(0)
      return { count }
    })

    const store = useTestStore()
    store.$patch({ count: 5 })
    await nextTick()

    expect(mockStorage['hc-store-test-nopersist']).toBeUndefined()
    cleanup()
  })

  it('supports custom key', async () => {
    const { cleanup } = setupPiniaWithApp()
    const useTestStore = defineStore(
      'test-key',
      () => {
        const val = ref('test')
        return { val }
      },
      // @ts-expect-error -- test-only: injecting persist option
      { persist: { key: 'my-custom-key' } },
    )

    const store = useTestStore()
    store.$patch({ val: 'changed' })
    await nextTick()

    expect(mockStorage['my-custom-key']).toBeDefined()
    const saved = JSON.parse(mockStorage['my-custom-key']!)
    expect(saved.d.val).toBe('changed')
    cleanup()
  })
})
