import { env } from '@/config/env'
import { api } from './client'

const K12_BASE = '/api/k12'

/** Resolve an immutable K12 asset identity to the authenticated read endpoint. */
export function k12AssetURL(agent: string, assetId: string): string {
  if (!assetId.startsWith('asset://')) return ''
  const file = assetId.slice(assetId.lastIndexOf('/') + 1)
  if (!agent.trim() || !file) return ''
  return `${env.apiBase}${K12_BASE}/assets/${file}?agent=${encodeURIComponent(agent)}`
}

/**
 * 经认证客户端拉取 K12 资产二进制（`<img src>` 直连 `/api/k12/assets/*`
 * 没有 Bearer/IPC 通道，桌面与 dev 下都会失败），返回 Blob 供 objectURL 展示。
 * 拉取失败（401/404/网络）返回 null，由调用方回退占位图。
 */
export async function k12GetAssetBlob(
  agent: string,
  assetId: string,
  signal?: AbortSignal,
): Promise<Blob | null> {
  if (!assetId.startsWith('asset://')) return null
  const file = assetId.slice(assetId.lastIndexOf('/') + 1)
  if (!agent.trim() || !file) return null
  try {
    const buffer = await api<ArrayBuffer, 'arrayBuffer'>(
      `${K12_BASE}/assets/${file}?agent=${encodeURIComponent(agent)}`,
      {
        method: 'GET',
        responseType: 'arrayBuffer',
        signal,
      },
    )
    if (!(buffer instanceof ArrayBuffer)) return null
    const ext = file.split('.').pop()?.toLowerCase() ?? ''
    const mime =
      ext === 'svg'
        ? 'image/svg+xml'
        : ext === 'jpeg' || ext === 'jpg'
          ? 'image/jpeg'
          : ext === 'webp'
            ? 'image/webp'
            : ext === 'gif'
              ? 'image/gif'
              : 'image/png'
    return new Blob([buffer], { type: mime })
  } catch {
    return null
  }
}
