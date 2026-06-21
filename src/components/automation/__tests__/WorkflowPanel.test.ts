import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import WorkflowPanel from '../WorkflowPanel.vue'

const saveWorkflowMock = vi.fn()
const getWorkflowsMock = vi.fn()
const runWorkflowMock = vi.fn()
const getWorkflowRunMock = vi.fn()
const deleteWorkflowMock = vi.fn()

vi.mock('@/api/canvas', () => ({
  listPanels: vi.fn(),
  getPanel: vi.fn(),
  sendCanvasEvent: vi.fn(),
  saveWorkflow: (...a: unknown[]) => saveWorkflowMock(...a),
  getWorkflows: (...a: unknown[]) => getWorkflowsMock(...a),
  deleteWorkflow: (...a: unknown[]) => deleteWorkflowMock(...a),
  runWorkflow: (...a: unknown[]) => runWorkflowMock(...a),
  getWorkflowRun: (...a: unknown[]) => getWorkflowRunMock(...a),
}))

vi.mock('lucide-vue-next', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  const stub = { template: '<span />' }
  const mocked: Record<string, unknown> = {}
  for (const key of Object.keys(original)) mocked[key] = stub
  return mocked
})

function createTestI18n() {
  return createI18n({ legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN', messages: { 'zh-CN': zhCN, zh: zhCN } })
}

async function mountPanel() {
  const wrapper = mount(WorkflowPanel, {
    global: { plugins: [createTestI18n()], stubs: { teleport: true, transition: false } },
  })
  await flushPromises()
  return wrapper
}

describe('WorkflowPanel — 线性工作流真实编辑器', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    getWorkflowsMock.mockResolvedValue([])
    saveWorkflowMock.mockResolvedValue({ id: 'wf-1', name: '新工作流' })
    runWorkflowMock.mockResolvedValue({
      id: 'run-1', status: 'completed', output: '跑通了',
      node_results: [{ node_id: 'n1', type: 'agent', status: 'completed' }],
    })
  })

  it('空态：无工作流时展示空状态 + 新建按钮', async () => {
    const wrapper = await mountPanel()
    expect(wrapper.text()).toContain('暂无工作流')
    expect(wrapper.text()).toContain('新建工作流')
  })

  it('createWorkflow 注入 触发→模型→输出 三步起步模板', async () => {
    const wrapper = await mountPanel()
    ;(wrapper.vm as unknown as { createWorkflow: () => void }).createWorkflow()
    await flushPromises()
    // 3 个线性节点 + 2 条线性连接边
    expect(wrapper.findAll('.wf-node')).toHaveLength(3)
    expect(wrapper.findAll('.wf-link')).toHaveLength(3) // 2 节点间 + 1 尾部到「添加步骤」
    expect(wrapper.text()).toContain('触发 / 输入')
    expect(wrapper.text()).toContain('透传最终输出') // output 节点摘要
  })

  it('添加步骤：点「添加步骤」→ 选「工具」追加一个节点', async () => {
    const wrapper = await mountPanel()
    ;(wrapper.vm as unknown as { createWorkflow: () => void }).createWorkflow()
    await flushPromises()
    expect(wrapper.findAll('.wf-node')).toHaveLength(3)

    await wrapper.find('.wf-add').trigger('click')
    const toolBtn = wrapper.findAll('.wf-addmenu button').find((b) => b.text().includes('工具'))
    expect(toolBtn).toBeTruthy()
    await toolBtn!.trigger('click')
    expect(wrapper.findAll('.wf-node')).toHaveLength(4)
  })

  it('保存：点「保存」调用后端 saveWorkflow（含线性边）', async () => {
    const wrapper = await mountPanel()
    ;(wrapper.vm as unknown as { createWorkflow: () => void }).createWorkflow()
    await flushPromises()
    const saveBtn = wrapper.findAll('button').find((b) => b.text().trim() === '保存')
    await saveBtn!.trigger('click')
    await flushPromises()
    expect(saveWorkflowMock).toHaveBeenCalledTimes(1)
    const arg = saveWorkflowMock.mock.calls[0]![0] as { nodes: unknown[]; edges: unknown[] }
    expect(arg.nodes).toHaveLength(3)
    expect(arg.edges).toHaveLength(2) // 线性链 input→agent→output
  })

  it('试运行：点「试运行」先保存再调 runWorkflow，回填运行结果', async () => {
    const wrapper = await mountPanel()
    ;(wrapper.vm as unknown as { createWorkflow: () => void }).createWorkflow()
    await flushPromises()
    const runBtn = wrapper.findAll('button').find((b) => b.text().includes('试运行'))
    await runBtn!.trigger('click')
    await flushPromises()
    expect(runWorkflowMock).toHaveBeenCalledTimes(1)
    // 运行结果面板出现
    expect(wrapper.text()).toContain('跑通了')
  })

  it('删除步骤：移除一个节点后重建线性边', async () => {
    const wrapper = await mountPanel()
    ;(wrapper.vm as unknown as { createWorkflow: () => void }).createWorkflow()
    await flushPromises()
    const delBtns = wrapper.findAll('.wf-op--danger')
    expect(delBtns.length).toBe(3)
    await delBtns[1]!.trigger('click')
    expect(wrapper.findAll('.wf-node')).toHaveLength(2)
  })
})
