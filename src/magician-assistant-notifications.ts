import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { Event } from "@opencode-ai/sdk/v2"
import { MAGICIAN_ASSISTANTS, type MagicianAssistantId } from "./agents.ts"
import {
  getAssistantIdFromTaskPart,
  getStableToolPartIdentity,
  getTaskPartStatus,
  isCountedTaskStatus,
  resolveRootSessionIDAsync,
  resolveCachedRootSessionID,
  type ToolPartLike,
} from "./magician-assistants-state.ts"

export type MagicianAssistantNotificationApi = Pick<
  TuiPluginApi,
  "client" | "event" | "lifecycle" | "route" | "state" | "ui"
>

export type MagicianAssistantNotificationLedger = {
  observe(rootSessionID: string, part: unknown): MagicianAssistantId | undefined
  dispose(): void
}

export const DEFAULT_MAGICIAN_ASSISTANT_NOTIFICATION_DURATION = 5_000

export type MagicianAssistantNotificationScheduler = {
  now(): number
  setTimeout(callback: () => void, delay: number): unknown
  clearTimeout(handle: unknown): void
}

export type MagicianAssistantNotificationEntry = {
  readonly id: string
  readonly message: string
  readonly expiresAt: number
}

export type MagicianAssistantNotificationStore = {
  getEntries(): readonly MagicianAssistantNotificationEntry[]
  add(message: string): MagicianAssistantNotificationEntry | undefined
  subscribe(listener: () => void): () => void
  dispose(): void
}

export type CreateMagicianAssistantNotificationStoreOptions = {
  duration?: number
  scheduler?: MagicianAssistantNotificationScheduler
}

const defaultNotificationScheduler: MagicianAssistantNotificationScheduler = {
  now: () => Date.now(),
  setTimeout(callback, delay) {
    const handle = globalThis.setTimeout(callback, delay)
    if (typeof handle === "object" && handle !== null && "unref" in handle) {
      const unref = (handle as { unref?: () => void }).unref
      unref?.()
    }
    return handle
  },
  clearTimeout(handle) {
    globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>)
  },
}

/**
 * Store notification entries independently. Each entry owns its timer, so
 * expiry never replaces or delays another entry. Entries are appended in
 * arrival order and that order is the top-to-bottom line order of the native
 * toast message.
 */
export function createMagicianAssistantNotificationStore(
  options: CreateMagicianAssistantNotificationStoreOptions = {},
): MagicianAssistantNotificationStore {
  const duration =
    typeof options.duration === "number" && Number.isFinite(options.duration)
      ? Math.max(0, options.duration)
      : DEFAULT_MAGICIAN_ASSISTANT_NOTIFICATION_DURATION
  const scheduler = options.scheduler ?? defaultNotificationScheduler
  const entries: MagicianAssistantNotificationEntry[] = []
  const timers = new Map<string, unknown>()
  const listeners = new Set<() => void>()
  let sequence = 0
  let disposed = false

  const notify = () => {
    for (const listener of [...listeners]) listener()
  }

  const clearTimerSafely = (handle: unknown) => {
    try {
      scheduler.clearTimeout(handle)
    } catch {
      // A scheduler cleanup failure must not turn a notification lifecycle event into a TUI error.
    }
  }

  const remove = (id: string): boolean => {
    if (disposed) return false
    const index = entries.findIndex((entry) => entry.id === id)
    if (index < 0) return false

    entries.splice(index, 1)
    const hadTimer = timers.has(id)
    if (hadTimer) clearTimerSafely(timers.get(id))
    timers.delete(id)
    notify()
    return hadTimer
  }

  return {
    getEntries() {
      return entries.slice()
    },
    add(message) {
      if (disposed) return undefined

      const now = scheduler.now()
      const entry: MagicianAssistantNotificationEntry = Object.freeze({
        id: `delegation-${++sequence}`,
        message,
        expiresAt: now + duration,
      })
      entries.push(entry)
      notify()

      let callbackFired = false
      let callbackClearedTimer = false
      try {
        const timer = scheduler.setTimeout(() => {
          callbackFired = true
          callbackClearedTimer = remove(entry.id)
        }, duration)

        if (callbackFired || !entries.some((candidate) => candidate.id === entry.id)) {
          if (!callbackClearedTimer) clearTimerSafely(timer)
        } else {
          timers.set(entry.id, timer)
        }
      } catch {
        remove(entry.id)
        return undefined
      }

      return entries.some((candidate) => candidate.id === entry.id) ? entry : undefined
    },
    subscribe(listener) {
      if (disposed) return () => {}
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    dispose() {
      if (disposed) return
      disposed = true
      for (const timer of timers.values()) clearTimerSafely(timer)
      timers.clear()
      entries.length = 0
      notify()
      listeners.clear()
    },
  }
}

type MessagePartUpdatedEvent = Extract<Event, { type: "message.part.updated" }>

/**
 * Keep notification identity separate from agent identity. A task invocation
 * is counted once when its first non-pending live observation arrives. The
 * fallback used by history counting needs a message-local part index, which
 * message.part.updated does not provide, so malformed live parts without an
 * id or callID are ignored rather than risking update spam or collisions.
 */
export function createMagicianAssistantNotificationLedger(): MagicianAssistantNotificationLedger {
  const notified = new Set<string>()
  let disposed = false

  return {
    observe(rootSessionID, part) {
      if (disposed || !rootSessionID) return undefined

      const agent = getAssistantIdFromTaskPart(part)
      const status = getTaskPartStatus(part)
      if (!agent || !isCountedTaskStatus(status)) return undefined

      const stableIdentity = getStableToolPartIdentity(part as ToolPartLike)
      if (!stableIdentity) return undefined

      const key = `${rootSessionID}:${stableIdentity}`
      if (notified.has(key)) return undefined
      notified.add(key)
      return agent
    },
    dispose() {
      disposed = true
      notified.clear()
    },
  }
}

export function getMagicianAssistantDelegationMessage(agent: MagicianAssistantId): string {
  const assistant = MAGICIAN_ASSISTANTS.find((candidate) => candidate.id === agent)
  return `Task delegated to ${assistant?.displayName ?? agent}`
}

type ViewedSessionSnapshot = {
  sessionID: string
  cachedRoot: ReturnType<typeof resolveCachedRootSessionID>
}

function viewedSessionSnapshot(api: MagicianAssistantNotificationApi): ViewedSessionSnapshot | undefined {
  const route = api.route.current
  if (route.name !== "session") return undefined

  const sessionID = route.params?.sessionID
  if (typeof sessionID !== "string" || sessionID.length === 0) return undefined

  return {
    sessionID,
    cachedRoot: resolveCachedRootSessionID(sessionID, (id) => api.state.session.get(id)),
  }
}

function unwrapSessionResponse(result: unknown): { parentID?: string } {
  if (result && typeof result === "object" && "error" in result && result.error) {
    throw new Error("load session ancestry failed")
  }
  if (result && typeof result === "object" && "error" in result && !("data" in result)) {
    throw new Error("load session ancestry returned an incomplete response")
  }

  const data = result && typeof result === "object" && "data" in result ? result.data : result
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("load session ancestry returned an invalid response")
  }

  const session = data as { parentID?: unknown }

  return {
    parentID: typeof session.parentID === "string" ? session.parentID : undefined,
  }
}

async function resolveViewedRootSessionID(
  api: MagicianAssistantNotificationApi,
  snapshot: ViewedSessionSnapshot,
): Promise<string | undefined> {
  if (snapshot.cachedRoot.complete) return snapshot.cachedRoot.rootSessionID

  try {
    return await resolveRootSessionIDAsync(snapshot.sessionID, async (sessionID) => {
      const cached = api.state.session.get(sessionID)
      if (cached) return cached
      return unwrapSessionResponse(await api.client.session.get({ sessionID }))
    })
  } catch {
    return undefined
  }
}

export type RegisterMagicianAssistantNotificationsOptions = {
  duration?: number
  scheduler?: MagicianAssistantNotificationScheduler
  store?: MagicianAssistantNotificationStore
}

/**
 * Register the live-only controller. The host keeps a single current toast,
 * so every store change pushes exactly one native toast whose message lists
 * all currently active delegations as newline-separated lines in arrival
 * order. An empty store pushes nothing because there is no dismiss API.
 */
export function registerMagicianAssistantNotifications(
  api: MagicianAssistantNotificationApi,
  options: RegisterMagicianAssistantNotificationsOptions = {},
): () => void {
  const ledger = createMagicianAssistantNotificationLedger()
  const store =
    options.store ??
    createMagicianAssistantNotificationStore({
      duration: options.duration,
      scheduler: options.scheduler,
    })
  let disposed = false

  const pushToast = () => {
    if (disposed) return
    const entries = store.getEntries()
    if (entries.length === 0) return
    api.ui.toast({
      variant: "info",
      message: entries.map((entry) => entry.message).join("\n"),
      duration: DEFAULT_MAGICIAN_ASSISTANT_NOTIFICATION_DURATION,
    })
  }
  const unsubscribe = store.subscribe(pushToast)

  const processEvent = (event: MessagePartUpdatedEvent, rootSessionID: string) => {
    if (event.properties.sessionID !== rootSessionID) return

    const agent = ledger.observe(rootSessionID, event.properties.part)
    if (!agent) return

    store.add(getMagicianAssistantDelegationMessage(agent))
  }

  const handleEvent = (event: MessagePartUpdatedEvent): void | Promise<void> => {
    if (disposed) return

    const snapshot = viewedSessionSnapshot(api)
    if (!snapshot) return

    if (snapshot.cachedRoot.complete) {
      processEvent(event, snapshot.cachedRoot.rootSessionID)
      return
    }

    return resolveViewedRootSessionID(api, snapshot).then((rootSessionID) => {
      if (disposed || !rootSessionID) return
      if (viewedSessionSnapshot(api)?.sessionID !== snapshot.sessionID) return
      processEvent(event, rootSessionID)
    })
  }

  const removeListener = api.event.on("message.part.updated", (event) => handleEvent(event))

  const dispose = () => {
    if (disposed) return
    disposed = true
    removeListener()
    unsubscribe()
    ledger.dispose()
    store.dispose()
  }
  api.lifecycle.onDispose(dispose)
  return dispose
}
