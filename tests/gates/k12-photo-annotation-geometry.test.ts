import { describe, expect, test } from 'vitest'

import {
  analyzePhotoAnnotationGeometry,
  type PhotoAnnotationGeometryInput,
  type PhotoAnnotationPixelDelta,
} from '../live/k12-photo-annotation-coverage'

const WHITE = [255, 255, 255, 255] as const
const GREEN = [22, 163, 74, 255] as const
const PURPLE = [165, 107, 214, 255] as const
const RED = [239, 68, 68, 255] as const

type Tone = 'green' | 'purple' | 'red'

const PALETTE = { green: GREEN, purple: PURPLE, red: RED } as const

function pixel(x: number, y: number): PhotoAnnotationPixelDelta {
  return { x, y, source: WHITE, annotated: GREEN }
}

function displacedGreenInput(): PhotoAnnotationGeometryInput {
  return {
    width: 480,
    height: 480,
    sourceDigest: 'a'.repeat(64),
    annotatedDigest: 'b'.repeat(64),
    changedPixels: [pixel(418, 418), pixel(419, 418), pixel(418, 419), pixel(419, 419)],
    items: [
      {
        identity: 'attempt-clear-1',
        status: 'correct',
        bbox: { x: 0.1, y: 0.1, w: 0.2, h: 0.1 },
      },
    ],
    expectedCounts: { green: 1, purple: 0, red: 0, no_mark: 0 },
    maxIgnoredChangedPixelRatio: 0,
  }
}

function blend(
  source: readonly [number, number, number, number],
  target: readonly [number, number, number, number],
  alpha: number,
): readonly [number, number, number, number] {
  return [
    Math.round(source[0] + (target[0] - source[0]) * alpha),
    Math.round(source[1] + (target[1] - source[1]) * alpha),
    Math.round(source[2] + (target[2] - source[2]) * alpha),
    255,
  ]
}

function cluster(centerX: number, centerY: number, tone: Tone): PhotoAnnotationPixelDelta[] {
  const pixels: PhotoAnnotationPixelDelta[] = []
  for (let y = -2; y <= 2; y += 1) {
    for (let x = -2; x <= 2; x += 1) {
      if (Math.abs(x) === 2 && Math.abs(y) === 2) continue
      const antialiased = Math.abs(x) === 2 || Math.abs(y) === 2
      pixels.push({
        x: centerX + x,
        y: centerY + y,
        source: WHITE,
        annotated: antialiased ? blend(WHITE, PALETTE[tone], 0.35) : PALETTE[tone],
      })
    }
  }
  return pixels
}

function frozenSheetInput(
  statuses: Array<'correct' | 'correct_with_process_issue' | 'wrong' | 'unanswered'>,
  expectedCounts: PhotoAnnotationGeometryInput['expectedCounts'],
): PhotoAnnotationGeometryInput {
  const width = 900
  const height = 1200
  const items = statuses.map((status, index) => {
    const column = index % 4
    const row = Math.floor(index / 4)
    return {
      identity: `canonical-attempt-${index + 1}`,
      status,
      bbox: {
        x: 0.04 + column * 0.22,
        y: 0.04 + row * 0.22,
        w: 0.08,
        h: 0.07,
      },
    } as const
  })
  const changedPixels = items.flatMap((item) => {
    const tone =
      item.status === 'correct'
        ? 'green'
        : item.status === 'correct_with_process_issue'
          ? 'purple'
          : item.status === 'wrong'
            ? 'red'
            : undefined
    if (!tone) return []
    const x = Math.round((item.bbox.x + item.bbox.w) * width)
    const y0 = Math.round(item.bbox.y * height)
    const y1 = Math.round((item.bbox.y + item.bbox.h) * height)
    return cluster(x, y0 + Math.floor(((y1 - y0) * 2) / 5), tone)
  })
  return {
    width,
    height,
    sourceDigest: 'c'.repeat(64),
    annotatedDigest: 'd'.repeat(64),
    changedPixels,
    items,
    expectedCounts,
    maxIgnoredChangedPixelRatio: 0,
  }
}

describe('BUG-K12-GRADING-ANNOTATION-REAL-ORACLE-20260824', () => {
  test('a displaced mark is rejected even though the legacy changed-pixel predicate passes', () => {
    const input = displacedGreenInput()

    expect(input.changedPixels.length).toBeGreaterThan(0)
    expect(() => analyzePhotoAnnotationGeometry(input)).toThrow(/outside|match|cluster/i)
  })

  test('clear sheet freezes 14 green and 2 purple clusters with one hashed bbox mapping each', () => {
    const input = frozenSheetInput(
      [
        ...Array.from({ length: 14 }, () => 'correct' as const),
        'correct_with_process_issue',
        'correct_with_process_issue',
      ],
      { green: 14, purple: 2, red: 0, no_mark: 0 },
    )

    const report = analyzePhotoAnnotationGeometry(input)

    expect(report.observed_counts).toEqual({ green: 14, purple: 2, red: 0, no_mark: 0 })
    expect(report.ignored_changed_pixels).toBe(0)
    expect(report.ignored_changed_pixel_ratio).toBe(0)
    expect(report.max_ignored_changed_pixel_ratio).toBe(0)
    expect(report.mappings).toHaveLength(16)
    expect(new Set(report.mappings.map((mapping) => mapping.identity_sha256))).toHaveLength(16)
    expect(new Set(report.mappings.map((mapping) => mapping.cluster_sha256))).toHaveLength(16)
    expect(report.mappings.every((mapping) => mapping.antialiased_pixels > 0)).toBe(true)
    expect(report.no_mark_items).toEqual([])
    const serialized = JSON.stringify(report)
    expect(serialized).not.toContain('canonical-attempt-')
    expect(serialized).not.toContain('"source":[')
    expect(serialized).not.toContain('"annotated":[')
    expect(serialized).not.toContain('base64')
  })

  test('messy sheet freezes 12 green, 3 red, and one unanswered identity with no cluster', () => {
    const input = frozenSheetInput(
      Array.from({ length: 16 }, (_, index) => {
        const ordinal = index + 1
        if ([8, 10, 15].includes(ordinal)) return 'wrong' as const
        if (ordinal === 16) return 'unanswered' as const
        return 'correct' as const
      }),
      { green: 12, purple: 0, red: 3, no_mark: 1 },
    )

    const report = analyzePhotoAnnotationGeometry(input)

    expect(
      input.items.flatMap((item, index) => (item.status === 'wrong' ? [index + 1] : [])),
    ).toEqual([8, 10, 15])
    expect(input.items[15]?.status).toBe('unanswered')
    expect(report.observed_counts).toEqual({ green: 12, purple: 0, red: 3, no_mark: 1 })
    expect(report.mappings).toHaveLength(15)
    expect(report.no_mark_items).toHaveLength(1)
    expect(report.no_mark_items[0]?.identity_sha256).toMatch(/^[a-f0-9]{64}$/)
  })

  test('a red cluster cannot satisfy a frozen green verdict', () => {
    const input = frozenSheetInput(['correct'], { green: 1, purple: 0, red: 0, no_mark: 0 })
    const bbox = input.items[0]!.bbox!
    const x = Math.round((bbox.x + bbox.w) * input.width)
    const y0 = Math.round(bbox.y * input.height)
    const y1 = Math.round((bbox.y + bbox.h) * input.height)
    const wrongColor = cluster(x, y0 + Math.floor(((y1 - y0) * 2) / 5), 'red')

    expect(() => analyzePhotoAnnotationGeometry({ ...input, changedPixels: wrongColor })).toThrow(
      /color-cluster counts/i,
    )
  })

  test('moving one red mark onto the unanswered bbox cannot pass by preserving color totals', () => {
    const input = frozenSheetInput(
      Array.from({ length: 16 }, (_, index) => {
        const ordinal = index + 1
        if ([8, 10, 15].includes(ordinal)) return 'wrong' as const
        if (ordinal === 16) return 'unanswered' as const
        return 'correct' as const
      }),
      { green: 12, purple: 0, red: 3, no_mark: 1 },
    )
    const wrong = input.items[14]!.bbox!
    const unanswered = input.items[15]!.bbox!
    const center = (bbox: typeof wrong) => {
      const x = Math.round((bbox.x + bbox.w) * input.width)
      const y0 = Math.round(bbox.y * input.height)
      const y1 = Math.round((bbox.y + bbox.h) * input.height)
      return [x, y0 + Math.floor(((y1 - y0) * 2) / 5)] as const
    }
    const wrongCenter = center(wrong)
    const unansweredCenter = center(unanswered)
    const moved = input.changedPixels.filter(
      (value) => Math.hypot(value.x - wrongCenter[0], value.y - wrongCenter[1]) > 8,
    )
    moved.push(...cluster(unansweredCenter[0], unansweredCenter[1], 'red'))

    expect(() => analyzePhotoAnnotationGeometry({ ...input, changedPixels: moved })).toThrow(
      /outside|no-mark|bbox anchor/i,
    )
  })

  test('any changed pixel outside the frozen annotation palette is rejected without a page-wide allowance', () => {
    const input = frozenSheetInput(['correct'], { green: 1, purple: 0, red: 0, no_mark: 0 })
    const ignored: PhotoAnnotationPixelDelta = {
      x: 400,
      y: 400,
      source: WHITE,
      annotated: [255, 255, 255, 0],
    }

    expect(() =>
      analyzePhotoAnnotationGeometry({
        ...input,
        changedPixels: [...input.changedPixels, ignored],
      }),
    ).toThrow(/ignored changed pixels|generative redraw/i)
  })
})
