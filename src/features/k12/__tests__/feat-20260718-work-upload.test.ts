/**
 * 作品照片上传契约（2026-07-18）：
 * 选图即传（预览缩略 + 进度 + 失败重试），保存带 source_asset_id；
 * 美术卡片显 asset:// 缩略图。
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
  generateFeedbackSpy: vi.fn(),
  deleteWorkSpy: vi.fn(),
  sendWorkSpy: vi.fn(),
  getDeliveryBatchSpy: vi.fn(),
  queryDeliveryBatchSpy: vi.fn(),
  retryDeliveryBatchSpy: vi.fn(),
  uploadSpy: vi.fn(),
  createImageTaskSpy: vi.fn(),
  getImageTaskSpy: vi.fn(),
  confirmImageTaskSpy: vi.fn(),
  retryImageTaskSpy: vi.fn(),
  cancelImageTaskSpy: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}))
vi.mock('@/api/k12', () => ({
  k12ListCreativeWorks: (agent: string, type?: string) => h.listSpy(agent, type),
  k12CreateCreativeWork: (req: unknown) => h.createSpy(req),
  k12GenerateWorkFeedback: (...args: unknown[]) => h.generateFeedbackSpy(...args),
  k12DeleteCreativeWork: (...args: unknown[]) => h.deleteWorkSpy(...args),
  k12SendCreativeWork: (...args: unknown[]) => h.sendWorkSpy(...args),
  k12GetDeliveryBatch: (...args: unknown[]) => h.getDeliveryBatchSpy(...args),
  k12QueryDeliveryBatch: (...args: unknown[]) => h.queryDeliveryBatchSpy(...args),
  k12RetryDeliveryBatch: (...args: unknown[]) => h.retryDeliveryBatchSpy(...args),
  k12UploadAsset: (a: string, f: File, p?: (n: number) => void, signal?: AbortSignal) =>
    h.uploadSpy(a, f, p, signal),
  k12CreateImageTask: (req: unknown) => h.createImageTaskSpy(req),
  k12GetImageTask: (agent: string, dispatchId: string) => h.getImageTaskSpy(agent, dispatchId),
  k12ConfirmImageTask: (dispatchId: string, req: unknown) => h.confirmImageTaskSpy(dispatchId, req),
  k12RetryImageTask: (dispatchId: string, req: unknown) => h.retryImageTaskSpy(dispatchId, req),
  k12CancelImageTask: (dispatchId: string, req: unknown) => h.cancelImageTaskSpy(dispatchId, req),
  k12AssetURL: (agent: string, id: string) =>
    id.startsWith('asset://')
      ? `http://test/api/k12/assets/${id.slice(id.lastIndexOf('/') + 1)}?agent=${agent}`
      : '',
}))
vi.mock('@/api/desktop', () => ({
  setClipboard: vi.fn(),
}))
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ success: h.toastSuccess, error: h.toastError }),
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
    work_id: 'w-art',
    work_type: 'art',
    display_name: '《雨后的校园》',
    work_title: '《雨后的校园》',
    source_asset_id: 'asset://k12-xiaoming/deadbeef.png',
    row_version: 1,
    created_at: 1,
    latest_generation_at: 1,
    initial_feedback: {
      generation_id: 'generation-art',
      status: 'succeeded',
      feedback: {
        feedback_id: 'feedback-art',
        feedback_type: 'art',
        evidence_refs: ['asset:deadbeef'],
        visible_evidence: ['画面主体清楚'],
        affirmation: '主体很明确。',
        parent_guidance: '可以问孩子最喜欢哪个颜色。',
        next_step: '下次只试三档明暗。',
        source_snapshot: {
          source: 'ai',
          method_ref: 'art-feedback@1',
          capability: 'creative_work_feedback',
        },
      },
    },
    ...over,
  }
}

function render() {
  return mount(K12CreativeWorksPanel, {
    props: { agentId: 'k12-xiaoming' },
    // 交互测试保留逻辑树，几何/真实 Teleport 由专门的弹窗与浏览器用例覆盖。
    global: { plugins: [i18n()], stubs: { teleport: true } },
  })
}

function artDispatch(status: 'ready' | 'promoted', version = 1) {
  return {
    dispatch_id: 'dispatch-art-new',
    task_intent: 'artwork',
    status: 'routed',
    intent_evidence: ['parent_selected'],
    intent_confidence: 1,
    confirmation_candidates: [],
    target: { type: 'creative_work_intake', id: 'intake-art-new' },
    target_projection: {
      kind: 'creative',
      intake_id: 'intake-art-new',
      work_type: 'art',
      status,
      entry_kind: 'new_work',
      promotion_policy: 'explicit_commit',
      commit_required: status !== 'promoted',
      commit_state: status === 'promoted' ? 'committed' : 'pending',
      ...(status === 'promoted' ? { work: { work_id: 'w-new', display_name: '美术作品' } } : {}),
    },
    progress: { operation: 'promotion', state: status },
    version,
    created_at: 1,
    updated_at: 2,
  }
}

beforeEach(() => {
  h.listSpy.mockReset().mockResolvedValue({ items: [] })
  h.createSpy.mockReset().mockResolvedValue({
    work_id: 'w-new',
    created: true,
    initial_feedback_generation_id: 'generation-new',
  })
  h.generateFeedbackSpy.mockReset()
  h.deleteWorkSpy.mockReset()
  h.sendWorkSpy.mockReset()
  h.getDeliveryBatchSpy.mockReset()
  h.queryDeliveryBatchSpy.mockReset()
  h.retryDeliveryBatchSpy.mockReset()
  h.uploadSpy
    .mockReset()
    .mockResolvedValue({ asset_id: 'asset://k12-xiaoming/abc123.png', size: 3 })
  h.createImageTaskSpy.mockReset().mockResolvedValue({
    created: true,
    dispatch: artDispatch('ready'),
  })
  h.getImageTaskSpy.mockReset().mockResolvedValue({ dispatch: artDispatch('ready') })
  h.confirmImageTaskSpy.mockReset().mockResolvedValue({ dispatch: artDispatch('promoted', 2) })
  h.retryImageTaskSpy.mockReset().mockResolvedValue({ dispatch: artDispatch('ready', 2) })
  h.cancelImageTaskSpy.mockReset().mockResolvedValue({
    dispatch: { ...artDispatch('ready', 2), status: 'cancelled' },
  })
  h.toastSuccess.mockReset()
  h.toastError.mockReset()
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
  it('选图即传：预览 + 上传成功态；美术 ready 后以 new_work dispatch 单独 commit', async () => {
    const w = render()
    await flushPromises()
    await w.find('[data-testid="cw-add-open"]').trigger('click')
    await w.find('[data-testid="cw-add-type-art"]').trigger('click')

    const file = new File([new Uint8Array([1, 2, 3])], '画.png', { type: 'image/png' })
    await pickPhoto(w, file)
    expect(h.uploadSpy).toHaveBeenCalledWith(
      'k12-xiaoming',
      file,
      expect.any(Function),
      expect.any(AbortSignal),
    )
    expect(w.find('[data-testid="cw-photo-preview"]').exists()).toBe(true)
    expect(w.find('[data-testid="cw-photo-ok"]').exists()).toBe(true)
    expect(h.createImageTaskSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'k12-xiaoming',
        source_session: 'creative-works:k12-xiaoming',
        source_kind: 'desktop',
        source_asset_refs: ['asset://k12-xiaoming/abc123.png'],
        creative_entry: { kind: 'new_work', task_intent: 'artwork' },
      }),
    )

    await w.find('[data-testid="cw-add-title"]').setValue('《雨后的校园》')
    await w.find('[data-testid="cw-add-submit"]').trigger('click')
    await flushPromises()
    expect(h.confirmImageTaskSpy).toHaveBeenCalledWith('dispatch-art-new', {
      agent: 'k12-xiaoming',
      version: 1,
      creative: {
        action: 'commit',
        work_title: '《雨后的校园》',
      },
    })
    expect(h.createSpy).not.toHaveBeenCalled()
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
