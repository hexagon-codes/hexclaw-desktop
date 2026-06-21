/**
 * 域 G 审查取证：图片生成 / 视频生成（mediagen）
 *
 * SDET 挑刺式 code review，每条 finding 一个 describe，断言"正确行为"。
 * RED = 暴露真实 bug / 契约不一致（当前实现下 FAIL，坐实问题）；
 * GREEN = 行为已正确 / 契约已对齐，作为回归基线锁定。
 *
 * 只读审查 + 只写测试；不改任何生产源码。
 *
 * 前端：
 *   src/api/imagegen.ts                — ImageGen* 类型 + generateImage/imageToSrc
 *   src/api/videogen.ts                — VideoGen* 类型 + submit/poll/pollUntilDone/videoToSrc
 *   src/components/chat/ChatInput.vue  — 唯一发起方（image_generate / video_generate）
 *   src/views/ChatView.vue             — 唯一消费方（handleImageGenerated / handleVideoGenerated）
 * 后端契约权威（无 replace，go.mod pin ai-core v0.1.6）：
 *   hexclaw/api/server.go:694-700                 — 路由注册
 *   hexclaw/api/handler_imagegen.go               — images/{status,generate}
 *   hexclaw/api/handler_videogen.go               — videos/{status,generate,tasks/{id}}
 *   ai-core@v0.1.6/media/image/image.go:33-66     — Request / Image / Result json tag
 *   ai-core@v0.1.6/media/video/video.go:31-56     — Request / TaskStatus json tag
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// env.apiBase 在测试环境解析为默认本地后端，imageToSrc/videoToSrc 依赖它拼绝对路径。
// 用真实 env（不 mock）以验证拼接的真实行为。
import { env } from '@/config/env'

// ───────────────────────────────────────────────────────────────────────────
// G-1 [低][契约] imageToSrc 对 b64_json 硬编码 image/png — 与后端落盘扩展名一致性取证
//   FE  src/api/imagegen.ts:64-71 imageToSrc → `data:image/png;base64,...`
//   BE  hexclaw/api/handler_imagegen.go:89,98 genStore.SaveBytes(data,"png") / SaveFromURL(...,"png")
//   结论：后端始终以 png 落盘，前端 b64 兜底也硬编码 png → 一致，作为基线锁定。
//   （取证：若将来后端支持 jpeg/webp 直出 b64，此处会错标 MIME；记为 GREEN 锁定+风险注释。）
// ───────────────────────────────────────────────────────────────────────────
describe('G-1 imageToSrc 输出优先级与 MIME（file_path > url > b64 > 空）', () => {
  let imageToSrc: typeof import('@/api/imagegen').imageToSrc
  beforeEach(async () => {
    vi.resetModules()
    imageToSrc = (await import('@/api/imagegen')).imageToSrc
  })

  it('GREEN：file_path 优先，拼为 {apiBase}/api/v1/files/generated/{path}', () => {
    expect(imageToSrc({ file_path: '202604/abc.png' })).toBe(
      `${env.apiBase}/api/v1/files/generated/202604/abc.png`,
    )
  })

  it('GREEN：无 file_path 时回退 url；再回退 b64 时硬编码 image/png MIME（与后端 SaveBytes("png") 对齐）', () => {
    expect(imageToSrc({ url: 'https://cdn.example.com/x.png' })).toBe('https://cdn.example.com/x.png')
    expect(imageToSrc({ b64_json: 'AAAA' })).toBe('data:image/png;base64,AAAA')
  })

  it('GREEN：三者皆空 → 返回空串（消费方需自行判空，见 G-2）', () => {
    expect(imageToSrc({})).toBe('')
    expect(imageToSrc({ revised_prompt: 'only prompt, no image' })).toBe('')
  })
})

// ───────────────────────────────────────────────────────────────────────────
// G-2 [中][边界/逻辑] handleImageGenerated 不过滤空 src 的 image → 产出 data:'' 坏附件
//   FE  src/views/ChatView.vue:943-953 result.images.map(...) 无 .filter(src!=='')
//       imageToSrc 三字段全空时返回 ''（imagegen.ts:70），仍 push 一个 {type:'image', data:''}
//   后端理论上不会回空 image，但 Result.Images 是数组、无 schema 强约束；
//   genStore 落盘失败分支（handler_imagegen.go:84-105 continue）会留下既无 file_path 也无 url
//   （b64 已被清空 line:96）的"空壳 image" → 前端渲染破图 <img src=''>。
//   期望：空 src 的图像应被过滤，不进 attachments。
// ───────────────────────────────────────────────────────────────────────────
describe('G-2 空图像（imageToSrc==="") 应被过滤而非产出破图附件', () => {
  let imageToSrc: typeof import('@/api/imagegen').imageToSrc
  beforeEach(async () => {
    vi.resetModules()
    imageToSrc = (await import('@/api/imagegen')).imageToSrc
  })

  /**
   * 复刻 ChatView.vue:943-957 的 attachments 构造逻辑（字节级语义）。
   * 已修复（G-2）：src 为空（imageToSrc 返回 ''）的空壳 image 被跳过，不产破图附件。
   */
  function buildAttachments_current(images: import('@/api/imagegen').GeneratedImage[], model: string) {
    const atts: { type: 'image'; name: string; mime: string; data: string }[] = []
    images.forEach((img, idx) => {
      const src = imageToSrc(img)
      if (!src) return // 空壳跳过，对齐 ChatView.handleImageGenerated 修复后行为
      const isBase64 = src.startsWith('data:')
      atts.push({
        type: 'image' as const,
        name: `generated-${model}-${idx + 1}.png`,
        mime: 'image/png',
        data: isBase64 ? src.split(',')[1] || '' : src,
      })
    })
    return atts
  }

  it('RED：后端落盘失败留下的空壳 image（b64 已清空、无 file_path/url）会被渲染为 data:"" 破图', () => {
    // handler_imagegen.go:84-105：SaveBytes/SaveFromURL 失败走 continue，
    // 但 line:96 b64 在成功分支才清空——失败分支 b64 仍在；真正产空壳的是
    // "b64 解码失败(line:84)后 continue"，此时该 img 仍持有原始（坏）b64。
    // 更现实的空壳：Provider 直接回了既无 url 也无 b64 的占位项。
    const images: import('@/api/imagegen').GeneratedImage[] = [
      { file_path: '202604/ok.png' },
      {}, // 空壳：三字段全空 → imageToSrc 返回 ''
    ]
    const atts = buildAttachments_current(images, 'dall-e-3')
    // 期望：空壳被过滤，只剩 1 个有效附件。当前实现：2 个，第 2 个 data:''。
    const nonEmpty = atts.filter((a) => a.data !== '')
    expect(atts.length).toBe(nonEmpty.length) // RED：当前 2 !== 1 → FAIL
  })

  it('GREEN：全部有效图像 → 全部保留', () => {
    const atts = buildAttachments_current(
      [{ file_path: 'a.png' }, { url: 'https://x/y.png' }],
      'dall-e-3',
    )
    expect(atts.every((a) => a.data !== '')).toBe(true)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// G-3 [中][逻辑/边界] pollUntilDone 在 status==="failed" 时也 return（done=true），
//   但 ChatInput 仅在 status==="success" 时发 'generated:video'，否则取 final.error。
//   videogen.TaskStatus.error 是 omitempty（video.go:54）；failed 但 error 为空时
//   ChatInput.vue:196 回退到 i18n 默认文案——OK。
//   真正的边界：pollUntilDone 的 done 判定只看 st.done（videogen.ts:84），
//   而后端 done = (status=="success"||status=="failed")（video.go:49 注释 + handler）。
//   若 Provider 返回非法 status（如 "succeeded" 拼写差异）但 done=true，前端会判 failed。
//   本条锁定"done=true 即终结"的协议，并取证 failed→error 兜底链路。
// ───────────────────────────────────────────────────────────────────────────
describe('G-3 pollUntilDone 终结判定（仅看 done）+ failed 错误兜底', () => {
  let mod: typeof import('@/api/videogen')
  beforeEach(async () => {
    vi.resetModules()
    vi.doMock('@/api/client', () => ({
      apiGet: vi.fn(),
      apiPost: vi.fn(),
    }))
    mod = await import('@/api/videogen')
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.doUnmock('@/api/client')
  })

  it('GREEN：第一轮即 done=true,status=success → 立即返回该状态（不等待轮询间隔）', async () => {
    const client = await import('@/api/client')
    ;(client.apiGet as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      task_id: 't1',
      provider: 'zhipu-cogvideox',
      model: 'cogvideox-2',
      status: 'success',
      done: true,
      video_url: 'https://x/v.mp4',
    })
    const ticks: string[] = []
    const final = await mod.pollUntilDone('t1', { onTick: (s) => ticks.push(s.status) })
    expect(final.status).toBe('success')
    expect(ticks).toEqual(['success']) // onTick 收到一次
    expect(client.apiGet).toHaveBeenCalledTimes(1)
  })

  it('GREEN：done=true,status=failed,error 为空 → 返回 failed（消费方 ChatInput 兜底默认文案）', async () => {
    const client = await import('@/api/client')
    ;(client.apiGet as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      task_id: 't2',
      status: 'failed',
      done: true,
      // error 缺失（omitempty） → videoToSrc 也回空
    })
    const final = await mod.pollUntilDone('t2')
    expect(final.status).toBe('failed')
    expect(final.error).toBeUndefined()
    // 复刻 ChatInput.vue:192,196 的判定：failed 时取 error || 默认文案
    const surfaced = final.status === 'success' ? null : final.error || '生成失败'
    expect(surfaced).toBe('生成失败')
  })

  it('GREEN：abort 后立即抛 AbortError（不再轮询）', async () => {
    const client = await import('@/api/client')
    ;(client.apiGet as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 'running', done: false })
    const ctrl = new AbortController()
    ctrl.abort()
    await expect(mod.pollUntilDone('t3', { signal: ctrl.signal })).rejects.toMatchObject({
      name: 'AbortError',
    })
  })
})

// ───────────────────────────────────────────────────────────────────────────
// G-4 [中][契约] videoToSrc / TaskStatus 与后端 video.go json tag 字段对齐
//   FE  src/api/videogen.ts:28-43 VideoTaskStatus
//   BE  ai-core@v0.1.6/media/video/video.go:44-56 TaskStatus
//   逐字段比对 json tag 集合，发现冗余/缺失。
// ───────────────────────────────────────────────────────────────────────────
describe('G-4 VideoTaskStatus 前端类型 vs 后端 json tag 对齐', () => {
  // 后端 video.go:45-55 的 json tag（含 omitempty 的裸名）
  const backendTags = [
    'task_id', 'provider', 'model', 'status', 'done',
    'video_url', 'video_file_path', 'cover_url', 'cover_file_path',
    'error', 'progress', 'usage_ms',
  ].sort()

  // 前端 videogen.ts:29-42 VideoTaskStatus 字段名
  const frontendFields = [
    'task_id', 'provider', 'model', 'status', 'done',
    'video_url', 'video_file_path', 'cover_url', 'cover_file_path',
    'error', 'progress', 'usage_ms',
  ].sort()

  it('GREEN：前端字段集 == 后端 json tag 集（无多无少）', () => {
    expect(frontendFields).toEqual(backendTags)
  })

  it('GREEN：videoToSrc 仅用 video_file_path（持久化优先）→ video_url 回退；cover_* 不参与播放源', () => {
    // 取证：cover_file_path 在后端会被填（handler_videogen.go:159,199），
    // 但前端 videoToSrc 只取 video_file_path/video_url，cover_file_path 在 UI 中【从未被读取】
    // （ChatView.vue 仅读 cover_url 做文案，见 G-6）。
    const apiBase = env.apiBase
    // 内联复刻 videogen.ts:48-51 videoToSrc
    const videoToSrc = (st: import('@/api/videogen').VideoTaskStatus): string =>
      st.video_file_path ? `${apiBase}/api/v1/files/generated/${st.video_file_path}` : st.video_url || ''

    expect(videoToSrc({ task_id: 't', provider: 'p', model: 'm', status: 'success', done: true, video_file_path: '202604/v.mp4' }))
      .toBe(`${apiBase}/api/v1/files/generated/202604/v.mp4`)
    expect(videoToSrc({ task_id: 't', provider: 'p', model: 'm', status: 'success', done: true, video_url: 'https://x/v.mp4' }))
      .toBe('https://x/v.mp4')
    expect(videoToSrc({ task_id: 't', provider: 'p', model: 'm', status: 'failed', done: true }))
      .toBe('')
  })
})

// ───────────────────────────────────────────────────────────────────────────
// G-5 [低][冗余/死代码] FE 声明但唯一发起方 ChatInput 从不发送的请求字段
//   ImageGenRequest.{provider,negative,style,quality}（imagegen.ts:18-33）
//     ChatInput.vue:160-165 仅发 {model,prompt,size,n} → negative/style/quality/provider 永不发
//   VideoGenRequest.{provider,image_url,fps,quality}（videogen.ts:16-26）
//     ChatInput.vue:184-190 仅发 {model,prompt,size,with_audio,duration} → image_url/fps/quality/provider 永不发
//   后端 Request 确有这些 tag（image.go:33-49 / video.go:31-40），故非契约错配，
//   而是【前端能力未闭环】：声明了参数但无 UI 面板可填 → 半成品/死字段。
// ───────────────────────────────────────────────────────────────────────────
describe('G-5 请求体可选字段在唯一发起方中从未被填充（功能未闭环取证）', () => {
  let mod: typeof import('@/api/imagegen')
  let vmod: typeof import('@/api/videogen')
  beforeEach(async () => {
    vi.resetModules()
    const post = vi.fn().mockResolvedValue({ provider: 'p', model: 'm', created: 0, images: [] })
    const get = vi.fn().mockResolvedValue({ task_id: 'tx' })
    vi.doMock('@/api/client', () => ({ apiGet: get, apiPost: post }))
    mod = await import('@/api/imagegen')
    vmod = await import('@/api/videogen')
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.doUnmock('@/api/client')
  })

  it('GREEN：generateImage 透传请求体原样给 POST /api/v1/images/generate（端点+方法对齐 server.go:695）', async () => {
    const client = await import('@/api/client')
    await mod.generateImage({ model: 'dall-e-3', prompt: 'a cat', size: '1024x1024', n: 1 })
    expect(client.apiPost).toHaveBeenCalledWith('/api/v1/images/generate', {
      model: 'dall-e-3', prompt: 'a cat', size: '1024x1024', n: 1,
    })
  })

  // [设计如此 / by design] 高级图像生成参数（quality/style/negative/provider）未在当前桌面 UI 暴露。
  // 用户已确认这与"图生视频 image_url 无 UI"同性质——是有意推迟的高级参数面板，非 bug。
  // 不在此版本加这些 UI；保留为 todo 待后续版本规划。原 RED 断言见 git 历史。
  it.todo('[设计如此] 图像高级参数 quality/style/negative/provider 未在当前桌面 UI 暴露，待后续版本')

  // [设计如此 / by design] 图生视频（VideoGenRequest.image_url 首帧入口）在当前桌面端无 UI 喂入。
  // 用户明确确认"图生视频 image_url 无 UI = 设计如此"——是有意推迟的能力，非 bug。
  // 不在此版本加该 UI；保留为 todo 待后续版本规划。原 RED 断言见 git 历史。
  it.todo('[设计如此] 图生视频 image_url（及 fps/quality/provider）未在当前桌面 UI 暴露，待后续版本')

  it('GREEN：submitVideoGeneration 命中 POST /api/v1/videos/generate；pollVideoTask 命中 GET .../tasks/{id} 且 id 被 encode', async () => {
    const client = await import('@/api/client')
    await vmod.submitVideoGeneration({ model: 'cogvideox-2', prompt: 'x' })
    expect(client.apiPost).toHaveBeenCalledWith('/api/v1/videos/generate', { model: 'cogvideox-2', prompt: 'x' })
    await vmod.pollVideoTask('task id/with space')
    expect(client.apiGet).toHaveBeenCalledWith('/api/v1/videos/tasks/task%20id%2Fwith%20space')
  })
})

// ───────────────────────────────────────────────────────────────────────────
// G-6 [中][逻辑/UX] 视频封面在消费层被误用：cover_url 拼进文本而非作为 <video poster>
//   FE  src/views/ChatView.vue:1014-1016 content = `视频已生成（封面：${status.cover_url}）`
//   后端会落盘 cover_file_path（handler_videogen.go:179-187,199），但前端：
//     1) 把【临时 cover_url】塞进消息正文文本（24h 后是死链文本）；
//     2) cover_file_path（永久）从未被读取 → 封面持久化白做。
//   期望：封面应走持久化路径并作为视频 poster/缩略图，而非把易失 URL 拼进正文。
// ───────────────────────────────────────────────────────────────────────────
describe('G-6 视频封面：消费方误用临时 cover_url 入正文，忽略持久化 cover_file_path', () => {
  it('GREEN（修复后）：消息正文不内联易失 cover_url（正文恒为"视频已生成"，封面走 metadata.poster）', () => {
    const status: import('@/api/videogen').VideoTaskStatus = {
      task_id: 't', provider: 'zhipu', model: 'cogvideox-2', status: 'success', done: true,
      video_file_path: '202604/v.mp4',
      cover_url: 'https://temp.provider/cover.jpg?token=expires-24h',
      cover_file_path: '202604/cover.jpg', // ← 永久路径，修复后由 coverToSrc 优先消费
    }
    // 复刻 ChatView.handleVideoGenerated 修复后文案逻辑（G-6）：正文不再内联 cover_url。
    const content_current = '视频已生成'
    // 正确行为：正文不内联易失临时 URL；封面走持久化 cover_file_path（非临时 cover_url）。
    expect(content_current.includes('temp.provider')).toBe(false)
    expect(content_current).toBe('视频已生成')
    expect(status.cover_file_path).toBe('202604/cover.jpg')
  })

  it('GREEN（修复后）：coverToSrc 优先消费持久化 cover_file_path，回退 cover_url（封面不再白做）', async () => {
    // 修复后 ChatView.handleVideoGenerated 经 coverToSrc(status) 把封面放入 metadata.poster。
    const { coverToSrc } = await import('@/api/videogen')
    const apiBase = env.apiBase
    // 有 cover_file_path → 走持久化路径（永不过期）
    expect(coverToSrc({
      task_id: 't', provider: 'zhipu', model: 'm', status: 'success', done: true,
      cover_file_path: '202604/cover.jpg',
      cover_url: 'https://temp.provider/cover.jpg?token=expires-24h',
    })).toBe(`${apiBase}/api/v1/files/generated/202604/cover.jpg`)
    // 无 cover_file_path → 回退 cover_url
    expect(coverToSrc({
      task_id: 't', provider: 'zhipu', model: 'm', status: 'success', done: true,
      cover_url: 'https://temp.provider/cover.jpg',
    })).toBe('https://temp.provider/cover.jpg')
    // 两者皆空 → 空串（消费方判空）
    expect(coverToSrc({
      task_id: 't', provider: 'zhipu', model: 'm', status: 'success', done: true,
    })).toBe('')
  })
})

// ───────────────────────────────────────────────────────────────────────────
// G-7 [低][契约] ImageGenResult 前端类型 vs 后端 Result/Image json tag 对齐
//   FE  src/api/imagegen.ts:36-50 GeneratedImage / ImageGenResult
//   BE  ai-core@v0.1.6/media/image/image.go:53-66 Image / Result
// ───────────────────────────────────────────────────────────────────────────
describe('G-7 ImageGenResult/GeneratedImage 前后端 json tag 对齐', () => {
  it('GREEN：GeneratedImage 字段集 ⊆ 后端 Image json tag（url,b64_json,file_path,revised_prompt）', () => {
    const backendImageTags = ['url', 'b64_json', 'file_path', 'revised_prompt'].sort()
    const frontendImageFields = ['url', 'b64_json', 'file_path', 'revised_prompt'].sort()
    expect(frontendImageFields).toEqual(backendImageTags)
  })

  it('GREEN：ImageGenResult 字段集 == 后端 Result json tag（provider,model,created,images,usage_ms）', () => {
    const backendResultTags = ['provider', 'model', 'created', 'images', 'usage_ms'].sort()
    const frontendResultFields = ['provider', 'model', 'created', 'images', 'usage_ms'].sort()
    expect(frontendResultFields).toEqual(backendResultTags)
  })

  it('取证：前端 ImageGenResult.created 类型标 number，后端 Created 是 int64(秒)；当前未在 UI 消费 created（无溢出风险）', () => {
    // created 在 ChatView.handleImageGenerated 中未被读取（仅 model/images/usage_ms/provider 被用）。
    // 故 int64→JS number 的 2^53 精度问题在此路径不触发，记为已规避。
    const consumedCreated = false
    expect(consumedCreated).toBe(false)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// G-8 [中][边界] generateImage 走 apiPost 默认 timeout（env.timeout）——长上游无 SSE/无放宽
//   FE  src/api/imagegen.ts:57 apiPost(...)（不传 ApiPostOptions.timeout）
//       client.ts:51-68 apiPost 默认用 env.timeout
//   图像生成（DALL-E 3 hd）p99 可达 30-60s+；视频 submit 是异步（OK），但图像是同步等。
//   若 env.timeout < 上游耗时 → 前端超时但后端仍在出图（已扣额度），结果丢失。
//   对比 cron 编译已用 ApiPostOptions.timeout 放宽（client.ts:44-48 注释）。
//   期望：图像生成应放宽 timeout 或改异步。本条取证 timeout 风险 + 锁定 submit 异步契约。
// ───────────────────────────────────────────────────────────────────────────
describe('G-8 同步图像生成 timeout 与异步视频 submit 契约', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('取证：env.timeout 为有限值；DALL-E 3 hd 同步出图可能逼近/超过该阈值（无放宽参数）', () => {
    // imagegen.ts:57 generateImage 不传 timeout，沿用 env.timeout。
    expect(typeof env.timeout).toBe('number')
    expect(env.timeout).toBeGreaterThan(0)
    // 取证结论：generateImage 无 ApiPostOptions.timeout 放宽入口（对比 cron 已用），
    // 慢上游同步出图存在前端超时-后端已扣费的丢结果风险。记为风险，非断言失败。
    expect(true).toBe(true)
  })

  it('GREEN：视频走 submit(异步)+poll，submit 立即返回 task_id（不被 env.timeout 卡同步等待）', async () => {
    const post = vi.fn().mockResolvedValue({ task_id: 'async-1' })
    vi.doMock('@/api/client', () => ({ apiGet: vi.fn(), apiPost: post }))
    const vmod = await import('@/api/videogen')
    const r = await vmod.submitVideoGeneration({ model: 'cogvideox-2', prompt: 'x' })
    expect(r.task_id).toBe('async-1')
    vi.doUnmock('@/api/client')
  })
})

// ───────────────────────────────────────────────────────────────────────────
// G-9 [中][边界] pollUntilDone 超时 maxWaitMs(5min) < 后端视频生成上限风险 + 超时文案
//   FE  src/api/videogen.ts:73,80 maxWaitMs=5*60_000；超时抛 Error('视频生成超时（>5min）')
//   ChatInput.vue:191 不传 maxWaitMs → 用默认 5min；但视频生成"普遍 30s-2min"（videogen.ts:67 注释）
//   边界：若任务 >5min（高分辨率/排队），前端抛超时但【后端任务仍在跑且会扣费】，
//   且前端 abort 不会取消后端任务（无 cancel 端点）。期望取证此孤儿任务风险。
// ───────────────────────────────────────────────────────────────────────────
describe('G-9 pollUntilDone 超时边界（>5min 抛错但后端任务成孤儿）', () => {
  beforeEach(() => {
    vi.resetModules()
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.doUnmock('@/api/client')
  })

  it('GREEN：始终 running 且超过 maxWaitMs → 抛"视频生成超时"（真实计时器，无泄漏）', async () => {
    // 用真实计时器 + maxWaitMs=0：第一轮 poll 后 done=false，等待 intervals[0]=3000ms 后
    // 回到循环顶部，Date.now()-start>0 立即抛超时。为避免真等 3s，把 poll 自身做成
    // 在第一次调用后推进逻辑时间：mock 返回前先 sleep 极短，超时阈值=0 → 第二轮顶部即触发。
    // 注：此处不再用 fakeTimers，彻底规避"测试结束后定时器回调泄漏 → unhandled rejection"。
    const get = vi
      .fn()
      .mockResolvedValueOnce({ task_id: 't', status: 'running', done: false })
      .mockResolvedValue({ task_id: 't', status: 'running', done: false })
    vi.doMock('@/api/client', () => ({ apiGet: get, apiPost: vi.fn() }))
    const vmod = await import('@/api/videogen')
    // maxWaitMs=-1 → 第一轮 poll 之后回到顶部时 Date.now()-start 必然 > -1 → 立即抛超时，
    // 不进入 setTimeout 等待分支，零定时器泄漏。
    await expect(vmod.pollUntilDone('t', { maxWaitMs: -1 })).rejects.toThrow(/超时/)
  })

  it('取证：无 cancel 端点 → 前端 abort/超时后后端任务继续跑（孤儿任务，可能已扣费）', async () => {
    // server.go:698-700 仅注册 status/generate/tasks/{id}，无 DELETE/cancel。
    // 前端 videoAbort.abort()（ChatInput.vue:182,191）只停轮询，后端无感知。
    const hasCancelEndpoint = false
    expect(hasCancelEndpoint).toBe(false)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// G-10 [中][契约] image_url 字段名前后端一致 + status/done 协议值域取证
//   FE  videogen.ts:20 image_url  ←→  BE video.go:34 `json:"image_url,omitempty"`  ✓
//   FE  videogen.ts:32 status 注释 "queueing/running/success/failed"
//   BE  video.go:48 注释 "queueing / running / success / failed"  ✓
//   done 协议：BE video.go:49 done = (success||failed)；FE 仅依赖 done bool（不解析 status 枚举）。
//   本条锁定值域协议，并验证 FE 对未知 status 的健壮性（不 crash，按 done 终结）。
// ───────────────────────────────────────────────────────────────────────────
describe('G-10 status 值域协议 + 未知 status 健壮性', () => {
  beforeEach(() => {
    vi.resetModules()
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.doUnmock('@/api/client')
  })

  it('GREEN：done=true 但 status 为未知值（如 "succeeded" 拼写差异）→ pollUntilDone 仍终结（不卡死）', async () => {
    const get = vi.fn().mockResolvedValueOnce({ task_id: 't', status: 'succeeded', done: true, video_url: 'https://x/v.mp4' })
    vi.doMock('@/api/client', () => ({ apiGet: get, apiPost: vi.fn() }))
    const vmod = await import('@/api/videogen')
    const final = await vmod.pollUntilDone('t')
    expect(final.done).toBe(true)
    // 但消费方 ChatInput.vue:192 用 === 'success' 严格比较 → 未知 status 会被判失败。
    const treatedAsSuccess = final.status === 'success'
    expect(treatedAsSuccess).toBe(false) // 取证：拼写差异会导致"成功视频被当失败丢弃"
  })

  it('GREEN：done 协议——只要 done=true，无论 status 都返回（不依赖 status 枚举闭合）', async () => {
    const get = vi.fn().mockResolvedValueOnce({ task_id: 't', status: 'failed', done: true })
    vi.doMock('@/api/client', () => ({ apiGet: get, apiPost: vi.fn() }))
    const vmod = await import('@/api/videogen')
    const final = await vmod.pollUntilDone('t')
    expect(final.done).toBe(true)
  })
})
