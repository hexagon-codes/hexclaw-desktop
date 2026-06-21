import { ref, watch, type Ref } from 'vue'
import { saveSecureValue, loadSecureValue, removeSecureValue } from '@/utils/secure-store'

/**
 * 数据连接器实例 store（模块级响应式单例 + localStorage 持久化）。
 *
 * 镜像 IM 通道的「实例列表」模型：用户在「数据连接器」tab 里添加具体的连接器实例
 * （支持同类型多个，如两个 MySQL「生产库」「分析库」、三个 Redis），每个实例自带
 * 名称 / 配置 / 启用态。类型目录（CONNECTOR_GROUPS）只作为新建弹窗第一步的类型选择器。
 *
 * 🔐 密钥处理：config 里的机密字段（password 等）**绝不**明文写入 localStorage。
 * 非机密字段照常落 localStorage（实例列表、host/port 等），机密字段值在持久化前被抹成空串，
 * 真实值改走 secure-store（Tauri 桌面端落加密 store；浏览器端 fail-closed 仅留当前会话内存）。
 * 与 IM 通道密钥的处置一致，避免数据库密码以明文长期驻留浏览器存储。
 */

export interface ConnectorInstance {
  id: string
  /** 连接器类型 slug（对齐 CONNECTOR_GROUPS items[].id，如 mysql / redis / localFolder） */
  type: string
  /** 实例名（用户可改，同类型多实例靠它区分，如「生产库」「分析库」） */
  name: string
  /** 配置键值对（host / port / database / user / password / path / url …，按类型而定） */
  config: Record<string, string>
  enabled: boolean
}

const STORAGE_KEY = 'hexclaw:connectorInstances'

/**
 * config 中视为机密、禁止明文落 localStorage 的键（与 im-channels 字段方案的 secret:true 对齐）。
 * 命中即在持久化前抹空、改走 secure-store。
 */
const SECRET_CONFIG_KEYS = new Set([
  'password',
  'token',
  'secret',
  'app_secret',
  'aes_key',
  'apiKey',
  'api_key',
  'accessKey',
  'access_key',
  'secretKey',
  'secret_key',
])

function isSecretKey(key: string): boolean {
  return SECRET_CONFIG_KEYS.has(key)
}

/** secure-store 中单条机密的键名：connector:<实例 id>:<字段名>。 */
function secureKeyFor(instanceId: string, field: string): string {
  return `connector:${instanceId}:${field}`
}

// 模块级单例：所有调用方共享同一个响应式数组（与 useTheme 同样的模块态模式）。
const list = ref<ConnectorInstance[]>(loadFromStorage())

function loadFromStorage(): ConnectorInstance[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    // 容错：丢弃形状不符的条目，保证下游字段安全。
    return parsed.filter(
      (x): x is ConnectorInstance =>
        !!x &&
        typeof x === 'object' &&
        typeof x.id === 'string' &&
        typeof x.type === 'string' &&
        typeof x.name === 'string',
    )
  } catch {
    return []
  }
}

/** 返回一份把机密字段值抹空的深拷贝，仅用于序列化落 localStorage（不改内存态）。 */
function redactSecrets(instances: ConnectorInstance[]): ConnectorInstance[] {
  return instances.map((i) => ({
    ...i,
    config: Object.fromEntries(
      Object.entries(i.config).map(([k, v]) => [k, isSecretKey(k) ? '' : v]),
    ),
  }))
}

/** 把一个实例的机密字段值写进 secure-store（机密键缺值则删除其残留）。 */
function persistInstanceSecrets(instance: ConnectorInstance): void {
  for (const [k, v] of Object.entries(instance.config)) {
    if (!isSecretKey(k)) continue
    const secureKey = secureKeyFor(instance.id, k)
    if (v) void saveSecureValue(secureKey, v)
    else void removeSecureValue(secureKey)
  }
}

/** 删除一个实例在 secure-store 里的全部机密残留。 */
function removeInstanceSecrets(instance: ConnectorInstance): void {
  for (const k of Object.keys(instance.config)) {
    if (isSecretKey(k)) void removeSecureValue(secureKeyFor(instance.id, k))
  }
}

/**
 * 启动时从 secure-store 回填机密字段（localStorage 里机密值是空串）。
 * 浏览器 fail-closed 模式下取不到 → 保持空，用户重输；Tauri 端能取回上次加密保存的值。
 */
async function hydrateSecrets(): Promise<void> {
  for (const inst of list.value) {
    for (const k of Object.keys(inst.config)) {
      if (!isSecretKey(k)) continue
      const v = await loadSecureValue(secureKeyFor(inst.id, k))
      if (v != null && v !== '') inst.config[k] = v
    }
  }
}

void hydrateSecrets()

// 变更即写回（深度监听，覆盖 add / update / remove 各路径）；机密字段抹空后再序列化。
watch(
  list,
  (val) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(redactSecrets(val)))
    } catch {
      // 存储不可用（隐私模式 / 配额）时静默退化，不阻塞内存态。
    }
  },
  { deep: true },
)

function genId(): string {
  return crypto.randomUUID?.() ?? String(Date.now() + Math.random())
}

/** 追加一个新实例（自动补 id），返回生成的实例。机密字段同步写 secure-store。 */
function addInstance(x: Omit<ConnectorInstance, 'id'>): ConnectorInstance {
  const instance: ConnectorInstance = { ...x, id: genId() }
  list.value.push(instance)
  persistInstanceSecrets(instance)
  return instance
}

/** 按 id patch 一个实例（浅合并，config 整体替换由调用方决定）。机密字段同步写 secure-store。 */
function updateInstance(id: string, patch: Partial<Omit<ConnectorInstance, 'id'>>): void {
  const idx = list.value.findIndex((i) => i.id === id)
  if (idx === -1) return
  const next = { ...list.value[idx]!, ...patch }
  list.value[idx] = next
  if (patch.config) persistInstanceSecrets(next)
}

/** 按 id 移除一个实例，并清理其 secure-store 机密残留。 */
function removeInstance(id: string): void {
  const idx = list.value.findIndex((i) => i.id === id)
  if (idx === -1) return
  const [removed] = list.value.splice(idx, 1)
  if (removed) removeInstanceSecrets(removed)
}

export function useConnectorInstances(): {
  list: Ref<ConnectorInstance[]>
  addInstance: typeof addInstance
  updateInstance: typeof updateInstance
  removeInstance: typeof removeInstance
} {
  return { list, addInstance, updateInstance, removeInstance }
}
