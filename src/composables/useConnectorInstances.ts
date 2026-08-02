import { ref, watch, type Ref } from 'vue'
import {
  credentialRefFor,
  deleteCredential,
  putCredential,
  type CredentialKey,
  type CredentialSecretKind,
} from '@/utils/secure-store'

export interface ConnectorInstance {
  id: string
  type: string
  name: string
  config: Record<string, string>
  enabled: boolean
  /** Non-secret references only; connector code never resolves plaintext. */
  credentialRefs?: Record<string, string>
}

const STORAGE_KEY = 'hexclaw:connectorInstances'
const SECRET_KIND: Record<string, CredentialSecretKind> = {
  password: 'password',
  token: 'token',
  secret: 'secret',
  app_secret: 'app_secret',
  aes_key: 'aes_key',
  apiKey: 'api_key',
  api_key: 'api_key',
  accessKey: 'access_key',
  access_key: 'access_key',
  secretKey: 'secret_key',
  secret_key: 'secret_key',
}

function isSecretKey(key: string): boolean {
  return key in SECRET_KIND
}

function credentialKeyFor(instanceId: string, field: string): CredentialKey {
  const secretKind = SECRET_KIND[field]
  if (!secretKind) throw new Error('connector credential kind is invalid')
  return { ownerKind: 'connection', ownerId: instanceId, secretKind }
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
    const key = credentialKeyFor(instance.id, field)
    if (value && !value.includes('*')) {
      const receipt = await putCredential(key, value)
      credentialRefs[field] = receipt.credentialRef
    } else if (!value && credentialRefs[field]) {
      await deleteCredential(key)
      delete credentialRefs[field]
    }
  }
  return redactedInstance({ ...instance, credentialRefs })
}

async function addInstance(x: Omit<ConnectorInstance, 'id'>): Promise<ConnectorInstance> {
  const candidate: ConnectorInstance = { ...x, id: genId() }
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
  const instance = list.value[index]!
  for (const field of Object.keys(instance.credentialRefs ?? {})) {
    await deleteCredential(credentialKeyFor(instance.id, field))
  }
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

export { credentialRefFor }
