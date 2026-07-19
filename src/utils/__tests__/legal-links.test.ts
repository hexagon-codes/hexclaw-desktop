import { describe, expect, it } from 'vitest'

import { thirdPartyAiServicesUrl } from '@/utils/legal-links'

describe('thirdPartyAiServicesUrl', () => {
  it.each([
    ['zh-CN', 'https://hexclaw.net/zh/third-party-ai-services'],
    ['zh', 'https://hexclaw.net/zh/third-party-ai-services'],
    ['en', 'https://hexclaw.net/en/third-party-ai-services'],
    ['en-US', 'https://hexclaw.net/en/third-party-ai-services'],
    ['ug-CN', 'https://hexclaw.net/ug/third-party-ai-services'],
    ['ug', 'https://hexclaw.net/ug/third-party-ai-services'],
  ])('maps %s to its localized service notice', (locale, expected) => {
    expect(thirdPartyAiServicesUrl(locale)).toBe(expected)
  })

  it('falls back to the Chinese notice for an unsupported locale', () => {
    expect(thirdPartyAiServicesUrl('fr')).toBe('https://hexclaw.net/zh/third-party-ai-services')
  })
})
