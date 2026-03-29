/**
 * Area 4: Store persistence version compatibility edge cases
 *
 * Tests the Pinia persist plugin's resilience against:
 * - Version mismatch discards stored data (not crashes)
 * - Corrupted JSON in localStorage doesn't crash
 * - Empty string in localStorage doesn't crash
 * - Very large stored state (>1MB) doesn't hang
 */
import { beforeEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createPinia, defineStore } from 'pinia'
import { createApp, nextTick, ref } from 'vue'
import { createPersistPlugin } from '../plugins/persist'

// Mock logger to prevent console noise
vi.mock('@/utils/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

describe('persist plugin edge cases', () => {
  let mockStorage: Record<string, string>
  const mockLocalStorage = {
    getItem: vi.fn<(key: string) => string | null>(),
    setItem: vi.fn<(key: string, value: string) => void>(),
    removeItem: vi.fn<(key: string) => void>(),
    clear: vi.fn<() => void>(),
    key: vi.fn<(index: number) => string | null>(),
    length: 0,
  } as unknown as Storage

  beforeAll(() => {
    Object.defineProperty(globalThis, 'localStorage', {
      value: mockLocalStorage,
      configurable: true,
      writable: true,
    })
  })

  beforeEach(() => {
    mockStorage = {}
    mockLocalStorage.getItem = vi.fn((key: string) => mockStorage[key] ?? null) as Storage['getItem']
    mockLocalStorage.setItem = vi.fn((key: string, val: string) => {
      mockStorage[key] = val
    }) as Storage['setItem']
    mockLocalStorage.removeItem = vi.fn((key: string) => {
      delete mockStorage[key]
    }) as Storage['removeItem']
    mockLocalStorage.clear = vi.fn(() => {
      for (const k of Object.keys(mockStorage)) delete mockStorage[k]
    }) as Storage['clear']
  })

  function setupPiniaWithApp() {
    const pinia = createPinia()
    pinia.use(createPersistPlugin())
    const app = createApp({ template: '<div />' })
    app.use(pinia)
    const el = document.createElement('div')
    app.mount(el)
    return { pinia, app, cleanup: () => app.unmount() }
  }

  // ─── Version mismatch ──────────────────────────────

  describe('version mismatch', () => {
    it('discards stored data when version is older', () => {
      mockStorage['hc-store-test-vm1'] = JSON.stringify({
        v: 1,
        d: { counter: 42 },
      })

      const { cleanup } = setupPiniaWithApp()
      const useStore = defineStore(
        'test-vm1',
        () => {
          const counter = ref(0)
          return { counter }
        },
        // @ts-expect-error -- test-only: injecting persist option
        { persist: { version: 2 } },
      )

      const store = useStore()
      expect(store.counter).toBe(0)
      // Old data should have been removed
      expect(mockStorage['hc-store-test-vm1']).toBeUndefined()
      cleanup()
    })

    it('discards stored data when version is newer (downgrade scenario)', () => {
      mockStorage['hc-store-test-vm2'] = JSON.stringify({
        v: 5,
        d: { counter: 99 },
      })

      const { cleanup } = setupPiniaWithApp()
      const useStore = defineStore(
        'test-vm2',
        () => {
          const counter = ref(0)
          return { counter }
        },
        // @ts-expect-error -- test-only: injecting persist option
        { persist: { version: 3 } },
      )

      const store = useStore()
      expect(store.counter).toBe(0)
      cleanup()
    })

    it('writes fresh data with new version after mismatch', async () => {
      mockStorage['hc-store-test-vm3'] = JSON.stringify({
        v: 1,
        d: { counter: 42 },
      })

      const { cleanup } = setupPiniaWithApp()
      const useStore = defineStore(
        'test-vm3',
        () => {
          const counter = ref(0)
          return { counter }
        },
        // @ts-expect-error -- test-only: injecting persist option
        { persist: { version: 2 } },
      )

      const store = useStore()
      store.$patch({ counter: 7 })
      await nextTick()

      // After patch, a new entry should be written with version 2
      const stored = mockStorage['hc-store-test-vm3']
      expect(stored).toBeDefined()
      const parsed = JSON.parse(stored!)
      expect(parsed.v).toBe(2)
      expect(parsed.d.counter).toBe(7)
      cleanup()
    })

    it('restores data when version matches', () => {
      mockStorage['hc-store-test-vm4'] = JSON.stringify({
        v: 3,
        d: { counter: 42, name: 'saved' },
      })

      const { cleanup } = setupPiniaWithApp()
      const useStore = defineStore(
        'test-vm4',
        () => {
          const counter = ref(0)
          const name = ref('default')
          return { counter, name }
        },
        // @ts-expect-error -- test-only: injecting persist option
        { persist: { version: 3 } },
      )

      const store = useStore()
      expect(store.counter).toBe(42)
      expect(store.name).toBe('saved')
      cleanup()
    })
  })

  // ─── Corrupted JSON ────────────────────────────────

  describe('corrupted JSON in localStorage', () => {
    it('does not crash on completely invalid JSON', () => {
      mockStorage['hc-store-test-cj1'] = '{{{invalid json!!!'

      const { cleanup } = setupPiniaWithApp()
      const useStore = defineStore(
        'test-cj1',
        () => {
          const counter = ref(0)
          return { counter }
        },
        // @ts-expect-error -- test-only: injecting persist option
        { persist: true },
      )

      expect(() => {
        const store = useStore()
        expect(store.counter).toBe(0)
      }).not.toThrow()
      cleanup()
    })

    it('does not crash on truncated JSON', () => {
      mockStorage['hc-store-test-cj2'] = '{"v":1,"d":{"coun'

      const { cleanup } = setupPiniaWithApp()
      const useStore = defineStore(
        'test-cj2',
        () => {
          const counter = ref(0)
          return { counter }
        },
        // @ts-expect-error -- test-only: injecting persist option
        { persist: true },
      )

      expect(() => {
        const store = useStore()
        expect(store.counter).toBe(0)
      }).not.toThrow()
      cleanup()
    })

    it('removes corrupted data from localStorage', () => {
      mockStorage['hc-store-test-cj3'] = 'not json at all'

      const { cleanup } = setupPiniaWithApp()
      const useStore = defineStore(
        'test-cj3',
        () => {
          const counter = ref(0)
          return { counter }
        },
        // @ts-expect-error -- test-only: injecting persist option
        { persist: true },
      )

      useStore()

      // The corrupted data should have been removed by the catch block
      expect(mockLocalStorage.removeItem).toHaveBeenCalledWith('hc-store-test-cj3')
      cleanup()
    })

    it('does not crash on JSON null', () => {
      mockStorage['hc-store-test-cj4'] = 'null'

      const { cleanup } = setupPiniaWithApp()
      const useStore = defineStore(
        'test-cj4',
        () => {
          const counter = ref(0)
          return { counter }
        },
        // @ts-expect-error -- test-only: injecting persist option
        { persist: true },
      )

      expect(() => {
        const store = useStore()
        expect(store.counter).toBe(0)
      }).not.toThrow()
      cleanup()
    })

    it('does not crash when d field is missing', () => {
      mockStorage['hc-store-test-cj5'] = JSON.stringify({ v: 1 })

      const { cleanup } = setupPiniaWithApp()
      const useStore = defineStore(
        'test-cj5',
        () => {
          const counter = ref(0)
          return { counter }
        },
        // @ts-expect-error -- test-only: injecting persist option
        { persist: true },
      )

      expect(() => {
        const store = useStore()
        // v matches but d is falsy — version check "persisted.v === version && persisted.d"
        // will be false, so it should clean up
        expect(store.counter).toBe(0)
      }).not.toThrow()
      cleanup()
    })

    it('does not crash when d field is an array instead of object', () => {
      mockStorage['hc-store-test-cj6'] = JSON.stringify({ v: 1, d: [1, 2, 3] })

      const { cleanup } = setupPiniaWithApp()
      const useStore = defineStore(
        'test-cj6',
        () => {
          const counter = ref(0)
          return { counter }
        },
        // @ts-expect-error -- test-only: injecting persist option
        { persist: true },
      )

      expect(() => {
        useStore()
      }).not.toThrow()
      cleanup()
    })
  })

  // ─── Empty string ──────────────────────────────────

  describe('empty string in localStorage', () => {
    it('does not crash on empty string', () => {
      mockStorage['hc-store-test-es1'] = ''

      const { cleanup } = setupPiniaWithApp()
      const useStore = defineStore(
        'test-es1',
        () => {
          const counter = ref(0)
          return { counter }
        },
        // @ts-expect-error -- test-only: injecting persist option
        { persist: true },
      )

      expect(() => {
        const store = useStore()
        expect(store.counter).toBe(0)
      }).not.toThrow()
      cleanup()
    })

    it('does not crash on whitespace-only string', () => {
      mockStorage['hc-store-test-es2'] = '   '

      const { cleanup } = setupPiniaWithApp()
      const useStore = defineStore(
        'test-es2',
        () => {
          const counter = ref(0)
          return { counter }
        },
        // @ts-expect-error -- test-only: injecting persist option
        { persist: true },
      )

      expect(() => {
        const store = useStore()
        expect(store.counter).toBe(0)
      }).not.toThrow()
      cleanup()
    })
  })

  // ─── Large stored state ────────────────────────────

  describe('large stored state', () => {
    it('handles >1MB state without hanging', () => {
      // Create a large array (about 1.5MB of JSON)
      const largeItems: string[] = []
      for (let i = 0; i < 15000; i++) {
        largeItems.push(`item-${i}-${'x'.repeat(100)}`)
      }

      mockStorage['hc-store-test-lg1'] = JSON.stringify({
        v: 1,
        d: { counter: 1, items: largeItems },
      })

      const { cleanup } = setupPiniaWithApp()
      const useStore = defineStore(
        'test-lg1',
        () => {
          const counter = ref(0)
          const items = ref<string[]>([])
          return { counter, items }
        },
        // @ts-expect-error -- test-only: injecting persist option
        { persist: true },
      )

      const startTime = Date.now()
      const store = useStore()
      const elapsed = Date.now() - startTime

      // Should complete in reasonable time (under 5 seconds)
      expect(elapsed).toBeLessThan(5000)
      expect(store.items.length).toBe(15000)
      expect(store.counter).toBe(1)
      cleanup()
    })
  })

  // ─── Pick fields ────────────────────────────────────

  describe('pick fields edge cases', () => {
    it('only persists specified fields', async () => {
      const { cleanup } = setupPiniaWithApp()
      const useStore = defineStore(
        'test-pk1',
        () => {
          const counter = ref(0)
          const name = ref('hello')
          return { counter, name }
        },
        // @ts-expect-error -- test-only: injecting persist option
        { persist: { pick: ['counter'] } },
      )

      const store = useStore()
      store.$patch({ counter: 42, name: 'changed' })
      await nextTick()

      const saved = mockStorage['hc-store-test-pk1']
      expect(saved).toBeDefined()
      const parsed = JSON.parse(saved!)
      expect(parsed.d.counter).toBe(42)
      // name should NOT be persisted
      expect(parsed.d.name).toBeUndefined()
      cleanup()
    })
  })

  // ─── Custom key ─────────────────────────────────────

  describe('custom key edge cases', () => {
    it('uses custom localStorage key', async () => {
      const { cleanup } = setupPiniaWithApp()
      const useStore = defineStore(
        'test-ck1',
        () => {
          const counter = ref(0)
          return { counter }
        },
        // @ts-expect-error -- test-only: injecting persist option
        { persist: { key: 'my-custom-key-edge' } },
      )

      const store = useStore()
      store.$patch({ counter: 7 })
      await nextTick()

      const stored = mockStorage['my-custom-key-edge']
      expect(stored).toBeDefined()
      const parsed = JSON.parse(stored!)
      expect(parsed.d.counter).toBe(7)
      // Default key should NOT exist
      expect(mockStorage['hc-store-test-ck1']).toBeUndefined()
      cleanup()
    })
  })
})
