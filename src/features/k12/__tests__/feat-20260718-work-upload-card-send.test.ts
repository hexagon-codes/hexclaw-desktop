/**
 * 作品域闭环三件套（2026-07-18，架构设计-v0.5.0 §3.10/§3.12）：
 *   任务1 照片真实上传：选图即传（预览缩略 + 进度 + 失败重试），保存带 source_asset_id；
 *          美术卡片显 asset:// 缩略图；
 *   任务2 观察练习卡：art 版本的 practice_card（服务端提炼）渲染成练习卡 + 打印/发送/完成打卡；
 *   任务3 点评发送出口：durable Receipt 区分平台受理/送达；未绑定给连接设置 CTA。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import K12CreativeWorksPanel from '../views/K12CreativeWorksPanel.vue'
import type { CreativeWorkDTO } from '@/api/k12'

const h = vi.hoisted(() => ({
  listSpy: vi.fn(),
  createSpy: vi.fn(),
  uploadSpy: vi.fn(),
  sendSpy: vi.fn(),
  retryDeliverySpy: vi.fn(),
  queryDeliverySpy: vi.fn(),
  cardDoneSpy: vi.fn(),
  printSpy: vi.fn(),
  savePdfSpy: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
}))
vi.mock('@/api/k12', () => ({
  k12ListCreativeWorks: (agent: string, type?: string) => h.listSpy(agent, type),
  k12CreateCreativeWork: (req: unknown) => h.createSpy(req),
  k12AttachWorkFeedback: vi.fn(),
  k12SubmitWorkRevision: vi.fn(),
  k12ArchiveCreativeWork: vi.fn(),
  k12AddAccumulation: vi.fn(),
  k12RecordMistake: vi.fn(),
  k12UploadAsset: (a: string, f: File, p?: (n: number) => void) => h.uploadSpy(a, f, p),
  k12AssetURL: (agent: string, id: string) =>
    id.startsWith('asset://')
      ? `http://test/api/k12/assets/${id.slice(id.lastIndexOf('/') + 1)}?agent=${agent}`
      : '',
  k12SendWorkFeedback: (a: string, id: string, kind?: string) => h.sendSpy(a, id, kind),
  k12RetryDeliveryReceipt: (a: string, id: string) => h.retryDeliverySpy(a, id),
  k12QueryDeliveryReceipt: (a: string, id: string) => h.queryDeliverySpy(a, id),
  k12MarkPracticeCardDone: (a: string, id: string) => h.cardDoneSpy(a, id),
}))
vi.mock('../export', () => ({
  printPracticePaper: (md: string, title: string) => h.printSpy(md, title),
  savePracticePaperPdf: (md: string, title: string) => h.savePdfSpy(md, title),
}))
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ success: h.toastSuccess, error: h.toastError, info: h.toastInfo }),
}))

function i18n() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    messages: { 'zh-CN': { ...zhCN, k12: k12Zh } },
  })
}

function artWork(over: Partial<CreativeWorkDTO> = {}): CreativeWorkDTO {
  return {
    record_id: 'w-art',
    work_type: 'art',
    title: '雨后的校园',
    task: '写生',
    status: 'feedback_ready',
    status_label: '已点评',
    versions: [
      {
        version_id: 'v1',
        source_asset_id: 'asset://k12-xiaoming/deadbeef.png',
        feedback: '画面主体清楚。\n## 建议\n- 试试只用三档明暗再画一张小稿。',
        practice_card: '- 试试只用三档明暗再画一张小稿。',
      },
    ],
    ...over,
  }
}

function delivery(status: 'sending' | 'delivered' | 'failed' | 'outcome_unknown' = 'sending') {
  return {
    delivery_id: 'delivery-work-1',
    agent_name: 'k12-xiaoming',
    object_kind: 'creative_work_feedback',
    object_id: 'w-art',
    binding_id: 'agent-rule:1',
    target: { platform: 'dingtalk', chat_id: 'staff-1', label: '钉钉 · 妈妈' },
    status,
    dedupe_key: 'd1',
    payload_digest: 'sha256:x',
    payload_json: '{}',
    render_manifest_json: '{}',
    external_message_id: 'pqk-1',
    attempt: 1,
    created_at: 1,
    updated_at: 1,
  }
}

function render() {
  return mount(K12CreativeWorksPanel, {
    props: { agentId: 'k12-xiaoming' },
    global: { plugins: [i18n()] },
  })
}

beforeEach(() => {
  h.listSpy.mockReset().mockResolvedValue({ items: [] })
  h.createSpy.mockReset().mockResolvedValue({ record_id: 'w-new', created: true })
  h.uploadSpy
    .mockReset()
    .mockResolvedValue({ asset_id: 'asset://k12-xiaoming/abc123.png', size: 3 })
  h.sendSpy.mockReset().mockResolvedValue(delivery())
  h.retryDeliverySpy.mockReset().mockResolvedValue(delivery())
  h.queryDeliverySpy.mockReset().mockResolvedValue(delivery('delivered'))
  h.cardDoneSpy.mockReset().mockResolvedValue(artWork())
  h.printSpy.mockReset().mockResolvedValue(true)
  h.savePdfSpy.mockReset().mockResolvedValue(true)
  h.toastSuccess.mockReset()
  h.toastError.mockReset()
  h.toastInfo.mockReset()
  vi.stubGlobal(
    'URL',
    Object.assign(URL, {
      createObjectURL: vi.fn(() => 'blob:preview'),
      revokeObjectURL: vi.fn(),
    }),
  )
})

async function pickPhoto(w: ReturnType<typeof render>, file: File) {
  const input = w.find('[data-testid="cw-add-photo-input"]').element as HTMLInputElement
  Object.defineProperty(input, 'files', { value: [file], configurable: true })
  await w.find('[data-testid="cw-add-photo-input"]').trigger('change')
  await flushPromises()
}

describe('任务1 · 照片真实上传', () => {
  it('选图即传：预览 + 上传成功态；保存作品带 source_asset_id', async () => {
    const w = render()
    await flushPromises()
    await w.find('[data-testid="cw-add-open"]').trigger('click')
    await w.find('[data-testid="cw-add-type-art"]').trigger('click')

    const file = new File([new Uint8Array([1, 2, 3])], '画.png', { type: 'image/png' })
    await pickPhoto(w, file)
    expect(h.uploadSpy).toHaveBeenCalledWith('k12-xiaoming', file, expect.any(Function))
    expect(w.find('[data-testid="cw-photo-preview"]').exists()).toBe(true)
    expect(w.find('[data-testid="cw-photo-ok"]').exists()).toBe(true)

    await w.find('[data-testid="cw-add-title"]').setValue('《雨后的校园》')
    await w.find('[data-testid="cw-add-task"]').setValue('水彩写生')
    await w.find('[data-testid="cw-add-submit"]').trigger('click')
    await flushPromises()
    expect(h.createSpy).toHaveBeenCalledWith(
      expect.objectContaining({ source_asset_id: 'asset://k12-xiaoming/abc123.png' }),
    )
  })

  it('上传失败：错误提示 + 重试按钮；重试成功后可保存', async () => {
    h.uploadSpy.mockRejectedValueOnce(new Error('只接受图片文件'))
    const w = render()
    await flushPromises()
    await w.find('[data-testid="cw-add-open"]').trigger('click')
    await pickPhoto(w, new File([new Uint8Array([9])], 'x.png', { type: 'image/png' }))
    expect(w.find('[data-testid="cw-photo-error"]').text()).toContain('只接受图片文件')

    await w.find('[data-testid="cw-photo-retry"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="cw-photo-ok"]').exists()).toBe(true)
  })

  it('非图片 / 超 10MB 在前端即拦（不发请求）', async () => {
    const w = render()
    await flushPromises()
    await w.find('[data-testid="cw-add-open"]').trigger('click')
    await pickPhoto(w, new File(['x'], 'x.txt', { type: 'text/plain' }))
    expect(h.uploadSpy).not.toHaveBeenCalled()
    expect(h.toastError).toHaveBeenCalled()
  })

  it('美术作品卡片显 asset:// 缩略图', async () => {
    h.listSpy.mockResolvedValue({ items: [artWork()] })
    const w = render()
    await flushPromises()
    const img = w.find('[data-testid="cw-thumb"]')
    expect(img.exists()).toBe(true)
    expect(img.attributes('src')).toContain('/api/k12/assets/deadbeef.png')
    expect(img.attributes('src')).toContain('agent=k12-xiaoming')
  })
})

describe('任务2 · 观察练习卡（§3.10：练习必须有产物，承诺即动作）', () => {
  it('art 已点评 → 渲染练习卡 + 打印/发送/完成打卡三动作', async () => {
    h.listSpy.mockResolvedValue({ items: [artWork()] })
    const w = render()
    await flushPromises()
    const card = w.find('[data-testid="cw-practice-card"]')
    expect(card.exists()).toBe(true)
    expect(card.text()).toContain('观察小练习')
    expect(card.text()).toContain('三档明暗')
    expect(w.find('[data-testid="cw-card-print"]').exists()).toBe(true)
    expect(w.find('[data-testid="cw-card-send"]').exists()).toBe(true)
    expect(w.find('[data-testid="cw-card-done"]').exists()).toBe(true)
  })

  it('写作作品不渲染练习卡（观察练习卡只属于美术）', async () => {
    h.listSpy.mockResolvedValue({
      items: [
        artWork({
          record_id: 'w-wr',
          work_type: 'writing',
          versions: [{ version_id: 'v1', feedback: '好' }],
        }),
      ],
    })
    const w = render()
    await flushPromises()
    expect(w.find('[data-testid="cw-practice-card"]').exists()).toBe(false)
  })

  it('打印走 printPracticePaper；完成打卡调 done 端点；已打卡显完成态且不再显按钮', async () => {
    h.listSpy.mockResolvedValue({ items: [artWork()] })
    const w = render()
    await flushPromises()
    await w.find('[data-testid="cw-card-print"]').trigger('click')
    expect(h.printSpy).toHaveBeenCalledWith(
      expect.stringContaining('三档明暗'),
      expect.stringContaining('雨后的校园'),
    )

    await w.find('[data-testid="cw-card-done"]').trigger('click')
    await flushPromises()
    expect(h.cardDoneSpy).toHaveBeenCalledWith('k12-xiaoming', 'w-art')

    // 已打卡：done_at 存在 → 完成态 + 无打卡按钮
    const done = artWork()
    done.versions[0]!.practice_card_done_at = 1752800000
    h.listSpy.mockResolvedValue({ items: [done] })
    const w2 = render()
    await flushPromises()
    expect(w2.find('[data-testid="cw-card-done-state"]').exists()).toBe(true)
    expect(w2.find('[data-testid="cw-card-done"]').exists()).toBe(false)
  })

  it('观察练习卡另存 PDF 与打印分轨', async () => {
    h.listSpy.mockResolvedValue({ items: [artWork()] })
    const w = render()
    await flushPromises()

    await w.find('[data-testid="cw-card-save-pdf"]').trigger('click')
    await flushPromises()

    expect(h.savePdfSpy).toHaveBeenCalledWith(
      expect.stringContaining('三档明暗'),
      expect.stringContaining('雨后的校园'),
    )
    expect(h.printSpy).not.toHaveBeenCalled()
  })

  it('练习卡「发送到手机」以 practice_card 类别走发送端点', async () => {
    h.listSpy.mockResolvedValue({ items: [artWork()] })
    const w = render()
    await flushPromises()
    await w.find('[data-testid="cw-card-send"]').trigger('click')
    await flushPromises()
    expect(h.sendSpy).toHaveBeenCalledWith('k12-xiaoming', 'w-art', 'practice_card')
  })
})

describe('任务3 · 点评发送出口（DD-024 durable Receipt）', () => {
  it('平台受理只显示发送中；查询送达证据后才成功', async () => {
    h.listSpy.mockResolvedValue({ items: [artWork()] })
    const w = render()
    await flushPromises()
    await w.find('[data-testid="cw-send-feedback"]').trigger('click')
    await flushPromises()
    expect(h.sendSpy).toHaveBeenCalledWith('k12-xiaoming', 'w-art', 'feedback')
    expect(h.toastSuccess).not.toHaveBeenCalled()
    expect(w.get('[data-testid="cw-feedback-delivery-receipt"]').text()).toContain('等待送达确认')
    await w.get('[data-testid="cw-feedback-delivery-query"]').trigger('click')
    await flushPromises()
    expect(h.queryDeliverySpy).toHaveBeenCalledWith('k12-xiaoming', 'delivery-work-1')
    expect(h.toastSuccess).toHaveBeenCalledWith(expect.stringContaining('已送达'))
  })

  it('未绑定：不复制文本冒充发送，并给连接设置 CTA', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', Object.assign(navigator, { clipboard: { writeText } }))
    h.sendSpy.mockRejectedValue(new Error('这个辅导助手还没绑定手机私聊'))
    h.listSpy.mockResolvedValue({ items: [artWork()] })
    const w = render()
    await flushPromises()
    await w.find('[data-testid="cw-send-feedback"]').trigger('click')
    await flushPromises()
    expect(writeText).not.toHaveBeenCalled()
    expect(h.toastSuccess).not.toHaveBeenCalled()
    expect(h.toastError).toHaveBeenCalledWith(expect.stringContaining('还没绑定手机私聊'))
    expect(w.get('[data-testid="cw-feedback-bind-required"] a').attributes('href')).toBe(
      '/channels',
    )
  })

  it('明确 failed 才显示安全重试，并复用同一个 delivery_id', async () => {
    h.sendSpy.mockResolvedValue({ ...delivery('failed'), last_error: '平台明确拒绝' })
    h.retryDeliverySpy.mockResolvedValue(delivery('sending'))
    h.listSpy.mockResolvedValue({ items: [artWork()] })
    const w = render()
    await flushPromises()
    await w.get('[data-testid="cw-send-feedback"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="cw-feedback-delivery-retry"]').exists()).toBe(true)
    await w.get('[data-testid="cw-feedback-delivery-retry"]').trigger('click')
    await flushPromises()
    expect(h.retryDeliverySpy).toHaveBeenCalledWith('k12-xiaoming', 'delivery-work-1')
    expect(w.find('[data-testid="cw-feedback-delivery-retry"]').exists()).toBe(false)
  })

  it('outcome_unknown 只提供查询，不提供重发', async () => {
    h.sendSpy.mockResolvedValue(delivery('outcome_unknown'))
    h.listSpy.mockResolvedValue({ items: [artWork()] })
    const w = render()
    await flushPromises()
    await w.get('[data-testid="cw-send-feedback"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="cw-feedback-delivery-retry"]').exists()).toBe(false)
    expect(w.find('[data-testid="cw-feedback-delivery-query"]').exists()).toBe(true)
  })
})
