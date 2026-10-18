import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { createRouter, createMemoryHistory } from 'vue-router'
import zhCN from '@/i18n/locales/zh-CN'
import WorkflowPanel from '../WorkflowPanel.vue'
import { useCanvasStore } from '@/stores/canvas'
import HcSelect from '@/components/common/HcSelect.vue'

const saveWorkflowMock = vi.fn()
const getWorkflowsMock = vi.fn()
const runWorkflowMock = vi.fn()
const getWorkflowRunMock = vi.fn()
const deleteWorkflowMock = vi.fn()


// 自动化权限治理 API：组件挂载即静默预检/总览，测试里一律 mock 成全绿空态。
vi.mock('@/api/autonomy', () => ({
  preflightAutonomy: vi.fn().mockResolvedValue({
    source: 'workflow', profile: 'function_first',
    capabilities: [], estimated: [], needs_decision: [], all_clear: true,
  }),
  createAutonomyGrant: vi.fn().mockResolvedValue({ grant: { id: 'g-1' } }),
  getAutonomySummary: vi.fn().mockResolvedValue({
    profile: 'function_first',
    counts: { tasks: 0, ready: 0, pending: 0, grants: 0 },
    pending: [], tasks: [],
  }),
  listAutonomyDecisions: vi.fn().mockResolvedValue({ decisions: [], total: 0 }),
  listAutonomyGrants: vi.fn().mockResolvedValue({ grants: [], total: 0 }),
  revokeAutonomyGrant: vi.fn().mockResolvedValue({ message: 'ok' }),
  getAutonomyProfile: vi.fn().mockResolvedValue({
    profile: 'function_first', profiles: [],
    matrix: { profile: 'function_first', categories: [], rows: [] },
  }),
  updateAutonomyProfile: vi.fn(),
}))

vi.mock('@/api/canvas', () => ({
  listPanels: vi.fn(),
  getPanel: vi.fn(),
  sendCanvasEvent: vi.fn(),
  saveWorkflow: (...a: unknown[]) => saveWorkflowMock(...a),
  getWorkflows: (...a: unknown[]) => getWorkflowsMock(...a),
  deleteWorkflow: (...a: unknown[]) => deleteWorkflowMock(...a),
  runWorkflow: (...a: unknown[]) => runWorkflowMock(...a),
  getWorkflowRun: (...a: unknown[]) => getWorkflowRunMock(...a),
  getWorkflowRuns: vi.fn().mockResolvedValue({ runs: [], total: 0 }),
  getWorkflowTriggers: vi.fn().mockResolvedValue({ triggers: [] }),
}))

vi.mock('@/api/agents', () => ({ getAgents: vi.fn().mockResolvedValue({ agents: [], default: '' }) }))
vi.mock('@/api/mcp', () => ({ getMcpTools: vi.fn().mockResolvedValue({ tools: [{ name: 'read-marker', description: 'Read marker' }] }) }))
vi.mock('@/api/skills', () => ({ getSkills: vi.fn().mockResolvedValue({ skills: [] }) }))
vi.mock('@/api/prompts', () => ({ getPrompts: vi.fn().mockResolvedValue({ prompts: [] }) }))
vi.mock('@/api/knowledge', () => ({ getDocuments: vi.fn().mockResolvedValue({ documents: [] }) }))

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

async function mountPanel(path = '/automation/workflows/editor') {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/automation/workflows/:page?', component: { template: '<div />' } }],
  })
  await router.push(path)
  await router.isReady()
  const wrapper = mount(WorkflowPanel, {
    global: { plugins: [createTestI18n(), router], stubs: { teleport: true, transition: false } },
  })
  await flushPromises()
  return wrapper
}

describe('WorkflowPanel — 线性工作流真实编辑器', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    getWorkflowsMock.mockResolvedValue([])
    saveWorkflowMock.mockImplementation(async (workflow) => ({ ...workflow, id: 'wf-1' }))
    runWorkflowMock.mockResolvedValue({
      id: 'run-1', workflow_id: 'wf-1', status: 'completed', output: '跑通了',
      node_results: [{ node_id: 'n1', type: 'agent', status: 'completed' }],
    })
  })

  it('空态：无工作流时展示空状态且不注入本地工作流', async () => {
    const wrapper = await mountPanel('/automation/workflows')
    expect(wrapper.text()).toContain('暂无工作流')
    expect(useCanvasStore().savedWorkflows).toHaveLength(0)
  })

  it('createWorkflow 注入 触发→模型→输出 三步起步模板', async () => {
    const wrapper = await mountPanel()
    ;(wrapper.vm as unknown as { createWorkflow: () => void }).createWorkflow()
    await flushPromises()
    // 3 个线性节点 + 2 条线性连接边
    expect(wrapper.findAll('.wf-node')).toHaveLength(3)
    expect(wrapper.findAll('.wf-link')).toHaveLength(2)
    expect(wrapper.text()).toContain('输入')
    expect(wrapper.text()).toContain('透传最终输出') // output 节点摘要
  })

  it('添加步骤：配置工具后保存追加一个节点', async () => {
    const wrapper = await mountPanel()
    ;(wrapper.vm as unknown as { createWorkflow: () => void }).createWorkflow()
    await flushPromises()
    expect(wrapper.findAll('.wf-node')).toHaveLength(3)

    await wrapper.find('.wf-add').trigger('click')
    const typeSelect = wrapper.findAllComponents(HcSelect).find((select) => select.props('ariaLabel') === '处理方式')
    expect(typeSelect).toBeTruthy()
    typeSelect!.vm.$emit('update:modelValue', 'tool')
    await flushPromises()
    const toolSelect = wrapper.findAllComponents(HcSelect).find((select) => select.props('options').some((option) => option.value === 'read-marker'))
    expect(toolSelect).toBeTruthy()
    toolSelect!.vm.$emit('update:modelValue', 'read-marker')
    await flushPromises()
    await wrapper.find('.wfp-panel__foot .hc-btn-primary').trigger('click')
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

  it('试运行：先配置模型指令，点「试运行」先保存再调 runWorkflow，回填运行结果', async () => {
    const wrapper = await mountPanel()
    ;(wrapper.vm as unknown as { createWorkflow: () => void }).createWorkflow()
    await flushPromises()
    // BUG-20260623: 默认模型步骤"未配置指令"，需先填指令才允许试运行 → 先给模型步骤配置 prompt
    const store = useCanvasStore()
    const agent = store.nodes.find((n) => n.type === 'agent')!
    store.updateNode(agent.id, { config: { prompt: '总结输入' } })
    // 输入模板需要用户填写本次试运行输入，不能以一次空点击替代运行。
    await flushPromises()
    const runBtn = wrapper.findAll('button').find((b) => b.text().includes('试运行'))
    await runBtn!.trigger('click')
    await flushPromises()
    const input = wrapper.find('#workflow-run-input')
    await input.setValue('测试输入')
    await wrapper.findAll('button').find((button) => button.text().trim() === '开始运行')!.trigger('click')
    await flushPromises()
    expect(runWorkflowMock).toHaveBeenCalledTimes(1)
    // 运行结果面板出现
    expect(wrapper.text()).toContain('跑通了')
  })

  it('BUG-20260623 默认（模型未配置指令）工作流点「试运行」不提交后端执行', async () => {
    const wrapper = await mountPanel()
    ;(wrapper.vm as unknown as { createWorkflow: () => void }).createWorkflow()
    await flushPromises()
    // 不配置任何指令，直接点试运行 —— 模型步骤"未配置指令"应被拦截，不调后端
    const runBtn = wrapper.findAll('button').find((b) => b.text().includes('试运行'))
    await runBtn!.trigger('click')
    await flushPromises()
    expect(runWorkflowMock).not.toHaveBeenCalled()
    expect(saveWorkflowMock).not.toHaveBeenCalled()
  })

  it('删除步骤：移除一个节点后重建线性边', async () => {
    const wrapper = await mountPanel()
    ;(wrapper.vm as unknown as { createWorkflow: () => void }).createWorkflow()
    await flushPromises()
    const delBtns = wrapper.findAll('.wf-op--danger')
    expect(delBtns.length).toBe(1)
    await delBtns[0]!.trigger('click')
    expect(wrapper.findAll('.wf-node')).toHaveLength(2)
  })
})
