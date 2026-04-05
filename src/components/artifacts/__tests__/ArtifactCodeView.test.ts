import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import ArtifactCodeView from '../ArtifactCodeView.vue'

vi.mock('lucide-vue-next', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  const stub = { template: '<span />' }
  const mocked: Record<string, unknown> = {}
  for (const key of Object.keys(original)) mocked[key] = stub
  return mocked
})

vi.mock('dompurify', () => ({
  default: {
    sanitize: (value: string) => value,
  },
}))

vi.mock('shiki', () => ({
  codeToHtml: vi.fn().mockResolvedValue('<pre><code>const a = 1</code></pre>'),
}))

describe('ArtifactCodeView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('copy action should fail gracefully when clipboard API is unavailable', async () => {
    const wrapper = mount(ArtifactCodeView, {
      props: {
        artifact: {
          id: 'a1',
          type: 'code',
          title: 'test.ts',
          language: 'ts',
          content: 'const a = 1',
        },
      },
    })

    await flushPromises()

    const vm = wrapper.vm as unknown as {
      copyCode: () => Promise<void>
    }

    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    })

    await expect(Promise.resolve(vm.copyCode())).resolves.toBeUndefined()
  })
})
