import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import ConnectorConfigModal from '../ConnectorConfigModal.vue'
import zhCN from '@/i18n/locales/zh-CN'

// ════════════════════════════════════════════════════════════════════
// 增量3（用户层闭环）：数据连接器走 MCP。ConnectorConfigModal 的 mcp 分支保存时，
// 必须真正调 addMcpServer(name, command, args, {env})——把数据库表单字段按各包契约
// 注入 env / 连接串 arg——而不是只写 localStorage（旧行为：mcp 连接器是装饰，没真注册）。
// 现场：ConnectorConfigModal.vue handleSave() 的 currentMethod==='mcp' 分支。
// ════════════════════════════════════════════════════════════════════

const { addMcpServer, removeMcpServer } = vi.hoisted(() => ({
  addMcpServer: vi.fn(),
  removeMcpServer: vi.fn(),
}))
vi.mock('@/api/mcp', () => ({ addMcpServer, removeMcpServer }))

const { addInstance, updateInstance, removeInstance, connectorList } = vi.hoisted(() => ({
  addInstance: vi.fn(),
  updateInstance: vi.fn(),
  removeInstance: vi.fn(),
  connectorList: { value: [] as Array<{ id: string; name: string; type: string; config: Record<string, string>; enabled: boolean }> },
}))
vi.mock('@/composables/useConnectorInstances', () => ({
  useConnectorInstances: () => ({ list: connectorList, addInstance, updateInstance, removeInstance }),
}))

const { toastSuccess, toastInfo, toastError } = vi.hoisted(() => ({
  toastSuccess: vi.fn(),
  toastInfo: vi.fn(),
  toastError: vi.fn(),
}))
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ success: toastSuccess, info: toastInfo, error: toastError, warning: vi.fn() }),
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

type Method = 'native' | 'mcp' | 'oauth' | 'token'
function mountModal(
  types: Array<{ id: string; method: Method; name: string }>,
  instance: { id: string; name: string; type: string; config: Record<string, string>; enabled: boolean } | null = null,
) {
  return mount(ConnectorConfigModal, {
    props: {
      instance,
      types: types.map((t) => ({ ...t, logo: null, monogram: t.name.slice(0, 1) })),
    },
    global: { plugins: [createTestI18n()], stubs: { teleport: true } },
  })
}

async function fillInputs(wrapper: ReturnType<typeof mountModal>, values: string[]) {
  const inputs = wrapper.findAll('input')
  // inputs[0] = 实例名；其后依次为 configFields
  for (let i = 0; i < values.length; i++) {
    await inputs[i]!.setValue(values[i])
  }
}

async function clickCreate(wrapper: ReturnType<typeof mountModal>) {
  const btn = wrapper.findAll('button').find((b) => b.text() === zhCN.common.create)
  expect(btn, '应有「创建」按钮').toBeDefined()
  await btn!.trigger('click')
  await flushPromises()
}

describe('增量3 ConnectorConfigModal mcp 保存 → addMcpServer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    connectorList.value = []
    addMcpServer.mockResolvedValue({ message: 'ok' })
    removeMcpServer.mockResolvedValue({ message: 'ok' })
  })

  it('★mysql：保存调 addMcpServer(npx, @benborla29, 离散 env)，并 addInstance 带 mcp_server', async () => {
    const wrapper = mountModal([{ id: 'mysql', method: 'mcp', name: 'MySQL' }])
    // 第 1 步：点 mysql 类型卡进第 2 步
    await wrapper.find('.hc-im-type-card').trigger('click')
    await flushPromises()
    // 实例名 + host/port/user/password/database
    await fillInputs(wrapper, ['生产库', '127.0.0.1', '3306', 'root', '123456', 'dev'])
    await clickCreate(wrapper)

    expect(addMcpServer).toHaveBeenCalledTimes(1)
    const [name, command, args, opts] = addMcpServer.mock.calls[0]!
    expect(name).toBe('生产库')
    expect(command).toBe('npx')
    expect(args).toEqual(['-y', '@benborla29/mcp-server-mysql'])
    expect(opts.env).toEqual({
      MYSQL_HOST: '127.0.0.1',
      MYSQL_PORT: '3306',
      MYSQL_USER: 'root',
      MYSQL_PASS: '123456',
      MYSQL_DB: 'dev',
    })

    // 实例落库（含 mcp_server 引用，供后续 test/delete 摘除 server）
    expect(addInstance).toHaveBeenCalledTimes(1)
    const inst = addInstance.mock.calls[0]![0]
    expect(inst.type).toBe('mysql')
    expect(inst.config.mcp_server).toBe('生产库')
    expect(inst.enabled).toBe(true)
    // 暖装秒连(connected 默认/未 false) → 已就绪 toast
    expect(toastSuccess).toHaveBeenCalledWith(zhCN.connections.connectors.mcpConnected)
  })

  it('冷装：后端回 connected:false → 提示"后台连接中"，实例仍落库', async () => {
    addMcpServer.mockResolvedValue({ message: 'queued', connected: false })
    const wrapper = mountModal([{ id: 'mysql', method: 'mcp', name: 'MySQL' }])
    await wrapper.find('.hc-im-type-card').trigger('click')
    await flushPromises()
    await fillInputs(wrapper, ['生产库', '127.0.0.1', '3306', 'root', '123456', 'dev'])
    await clickCreate(wrapper)

    expect(addMcpServer).toHaveBeenCalledTimes(1)
    expect(addInstance).toHaveBeenCalledTimes(1)
    expect(toastInfo).toHaveBeenCalledWith(zhCN.connections.connectors.mcpConnecting)
    expect(toastSuccess).not.toHaveBeenCalled()
  })

  it('redis：连接串作 arg（非 env），仅密码 userinfo', async () => {
    const wrapper = mountModal([{ id: 'redis', method: 'mcp', name: 'Redis' }])
    await wrapper.find('.hc-im-type-card').trigger('click')
    await flushPromises()
    // redis 字段：host/port/password
    await fillInputs(wrapper, ['缓存', '10.0.0.5', '6379', 'p@ss'])
    await clickCreate(wrapper)

    expect(addMcpServer).toHaveBeenCalledTimes(1)
    const [, command, args, opts] = addMcpServer.mock.calls[0]!
    expect(command).toBe('npx')
    expect(args).toEqual(['-y', '@gongrzhe/server-redis-mcp', 'redis://:p%40ss@10.0.0.5:6379'])
    expect(opts.env).toEqual({})
  })

  // ── 语雀/飞书：旧为 OAuth「即将上线」占位，现走 MCP 真注册（点保存真调 addMcpServer，无占位）──
  it('★语雀：保存调 addMcpServer(yuque-mcp-server + env YUQUE_TOKEN)，不再 OAuth 占位', async () => {
    const wrapper = mountModal([{ id: 'yuque', method: 'mcp', name: '语雀' }])
    await wrapper.find('.hc-im-type-card').trigger('click')
    await flushPromises()
    // 无「授权连接」占位按钮
    expect(wrapper.findAll('button').some((b) => b.text().includes('授权'))).toBe(false)
    await fillInputs(wrapper, ['我的语雀', 'yq_token_abc'])
    await clickCreate(wrapper)
    expect(addMcpServer).toHaveBeenCalledTimes(1)
    const [name, command, args, opts] = addMcpServer.mock.calls[0]!
    expect(name).toBe('我的语雀')
    expect(command).toBe('npx')
    expect(args).toEqual(['-y', 'yuque-mcp-server'])
    expect(opts.env).toEqual({ YUQUE_TOKEN: 'yq_token_abc' })
  })

  it('★飞书：保存调 addMcpServer(@larksuiteoapi/lark-mcp mcp -a -s)', async () => {
    const wrapper = mountModal([{ id: 'feishuDoc', method: 'mcp', name: '飞书文档' }])
    await wrapper.find('.hc-im-type-card').trigger('click')
    await flushPromises()
    await fillInputs(wrapper, ['飞书', 'cli_app123', 'secret_xyz'])
    await clickCreate(wrapper)
    expect(addMcpServer).toHaveBeenCalledTimes(1)
    const [, , args] = addMcpServer.mock.calls[0]!
    expect(args).toEqual(['-y', '@larksuiteoapi/lark-mcp', 'mcp', '-a', 'cli_app123', '-s', 'secret_xyz'])
  })

  it('native(localFolder) 保存不调 addMcpServer（仍走 localStorage）', async () => {
    const wrapper = mountModal([{ id: 'localFolder', method: 'native', name: '本地文件夹' }])
    await wrapper.find('.hc-im-type-card').trigger('click')
    await flushPromises()
    await fillInputs(wrapper, ['我的文件夹', '/tmp/data'])
    await clickCreate(wrapper)

    expect(addMcpServer).not.toHaveBeenCalled()
    expect(addInstance).toHaveBeenCalledTimes(1)
  })

  it('sqlite：缺路径必填校验拦截，不调 addMcpServer', async () => {
    const wrapper = mountModal([{ id: 'sqlite', method: 'mcp', name: 'SQLite' }])
    await wrapper.find('.hc-im-type-card').trigger('click')
    await flushPromises()
    // 只填实例名，留空 path
    await fillInputs(wrapper, ['本地库'])
    await clickCreate(wrapper)
    expect(addMcpServer).not.toHaveBeenCalled()
  })

  // ── 名称唯一性（防后端 server key 撞名互相覆盖）──
  it('★重名拦截：与已有连接同名 → 不调 addMcpServer（否则后端同名 server 互相覆盖）', async () => {
    connectorList.value = [{ id: 'other', name: '生产库', type: 'mysql', config: { mcp_server: '生产库' }, enabled: true }]
    const wrapper = mountModal([{ id: 'mysql', method: 'mcp', name: 'MySQL' }])
    await wrapper.find('.hc-im-type-card').trigger('click')
    await flushPromises()
    await fillInputs(wrapper, ['生产库', '127.0.0.1', '3306', 'root', 'pw', 'db']) // 手改成与 other 同名
    await clickCreate(wrapper)
    expect(addMcpServer).not.toHaveBeenCalled()
    expect(addInstance).not.toHaveBeenCalled()
    expect(toastError).toHaveBeenCalledWith(zhCN.connections.connectors.nameExists)
  })

  // ── 编辑改名：add 先行，add 成功后才摘旧 server；add 失败不删旧（无半失败死状态）──
  it('编辑改名：先 addMcpServer(新名) 成功 → 再 removeMcpServer(旧名)', async () => {
    const inst = { id: 'i1', name: '旧名', type: 'mysql', config: { host: 'h', port: '3306', user: 'root', mcp_server: '旧名' }, enabled: true }
    const wrapper = mountModal([{ id: 'mysql', method: 'mcp', name: 'MySQL' }], inst)
    await flushPromises() // edit 模式直接进第 2 步
    const nameInput = wrapper.findAll('input')[0]!
    await nameInput.setValue('新名')
    const btn = wrapper.findAll('button').find((b) => b.text() === zhCN.common.save)
    await btn!.trigger('click')
    await flushPromises()

    expect(addMcpServer).toHaveBeenCalledTimes(1)
    expect(addMcpServer.mock.calls[0]![0]).toBe('新名')
    expect(removeMcpServer).toHaveBeenCalledWith('旧名')
    // add 调用早于 remove（add 先行）
    expect(addMcpServer.mock.invocationCallOrder[0]!).toBeLessThan(removeMcpServer.mock.invocationCallOrder[0]!)
    expect(updateInstance).toHaveBeenCalledTimes(1)
  })

  it('编辑改名 add 失败 → 不删旧 server、不 updateInstance（旧态保持一致）', async () => {
    addMcpServer.mockRejectedValueOnce(new Error('connect failed'))
    const inst = { id: 'i1', name: '旧名', type: 'mysql', config: { host: 'h', port: '3306', user: 'root', mcp_server: '旧名' }, enabled: true }
    const wrapper = mountModal([{ id: 'mysql', method: 'mcp', name: 'MySQL' }], inst)
    await flushPromises()
    await wrapper.findAll('input')[0]!.setValue('新名')
    const btn = wrapper.findAll('button').find((b) => b.text() === zhCN.common.save)
    await btn!.trigger('click')
    await flushPromises()

    expect(addMcpServer).toHaveBeenCalledTimes(1)
    expect(removeMcpServer).not.toHaveBeenCalled() // 旧 server 必须保留
    expect(updateInstance).not.toHaveBeenCalled() // 实例不被改（仍指向旧名，一致）
  })
})
