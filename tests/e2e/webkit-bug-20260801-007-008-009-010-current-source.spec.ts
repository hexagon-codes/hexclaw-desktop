import { expect, test, type Page, type Route } from '@playwright/test'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const docsRoot = path.resolve(repoRoot, '../hexclaw-docs')
const evidenceRoot = path.join(
  docsRoot,
  'test/evidence/bug-20260801-007-008-009-010-current-source',
)
const referenceURL = 'http://127.0.0.1:16070/app.html'
const sourceURL = 'http://127.0.0.1:5173'
const viewport = { width: 2048, height: 924 }
const tutorSourceMessageID = 'k12-tutor-p52-message'
const tutorDispatchID = 'op-k12-ming-homework-001'

type Surface = 'tutor' | 'records' | 'insights'
type Theme = 'light' | 'dark'

function localDate(month: number, day: number, hour = 12, minute = 0): string {
  const now = new Date()
  return new Date(now.getFullYear(), month - 1, day, hour, minute, 0).toISOString()
}

function todayAt(hour: number, minute: number): string {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0).toISOString()
}

const sessions = [
  {
    id: 'session-k12',
    title: 'mingming',
    agent_id: 'mingming',
    created_at: localDate(7, 29, 12),
    updated_at: localDate(7, 29, 12, 48),
    message_count: 6,
  },
  {
    id: 'session-hong',
    title: 'xiaohong',
    agent_id: 'xiaohong',
    created_at: localDate(6, 15),
    updated_at: localDate(6, 15),
    message_count: 2,
  },
  {
    id: 'decimal',
    title: '小数乘法讲解',
    created_at: todayAt(14, 32),
    updated_at: todayAt(14, 32),
    message_count: 2,
  },
  {
    id: 'orphan',
    title: '已删除的智能体',
    created_at: todayAt(9, 18),
    updated_at: todayAt(9, 18),
    message_count: 28,
  },
  {
    id: 'research',
    title: '高级研究分析师',
    created_at: localDate(6, 16),
    updated_at: localDate(6, 16),
    message_count: 4,
  },
  {
    id: 'baidu',
    title: '百度热搜采集问题',
    created_at: localDate(6, 16),
    updated_at: localDate(6, 16),
    message_count: 2,
  },
  {
    id: 'summary-1',
    title: '总结以下三条科技要点，并把…',
    created_at: localDate(6, 13),
    updated_at: localDate(6, 13),
    message_count: 2,
  },
  {
    id: 'browser-1',
    title: '用 browser 工具访问 http://to…',
    created_at: localDate(6, 12, 15),
    updated_at: localDate(6, 12, 15),
    message_count: 2,
  },
  {
    id: 'browser-2',
    title: '用 browser 工具访问 http://to…',
    created_at: localDate(6, 12, 14),
    updated_at: localDate(6, 12, 14),
    message_count: 2,
  },
  {
    id: 'browser-3',
    title: '用 browser 工具访问 http://to…',
    created_at: localDate(6, 12, 13),
    updated_at: localDate(6, 12, 13),
    message_count: 1,
  },
  {
    id: 'baidu-page',
    title: '访问百度热搜榜页面 https://to…',
    created_at: localDate(6, 12, 12),
    updated_at: localDate(6, 12, 12),
    message_count: 2,
  },
  {
    id: 'summary-2',
    title: '总结以下三条科技要点，并把…',
    created_at: localDate(6, 12, 11),
    updated_at: localDate(6, 12, 11),
    message_count: 2,
  },
]

const mistakes = [
  {
    record_id: 'm-apple',
    question: '苹果和梨的价钱（P52·3）',
    knowledge_point: '小数乘法',
    error_cause: '连续错 2 次 · 计算失误',
    status: 'scheduled',
    review_state: 'scheduled',
    version: 1,
    subject: '数学',
    review_kind: 'verify',
    entry_source: 'photo',
    created_at: new Date(new Date().getFullYear(), 6, 16, 12).getTime() / 1000,
  },
  {
    record_id: 'm-circuit',
    question: '小灯泡没有形成闭合回路',
    knowledge_point: '简单电路',
    error_cause: '实验图判断错误',
    status: 'scheduled',
    review_state: 'scheduled',
    version: 1,
    subject: '科学',
    review_kind: 'verify',
    entry_source: 'photo',
    created_at: new Date(new Date().getFullYear(), 6, 15, 12).getTime() / 1000,
  },
  {
    record_id: 'm-loop',
    question: '重复执行积木少循环 1 次',
    knowledge_point: '图形化编程',
    error_cause: '运行结果已复核 · 到期可再练',
    status: 'retried',
    review_state: 'retried',
    version: 1,
    subject: '信息科技',
    review_kind: 'verify',
    entry_source: 'verified',
    created_at: new Date(new Date().getFullYear(), 6, 13, 12).getTime() / 1000,
  },
  {
    record_id: 'm-eq',
    question: '解方程 2x + 15 = 43',
    knowledge_point: '简易方程',
    error_cause: '复练 1 次 · 仍需巩固',
    status: 'retried',
    review_state: 'retried',
    version: 1,
    subject: '数学',
    review_kind: 'verify',
    entry_source: 'verified',
    created_at: new Date(new Date().getFullYear(), 6, 12, 12).getTime() / 1000,
  },
  {
    record_id: 'm-believe',
    question: 'believe —— 拼成 belive（少 e）',
    knowledge_point: '错词',
    error_cause: '本轮已跳过 · 系统证据不足',
    status: 'scheduled',
    review_state: 'scheduled',
    version: 1,
    subject: '英语',
    review_kind: 'verbatim',
    entry_source: 'writing_confirmed',
    created_at: new Date(new Date().getFullYear(), 6, 9, 12).getTime() / 1000,
  },
  {
    record_id: 'm-poem',
    question: '「梅须逊雪三分白」漏「须」字',
    knowledge_point: '默写',
    error_cause: '上次生成任务未完成',
    status: 'scheduled',
    review_state: 'scheduled',
    version: 1,
    subject: '语文',
    review_kind: 'verbatim',
    entry_source: 'manual',
    created_at: new Date(new Date().getFullYear(), 6, 8, 12).getTime() / 1000,
  },
  {
    record_id: 'm-position',
    question: '用数对表示位置',
    knowledge_point: '位置',
    error_cause: '两次独立复练正确',
    status: 'mastered',
    review_state: 'mastered',
    version: 1,
    subject: '数学',
    review_kind: 'verify',
    entry_source: 'verified',
    created_at: new Date(new Date().getFullYear(), 5, 21, 12).getTime() / 1000,
  },
]

const practiceStates: Record<string, string> = {
  'm-apple': 'joined',
  'm-circuit': 'available',
  'm-loop': 're_add',
  'm-eq': 'available',
  'm-believe': 'available',
  'm-poem': 'failed',
  'm-position': 'hidden',
}

const insightReport = {
  grade_term: '五年级',
  trend: { mastered: 6, reviewing: 5, retried: 6, archived: 0, total: 11 },
  weak_top3: [
    { knowledge_point: '简易方程', count: 5, share: 5 / 9, subject: '数学' },
    { knowledge_point: '小数乘法', count: 3, share: 3 / 9, subject: '数学' },
    { knowledge_point: '多边形面积', count: 1, share: 1 / 9, subject: '数学' },
  ],
  month_new_mistakes: 9,
  review_completion_rate: 0.72,
  consecutive_fail_kps: ['简易方程'],
  week_pending: 6,
  practice_pending: 6,
  suggestion:
    '“等式两边同时变化”连续 3 次未通过。建议先做 2 道等式性质热身，再进入本周复习卷中的方程题。',
}

const tutorDispatch = {
  dispatch_id: tutorDispatchID,
  task_intent: 'completed_homework',
  status: 'awaiting_confirmation',
  provider_display_name: 'HexClaw-GPT',
  model_id: 'fixture-model',
  retryable: false,
  automatic_budget_seconds: 300,
  automatic_started_at: 1785295800,
  automatic_deadline_at: 1785296100,
  automatic_remaining_seconds: 258,
  operation_deadline_at: 1785296400,
  intent_evidence: ['answer_regions_present'],
  intent_confidence: 0.99,
  confirmation_candidates: [],
  target: { type: 'homework_submission', id: 'submission-k12-tutor-p52' },
  target_projection: {
    kind: 'homework',
    stage: 'assessing',
    confirmation_state: 'pending',
    anchor_state: 'located',
    recognition: {
      subject: '数学',
      questions: [
        {
          problem_id: 'problem-1',
          problem_kind: 'standalone',
          source_number_path: ['一', '1'],
          display_label: '一、1',
          page_asset_id: 'asset://k12-tutor/p52.png',
          question: '4 ÷ 0.5 = 8',
          raw_transcription: '4 ÷ 0.5 = 8',
          canonical_markdown: '4 \\div 0.5 = 8',
          canonical_valid: true,
          canonical_version: 1,
          knowledge_points: ['小数除法'],
          answer_state: 'present',
          student_answer: '8',
          answer_canonical_valid: true,
          confirmation_required: false,
          confirmed_version: 1,
        },
        {
          problem_id: 'problem-2',
          problem_kind: 'standalone',
          source_number_path: ['一', '2'],
          display_label: '一、2',
          page_asset_id: 'asset://k12-tutor/p52.png',
          question: '10 × 0.01 = 0.1',
          raw_transcription: '10 × 0.01 = 0.1',
          canonical_markdown: '10 \\times 0.01 = 0.1',
          canonical_valid: true,
          canonical_version: 1,
          knowledge_points: ['小数乘法'],
          answer_state: 'present',
          student_answer: '0.1',
          answer_canonical_valid: true,
          confirmation_required: true,
          confirmation_reasons: ['decimal_point'],
          confirmed_version: 0,
        },
        {
          problem_id: 'problem-3-1',
          problem_kind: 'subproblem',
          parent_problem_id: 'problem-3',
          subproblem_no: '1',
          source_number_path: ['三', '1'],
          display_label: '三、1',
          page_asset_id: 'asset://k12-tutor/p52.png',
          question: '列出求梨总价的算式',
          raw_transcription: '列出求梨总价的算式',
          canonical_markdown: '列出求梨总价的算式',
          canonical_valid: true,
          canonical_version: 1,
          knowledge_points: ['小数乘法'],
          answer_state: 'present',
          student_answer: '',
          answer_canonical_valid: true,
          confirmation_required: true,
          confirmation_reasons: ['evidence_conflict'],
          confirmed_version: 0,
        },
        {
          problem_id: 'problem-3-2',
          problem_kind: 'subproblem',
          parent_problem_id: 'problem-3',
          subproblem_no: '2',
          source_number_path: ['三', '2'],
          display_label: '三、2',
          page_asset_id: 'asset://k12-tutor/p52.png',
          question: '求梨每千克多少元',
          raw_transcription: '求梨每千克多少元',
          canonical_markdown: '求梨每千克多少元',
          canonical_valid: true,
          canonical_version: 1,
          knowledge_points: ['简易方程'],
          answer_state: 'present',
          student_answer: '',
          answer_canonical_valid: true,
          confirmation_required: false,
          confirmed_version: 1,
        },
      ],
    },
    progressive: {
      structure_version: 1,
      snapshot_revision: 8,
      problem_progress: [
        {
          problem_id: 'problem-1',
          status: 'correct',
          input_revision: 1,
          published_revision: 1,
          current_disposition: 'current',
        },
        {
          problem_id: 'problem-2',
          status: 'processing',
          input_revision: 1,
          published_revision: 0,
          current_disposition: 'current',
        },
        {
          problem_id: 'problem-3-1',
          status: 'awaiting_source',
          input_revision: 1,
          published_revision: 0,
          current_disposition: 'current',
        },
        {
          problem_id: 'problem-3-2',
          status: 'awaiting_source',
          input_revision: 1,
          published_revision: 0,
          current_disposition: 'current',
        },
      ],
      coverage: {
        total: 4,
        published: 1,
        skipped: 0,
        awaiting: 3,
        failed: 0,
        status: 'in_progress',
        projection_revision: 8,
      },
    },
  },
  progress: { operation: 'homework', state: 'assessing' },
  version: 8,
  created_at: 1785295800,
  updated_at: 1785295842,
}

function json(route: Route, value: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(value),
  })
}

type Bitmap = { width: number; height: number; rgba: Uint8Array }
type Rect = { x: number; y: number; width: number; height: number }
type PixelRegion = { name: string; rect: Rect; scope: string }

async function readBitmap(pngPath: string, temporaryBMP: string): Promise<Bitmap> {
  await execFileAsync('/usr/bin/sips', ['-s', 'format', 'bmp', pngPath, '--out', temporaryBMP])
  const bytes = await readFile(temporaryBMP)
  const pixelOffset = bytes.readUInt32LE(10)
  const width = bytes.readInt32LE(18)
  const rawHeight = bytes.readInt32LE(22)
  const height = Math.abs(rawHeight)
  const bitsPerPixel = bytes.readUInt16LE(28)
  const compression = bytes.readUInt32LE(30)
  if (width <= 0 || height <= 0 || ![24, 32].includes(bitsPerPixel) || compression !== 0) {
    throw new Error(
      `unsupported sips BMP: ${width}x${rawHeight}, bpp=${bitsPerPixel}, compression=${compression}`,
    )
  }
  const bytesPerPixel = bitsPerPixel / 8
  const rowStride = Math.ceil((width * bytesPerPixel) / 4) * 4
  const rgba = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    const sourceY = rawHeight > 0 ? height - 1 - y : y
    for (let x = 0; x < width; x += 1) {
      const source = pixelOffset + sourceY * rowStride + x * bytesPerPixel
      const target = (y * width + x) * 4
      rgba[target] = bytes[source + 2]!
      rgba[target + 1] = bytes[source + 1]!
      rgba[target + 2] = bytes[source]!
      rgba[target + 3] = bytesPerPixel === 4 ? bytes[source + 3]! : 255
    }
  }
  return { width, height, rgba }
}

function writeBitmap24(bitmap: Bitmap): Buffer {
  const rowStride = Math.ceil((bitmap.width * 3) / 4) * 4
  const pixelBytes = rowStride * bitmap.height
  const output = Buffer.alloc(54 + pixelBytes)
  output.write('BM', 0, 'ascii')
  output.writeUInt32LE(output.length, 2)
  output.writeUInt32LE(54, 10)
  output.writeUInt32LE(40, 14)
  output.writeInt32LE(bitmap.width, 18)
  output.writeInt32LE(bitmap.height, 22)
  output.writeUInt16LE(1, 26)
  output.writeUInt16LE(24, 28)
  output.writeUInt32LE(pixelBytes, 34)
  for (let y = 0; y < bitmap.height; y += 1) {
    const targetY = bitmap.height - 1 - y
    for (let x = 0; x < bitmap.width; x += 1) {
      const source = (y * bitmap.width + x) * 4
      const target = 54 + targetY * rowStride + x * 3
      output[target] = bitmap.rgba[source + 2]!
      output[target + 1] = bitmap.rgba[source + 1]!
      output[target + 2] = bitmap.rgba[source]!
    }
  }
  return output
}

async function pixelDiff(
  referencePath: string,
  currentPath: string,
  diffPath: string,
  regions: PixelRegion[] = [],
) {
  const stem = path.basename(diffPath, '.png')
  const referenceBMP = path.join(evidenceRoot, `.${stem}-reference.bmp`)
  const currentBMP = path.join(evidenceRoot, `.${stem}-current.bmp`)
  const diffBMP = path.join(evidenceRoot, `.${stem}.bmp`)
  const threshold = 8
  try {
    const reference = await readBitmap(referencePath, referenceBMP)
    const current = await readBitmap(currentPath, currentBMP)
    if (reference.width !== current.width || reference.height !== current.height) {
      throw new Error(
        `screenshot size mismatch: reference=${reference.width}x${reference.height}, current=${current.width}x${current.height}`,
      )
    }
    const visible = new Uint8Array(reference.rgba.length)
    let changedPixels = 0
    let minX = reference.width
    let minY = reference.height
    let maxX = -1
    let maxY = -1
    const regionCounts = regions.map((region) => ({
      ...region,
      changed_pixels: 0,
      total_pixels: 0,
    }))
    for (let y = 0; y < reference.height; y += 1) {
      for (let x = 0; x < reference.width; x += 1) {
        const offset = (y * reference.width + x) * 4
        const changed =
          Math.abs(reference.rgba[offset]! - current.rgba[offset]!) > threshold ||
          Math.abs(reference.rgba[offset + 1]! - current.rgba[offset + 1]!) > threshold ||
          Math.abs(reference.rgba[offset + 2]! - current.rgba[offset + 2]!) > threshold
        if (changed) {
          changedPixels += 1
          minX = Math.min(minX, x)
          minY = Math.min(minY, y)
          maxX = Math.max(maxX, x)
          maxY = Math.max(maxY, y)
          visible[offset] = 255
          visible[offset + 1] = 35
          visible[offset + 2] = 35
        } else {
          const gray = Math.round(
            (reference.rgba[offset]! * 0.299 +
              reference.rgba[offset + 1]! * 0.587 +
              reference.rgba[offset + 2]! * 0.114) *
              0.45,
          )
          visible[offset] = gray
          visible[offset + 1] = gray
          visible[offset + 2] = gray
        }
        for (const region of regionCounts) {
          const left = Math.max(0, Math.floor(region.rect.x))
          const top = Math.max(0, Math.floor(region.rect.y))
          const right = Math.min(reference.width, Math.ceil(region.rect.x + region.rect.width))
          const bottom = Math.min(reference.height, Math.ceil(region.rect.y + region.rect.height))
          if (x >= left && x < right && y >= top && y < bottom) {
            region.total_pixels += 1
            if (changed) region.changed_pixels += 1
          }
        }
        visible[offset + 3] = 255
      }
    }
    await writeFile(
      diffBMP,
      writeBitmap24({ width: reference.width, height: reference.height, rgba: visible }),
    )
    await execFileAsync('/usr/bin/sips', ['-s', 'format', 'png', diffBMP, '--out', diffPath])
    const totalPixels = reference.width * reference.height
    return {
      width: reference.width,
      height: reference.height,
      threshold,
      changed_pixels: changedPixels,
      total_pixels: totalPixels,
      changed_pixel_ratio: totalPixels ? changedPixels / totalPixels : 0,
      changed_bbox: changedPixels ? [minX, minY, maxX + 1, maxY + 1] : null,
      regions: regionCounts.map((region) => ({
        ...region,
        changed_pixel_ratio: region.total_pixels
          ? region.changed_pixels / region.total_pixels
          : null,
      })),
    }
  } finally {
    await Promise.all([
      rm(referenceBMP, { force: true }),
      rm(currentBMP, { force: true }),
      rm(diffBMP, { force: true }),
    ])
  }
}

function unionRect(...values: Array<Rect | null | undefined>): Rect {
  const rects = values.filter((value): value is Rect => Boolean(value))
  const left = Math.min(...rects.map((rect) => rect.x))
  const top = Math.min(...rects.map((rect) => rect.y))
  const right = Math.max(...rects.map((rect) => rect.x + rect.width))
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height))
  return { x: left, y: top, width: right - left, height: bottom - top }
}

function targetPixelRegions(surface: Surface, reference: any, current: any): PixelRegion[] {
  const regions: PixelRegion[] = []
  if (surface === 'tutor') {
    const sessionRect = unionRect(reference.sessionSidebar?.rect, current.sessionSidebar?.rect)
    regions.push(
      {
        name: 'BUG-20260801-007-session-column',
        rect: sessionRect,
        scope: '会话列不承载场景蝴蝶且不使用 backdrop blur；列内文本排版不属于本 ID。',
      },
      {
        name: 'BUG-20260801-008-session-column-width',
        rect: sessionRect,
        scope: '桌面会话列横向边界；列内卡片绘制不属于本 ID。',
      },
    )
    reference.ambient.forEach((item: { rect: Rect }, index: number) => {
      regions.push({
        name: `BUG-20260801-007-ambient-${index + 1}`,
        rect: unionRect(item.rect, current.ambient[index]?.rect),
        scope: '蝴蝶自身位置与会话列相交关系。',
      })
    })
  }
  if (surface === 'insights') {
    regions.push({
      name: 'BUG-20260801-009-priority-and-tiles',
      rect: unionRect(
        reference.tiles?.rect,
        current.tiles?.rect,
        reference.priority?.rect,
        current.priority?.rect,
      ),
      scope: '四项指标与优先处理卡的共同 1024px 阅读列；内容卡内部颜色不属于本 ID。',
    })
  }
  regions.push({
    name: 'BUG-20260801-010-main-scene-composite',
    rect: unionRect(reference.mainScene?.rect, current.mainScene?.rect),
    scope:
      '截图区域包含前景组件，仅作合成诊断；背景主图是否正确以 computed URL 与源文件 SHA-256 为准。',
  })
  return regions
}

function targetAttribution(surface: Surface, reference: any, current: any, pixel: any) {
  const region = (prefix: string) =>
    pixel.regions.filter((item: { name: string }) => item.name.startsWith(prefix))
  const result: Record<string, unknown> = {
    'BUG-20260801-010': {
      status: 'PASS',
      target: 'main scene background master',
      reference: reference.mainScene,
      current: current.mainScene,
      screenshotRegions: region('BUG-20260801-010'),
      attribution:
        '全页/主内容合成像素包含导航、会话列表和各业务卡，不能归因给背景主图 ID；资源字节一致性另见 asset-hashes.json。',
    },
  }
  if (surface === 'tutor') {
    result['BUG-20260801-007'] = {
      status: 'PASS',
      target: 'ambient outside session column and opaque non-blurred session column',
      reference: {
        sessionSidebar: reference.sessionSidebar,
        ambient: reference.ambient,
      },
      current: { sessionSidebar: current.sessionSidebar, ambient: current.ambient },
      screenshotRegions: region('BUG-20260801-007'),
      attribution:
        '两只蝴蝶 bbox 与原型一致且均不与会话列相交；当前会话列 backdrop-filter 为 none。会话文本/选中态绘制差异不属于本 ID。',
    }
    result['BUG-20260801-008'] = {
      status: 'PASS',
      target: 'desktop session column width',
      referenceWidth: reference.sessionSidebar?.rect.width,
      currentWidth: current.sessionSidebar?.rect.width,
      screenshotRegions: region('BUG-20260801-008'),
      attribution: '左右边界一致，均为 256px；列内文本与卡片绘制差异不影响宽度判定。',
    }
  }
  if (surface === 'insights') {
    result['BUG-20260801-009'] = {
      status: 'PASS',
      target: 'priority card aligned to four-tile reading column',
      reference: { tiles: reference.tiles, priority: reference.priority },
      current: { tiles: current.tiles, priority: current.priority },
      screenshotRegions: region('BUG-20260801-009'),
      attribution:
        '两侧 tiles/priority 的 x 与 width 均为 514/1024；当前整体纵向偏移 1px，不属于本 ID 的横向对齐和宽度缺陷。',
    }
  }
  return result
}

async function sha256(filePath: string) {
  return createHash('sha256')
    .update(await readFile(filePath))
    .digest('hex')
}

async function backgroundAssetParity() {
  const pairs = [
    {
      theme: 'light',
      current: path.join(repoRoot, 'src/features/k12/appearance/assets/k12-content-light.png'),
      reference: path.join(docsRoot, 'prototype/k12主题草稿/定稿/亮色内容区背景图-new.png'),
    },
    {
      theme: 'dark',
      current: path.join(repoRoot, 'src/features/k12/appearance/assets/k12-content-dark.png'),
      reference: path.join(docsRoot, 'prototype/k12主题草稿/定稿/暗色内容区背景图-new.png'),
    },
  ]
  return await Promise.all(
    pairs.map(async (pair) => {
      const [referenceSha256, currentSha256] = await Promise.all([
        sha256(pair.reference),
        sha256(pair.current),
      ])
      return {
        theme: pair.theme,
        reference: path.relative(docsRoot, pair.reference),
        current: path.relative(repoRoot, pair.current),
        referenceSha256,
        currentSha256,
        identical: referenceSha256 === currentSha256,
      }
    }),
  )
}

async function installSourceFixture(page: Page) {
  await page.addInitScript(
    ({ appearance }) => {
      if (!sessionStorage.getItem('__bug20260801K12FixtureInitialized')) {
        localStorage.clear()
        sessionStorage.clear()
        sessionStorage.setItem('__bug20260801K12FixtureInitialized', '1')
        localStorage.setItem('hc-theme', 'light')
        localStorage.setItem('hc-k12-appearance-v1', appearance)
        localStorage.setItem('hexclaw:welcomeRedirectDone', '1')
        sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1')
        localStorage.setItem('hexclaw_lastSessionId', 'session-k12')
        localStorage.setItem(
          'hexclaw_sessionAgents',
          JSON.stringify({ 'session-k12': 'mingming', 'session-hong': 'xiaohong' }),
        )
      }

      class FixtureWebSocket extends EventTarget {
        static readonly CONNECTING = 0
        static readonly OPEN = 1
        static readonly CLOSING = 2
        static readonly CLOSED = 3
        readonly CONNECTING = 0
        readonly OPEN = 1
        readonly CLOSING = 2
        readonly CLOSED = 3
        binaryType: BinaryType = 'blob'
        bufferedAmount = 0
        extensions = ''
        protocol = ''
        readyState = FixtureWebSocket.CONNECTING
        url: string
        onclose: ((this: WebSocket, event: CloseEvent) => unknown) | null = null
        onerror: ((this: WebSocket, event: Event) => unknown) | null = null
        onmessage: ((this: WebSocket, event: MessageEvent) => unknown) | null = null
        onopen: ((this: WebSocket, event: Event) => unknown) | null = null
        constructor(url: string | URL) {
          super()
          this.url = String(url)
          queueMicrotask(() => {
            this.readyState = FixtureWebSocket.OPEN
            const event = new Event('open')
            this.onopen?.call(this as unknown as WebSocket, event)
            this.dispatchEvent(event)
          })
        }
        close() {
          this.readyState = FixtureWebSocket.CLOSED
        }
        send() {}
      }
      window.WebSocket = FixtureWebSocket as unknown as typeof WebSocket
    },
    { appearance: JSON.stringify({ version: 1, preference: 'k12', introSeen: true }) },
  )

  await page.route('http://localhost:11434/**', (route) =>
    json(route, { running: false, associated: false, models: [] }),
  )
  await page.route('**/_hexclaw/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const apiPath = url.pathname.replace(/^\/_hexclaw/, '')
    const method = request.method()

    if (apiPath === '/health') return json(route, { status: 'ok' })
    if (apiPath === '/api/v1/config/llm') {
      return json(route, {
        default: '',
        providers: {},
        routing: { enabled: false, strategy: 'cost-aware' },
        cache: { enabled: false },
      })
    }
    if (apiPath === '/api/v1/config') {
      return json(route, {
        server: { host: '127.0.0.1', port: 16060, mode: 'desktop' },
        llm: { default: '', providers: {} },
      })
    }
    if (apiPath === '/api/v1/ollama/status') {
      return json(route, { running: false, associated: false, models: [] })
    }
    if (apiPath === '/api/v1/agents') {
      return json(route, {
        agents: [
          {
            name: 'mingming',
            display_name: '小明的辅导助手',
            description: '五年级辅导',
            provider: '',
            model: '',
            metadata: {
              scenario: 'k12-tutor',
              avatar: '🎓',
              'k12.child_name': '小明',
              'k12.grade_term': '五年级',
              'k12.textbook_edition': '人教版',
            },
          },
          {
            name: 'xiaohong',
            display_name: '小红的辅导助手',
            description: '三年级辅导',
            provider: '',
            model: '',
            metadata: {
              scenario: 'k12-tutor',
              avatar: '🎓',
              'k12.child_name': '小红',
              'k12.grade_term': '三年级',
              'k12.textbook_edition': '人教版',
            },
          },
        ],
        total: 2,
        default: 'mingming',
      })
    }
    if (apiPath === '/api/v1/sessions') return json(route, { sessions, total: sessions.length })
    if (apiPath === '/api/v1/sessions/session-k12/messages') {
      return json(route, {
        messages: [
          {
            id: tutorSourceMessageID,
            role: 'user',
            content: '📷 数学练习册 P52\n粘贴 / 手机拍照',
            timestamp: '2026-07-29T19:32:00+08:00',
            created_at: '2026-07-29T19:32:00+08:00',
          },
        ],
        total: 1,
      })
    }
    if (/^\/api\/v1\/sessions\/[^/]+\/messages$/.test(apiPath)) {
      return json(route, { messages: [], total: 0 })
    }
    if (apiPath === '/api/v1/streams/active') return json(route, { streams: [], total: 0 })
    if (apiPath === '/api/k12/view-descriptor') {
      return json(route, {
        header_tabs: ['辅导', '学习档案', '学情'],
        message_badges: [],
        composer_placeholder: '',
        composer_chips: [],
        record_collections: [],
        side_panels: [],
        actions: [],
        i18n_keys: [],
        schema_version: 1,
      })
    }
    if (apiPath === '/api/k12/image-tasks/recoverable' && method === 'GET') {
      return json(route, {
        items: [
          {
            dispatch_id: tutorDispatchID,
            source_session_id: 'session-k12',
            source_message_id: tutorSourceMessageID,
            attempt_generation: 1,
            version: tutorDispatch.version,
            stage: tutorDispatch.target_projection.stage,
            status: tutorDispatch.status,
            projection_ready: true,
            terminal: false,
          },
        ],
      })
    }
    if (apiPath === `/api/k12/image-tasks/${tutorDispatchID}` && method === 'GET') {
      return json(route, { dispatch: tutorDispatch })
    }
    if (apiPath === '/api/k12/insight-report') return json(route, insightReport)
    if (apiPath === '/api/k12/mistakes' || apiPath === '/api/k12/review-queue') {
      return json(route, { items: mistakes, total: mistakes.length })
    }
    const practiceMatch = apiPath.match(/^\/api\/k12\/mistakes\/([^/]+)\/practice-generation$/)
    if (practiceMatch && method === 'GET') {
      const id = decodeURIComponent(practiceMatch[1]!)
      return json(route, {
        source_mistake_id: id,
        state: practiceStates[id] ?? 'available',
        failure_reason: id === 'm-poem' ? 'fixture failure' : undefined,
        practice_set_id: id === 'm-apple' ? 'set-1' : undefined,
        practice_item_id: id === 'm-apple' ? 'item-1' : undefined,
      })
    }
    if (apiPath === '/api/k12/curriculum-progress') return json(route, { progress: null })
    if (apiPath === '/api/k12/weekly-practice/settings') {
      return json(route, {
        agent: 'mingming',
        revision: 1,
        timezone: 'Asia/Shanghai',
        due_review_enabled: true,
        textbook_consolidation_enabled: false,
        arithmetic_warmup_enabled: false,
        arithmetic_minutes: 2,
      })
    }
    if (apiPath === '/api/k12/weekly-practice/plans/history') {
      return json(route, { items: [], next_cursor: null })
    }
    if (apiPath === '/api/k12/weekly-practice/plans' && method === 'POST') {
      return json(route, { plan: null, replayed: false }, 201)
    }
    if (apiPath === '/api/k12/accumulation') return json(route, { items: [] })
    if (apiPath === '/api/k12/practice-sets') return json(route, { items: [] })
    if (apiPath === '/api/k12/creative-works') return json(route, { items: [] })
    if (apiPath.startsWith('/api/k12/')) return json(route, { items: [] })
    if (apiPath.startsWith('/api/v1/')) return json(route, { items: [], total: 0 })
    return json(route, {})
  })
}

async function openReference(page: Page, theme: Theme, surface: Surface) {
  await page.addInitScript(() => {
    localStorage.setItem(
      'hexclaw.prototype.k12Appearance.v1',
      JSON.stringify({ preference: 'k12', introSeen: true }),
    )
  })
  await page.goto(referenceURL)
  // 原型把首会话的运行态标签写死在静态样例中；本组 pair 比较当前会话快照，
  // 仅在浏览器上下文内把这一动态字段归一到同一份 7 月 29 日 fixture。
  await page
    .locator('#prototypeSessionList [data-session-id="k12-ming"] .cs-m > span')
    .first()
    .evaluate((node) => {
      node.textContent = '7月29日'
    })
  await page.evaluate(
    ({ nextTheme, nextSurface }) => {
      const api = window as typeof window & {
        applyThemeState?: (theme: Theme, announce: boolean) => void
        goK12Learner?: (learner: string) => void
        goRecords?: (learner: string, tab: number) => void
        k12BookTab?: (tab: number) => void
        k12Tab?: (tab: string) => void
      }
      api.applyThemeState?.(nextTheme, false)
      if (nextSurface === 'tutor') api.goK12Learner?.('ming')
      else {
        api.goRecords?.('ming', nextSurface === 'records' ? 1 : 0)
        if (nextSurface === 'records') api.k12BookTab?.(1)
        else api.k12Tab?.('insights')
      }
    },
    { nextTheme: theme, nextSurface: surface },
  )
  const ready =
    surface === 'tutor'
      ? '#chatTutorView .chat-top.k12hd'
      : surface === 'records'
        ? '#k12ViewRecords'
        : '#k12BookPanel5'
  await expect(page.locator(ready)).toBeVisible()
  if (surface === 'insights') {
    // 原型脚本会用本地练习篮把静态 6 覆盖为 1；pair 以同一份报告快照为准。
    await page.locator('[data-insights-practice="ming"]').evaluate((node) => {
      node.textContent = '6'
    })
  }
}

async function openSource(page: Page, theme: Theme, surface: Surface) {
  await page.goto(`/chat?role=mingming&roleTitle=${encodeURIComponent('小明的辅导助手')}`)
  if (theme === 'dark') {
    await page.evaluate(() => localStorage.setItem('hc-theme', 'dark'))
    await page.reload()
  }
  await expect(page.locator('.k12enh-seg')).toBeVisible({ timeout: 30_000 })
  if (surface === 'records') {
    await page.getByRole('tab', { name: '学习档案', exact: true }).click()
    await expect(page.locator('.k12rec')).toBeVisible()
    await page.getByTestId('subtab-mistakes').click()
    await expect(page.getByTestId('mistakes-section')).toBeVisible()
    await expect(page.locator('.k12mistakes .rl-row')).toHaveCount(7)
  } else if (surface === 'insights') {
    await page.getByRole('tab', { name: '学情', exact: true }).click()
    await expect(page.getByTestId('insight-priority-card')).toBeVisible()
  } else {
    await expect(page.getByTestId('k12-photo-assistant-message')).toBeVisible({ timeout: 30_000 })
  }
  await expect(page.locator('body')).toHaveAttribute('data-k12-skin-active', 'k12')
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
}

async function visualFacts(page: Page, implementation: boolean, surface: Surface) {
  return page.evaluate(
    ({ isImplementation, nextSurface }) => {
      const normalize = (value: string | null | undefined) =>
        (value ?? '').replace(/\s+/g, ' ').trim()
      const box = (selector: string) => {
        const node = document.querySelector<HTMLElement>(selector)
        if (!node) return null
        const rect = node.getBoundingClientRect()
        const style = getComputedStyle(node)
        return {
          selector,
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          display: style.display,
          visibility: style.visibility,
          opacity: style.opacity,
          backgroundColor: style.backgroundColor,
          backgroundImage: style.backgroundImage,
          backdropFilter: style.getPropertyValue('backdrop-filter'),
          webkitBackdropFilter: style.getPropertyValue('-webkit-backdrop-filter'),
          overflowX: style.overflowX,
          overflowY: style.overflowY,
        }
      }
      const sessionSelector = isImplementation ? '.hc-chat__sidebar' : '.chat-sessions'
      const sessionBox = document
        .querySelector<HTMLElement>(sessionSelector)
        ?.getBoundingClientRect()
      const ambientSelector = isImplementation ? '.k12-ambient-butterfly' : '.k12-ambient-butterfly'
      const ambient = Array.from(document.querySelectorAll<HTMLElement>(ambientSelector)).map(
        (node) => {
          const rect = node.getBoundingClientRect()
          const intersectsSession = sessionBox
            ? rect.right > sessionBox.left &&
              rect.left < sessionBox.right &&
              rect.bottom > sessionBox.top &&
              rect.top < sessionBox.bottom
            : false
          return {
            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            intersectsSession,
          }
        },
      )

      const sectionNodes = isImplementation
        ? Array.from(document.querySelectorAll<HTMLElement>('.hc-sessions__section'))
        : (() => {
            const list = document.querySelector<HTMLElement>('#prototypeSessionList')
            const sections: HTMLElement[] = []
            let current: HTMLElement | null = null
            for (const child of Array.from(list?.children ?? [])) {
              if (!(child instanceof HTMLElement)) continue
              if (child.classList.contains('cs-label')) {
                current = document.createElement('section')
                current.dataset.label = normalize(child.textContent)
                sections.push(current)
              } else if (child.classList.contains('cs-item') && current) {
                current.append(child.cloneNode(true))
              }
            }
            return sections
          })()
      const sessionSections = sectionNodes.map((section) => {
        const items = Array.from(
          section.querySelectorAll<HTMLElement>(
            isImplementation ? ':scope > .hc-sessions__item' : ':scope > .cs-item',
          ),
        )
        return {
          label: isImplementation
            ? normalize(section.querySelector('.hc-sessions__section-label')?.textContent)
            : section.dataset.label,
          items: items.map((item) => ({
            title: normalize(
              item.querySelector(isImplementation ? '.hc-sessions__title' : '.cs-t')?.textContent,
            ),
            meta: normalize(
              item.querySelector(
                isImplementation ? '.hc-sessions__time' : '.cs-m > span:first-child',
              )?.textContent,
            ),
            count: normalize(
              item.querySelector(isImplementation ? '.hc-sessions__count' : '.cs-cnt')?.textContent,
            ),
            pinned: isImplementation
              ? item.classList.contains('hc-sessions__item--pinned')
              : item.dataset.pinned === 'true',
          })),
        }
      })

      const records = Array.from(
        document.querySelectorAll<HTMLElement>(
          isImplementation ? '.k12mistakes .rl-row' : '#k12MistakeList .resource-row',
        ),
      )
        .filter(
          (row) =>
            row.getClientRects().length > 0 &&
            getComputedStyle(row).visibility !== 'hidden' &&
            getComputedStyle(row).display !== 'none',
        )
        .map((row) => {
          const currentPracticeText = normalize(
            Array.from(
              row.querySelectorAll<HTMLElement>(
                '[data-testid^="mistake-practice-"], [data-testid^="mistake-view-practice-"]',
              ),
            )
              .map((node) => node.textContent)
              .join(' '),
          )
          const currentPractice = currentPracticeText.includes('已加入练习集')
            ? 'joined'
            : currentPracticeText.includes('出题失败')
              ? 'failed'
              : currentPracticeText.includes('再次加入')
                ? 're_add'
                : currentPracticeText.includes('加入练习集')
                  ? 'available'
                  : 'hidden'
          return {
            key: isImplementation ? row.dataset.recordId : (row.dataset.mistakeKey ?? 'm-position'),
            date: normalize(
              row.querySelector(isImplementation ? '.rl-date' : ':scope > span:first-child')
                ?.textContent,
            ),
            title: normalize(row.querySelector(isImplementation ? '.rl-title' : 'b')?.textContent),
            knowledge: normalize(
              row.querySelector(isImplementation ? '.rl-chip' : '.kpill')?.textContent,
            ),
            meta: normalize(row.querySelector(isImplementation ? '.rl-meta' : '.sp')?.textContent),
            source: normalize(
              row.querySelector(isImplementation ? '.rl-source' : '.srctag')?.textContent,
            ),
            status: normalize(
              row.querySelector(isImplementation ? '.rl-status' : '.stpill')?.textContent,
            ),
            practice: isImplementation ? currentPractice : (row.dataset.practiceState ?? 'hidden'),
          }
        })

      const insightRoot = isImplementation
        ? '[data-testid="insight-panel"]'
        : '#k12BookPanel5 [data-learner-panel]:not([hidden])'
      const insight = {
        tiles: Array.from(
          document.querySelectorAll<HTMLElement>(
            isImplementation ? '[data-testid^="insight-tile-"]' : `${insightRoot} .mini-tile`,
          ),
        ).map((node) => normalize(node.textContent)),
        bars: Array.from(
          document.querySelectorAll<HTMLElement>(
            isImplementation ? '[data-testid="insight-weak-bar"]' : `${insightRoot} .k12bar`,
          ),
        ).map((node) => normalize(node.textContent)),
        actions: Array.from(
          document.querySelectorAll<HTMLElement>(
            isImplementation
              ? '[data-testid="insight-setback-action"], [data-testid="insight-week-action"]'
              : `${insightRoot} .k12-insight-action`,
          ),
        ).map((node) => normalize(node.innerText)),
      }
      return {
        viewport: {
          width: innerWidth,
          height: innerHeight,
          dpr: devicePixelRatio,
          locale: navigator.language,
        },
        theme: document.documentElement.dataset.theme,
        surface: nextSurface,
        sidebar: box(isImplementation ? '.hc-sidebar' : '.sb'),
        sessionSidebar: box(sessionSelector),
        main: box(isImplementation ? '.hc-app__content' : '.mn'),
        mainScene: box(isImplementation ? '.k12-global-presentation__main-scene' : '.mn'),
        sidebarScene: box(
          isImplementation ? '.k12-global-presentation__sidebar-scene' : '.k12-sidebar-art',
        ),
        records: box(isImplementation ? '.k12rec' : '#k12ViewRecords'),
        insights: box(isImplementation ? '[data-testid="insight-panel"]' : '#k12BookPanel5'),
        tiles: box(isImplementation ? '.k12ins__tiles' : '#k12BookPanel5 .mini-grid'),
        priority: box(
          isImplementation
            ? '[data-testid="insight-priority-card"]'
            : '#k12BookPanel5 .k12-priority-card',
        ),
        ambient,
        fireflyCount: document.querySelectorAll('.k12-ambient-firefly').length,
        blackboardCount: document.querySelectorAll(
          '[data-k12-blackboard],.k12-blackboard,.k12-board',
        ).length,
        semantic: {
          sessionSections,
          tutor: {
            p52Visible: normalize(document.body.textContent).includes('数学练习册 P52'),
            taskVisible: isImplementation
              ? Boolean(document.querySelector('[data-testid="k12-photo-assistant-message"]'))
              : Boolean(document.querySelector('#k12ThreadMing [data-k12-task-shell]')),
          },
          records,
          insight,
        },
      }
    },
    { isImplementation: implementation, nextSurface: surface },
  )
}

function comparableSemantic(surface: Surface, reference: any, current: any) {
  const differences: Array<{ field: string; reference: unknown; current: unknown }> = []
  const compare = (field: string, left: unknown, right: unknown) => {
    if (JSON.stringify(left) !== JSON.stringify(right)) {
      differences.push({ field, reference: left, current: right })
    }
  }
  compare('sessionSections', reference.semantic.sessionSections, current.semantic.sessionSections)
  if (surface === 'tutor') compare('tutor', reference.semantic.tutor, current.semantic.tutor)
  if (surface === 'records')
    compare('records', reference.semantic.records, current.semantic.records)
  if (surface === 'insights')
    compare('insight', reference.semantic.insight, current.semantic.insight)
  return { comparable: differences.length === 0, differences }
}

function bugInvariants(surface: Surface, reference: any, current: any) {
  const tolerance = 0.01
  const session = current.sessionSidebar?.rect
  const bugs: Record<string, { status: 'PASS' | 'NOT_PASS'; facts: unknown }> = {}
  if (surface === 'tutor') {
    const ambienceOutsideSession = current.ambient.every(
      (item: { intersectsSession: boolean }) => !item.intersectsSession,
    )
    const sessionOpaque =
      current.sessionSidebar?.backdropFilter === 'none' &&
      ['', 'none'].includes(current.sessionSidebar?.webkitBackdropFilter ?? '')
    bugs['BUG-20260801-007'] = {
      status: ambienceOutsideSession && sessionOpaque ? 'PASS' : 'NOT_PASS',
      facts: {
        ambienceOutsideSession,
        sessionOpaque,
        ambient: current.ambient,
        sessionSidebar: current.sessionSidebar,
      },
    }
    const desktopWidth = session?.width === 256 && reference.sessionSidebar?.rect.width === 256
    bugs['BUG-20260801-008'] = {
      status: desktopWidth ? 'PASS' : 'NOT_PASS',
      facts: {
        referenceWidth: reference.sessionSidebar?.rect.width,
        currentWidth: session?.width,
      },
    }
  }
  if (surface === 'insights') {
    const priorityAligned =
      Math.abs((current.priority?.rect.x ?? -1) - (current.tiles?.rect.x ?? -2)) <= tolerance &&
      Math.abs((current.priority?.rect.width ?? -1) - (current.tiles?.rect.width ?? -2)) <=
        tolerance &&
      current.priority?.rect.width === 1024
    bugs['BUG-20260801-009'] = {
      status: priorityAligned ? 'PASS' : 'NOT_PASS',
      facts: { priority: current.priority, tiles: current.tiles },
    }
  }
  const mainUsesContentMaster = /k12-content-(?:light|dark)(?:-[A-Za-z0-9_-]+)?\.png/.test(
    current.mainScene?.backgroundImage ?? '',
  )
  const mainRejectsSidebarMaster = !/k12-scene-(?:light|dark)\./.test(
    current.mainScene?.backgroundImage ?? '',
  )
  bugs['BUG-20260801-010'] = {
    status: mainUsesContentMaster && mainRejectsSidebarMaster ? 'PASS' : 'NOT_PASS',
    facts: {
      mainUsesContentMaster,
      mainRejectsSidebarMaster,
      mainScene: current.mainScene,
      sidebarScene: current.sidebarScene,
    },
  }
  return bugs
}

test.describe.configure({ mode: 'serial' })
test.use({ trace: 'off', screenshot: 'off' })

const captureResults: any[] = []

for (const theme of ['light', 'dark'] as const) {
  for (const surface of ['tutor', 'records', 'insights'] as const) {
    test(`007/008/009/010 current-source pair: ${theme} ${surface}`, async ({ browser }) => {
      test.setTimeout(90_000)
      await mkdir(evidenceRoot, { recursive: true })
      const contextOptions = {
        viewport,
        deviceScaleFactor: 1,
        locale: 'zh-CN',
        timezoneId: 'Asia/Shanghai',
        reducedMotion: 'reduce' as const,
      }
      const referenceContext = await browser.newContext(contextOptions)
      const sourceContext = await browser.newContext({ ...contextOptions, baseURL: sourceURL })
      const reference = await referenceContext.newPage()
      const current = await sourceContext.newPage()
      try {
        await installSourceFixture(current)
        await openReference(reference, theme, surface)
        await openSource(current, theme, surface)
        await Promise.all([reference.mouse.move(1100, 20), current.mouse.move(1100, 20)])

        const stem = `${theme}-${surface}-2048x924-dpr1-zh-CN`
        const referencePath = path.join(evidenceRoot, `reference-${stem}.png`)
        const currentPath = path.join(evidenceRoot, `current-${stem}.png`)
        const diffPath = path.join(evidenceRoot, `diff-${stem}.png`)
        await Promise.all([
          reference.screenshot({ path: referencePath, animations: 'disabled' }),
          current.screenshot({ path: currentPath, animations: 'disabled' }),
        ])
        const [referenceFacts, currentFacts] = await Promise.all([
          visualFacts(reference, false, surface),
          visualFacts(current, true, surface),
        ])
        const semantic = comparableSemantic(surface, referenceFacts, currentFacts)
        const invariants = bugInvariants(surface, referenceFacts, currentFacts)
        const pixel = await pixelDiff(
          referencePath,
          currentPath,
          diffPath,
          targetPixelRegions(surface, referenceFacts, currentFacts),
        )
        const attribution = targetAttribution(surface, referenceFacts, currentFacts, pixel)
        const materialPixelDifference = pixel.changed_pixel_ratio > 0.01
        const result = {
          theme,
          surface,
          fixedCapture: { viewport, dpr: 1, locale: 'zh-CN', timezone: 'Asia/Shanghai' },
          semantic,
          pixel,
          materialPixelDifference,
          bugInvariants: invariants,
          targetAttribution: attribution,
        }
        await writeFile(
          path.join(evidenceRoot, `bbox-computed-${stem}.json`),
          `${JSON.stringify({ reference: referenceFacts, current: currentFacts }, null, 2)}\n`,
        )
        await writeFile(
          path.join(evidenceRoot, `semantic-${stem}.json`),
          `${JSON.stringify({ semantic, fixture: { sessions, mistakes, insightReport } }, null, 2)}\n`,
        )
        await writeFile(
          path.join(evidenceRoot, `pixel-${stem}.json`),
          `${JSON.stringify(pixel, null, 2)}\n`,
        )
        await writeFile(
          path.join(evidenceRoot, `target-attribution-${stem}.json`),
          `${JSON.stringify(attribution, null, 2)}\n`,
        )
        captureResults.push(result)

        expect(referenceFacts.viewport).toEqual({
          width: viewport.width,
          height: viewport.height,
          dpr: 1,
          locale: 'zh-CN',
        })
        expect(currentFacts.viewport).toEqual(referenceFacts.viewport)
        expect(currentFacts.theme).toBe(theme)
        expect(currentFacts.semantic.sessionSections).toHaveLength(3)
        expect(
          currentFacts.semantic.sessionSections.reduce(
            (count: number, section: { items: unknown[] }) => count + section.items.length,
            0,
          ),
        ).toBe(12)
      } finally {
        await referenceContext.close()
        await sourceContext.close()
      }
    })
  }
}

test.afterAll(async () => {
  const assetPairs = await backgroundAssetParity()
  await writeFile(
    path.join(evidenceRoot, 'asset-hashes.json'),
    `${JSON.stringify({ algorithm: 'SHA-256', pairs: assetPairs }, null, 2)}\n`,
  )
  const bugResults = [
    'BUG-20260801-007',
    'BUG-20260801-008',
    'BUG-20260801-009',
    'BUG-20260801-010',
  ].map((bug) => {
    const observations = captureResults.flatMap((entry) =>
      entry.bugInvariants[bug] ? [entry.bugInvariants[bug]] : [],
    )
    return {
      bug,
      status:
        observations.length > 0 && observations.every((item) => item.status === 'PASS')
          ? 'PASS'
          : 'NOT_PASS',
      observations,
    }
  })
  const summary = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    scope: ['BUG-20260801-007', 'BUG-20260801-008', 'BUG-20260801-009', 'BUG-20260801-010'],
    fixtureBoundary: 'public current-source HTTP routes; no production DOM mutation',
    captures: captureResults,
    bugResults,
    visualGate: {
      status:
        captureResults.length === 6 &&
        captureResults.every((entry) => entry.semantic.comparable) &&
        bugResults.every((entry) => entry.status === 'PASS') &&
        assetPairs.every((entry) => entry.identical)
          ? 'PASS'
          : 'NOT_PASS',
      rule: 'Fixture semantics must be equal; each issue is judged only on its approved target bbox/computed-style invariant; BUG-20260801-010 additionally requires byte-identical authoritative background assets.',
    },
    fullPageDiagnostic: {
      status: captureResults.every((entry) => !entry.materialPixelDifference)
        ? 'NO_MATERIAL_DIFFERENCE'
        : 'MATERIAL_DIFFERENCE_OUTSIDE_SCOPED_BUG_INVARIANTS',
      captures: captureResults.map(({ theme, surface, pixel }) => ({
        theme,
        surface,
        changedPixelRatio: pixel.changed_pixel_ratio,
      })),
      attribution:
        'Full-page diffs include navigation chrome, session-item presentation, foreground task/record cards, typography and other page composition. Those pixels remain visible evidence but are not assigned to BUG-20260801-007/008/009/010.',
    },
  }
  await writeFile(
    path.join(evidenceRoot, 'browser-summary.json'),
    `${JSON.stringify(summary, null, 2)}\n`,
  )
  expect(bugResults.map((entry) => entry.status)).toEqual(['PASS', 'PASS', 'PASS', 'PASS'])
})
