import { createHash } from 'node:crypto'

import type { BBox, GradeResp } from '../../src/api/k12'
import { gradeToVerify } from '../../src/features/k12/mappers'
import { isValidGradingBBox } from '../../src/features/k12/graded-photo'

type Json = Record<string, unknown>

export interface PhotoAnnotationCoverage {
  /** Number of final result items that the overlay is required to account for. */
  evaluated: number
  /** Whether the same artifact is safe for the production WebView to render. */
  immutableArtifact: boolean
  /**
   * Items with a trusted, in-scope coordinate.  With an immutable artifact
   * they are baked into that artifact; otherwise PhotoGradeOverlay renders
   * one DOM mark for each item.
   */
  artifactCoverage: number
  /** Items that must be represented by one DOM degraded row, never a mark. */
  degradedCoverage: number
}

export type PhotoAnnotationTone = 'green' | 'purple' | 'red'

export type PhotoAnnotationOracleStatus =
  | 'correct'
  | 'correct_with_process_issue'
  | 'wrong'
  | 'unanswered'
  | 'out_of_scope'
  | 'untrusted'
  | 'failed'

export interface PhotoAnnotationPixelDelta {
  x: number
  y: number
  source: readonly [number, number, number, number]
  annotated: readonly [number, number, number, number]
}

export interface PhotoAnnotationExpectedItem {
  identity: string
  status: PhotoAnnotationOracleStatus
  bbox?: BBox | null
}

export interface PhotoAnnotationExpectedCounts {
  green: number
  purple: number
  red: number
  no_mark: number
}

export interface PhotoAnnotationGeometryInput {
  width: number
  height: number
  sourceDigest: string
  annotatedDigest: string
  changedPixels: readonly PhotoAnnotationPixelDelta[]
  items: readonly PhotoAnnotationExpectedItem[]
  expectedCounts: PhotoAnnotationExpectedCounts
}

export interface PhotoAnnotationGeometryReport {
  schema_version: 1
  status: 'PASS'
  source_digest: string
  annotated_digest: string
  width: number
  height: number
  changed_pixels: number
  palette_pixels: number
  ignored_changed_pixels: number
  ignored_changed_pixel_ratio: number
  max_ignored_changed_pixel_ratio: number
  discarded_palette_noise_pixels: number
  expected_counts: PhotoAnnotationExpectedCounts
  observed_counts: PhotoAnnotationExpectedCounts
  mappings: Array<{
    identity_sha256: string
    bbox_sha256: string
    cluster_sha256: string
    tone: PhotoAnnotationTone
    expected_anchor: [number, number]
    cluster_bbox: [number, number, number, number]
    cluster_centroid: [number, number]
    distance_px: number
    cluster_pixels: number
    antialiased_pixels: number
  }>
  no_mark_items: Array<{
    identity_sha256: string
    bbox_sha256: string | null
  }>
}

const OVERLAY_ITEM_STATUSES = new Set([
  'correct',
  'correct_with_process_issue',
  'wrong',
  'out_of_scope',
  'untrusted',
])
const SAFE_ANNOTATED_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp'])

function asRecord(value: unknown, label: string): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as Json
}

function renderableImmutableArtifact(value: unknown): boolean {
  if (value === undefined) return false
  const image = asRecord(value, 'annotated_image')
  const mime = typeof image.mime === 'string' ? image.mime.trim().toLowerCase() : ''
  const payload = typeof image.data_base64 === 'string' ? image.data_base64.replace(/\s/g, '') : ''
  if (
    !SAFE_ANNOTATED_IMAGE_MIMES.has(mime) ||
    !payload ||
    payload.length % 4 === 1 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(payload)
  ) {
    throw new Error('annotated_image is not renderable by the production WebView')
  }
  return true
}

function gradeVerdict(value: unknown, label: string): GradeResp['verdict'] {
  switch (value) {
    case 'agree':
    case 'disagree':
    case 'unverifiable':
    case 'out_of_scope':
    case 'verbatim':
      return value
    default:
      throw new Error(`${label} must be a valid GradeResp verdict`)
  }
}

function gradeEvidenceType(value: unknown, label: string): GradeResp['evidence_type'] {
  switch (value) {
    case 'numeric_exec':
    case 'symbolic_exec':
    case 'heterogeneous_model':
    case 'heuristic':
    case 'verbatim':
    case 'none':
      return value
    default:
      throw new Error(`${label} must be a valid GradeResp evidence_type`)
  }
}

function gradeBadge(value: unknown, label: string): GradeResp['badge'] {
  switch (value) {
    case 'verified-strong':
    case 'verified-weak':
    case 'disagree':
    case 'out-of-scope':
    case 'unverifiable':
    case 'verbatim-recall':
      return value
    default:
      throw new Error(`${label} must be a valid GradeResp badge`)
  }
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error(`${label} must be a string when present`)
  return value
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean when present`)
  return value
}

function optionalStringList(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`${label} must be a string array when present`)
  }
  return [...value]
}

function completeGrade(value: unknown, index: number): GradeResp {
  const label = `items[${index}].grade`
  const grade = asRecord(value, label)
  if (typeof grade.solution !== 'string' || typeof grade.out_of_scope !== 'boolean') {
    throw new Error(`${label} must be a complete GradeResp`)
  }
  if (typeof grade.record_created !== 'boolean') {
    throw new Error(`${label} must be a complete GradeResp`)
  }

  const wrongStep = optionalString(grade.wrong_step, `${label}.wrong_step`)
  const errorCause = optionalString(grade.error_cause, `${label}.error_cause`)
  const outOfScopeKnowledgePoint = optionalString(grade.out_of_scope_kp, `${label}.out_of_scope_kp`)
  const recordID = optionalString(grade.record_id, `${label}.record_id`)
  const curriculumUnmapped = optionalStringList(
    grade.curriculum_unmapped,
    `${label}.curriculum_unmapped`,
  )
  const solveOnly = optionalBoolean(grade.solve_only, `${label}.solve_only`)

  return {
    solution: grade.solution,
    verdict: gradeVerdict(grade.verdict, `${label}.verdict`),
    evidence_type: gradeEvidenceType(grade.evidence_type, `${label}.evidence_type`),
    badge: gradeBadge(grade.badge, `${label}.badge`),
    out_of_scope: grade.out_of_scope,
    record_created: grade.record_created,
    ...(wrongStep === undefined ? {} : { wrong_step: wrongStep }),
    ...(errorCause === undefined ? {} : { error_cause: errorCause }),
    ...(outOfScopeKnowledgePoint === undefined
      ? {}
      : { out_of_scope_kp: outOfScopeKnowledgePoint }),
    ...(recordID === undefined ? {} : { record_id: recordID }),
    ...(curriculumUnmapped === undefined ? {} : { curriculum_unmapped: curriculumUnmapped }),
    ...(solveOnly === undefined ? {} : { solve_only: solveOnly }),
  }
}

function overlayOutOfScope(value: unknown, index: number): boolean {
  return gradeToVerify(completeGrade(value, index)).verdict === 'out_of_scope'
}

/**
 * Mirrors the two production overlay branches without reading image pixels or
 * model text. The live caller separately verifies item identities and the
 * immutable artifact's wire digest before it uses this coverage summary.
 */
export function summarizePhotoAnnotationCoverage(value: unknown): PhotoAnnotationCoverage {
  const payload = asRecord(value, 'homework payload')
  if (!Array.isArray(payload.items)) throw new Error('homework payload.items must be an array')

  let artifactCoverage = 0
  let degradedCoverage = 0
  for (const [index, value] of payload.items.entries()) {
    const item = asRecord(value, `items[${index}]`)
    if (typeof item.status !== 'string' || !OVERLAY_ITEM_STATUSES.has(item.status)) {
      throw new Error(`items[${index}] does not map to a completed-photo overlay mark`)
    }
    if (item.grade === undefined)
      throw new Error(`items[${index}] has no grade for its overlay mark`)

    const outOfScope = overlayOutOfScope(item.grade, index)
    if ((item.status === 'out_of_scope') !== outOfScope) {
      throw new Error(`items[${index}] status and grade disagree about out_of_scope`)
    }
    const question = asRecord(item.question, `items[${index}].question`)
    const positioned = !outOfScope && isValidGradingBBox(question.bbox as BBox | null | undefined)
    if (positioned) artifactCoverage += 1
    else degradedCoverage += 1
  }

  return {
    evaluated: payload.items.length,
    immutableArtifact: renderableImmutableArtifact(payload.annotated_image),
    artifactCoverage,
    degradedCoverage,
  }
}

type RGB = readonly [number, number, number]

interface ClassifiedPixel {
  x: number
  y: number
  tone: PhotoAnnotationTone
  antialiased: boolean
}

interface PixelCluster {
  tone: PhotoAnnotationTone
  pixels: ClassifiedPixel[]
  bbox: [number, number, number, number]
  centroid: [number, number]
  antialiasedPixels: number
}

interface ExpectedGeometryItem {
  identityHash: string
  bboxHash: string
  tone: PhotoAnnotationTone
  anchor: [number, number]
  radius: number
}

const PHOTO_ANNOTATION_PALETTE: Record<PhotoAnnotationTone, RGB> = {
  green: [22, 163, 74],
  purple: [165, 107, 214],
  red: [239, 68, 68],
}

const MARK_TONE_BY_STATUS: Partial<Record<PhotoAnnotationOracleStatus, PhotoAnnotationTone>> = {
  correct: 'green',
  correct_with_process_issue: 'purple',
  wrong: 'red',
}

const PHOTO_ANNOTATION_ORACLE_STATUSES = new Set<PhotoAnnotationOracleStatus>([
  'correct',
  'correct_with_process_issue',
  'wrong',
  'unanswered',
  'out_of_scope',
  'untrusted',
  'failed',
])

const SHA256_PATTERN = /^[a-f0-9]{64}$/
function sha256Text(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function normalizedSHA256(value: string, label: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/^sha256:/, '')
  if (!SHA256_PATTERN.test(normalized)) throw new Error(`${label} must be a SHA-256 digest`)
  return normalized
}

function validateExpectedCounts(value: PhotoAnnotationExpectedCounts): void {
  for (const [tone, count] of Object.entries(value)) {
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error(`expected ${tone} count must be a non-negative integer`)
    }
  }
}

function validChannel(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 255
}

function validatePixelDelta(
  pixel: PhotoAnnotationPixelDelta,
  index: number,
  width: number,
  height: number,
): void {
  if (
    !Number.isInteger(pixel.x) ||
    !Number.isInteger(pixel.y) ||
    pixel.x < 0 ||
    pixel.y < 0 ||
    pixel.x >= width ||
    pixel.y >= height
  ) {
    throw new Error(`changedPixels[${index}] is outside the image`)
  }
  if (pixel.source.length !== 4 || pixel.annotated.length !== 4) {
    throw new Error(`changedPixels[${index}] must contain two RGBA pixels`)
  }
  if ([...pixel.source, ...pixel.annotated].some((channel) => !validChannel(channel))) {
    throw new Error(`changedPixels[${index}] contains an invalid RGBA channel`)
  }
  if (pixel.source.every((channel, channelIndex) => channel === pixel.annotated[channelIndex])) {
    throw new Error(`changedPixels[${index}] does not change a pixel`)
  }
}

function squaredDistance(left: readonly number[], right: readonly number[]): number {
  let total = 0
  for (let index = 0; index < left.length; index += 1) {
    const delta = left[index]! - right[index]!
    total += delta * delta
  }
  return total
}

/**
 * 生产标记可能经过浏览器抗锯齿或 JPEG 边缘压缩。这里不要求像素等于基准色，
 * 而是验证“原像素沿着生产色方向混合”且重建残差足够小，避免把整图重编码噪声
 * 或原卷本来就有的彩色笔迹误算成批改标记。
 */
function classifyAnnotationPixel(pixel: PhotoAnnotationPixelDelta): ClassifiedPixel | null {
  const source: RGB = [pixel.source[0], pixel.source[1], pixel.source[2]]
  const annotated: RGB = [pixel.annotated[0], pixel.annotated[1], pixel.annotated[2]]
  let best:
    | { tone: PhotoAnnotationTone; residual: number; alpha: number; directedChange: number }
    | undefined

  for (const tone of Object.keys(PHOTO_ANNOTATION_PALETTE) as PhotoAnnotationTone[]) {
    const palette = PHOTO_ANNOTATION_PALETTE[tone]
    const paletteVector = palette.map((channel, index) => channel - source[index]!)
    const changedVector = annotated.map((channel, index) => channel - source[index]!)
    const denominator = paletteVector.reduce((sum, channel) => sum + channel * channel, 0)
    if (denominator < 400) continue
    const alpha =
      paletteVector.reduce((sum, channel, index) => sum + channel * changedVector[index]!, 0) /
      denominator
    if (alpha < 0.18 || alpha > 1.2) continue
    const reconstructed = source.map((channel, index) => channel + alpha * paletteVector[index]!)
    const residual = Math.sqrt(squaredDistance(annotated, reconstructed) / 3)
    const directedChange = Math.sqrt(denominator) * alpha
    if (residual > 24 || directedChange < 24) continue
    const candidate = { tone, residual, alpha, directedChange }
    if (
      !best ||
      candidate.residual < best.residual - 0.001 ||
      (Math.abs(candidate.residual - best.residual) <= 0.001 &&
        candidate.directedChange > best.directedChange)
    ) {
      best = candidate
    }
  }
  if (!best) return null
  return {
    x: pixel.x,
    y: pixel.y,
    tone: best.tone,
    antialiased: best.alpha < 0.92 || best.residual > 2,
  }
}

function clusterPixels(
  pixels: ClassifiedPixel[],
  width: number,
  height: number,
): { clusters: PixelCluster[]; discardedPixels: number } {
  const joinRadius = Math.max(2, Math.min(8, Math.round(Math.min(width, height) / 240)))
  const minimumClusterPixels = Math.max(12, Math.round(Math.min(width, height) / 90))
  const clusters: PixelCluster[] = []
  let discardedPixels = 0

  for (const tone of Object.keys(PHOTO_ANNOTATION_PALETTE) as PhotoAnnotationTone[]) {
    const tonePixels = pixels.filter((pixel) => pixel.tone === tone)
    const byCoordinate = new Map<string, number>()
    tonePixels.forEach((pixel, index) => byCoordinate.set(`${pixel.x}:${pixel.y}`, index))
    const visited = new Uint8Array(tonePixels.length)

    for (let start = 0; start < tonePixels.length; start += 1) {
      if (visited[start]) continue
      const queue = [start]
      const component: ClassifiedPixel[] = []
      visited[start] = 1
      for (let cursor = 0; cursor < queue.length; cursor += 1) {
        const current = tonePixels[queue[cursor]!]!
        component.push(current)
        for (let dy = -joinRadius; dy <= joinRadius; dy += 1) {
          for (let dx = -joinRadius; dx <= joinRadius; dx += 1) {
            if (dx * dx + dy * dy > joinRadius * joinRadius) continue
            const neighbor = byCoordinate.get(`${current.x + dx}:${current.y + dy}`)
            if (neighbor === undefined || visited[neighbor]) continue
            visited[neighbor] = 1
            queue.push(neighbor)
          }
        }
      }

      if (component.length < minimumClusterPixels) {
        discardedPixels += component.length
        continue
      }
      const xs = component.map((pixel) => pixel.x)
      const ys = component.map((pixel) => pixel.y)
      const sumX = xs.reduce((sum, value) => sum + value, 0)
      const sumY = ys.reduce((sum, value) => sum + value, 0)
      clusters.push({
        tone,
        pixels: component,
        bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs) + 1, Math.max(...ys) + 1],
        centroid: [sumX / component.length, sumY / component.length],
        antialiasedPixels: component.filter((pixel) => pixel.antialiased).length,
      })
    }
  }
  return { clusters, discardedPixels }
}

function annotationAnchor(
  bbox: BBox,
  width: number,
  height: number,
): {
  anchor: [number, number]
  radius: number
} {
  const radius = Math.min(42, Math.max(18, Math.floor(Math.min(width, height) / 45)))
  const y0 = Math.round(bbox.y * height)
  const x1 = Math.round((bbox.x + bbox.w) * width)
  const y1 = Math.round((bbox.y + bbox.h) * height)
  let x = Math.min(width - radius - 1, Math.max(radius + 1, x1))
  let y = y0 + Math.floor(((y1 - y0) * 2) / 5)
  y = Math.max(radius + 1, y)
  if (y + radius >= height) y = height - radius - 1
  x = Math.max(0, x)
  y = Math.max(0, y)
  return { anchor: [x, y], radius }
}

function bboxDigest(bbox: BBox): string {
  return sha256Text([bbox.x, bbox.y, bbox.w, bbox.h].map((value) => value.toFixed(8)).join(':'))
}

function clusterDigest(cluster: PixelCluster): string {
  return sha256Text(
    `${cluster.tone}:${cluster.bbox.join(':')}:${cluster.centroid
      .map((value) => value.toFixed(3))
      .join(':')}:${cluster.pixels.length}`,
  )
}

function distance(left: readonly [number, number], right: readonly [number, number]): number {
  return Math.hypot(left[0] - right[0], left[1] - right[1])
}

function minimumCostMatches(
  expected: ExpectedGeometryItem[],
  clusters: PixelCluster[],
): Array<{ item: ExpectedGeometryItem; cluster: PixelCluster; distance: number }> {
  if (expected.length !== clusters.length) {
    throw new Error(
      `annotation cluster count mismatch for ${expected[0]?.tone ?? 'tone'}: expected=${expected.length} observed=${clusters.length}`,
    )
  }
  if (expected.length === 0) return []
  if (expected.length > 20)
    throw new Error('annotation geometry oracle supports at most 20 marks per tone')

  const distances = expected.map((item) =>
    clusters.map((cluster) => distance(item.anchor, cluster.centroid)),
  )
  const memo = new Map<string, { cost: number; clusterIndex: number } | null>()
  const solve = (itemIndex: number, usedMask: number): number => {
    if (itemIndex === expected.length) return 0
    const key = `${itemIndex}:${usedMask}`
    const cached = memo.get(key)
    if (cached !== undefined) return cached?.cost ?? Number.POSITIVE_INFINITY
    const item = expected[itemIndex]!
    const tolerance = Math.max(24, item.radius * 2.75)
    let bestCost = Number.POSITIVE_INFINITY
    let bestCluster = -1
    for (let clusterIndex = 0; clusterIndex < clusters.length; clusterIndex += 1) {
      if (usedMask & (1 << clusterIndex)) continue
      const candidateDistance = distances[itemIndex]![clusterIndex]!
      if (candidateDistance > tolerance) continue
      const tailCost = solve(itemIndex + 1, usedMask | (1 << clusterIndex))
      const cost = candidateDistance + tailCost
      if (cost < bestCost) {
        bestCost = cost
        bestCluster = clusterIndex
      }
    }
    const result = Number.isFinite(bestCost) ? { cost: bestCost, clusterIndex: bestCluster } : null
    memo.set(key, result)
    return bestCost
  }

  if (!Number.isFinite(solve(0, 0))) {
    throw new Error(`annotation cluster is outside every trusted ${expected[0]!.tone} bbox anchor`)
  }
  const matches: Array<{ item: ExpectedGeometryItem; cluster: PixelCluster; distance: number }> = []
  let mask = 0
  for (let itemIndex = 0; itemIndex < expected.length; itemIndex += 1) {
    const decision = memo.get(`${itemIndex}:${mask}`)
    if (!decision) throw new Error('annotation geometry matching did not converge')
    const cluster = clusters[decision.clusterIndex]!
    matches.push({
      item: expected[itemIndex]!,
      cluster,
      distance: distances[itemIndex]![decision.clusterIndex]!,
    })
    mask |= 1 << decision.clusterIndex
  }
  return matches
}

function exactCounts(items: readonly PhotoAnnotationExpectedItem[]): PhotoAnnotationExpectedCounts {
  const counts: PhotoAnnotationExpectedCounts = { green: 0, purple: 0, red: 0, no_mark: 0 }
  for (const item of items) {
    const tone = MARK_TONE_BY_STATUS[item.status]
    if (tone && isValidGradingBBox(item.bbox)) counts[tone] += 1
    else counts.no_mark += 1
  }
  return counts
}

function countsEqual(
  left: PhotoAnnotationExpectedCounts,
  right: PhotoAnnotationExpectedCounts,
): boolean {
  return (
    left.green === right.green &&
    left.purple === right.purple &&
    left.red === right.red &&
    left.no_mark === right.no_mark
  )
}

/**
 * 对原图与不可变批注图的差异像素执行独立几何 Oracle：生产色按混合向量识别，
 * 同色像素合成逻辑簇，再把每个簇唯一分配给可信 bbox 的答案侧锚点。返回值只含
 * SHA-256、计数与像素几何，不包含题干、作答、模型正文、图片字节或 Base64。
 */
export function analyzePhotoAnnotationGeometry(
  input: PhotoAnnotationGeometryInput,
): PhotoAnnotationGeometryReport {
  if (!Number.isSafeInteger(input.width) || !Number.isSafeInteger(input.height)) {
    throw new Error('annotation image dimensions must be integers')
  }
  if (input.width <= 0 || input.height <= 0) {
    throw new Error('annotation image dimensions must be positive')
  }
  const sourceDigest = normalizedSHA256(input.sourceDigest, 'sourceDigest')
  const annotatedDigest = normalizedSHA256(input.annotatedDigest, 'annotatedDigest')
  if (sourceDigest === annotatedDigest) throw new Error('annotated image must differ from source')
  validateExpectedCounts(input.expectedCounts)
  if (input.changedPixels.length === 0) throw new Error('annotated image has no visible changes')

  const coordinateSet = new Set<string>()
  input.changedPixels.forEach((pixel, index) => {
    validatePixelDelta(pixel, index, input.width, input.height)
    const key = `${pixel.x}:${pixel.y}`
    if (coordinateSet.has(key)) throw new Error(`changedPixels[${index}] duplicates a coordinate`)
    coordinateSet.add(key)
  })

  const identities = new Set<string>()
  for (const [index, item] of input.items.entries()) {
    if (!item.identity.trim()) throw new Error(`items[${index}] has no canonical identity`)
    const identityHash = sha256Text(item.identity)
    if (identities.has(identityHash)) throw new Error(`items[${index}] duplicates an identity`)
    identities.add(identityHash)
    if (!PHOTO_ANNOTATION_ORACLE_STATUSES.has(item.status)) {
      throw new Error(`items[${index}] has an unsupported status`)
    }
  }

  const derivedCounts = exactCounts(input.items)
  if (!countsEqual(derivedCounts, input.expectedCounts)) {
    throw new Error(
      `frozen annotation counts disagree with trusted items: expected=${JSON.stringify(input.expectedCounts)} actual=${JSON.stringify(derivedCounts)}`,
    )
  }

  const classified = input.changedPixels
    .map((pixel) => classifyAnnotationPixel(pixel))
    .filter((pixel): pixel is ClassifiedPixel => pixel !== null)
  const ignoredChangedPixels = input.changedPixels.length - classified.length
  const ignoredChangedPixelRatio = ignoredChangedPixels / (input.width * input.height)
  if (ignoredChangedPixels !== 0) {
    throw new Error(
      `ignored changed pixels are outside the frozen annotation palette: ignored=${ignoredChangedPixels}`,
    )
  }
  const { clusters, discardedPixels } = clusterPixels(classified, input.width, input.height)
  if (discardedPixels !== 0) {
    throw new Error(
      `annotation-colored pixels are outside every frozen mark neighborhood: discarded=${discardedPixels}`,
    )
  }
  const observedCounts: PhotoAnnotationExpectedCounts = {
    green: clusters.filter((cluster) => cluster.tone === 'green').length,
    purple: clusters.filter((cluster) => cluster.tone === 'purple').length,
    red: clusters.filter((cluster) => cluster.tone === 'red').length,
    no_mark: derivedCounts.no_mark,
  }
  if (!countsEqual(observedCounts, input.expectedCounts)) {
    throw new Error(
      `annotation color-cluster counts disagree with frozen oracle: expected=${JSON.stringify(input.expectedCounts)} observed=${JSON.stringify(observedCounts)}`,
    )
  }

  const marked: ExpectedGeometryItem[] = []
  const noMarkItems: PhotoAnnotationGeometryReport['no_mark_items'] = []
  for (const item of input.items) {
    const identityHash = sha256Text(item.identity)
    const tone = MARK_TONE_BY_STATUS[item.status]
    if (!tone || !isValidGradingBBox(item.bbox)) {
      noMarkItems.push({
        identity_sha256: identityHash,
        bbox_sha256: isValidGradingBBox(item.bbox) ? bboxDigest(item.bbox) : null,
      })
      continue
    }
    const geometry = annotationAnchor(item.bbox, input.width, input.height)
    marked.push({
      identityHash,
      bboxHash: bboxDigest(item.bbox),
      tone,
      anchor: geometry.anchor,
      radius: geometry.radius,
    })
  }

  for (const noMark of input.items.filter(
    (item) => !MARK_TONE_BY_STATUS[item.status] || !isValidGradingBBox(item.bbox),
  )) {
    if (!isValidGradingBBox(noMark.bbox)) continue
    const geometry = annotationAnchor(noMark.bbox, input.width, input.height)
    const exclusionRadius = Math.max(16, geometry.radius * 1.2)
    if (
      clusters.some((cluster) => distance(geometry.anchor, cluster.centroid) <= exclusionRadius)
    ) {
      throw new Error(
        `no-mark item ${sha256Text(noMark.identity)} has an annotation cluster inside its bbox anchor`,
      )
    }
  }

  const mappings = (Object.keys(PHOTO_ANNOTATION_PALETTE) as PhotoAnnotationTone[])
    .flatMap((tone) =>
      minimumCostMatches(
        marked.filter((item) => item.tone === tone),
        clusters.filter((cluster) => cluster.tone === tone),
      ),
    )
    .map(({ item, cluster, distance: matchDistance }) => ({
      identity_sha256: item.identityHash,
      bbox_sha256: item.bboxHash,
      cluster_sha256: clusterDigest(cluster),
      tone: item.tone,
      expected_anchor: item.anchor,
      cluster_bbox: cluster.bbox,
      cluster_centroid: cluster.centroid.map((value) => Number(value.toFixed(3))) as [
        number,
        number,
      ],
      distance_px: Number(matchDistance.toFixed(3)),
      cluster_pixels: cluster.pixels.length,
      antialiased_pixels: cluster.antialiasedPixels,
    }))
    .sort((left, right) => left.identity_sha256.localeCompare(right.identity_sha256))

  return {
    schema_version: 1,
    status: 'PASS',
    source_digest: sourceDigest,
    annotated_digest: annotatedDigest,
    width: input.width,
    height: input.height,
    changed_pixels: input.changedPixels.length,
    palette_pixels: classified.length,
    ignored_changed_pixels: ignoredChangedPixels,
    ignored_changed_pixel_ratio: Number(ignoredChangedPixelRatio.toFixed(8)),
    max_ignored_changed_pixel_ratio: 0,
    discarded_palette_noise_pixels: discardedPixels,
    expected_counts: { ...input.expectedCounts },
    observed_counts: observedCounts,
    mappings,
    no_mark_items: noMarkItems.sort((left, right) =>
      left.identity_sha256.localeCompare(right.identity_sha256),
    ),
  }
}
