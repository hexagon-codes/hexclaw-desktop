import { env } from '@/config/env'
import { api } from './client'

// 保持现有后端资产路由，统一前端内容寻址与认证读取。
const ASSET_BASE = '/api/k12/assets'

/** 将不可变资产身份解析为当前后端的认证读取地址。 */
export function assetContentURL(agent: string, assetId: string): string {
  if (!assetId.startsWith('asset://')) return ''
  const file = assetId.slice(assetId.lastIndexOf('/') + 1)
  if (!agent.trim() || !file) return ''
  return `${env.apiBase}${ASSET_BASE}/${file}?agent=${encodeURIComponent(agent)}`
}

/** 经认证客户端读取图片字节；失败沿用null结果，取消仍传给底层请求。 */
export async function getAssetBlob(
  agent: string,
  assetId: string,
  signal?: AbortSignal,
): Promise<Blob | null> {
  if (!assetId.startsWith('asset://')) return null
  const file = assetId.slice(assetId.lastIndexOf('/') + 1)
  if (!agent.trim() || !file) return null
  try {
    const buffer = await api<ArrayBuffer, 'arrayBuffer'>(
      `${ASSET_BASE}/${file}?agent=${encodeURIComponent(agent)}`,
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
