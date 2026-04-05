import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'

const canvasStore = vi.hoisted(() => ({
  nodes: [{ id: 'node-1', type: 'agent', label: 'Agent', x: 10, y: 20, config: {} }],
  edges: [],
  panels: [],
  savedWorkflows: [],
  loading: false,
  runStatus: 'idle',
  runResult: null,
  runOutput: '',
  nodeRunStatus: {},
  loadPanels: vi.fn(),
  loadWorkflows: vi.fn(),
  addNode: vi.fn(),
  removeNode: vi.fn(),
  clearCanvas: vi.fn(),
  updateNode: vi.fn(),
  addEdge: vi.fn(),
  removeEdge: vi.fn(),
  loadPanel: vi.fn(),
  saveWorkflow: vi.fn(),
  loadWorkflowToCanvas: vi.fn(),
  deleteWorkflow: vi.fn(),
  validateWorkflow: vi.fn(() => []),
  runWorkflow: vi.fn(),
}))

vi.mock('@/stores/canvas', () => ({
  useCanvasStore: () => canvasStore,
}))

vi.mock('lucide-vue-next', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  const stub = { template: '<span />' }
  const mocked: Record<string, unknown> = {}
  for (const key of Object.keys(original)) mocked[key] = stub
  return mocked
})

function createTestI18n() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': zhCN, zh: zhCN },
  })
}

async function mountView() {
  const CanvasView = (await import('../CanvasView.vue')).default
  return mount(CanvasView, {
    global: {
      plugins: [createTestI18n()],
      stubs: {
        PageHeader: { template: '<div><slot name="actions" /></div>' },
        TemplateGallery: { template: '<div />' },
        teleport: true,
        transition: false,
      },
    },
  })
}

describe('CanvasView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    canvasStore.nodes = [{ id: 'node-1', type: 'agent', label: 'Agent', x: 10, y: 20, config: {} }]
    canvasStore.edges = []
    canvasStore.panels = []
    canvasStore.savedWorkflows = []
    canvasStore.loading = false
    canvasStore.runStatus = 'idle'
    canvasStore.runResult = null
    canvasStore.runOutput = ''
    canvasStore.nodeRunStatus = {}
    canvasStore.validateWorkflow.mockReturnValue([])
  })

  it('does not start a second save request while the first workflow save is still running', async () => {
    let resolveSave!: () => void
    canvasStore.saveWorkflow.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveSave = resolve
        }),
    )

    const wrapper = await mountView()
    await flushPromises()

    const vm = wrapper.vm as unknown as {
      showSaveDialog: boolean
      saveName: string
      saveDescription: string
      handleSave: () => Promise<void>
    }

    vm.showSaveDialog = true
    vm.saveName = 'Flow A'
    vm.saveDescription = 'desc'

    void vm.handleSave()
    await flushPromises()
    void vm.handleSave()
    await flushPromises()

    expect(canvasStore.saveWorkflow).toHaveBeenCalledTimes(1)

    resolveSave()
    await flushPromises()
  })

  it('does not start a second run request while the first workflow run is still running', async () => {
    let resolveRun!: () => void
    canvasStore.runWorkflow.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveRun = resolve
        }),
    )

    const wrapper = await mountView()
    await flushPromises()

    const vm = wrapper.vm as unknown as {
      handleRun: () => Promise<void>
    }

    void vm.handleRun()
    await flushPromises()
    void vm.handleRun()
    await flushPromises()

    expect(canvasStore.runWorkflow).toHaveBeenCalledTimes(1)

    resolveRun()
    await flushPromises()
  })
})
