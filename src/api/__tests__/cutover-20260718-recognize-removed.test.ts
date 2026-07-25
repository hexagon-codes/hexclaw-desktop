/**
 * 一次切换终局批（架构设计 §6.14 / 执行计划 §3.4 · 2026-07-18）：
 * 批改链路旧直连编排 API 的前端反向契约。
 *
 * 后端 POST /recognize、/recognize/anchors 已删除（404），POST /practice-sets
 * （整卷直建）列入切换日死刑名单。前端 api/k12.ts 必须：
 *  1. 不再导出 k12Recognize / k12RecognizeAnchors / k12CreatePracticeSet；
 *  2. 源码中不残留 /recognize、整卷直建 POST /practice-sets 的请求路径
 *     （防止任何组件绕开统一 ImageTaskDispatch / 装篮命令重新对接旧端点）；
 *  3. 保留甄别项：k12Grade（单题补批）/ k12Solve（空白题求解）仍被
 *     RecognizeGuardPanel 等 facade 外合法路径消费，不许误删。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as api from '../k12'

describe('§6.14 一次切换：旧直连 API 已删（反向契约）', () => {
  it('不再导出旧直连编排函数', () => {
    const exports = api as Record<string, unknown>
    for (const dead of [
      'k12Recognize',
      'k12RecognizeAnchors',
      'k12CreatePracticeSet',
      'k12CreateGradingJob',
      'k12GetGradingJob',
      'k12GetGradingJobResult',
      'k12ConfirmGradingJob',
      'k12RetryGradingJob',
      'k12CancelGradingJob',
    ]) {
      expect(exports[dead], `${dead} 应已随一次切换删除`).toBeUndefined()
    }
  })

  it('源码不残留旧端点请求路径', () => {
    const src = readFileSync(resolve(__dirname, '../k12.ts'), 'utf8')
    expect(/`\$\{BASE\}\/recognize/.test(src), '不得残留 /recognize 端点路径').toBe(false)
    // 整卷直建 = 对裸 `${BASE}/practice-sets` 的 apiPost（GET 列表与子路径命令 basket/items 等合法）。
    expect(
      /apiPost[^`]*`\$\{BASE\}\/practice-sets`/.test(src),
      '不得残留整卷直建 POST 路径',
    ).toBe(false)
  })

  it('公开类型不再泄露服务端内部 GradingJob 契约', () => {
    const src = readFileSync(resolve(__dirname, '../k12.ts'), 'utf8')
    expect(src).not.toMatch(/export (?:type|interface) GradingJob/)
  })

  it('甄别保留项仍导出（防过删）', () => {
    expect(typeof api.k12Grade).toBe('function')
    expect(typeof api.k12Solve).toBe('function')
    expect(typeof api.k12CreateImageTask).toBe('function')
  })
})
