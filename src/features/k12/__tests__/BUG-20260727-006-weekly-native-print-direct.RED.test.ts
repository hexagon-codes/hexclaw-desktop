import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import K12PersistentPrintController from '../components/K12PersistentPrintController.vue'

const h = vi.hoisted(() => ({
  prepare: vi.fn(),
  previewGetDocument: vi.fn(),
}))

vi.mock('../persistent-print', () => ({
  preparePersistentPrint: (...args: unknown[]) => h.prepare(...args),
}))
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: (...args: unknown[]) => h.previewGetDocument(...args),
}))
vi.mock('pdfjs-dist/legacy/build/pdf.worker.mjs?url', () => ({
  default: 'pdf.worker.test.mjs',
}))

const request = {
  agent: 'k12-xiaoming',
  idempotencyKey: 'weekly-print:artifact-30',
  sourceKind: 'weekly_practice_snapshot' as const,
  sourceRef: 'snapshot-30',
  title: '本周该练',
  artifactId: 'artifact-30',
  browserPrint: vi.fn(),
}

describe('BUG-20260727-006 — weekly printing goes directly to the native dialog', () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      {} as CanvasRenderingContext2D,
    )
    h.prepare.mockReset()
    h.previewGetDocument.mockReset().mockReturnValue({
      promise: new Promise(() => undefined),
      destroy: vi.fn().mockResolvedValue(undefined),
    })
  })

  afterEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('confirms the frozen artifact immediately in native-dialog mode without mounting app preview UI', async () => {
    const confirm = vi.fn().mockResolvedValue(false)
    h.prepare.mockResolvedValue({
      status: 'preview',
      title: '本周该练',
      pdf: new Blob(['%PDF-weekly'], { type: 'application/pdf' }),
      confirm,
    })
    const wrapper = mount(K12PersistentPrintController, {
      props: { mode: 'native-dialog' },
    })

    await (wrapper.vm as unknown as { open: (req: typeof request) => Promise<void> }).open(request)
    await flushPromises()

    expect(confirm).toHaveBeenCalledOnce()
    expect(wrapper.emitted('result')).toEqual([[false]])
    expect(document.body.querySelector('[data-testid="k12-print-preview"]')).toBeNull()
    wrapper.unmount()
  })

  it('projects the weekly current/history controller through the same native-dialog mode', () => {
    const recordsSource = readFileSync(
      resolve(__dirname, '../views/K12RecordsView.vue'),
      'utf8',
    )
    const controller = recordsSource.match(
      /<K12PersistentPrintController[\s\S]*?ref="weeklyPrintController"[\s\S]*?\/>/,
    )?.[0]

    expect(controller).toBeDefined()
    expect(controller).toContain('mode="native-dialog"')
  })
})
