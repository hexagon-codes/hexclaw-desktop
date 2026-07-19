const THIRD_PARTY_AI_SERVICES_BASE_URL = 'https://hexclaw.net'

export function thirdPartyAiServicesUrl(locale: string): string {
  const language = locale.trim().toLowerCase().split(/[-_]/, 1)[0]
  const pathLocale = language === 'en' || language === 'ug' ? language : 'zh'

  return `${THIRD_PARTY_AI_SERVICES_BASE_URL}/${pathLocale}/third-party-ai-services`
}
