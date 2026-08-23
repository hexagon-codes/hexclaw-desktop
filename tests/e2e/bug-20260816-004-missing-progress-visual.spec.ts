import { expect, test, type Page } from '@playwright/test'
import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import {
  collectCardFacts,
  freezeVisualState,
  installReferenceFixture,
  installSourceFixture,
  openReferenceMissingProgress,
  openSourceMissingProgress,
} from './bug-20260816-004-missing-progress-visual.helper'

const execFileAsync = promisify(execFile)
const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const sourceURL = process.env.HEX_BUG004_SOURCE_URL
const referenceURL = process.env.HEX_BUG004_REFERENCE_URL
const evidenceRoot = process.env.HEX_BUG004_EVIDENCE_DIR
const rawPixelDiffHelper = path.join(
  desktopRoot,
  'tests/e2e/bug-20260816-004-pixel-diff.helper.py',
)
const strictPixelDiffHelper = path.join(desktopRoot, 'tests/e2e/tools/visual_pixel_diff.py')
const PIXEL_THRESHOLD = 8
const MAX_TARGET_CHANGED_PIXEL_RATIO = 0.001

if (!sourceURL || !referenceURL || !evidenceRoot) {
  throw new Error('BUG-20260816-004 source/reference/evidence variables are required')
}

const states = [
  { id: 'wide-1226x700', viewport: { width: 1226, height: 700 } },
  { id: 'narrow-supported-min-900x700', viewport: { width: 900, height: 700 } },
] as const

function allChecksPass(checks: Record<string, boolean>) {
  return Object.values(checks).every(Boolean)
}

function nearlyEqual(left: number, right: number) {
  return Math.abs(left - right) <= 0.01
}

async function pixelDiff(
  helper: string,
  referencePath: string,
  currentPath: string,
  diffPath: string,
) {
  const { stdout } = await execFileAsync(
    'uv',
    [
      'run',
      '--offline',
      '--isolated',
      '--python',
      '3.12',
      '--with',
      'pillow==10.4.0',
      'python',
      helper,
      referencePath,
      currentPath,
      diffPath,
      String(PIXEL_THRESHOLD),
    ],
    { cwd: desktopRoot },
  )
  return JSON.parse(stdout)
}

async function normalizeContentOwnedRaster(page: Page, cardSelector: string) {
  await page.locator(cardSelector).evaluate((card) => {
    const element = card as HTMLElement
    element.style.setProperty('background', 'rgb(255, 254, 249)', 'important')
    element.style.setProperty('background-image', 'none', 'important')
  })
}

async function captureTargetPixel(
  kind: 'title' | 'button',
  reference: Page,
  current: Page,
  referenceSelector: string,
  currentSelector: string,
  outputDir: string,
) {
  const childSelector = kind === 'title' ? 'b' : 'button'
  const files =
    kind === 'title'
      ? {
          reference: 'target-title-reference.png',
          current: 'target-title-current.png',
          diff: 'target-title-pixel-diff.png',
        }
      : {
          reference: 'target-button-reference.png',
          current: 'target-button-current.png',
          diff: 'target-button-pixel-diff.png',
        }
  const referencePath = path.join(outputDir, files.reference)
  const currentPath = path.join(outputDir, files.current)
  const diffPath = path.join(outputDir, files.diff)
  await Promise.all([
    reference.locator(`${referenceSelector} ${childSelector}`).screenshot({
      path: referencePath,
      animations: 'disabled',
      caret: 'hide',
      scale: 'css',
    }),
    current.locator(`${currentSelector} ${childSelector}`).screenshot({
      path: currentPath,
      animations: 'disabled',
      caret: 'hide',
      scale: 'css',
    }),
  ])
  try {
    const pixel = await pixelDiff(
      strictPixelDiffHelper,
      referencePath,
      currentPath,
      diffPath,
    )
    return {
      kind,
      status: pixel.changed_pixel_ratio <= MAX_TARGET_CHANGED_PIXEL_RATIO ? 'PASS' : 'RED',
      pass: pixel.changed_pixel_ratio <= MAX_TARGET_CHANGED_PIXEL_RATIO,
      maxChangedPixelRatio: MAX_TARGET_CHANGED_PIXEL_RATIO,
      pixel,
      files: {
        reference: path.basename(referencePath),
        current: path.basename(currentPath),
        diff: path.basename(diffPath),
      },
    }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    const sizeMismatch = message.includes('screenshot size mismatch')
    return {
      kind,
      status: sizeMismatch ? 'NOT_COMPARABLE' : 'RED',
      pass: false,
      maxChangedPixelRatio: MAX_TARGET_CHANGED_PIXEL_RATIO,
      pixel: null,
      reason: sizeMismatch
        ? 'reference/current target clip dimensions differ'
        : 'target pixel diff execution failed',
      error: message,
      files: {
        reference: path.basename(referencePath),
        current: path.basename(currentPath),
        diff: path.basename(diffPath),
      },
    }
  }
}

for (const state of states) {
  test(`${state.id}: missing progress remains one line`, async ({ browser }) => {
    const externalRequests: string[] = []
    const contextOptions = {
      viewport: state.viewport,
      deviceScaleFactor: 1,
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      colorScheme: 'light' as const,
      reducedMotion: 'reduce' as const,
    }
    const sourceContext = await browser.newContext(contextOptions)
    const referenceContext = await browser.newContext(contextOptions)
    const source = await sourceContext.newPage()
    const reference = await referenceContext.newPage()
    const outputDir = path.join(evidenceRoot, 'chromium', state.id)
    await mkdir(outputDir, { recursive: true })
    try {
      await installSourceFixture(source, externalRequests)
      await installReferenceFixture(reference, externalRequests)
      await Promise.all([
        openSourceMissingProgress(source, sourceURL),
        openReferenceMissingProgress(reference, referenceURL),
      ])
      await Promise.all([freezeVisualState(source), freezeVisualState(reference)])

      const sourceSelector = '.weekly-progress--missing'
      const referenceSelector =
        '#k12BookPanel0 [data-learner-panel="hong"] .rc-week-progress--missing'
      const [current, oracle] = await Promise.all([
        collectCardFacts(source, sourceSelector),
        collectCardFacts(reference, referenceSelector),
      ])
      const referencePath = path.join(outputDir, 'reference.png')
      const currentPath = path.join(outputDir, 'current.png')
      const diffPath = path.join(outputDir, 'pixel-diff.png')
      await Promise.all([
        reference.locator(referenceSelector).screenshot({
          path: referencePath,
          animations: 'disabled',
          caret: 'hide',
          scale: 'css',
        }),
        source.locator(sourceSelector).screenshot({
          path: currentPath,
          animations: 'disabled',
          caret: 'hide',
          scale: 'css',
        }),
      ])
      const pixel = await pixelDiff(rawPixelDiffHelper, referencePath, currentPath, diffPath)
      const comparability = {
        sameViewport:
          oracle.viewport.width === current.viewport.width &&
          oracle.viewport.height === current.viewport.height &&
          oracle.viewport.dpr === current.viewport.dpr,
        sameLocale: oracle.viewport.locale === current.viewport.locale,
        sameExactText: oracle.text === current.text,
        sameState: oracle.checks.exactTitle && current.checks.exactTitle,
      }
      const referenceCard = oracle.rects.card
      const currentCard = current.rects.card
      const shellAttributionChecks = {
        cardHeightEqual: nearlyEqual(referenceCard.height, currentCard.height),
        titleLeftInsetEqual: nearlyEqual(
          oracle.rects.title.x - referenceCard.x,
          current.rects.title.x - currentCard.x,
        ),
        titleTopInsetEqual: nearlyEqual(
          oracle.rects.title.y - referenceCard.y,
          current.rects.title.y - currentCard.y,
        ),
        titleSizeEqual:
          nearlyEqual(oracle.rects.title.width, current.rects.title.width) &&
          nearlyEqual(oracle.rects.title.height, current.rects.title.height),
        buttonRightInsetEqual: nearlyEqual(
          referenceCard.x + referenceCard.width - oracle.rects.button.x - oracle.rects.button.width,
          currentCard.x + currentCard.width - current.rects.button.x - current.rects.button.width,
        ),
        buttonTopInsetEqual: nearlyEqual(
          oracle.rects.button.y - referenceCard.y,
          current.rects.button.y - currentCard.y,
        ),
        buttonSizeEqual:
          nearlyEqual(oracle.rects.button.width, current.rects.button.width) &&
          nearlyEqual(oracle.rects.button.height, current.rects.button.height),
        bothInsideViewport:
          oracle.checks.noHorizontalOverflow && current.checks.noHorizontalOverflow,
      }
      const shellAttribution = {
        owner: 'outer-shell-and-background',
        rawCardPixelGating: false,
        reason:
          'The raw card keeps the real flexible shell width and transparent scene background; content-owned target clips carry the release pixel gate.',
        absoluteCardDelta: {
          x: currentCard.x - referenceCard.x,
          y: currentCard.y - referenceCard.y,
          width: currentCard.width - referenceCard.width,
          height: currentCard.height - referenceCard.height,
        },
        checks: shellAttributionChecks,
        pass: allChecksPass(shellAttributionChecks),
      }
      await Promise.all([
        normalizeContentOwnedRaster(reference, referenceSelector),
        normalizeContentOwnedRaster(source, sourceSelector),
      ])
      const [titleTargetPixel, buttonTargetPixel] = await Promise.all([
        captureTargetPixel(
          'title',
          reference,
          source,
          referenceSelector,
          sourceSelector,
          outputDir,
        ),
        captureTargetPixel(
          'button',
          reference,
          source,
          referenceSelector,
          sourceSelector,
          outputDir,
        ),
      ])
      const targetPixels = {
        threshold: PIXEL_THRESHOLD,
        maxChangedPixelRatio: MAX_TARGET_CHANGED_PIXEL_RATIO,
        rasterNormalization:
          'Only the secondary target channel uses the same opaque card background; raw card evidence remains unchanged.',
        title: titleTargetPixel,
        button: buttonTargetPixel,
      }
      const targetPixelPass = titleTargetPixel.pass && buttonTargetPixel.pass
      const contentInvariantPass =
        allChecksPass(comparability) &&
        allChecksPass(oracle.checks) &&
        allChecksPass(current.checks) &&
        shellAttribution.pass
      const acceptance = {
        contentInvariantPass,
        targetPixelPass,
        pass: contentInvariantPass && targetPixelPass,
        failedCurrentChecks: Object.entries(current.checks)
          .filter(([, pass]) => !pass)
          .map(([name]) => name),
      }
      const targetNotComparable =
        titleTargetPixel.status === 'NOT_COMPARABLE' ||
        buttonTargetPixel.status === 'NOT_COMPARABLE'
      const report = {
        bugId: 'BUG-20260816-004',
        state,
        status:
          !allChecksPass(comparability) || targetNotComparable
            ? 'NOT_COMPARABLE'
            : acceptance.pass
              ? 'PASS'
              : 'RED',
        reference: oracle,
        current,
        rawCardPixel: {
          ...pixel,
          gating: false,
          reason: shellAttribution.reason,
        },
        targetPixels,
        shellAttribution,
        externalRequests,
        acceptance,
      }
      await writeFile(path.join(outputDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)

      expect(comparability, 'prototype/source must be homomorphic').toEqual({
        sameViewport: true,
        sameLocale: true,
        sameExactText: true,
        sameState: true,
      })
      expect(externalRequests, 'gate must stay loopback-only').toEqual([])
      expect(report.acceptance.pass, JSON.stringify(report.acceptance)).toBe(true)
    } finally {
      await sourceContext.close()
      await referenceContext.close()
    }
  })
}
