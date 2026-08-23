import { ref, watch, type Ref } from 'vue'

export interface ConnectorInstance {
  id: string
  type: string
  name: string
  config: Record<string, string>
  enabled: boolean
  /** Non-secret references only; Sidecar resolves the encrypted value. */
  credentialRefs?: Record<string, string>
}

const STORAGE_KEY = 'hexclaw:connectorInstances'
const SECRET_FIELDS = new Set([
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
  return SECRET_FIELDS.has(key)
}

function loadFromStorage(): ConnectorInstance[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (value): value is ConnectorInstance =>
        !!value
        && typeof value === 'object'
        && typeof value.id === 'string'
        && typeof value.type === 'string'
        && typeof value.name === 'string'
        && !!value.config
        && typeof value.config === 'object',
    )
  } catch {
    return []
  }
}

function redactedInstance(instance: ConnectorInstance): ConnectorInstance {
  return {
    ...instance,
    config: Object.fromEntries(
      Object.entries(instance.config).map(([key, value]) => [
        key,
        isSecretKey(key) && value ? '********' : value,
      ]),
    ),
  }
}

const list = ref<ConnectorInstance[]>(loadFromStorage().map(redactedInstance))

watch(
  list,
  (instances) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(instances.map(redactedInstance)))
    } catch {
      // Persistence unavailable: keep the in-memory projection only.
    }
  },
  { deep: true },
)

function genId(): string {
  return crypto.randomUUID?.() ?? String(Date.now() + Math.random())
}

async function persistSecrets(
  instance: ConnectorInstance,
  previous?: ConnectorInstance,
): Promise<ConnectorInstance> {
  const credentialRefs = { ...previous?.credentialRefs, ...instance.credentialRefs }
  for (const [field, value] of Object.entries(instance.config)) {
    if (!isSecretKey(field)) continue
    if (value && !value.includes('*')) {
      // Secret bytes go directly to the Sidecar MCP/Connection mutation. The
      // renderer keeps only a stable reference and a masked projection.
      credentialRefs[field] = `sidecar-connection:v1:${instance.id}:${field}`
    } else if (!value && credentialRefs[field]) {
      delete credentialRefs[field]
    }
  }
  return redactedInstance({ ...instance, credentialRefs })
}

type NewConnectorInstance = Omit<ConnectorInstance, 'id'> & { id?: string }

async function addInstance(x: NewConnectorInstance): Promise<ConnectorInstance> {
  const candidate: ConnectorInstance = { ...x, id: x.id ?? genId() }
  const instance = await persistSecrets(candidate)
  list.value.push(instance)
  return instance
}

async function updateInstance(
  id: string,
  patch: Partial<Omit<ConnectorInstance, 'id'>>,
): Promise<void> {
  const index = list.value.findIndex((instance) => instance.id === id)
  if (index === -1) return
  const previous = list.value[index]!
  const candidate = { ...previous, ...patch }
  const next = patch.config ? await persistSecrets(candidate, previous) : candidate
  list.value[index] = next
}

async function removeInstance(id: string): Promise<void> {
  const index = list.value.findIndex((instance) => instance.id === id)
  if (index === -1) return
  list.value.splice(index, 1)
}

export function useConnectorInstances(): {
  list: Ref<ConnectorInstance[]>
  addInstance: typeof addInstance
  updateInstance: typeof updateInstance
  removeInstance: typeof removeInstance
} {
  return { list, addInstance, updateInstance, removeInstance }
}
