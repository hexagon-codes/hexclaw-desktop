import { apiGet } from '@/api/client'
import mirror from '@/generated/agent-templates.json'

export interface AgentTemplateSnapshot {
  catalog_source: 'backend' | 'bundled'
  catalog_version: string
  template_key: string
  template_version: string
  template_digest: string
  locale: string
  slug: string
  icon_key: string
  name: string
  description: string
  system_prompt: string
  expertise: string[]
}

export function bundledAgentTemplates(locale: string): AgentTemplateSnapshot[] {
  const language = locale === 'zh' ? 'zh-CN' : locale
  return mirror.templates.map(template => {
    const value = template.locales[language as keyof typeof template.locales] ?? template.locales['zh-CN']
    return {
      catalog_source: 'bundled', catalog_version: mirror.catalog_version,
      template_key: template.template_key, template_version: template.template_version,
      template_digest: value.template_digest, locale: language, slug: template.slug,
      icon_key: template.icon_key, name: value.name, description: value.description,
      system_prompt: value.system_prompt, expertise: [...value.expertise],
    }
  })
}

// 仅明确旧后端或显式离线采用镜像；认证失败、超时和服务错误保留真实失败。
export async function loadAgentTemplateCatalog(locale: string, offline = false): Promise<AgentTemplateSnapshot[]> {
  if (offline) return bundledAgentTemplates(locale)
  try {
    const response = await apiGet<{ schema_version: number; catalog_version: string; templates: AgentTemplateSnapshot[] }>(`/api/v1/agents/templates?locale=${encodeURIComponent(locale)}`)
    if (response.schema_version !== 1 || !Array.isArray(response.templates)) throw new Error('Unsupported agent template catalog')
    if (response.templates.some(template => template.catalog_source !== 'backend' || template.catalog_version !== response.catalog_version || !template.template_digest || !template.system_prompt)) throw new Error('Invalid agent template snapshot')
    return response.templates
  } catch (error) {
    if ((error as { status?: number }).status === 404 || (error as { status?: number }).status === 405) return bundledAgentTemplates(locale)
    throw error
  }
}

export function agentTemplateMetadata(snapshot: AgentTemplateSnapshot): Record<string, string> {
  return {
    catalog_source: snapshot.catalog_source, catalog_version: snapshot.catalog_version,
    template_key: snapshot.template_key, template_version: snapshot.template_version,
    template_digest: snapshot.template_digest, template_locale: snapshot.locale,
    template_snapshot: JSON.stringify(snapshot),
  }
}
