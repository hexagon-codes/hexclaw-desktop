import { beforeEach, describe, expect, it, vi } from 'vitest'

const client = vi.hoisted(() => ({
  api: vi.fn(),
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPut: vi.fn(),
  apiDelete: vi.fn(),
}))

vi.mock('../client', () => client)

import {
  k12ConfirmCreativeWorkOCR,
  k12CreateCreativeWorkOCR,
  k12GetCreativeWorkOCR,
  k12RetryCreativeWorkOCR,
  k12SubmitWorkRevision,
} from '../k12'

describe('K12 creative-work OCR API contract', () => {
  beforeEach(() => {
    for (const mock of Object.values(client)) mock.mockReset().mockResolvedValue({})
  })

  it('uses the durable create/get/retry/confirm resource routes and owner-scoped DTOs', async () => {
    await k12CreateCreativeWorkOCR({
      agent: 'kid-a',
      request_id: 'upload-once',
      source_asset_id: 'asset://kid-a/photo.png',
    })
    await k12GetCreativeWorkOCR('kid-a', 'job/id')
    await k12RetryCreativeWorkOCR('kid-a', 'job/id')
    await k12ConfirmCreativeWorkOCR('kid-a', 'job/id', '家长确认稿')

    expect(client.apiPost).toHaveBeenNthCalledWith(1, '/api/k12/creative-work-ocr-jobs', {
      agent: 'kid-a',
      request_id: 'upload-once',
      source_asset_id: 'asset://kid-a/photo.png',
    }, { timeout: 240_000 })
    expect(client.apiGet).toHaveBeenCalledWith(
      '/api/k12/creative-work-ocr-jobs/job%2Fid',
      { agent: 'kid-a' },
    )
    expect(client.apiPost).toHaveBeenNthCalledWith(
      2,
      '/api/k12/creative-work-ocr-jobs/job%2Fid/retry',
      { agent: 'kid-a' },
      { timeout: 240_000 },
    )
    expect(client.apiPost).toHaveBeenNthCalledWith(
      3,
      '/api/k12/creative-work-ocr-jobs/job%2Fid/confirm',
      { agent: 'kid-a', content_markdown: '家长确认稿' },
    )
  })

  it('submits the confirmed OCR job/version/digest with a photo revision', async () => {
    await k12SubmitWorkRevision(
      'kid-a',
      'work-1',
      '修改稿',
      'asset://kid-a/revision.png',
      { jobId: 'ocr-1', version: 2, digest: 'sha256-digest-v2' },
    )

    expect(client.apiPost).toHaveBeenCalledWith('/api/k12/creative-works/work-1/revision', {
      agent: 'kid-a',
      content_markdown: '修改稿',
      source_asset_id: 'asset://kid-a/revision.png',
      ocr_job_id: 'ocr-1',
      ocr_version: 2,
      ocr_confirmed_digest: 'sha256-digest-v2',
    })
  })
})
