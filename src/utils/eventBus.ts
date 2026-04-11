type Handler = () => void
const listeners = new Map<string, Set<Handler>>()

export function emit(event: string) {
  listeners.get(event)?.forEach((fn) => fn())
}

export function on(event: string, fn: Handler): () => void {
  if (!listeners.has(event)) listeners.set(event, new Set())
  listeners.get(event)!.add(fn)
  return () => { listeners.get(event)?.delete(fn) }
}
