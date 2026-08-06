import { MAGICIAN_ASSISTANTS, type MagicianAssistantId } from "./agents.ts"

export const MAGICIAN_ASSISTANTS_PREFERENCE_KEY = "arcana.sidebar.magician-assistants.open"
export const MAGICIAN_ASSISTANTS_SLOT_ORDER = 175
export const DEFAULT_HISTORY_PAGE_SIZE = 100
export const MAX_HISTORY_PAGES = 10_000

export type AssistantViewModel = {
  id: MagicianAssistantId
  displayName: string
  active: boolean
  count: number
}

export type MessageRecord = {
  info?: {
    id?: unknown
    sessionID?: unknown
    time?: { created?: unknown }
  }
  parts?: readonly unknown[]
}

export type ToolPartLike = {
  id?: unknown
  callID?: unknown
  messageID?: unknown
  type?: unknown
  tool?: unknown
  state?: {
    status?: unknown
    input?: unknown
  }
}

export type ChildActivity = {
  id?: unknown
  agent?: unknown
  status?: unknown
}

export type HistoryPageRequest = {
  sessionID: string
  limit: number
  before?: string
}

type AssistantTaskObservation = {
  id: string
  messageID: string
  agent: MagicianAssistantId
  status: string
}

type ChildStatusOverride = {
  status: string
  agent?: unknown
  revision: number
}

type RecordLike = Record<string, unknown>

function isRecord(value: unknown): value is RecordLike {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function isAssistantId(value: unknown): value is MagicianAssistantId {
  return typeof value === "string" && MAGICIAN_ASSISTANTS.some((assistant) => assistant.id === value)
}

function statusType(value: unknown): string | undefined {
  if (typeof value === "string") return value
  return isRecord(value) && typeof value.type === "string" ? value.type : undefined
}

function isTaskPart(value: unknown): value is ToolPartLike {
  if (!isRecord(value)) return false
  return value.type === "tool" && value.tool === "task" && isRecord(value.state)
}

function taskInput(part: ToolPartLike): RecordLike | undefined {
  return isRecord(part.state?.input) ? part.state.input : undefined
}

/** Return the worker represented by a native task ToolPart, if it is one of ours. */
export function getAssistantIdFromTaskPart(part: unknown): MagicianAssistantId | undefined {
  if (!isTaskPart(part)) return undefined
  const agent = taskInput(part)?.subagent_type
  return isAssistantId(agent) ? agent : undefined
}

/**
 * Parts have a stable id in the public SDK. The fallback keeps tests and older
 * records usable without conflating two parts in the same message: callID is
 * preferred, then the message-local part index is used.
 */
export function getToolPartIdentity(part: ToolPartLike, messageID = "", partIndex = 0): string {
  const id = stringValue(part.id)
  if (id) return `part:${id}`

  const callID = stringValue(part.callID)
  if (callID) return `call:${messageID}:${callID}`

  const agent = getAssistantIdFromTaskPart(part) ?? "unknown"
  return `fallback:${messageID}:${partIndex}:${agent}`
}

function getObservation(part: unknown, messageID: string, partIndex: number): AssistantTaskObservation | undefined {
  if (!isTaskPart(part)) return undefined
  const agent = getAssistantIdFromTaskPart(part)
  const status = stringValue(part.state?.status)
  if (!agent || !status) return undefined
  return {
    id: getToolPartIdentity(part, messageID, partIndex),
    messageID,
    agent,
    status,
  }
}

function collectTaskObservations(messages: Iterable<MessageRecord>): Map<string, AssistantTaskObservation> {
  const observations = new Map<string, AssistantTaskObservation>()
  for (const message of messages) {
    const messageID = stringValue(message.info?.id) ?? stringValue(message.info?.sessionID) ?? "message"
    for (const [partIndex, part] of (message.parts ?? []).entries()) {
      const observation = getObservation(part, messageID, partIndex)
      if (observation) observations.set(observation.id, observation)
    }
  }
  return observations
}

export function createInitialAssistantModel(): AssistantViewModel[] {
  return MAGICIAN_ASSISTANTS.map((assistant) => ({
    id: assistant.id,
    displayName: assistant.displayName,
    active: false,
    count: 0,
  }))
}

/** Aggregate root-session task parts and direct-child activity into fixed rows. */
export function aggregateAssistantModel(
  messages: Iterable<MessageRecord>,
  children: Iterable<ChildActivity> = [],
): AssistantViewModel[] {
  const observations = collectTaskObservations(messages)
  const counts = new Map<MagicianAssistantId, number>()
  const active = new Set<MagicianAssistantId>()

  for (const observation of observations.values()) {
    if (observation.status !== "pending") {
      counts.set(observation.agent, (counts.get(observation.agent) ?? 0) + 1)
    }
    if (observation.status === "running") active.add(observation.agent)
  }

  for (const child of children) {
    if (!isAssistantId(child.agent)) continue
    const status = statusType(child.status)
    if (status === "busy" || status === "retry") active.add(child.agent)
  }

  return MAGICIAN_ASSISTANTS.map((assistant) => ({
    id: assistant.id,
    displayName: assistant.displayName,
    active: active.has(assistant.id),
    count: Math.max(0, counts.get(assistant.id) ?? 0),
  }))
}

export type SidebarRenderModel = {
  heading: string
  rows: AssistantViewModel[]
  bodyVisible: boolean
}

export type HistoryReliability = "loading" | "ready" | "unavailable" | "stale"
export type ActivityReliability = HistoryReliability

export function getHistoryReliabilityText(state: HistoryReliability): string | undefined {
  if (state === "loading") return "Loading history…"
  if (state === "unavailable") return "History unavailable"
  if (state === "stale") return "History stale"
  return undefined
}

export function getActivityReliabilityText(state: HistoryReliability): string | undefined {
  if (state === "loading") return "Activity loading…"
  if (state === "unavailable") return "Activity unavailable"
  if (state === "stale") return "Activity stale"
  return undefined
}

export function getSidebarRenderModel(rows: AssistantViewModel[], open: boolean): SidebarRenderModel {
  return {
    heading: open ? "▼ Magician Assistants" : "▶ Magician Assistants (4)",
    rows: open ? rows : [],
    bodyVisible: open,
  }
}

export function readSidebarOpenPreference(get: (key: string, fallback: boolean) => unknown): boolean {
  const value = get(MAGICIAN_ASSISTANTS_PREFERENCE_KEY, true)
  return typeof value === "boolean" ? value : true
}

export function writeSidebarOpenPreference(set: (key: string, value: boolean) => void, open: boolean): void {
  set(MAGICIAN_ASSISTANTS_PREFERENCE_KEY, open)
}

export type CachedRootResolution = {
  rootSessionID: string
  complete: boolean
}

export function resolveCachedRootSessionID(
  sessionID: string,
  getSession: (id: string) => { parentID?: string } | undefined,
): CachedRootResolution {
  let currentID = sessionID
  const visited = new Set<string>()

  while (!visited.has(currentID)) {
    visited.add(currentID)
    const session = getSession(currentID)
    if (!session) return { rootSessionID: sessionID, complete: false }
    const parentID = session.parentID
    if (!parentID) return { rootSessionID: currentID, complete: true }
    if (visited.has(parentID)) return { rootSessionID: sessionID, complete: false }
    currentID = parentID
  }

  return { rootSessionID: sessionID, complete: false }
}

export function resolveRootSessionID(
  sessionID: string,
  getSession: (id: string) => { parentID?: string } | undefined,
): string {
  return resolveCachedRootSessionID(sessionID, getSession).rootSessionID
}

export async function resolveRootSessionIDAsync(
  sessionID: string,
  getSession: (id: string) => Promise<{ parentID?: string } | undefined>,
  maxDepth = 100,
): Promise<string> {
  let currentID = sessionID
  const visited = new Set<string>()

  for (let depth = 0; depth < Math.max(1, maxDepth); depth += 1) {
    if (visited.has(currentID)) throw new Error("session ancestry cycle")
    visited.add(currentID)
    const session = await getSession(currentID)
    if (!session) throw new Error("session ancestry unavailable")
    const parentID = session.parentID
    if (!parentID) return currentID
    if (visited.has(parentID)) throw new Error("session ancestry cycle")
    currentID = parentID
  }

  throw new Error("session ancestry depth limit reached")
}

export function isRelevantChildSessionEvent(
  rootSessionID: string,
  sessionID: string,
  knownChildIDs: Iterable<string>,
  parentID?: string,
): boolean {
  if (sessionID === rootSessionID) return false
  if (new Set(knownChildIDs).has(sessionID)) return true
  return parentID === rootSessionID
}

function compareMessagePosition(left: MessageRecord, right: MessageRecord): number {
  const leftTime = typeof left.info?.time?.created === "number" ? left.info.time.created : Number.POSITIVE_INFINITY
  const rightTime = typeof right.info?.time?.created === "number" ? right.info.time.created : Number.POSITIVE_INFINITY
  if (leftTime !== rightTime) return leftTime - rightTime
  return (stringValue(left.info?.id) ?? "").localeCompare(stringValue(right.info?.id) ?? "")
}

function unwrapPage(result: unknown): MessageRecord[] {
  if (isRecord(result) && "error" in result && result.error) {
    throw new Error(`load session messages: ${JSON.stringify(result.error)}`)
  }
  const data = isRecord(result) && "data" in result ? result.data : result
  if (!Array.isArray(data)) throw new Error("load session messages: invalid response")
  return data as MessageRecord[]
}

/**
 * OpenCode's session endpoint returns pages in chronological order and places
 * the opaque cursor in response headers. The SDK's public response shape does
 * not require consumers to inspect headers, so derive the exact v1 cursor from
 * the oldest returned message. This mirrors MessageV2.cursor.encode.
 */
export function encodeMessageCursor(message: MessageRecord): string | undefined {
  const id = stringValue(message.info?.id)
  const time = message.info?.time?.created
  if (!id || typeof time !== "number" || !Number.isFinite(time) || time < 0) return undefined
  return Buffer.from(JSON.stringify({ id, time })).toString("base64url")
}

export function deriveBeforeCursor(page: readonly MessageRecord[]): string | undefined {
  const oldest = page.toSorted(compareMessagePosition)[0]
  return oldest ? encodeMessageCursor(oldest) : undefined
}

export async function loadFullSessionHistory(
  fetchPage: (request: HistoryPageRequest) => Promise<unknown>,
  sessionID: string,
  options: { limit?: number; maxPages?: number } = {},
): Promise<MessageRecord[]> {
  const limit = Math.max(1, Math.floor(options.limit ?? DEFAULT_HISTORY_PAGE_SIZE))
  const maxPages = Math.max(1, Math.floor(options.maxPages ?? MAX_HISTORY_PAGES))
  const pages: MessageRecord[][] = []
  const seenCursors = new Set<string>()
  const seenOldestMessages = new Set<string>()
  let before: string | undefined
  let previousOldest: MessageRecord | undefined
  let completed = false

  for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
    const page = unwrapPage(await fetchPage({ sessionID, limit, before }))
    if (page.length === 0) {
      completed = true
      break
    }
    pages.unshift(page)

    const oldest = page.toSorted(compareMessagePosition)[0]
    const oldestID = oldest ? stringValue(oldest.info?.id) : undefined
    const isShortPage = page.length < limit
    const cursor = isShortPage ? undefined : deriveBeforeCursor(page)
    if (!isShortPage && !cursor) {
      throw new Error("load session messages: incomplete history pagination (missing cursor)")
    }
    if (!isShortPage && cursor && seenCursors.has(cursor)) {
      throw new Error("load session messages: incomplete history pagination (cursor did not advance)")
    }
    if (previousOldest && oldestID && seenOldestMessages.has(oldestID)) {
      throw new Error("load session messages: incomplete history pagination (oldest message did not advance)")
    }
    if (previousOldest && compareMessagePosition(oldest, previousOldest) >= 0) {
      throw new Error("load session messages: incomplete history pagination (page did not advance to older messages)")
    }

    // A short page is the normal end condition, but only after proving it is
    // older than the previous page. This prevents a malformed terminal page
    // from masking a cursor that stopped advancing.
    if (isShortPage) {
      completed = true
      break
    }

    if (!cursor) throw new Error("load session messages: incomplete history pagination (missing cursor)")
    seenCursors.add(cursor)
    if (oldestID) seenOldestMessages.add(oldestID)
    previousOldest = oldest
    before = cursor
  }

  if (!completed) throw new Error("load session messages: incomplete history pagination (page limit reached)")

  // Keep overlapping message records. collectTaskObservations deduplicates by
  // stable ToolPart identity, allowing distinct parts to be unioned while the
  // later (newer) page representation wins for the same part.
  return pages.flat()
}

export type AssistantTracker = {
  getModel(): AssistantViewModel[]
  getHistoryState(): HistoryReliability
  getActivityState(): ActivityReliability
  hydrate(): Promise<void>
  refreshHistory(): Promise<void>
  refreshChildren(): Promise<void>
  setPart(part: unknown, messageID?: string): void
  removePart(partID: string): void
  removeMessage(messageID: string): void
  setChildStatus(sessionID: string, status: string): boolean
  observeChildStatus(sessionID: string, status: string, agent?: unknown): void
  hasChild(sessionID: string): boolean
  getChildIDs(): string[]
  removeChild(sessionID: string): void
  setChildren(children: ChildActivity[]): void
  dispose(): void
}

export type RootTrackerSwitcher<T extends Pick<AssistantTracker, "hydrate" | "dispose">> = {
  readonly activeRootID: string
  readonly tracker: T
  switchTracker(nextRootID: string): Promise<void>
  hydrateCurrent(): Promise<void>
  dispose(): void
}

/**
 * Owns root tracker replacement and its one-time hydration. Disposing the old
 * tracker before creating the new one keeps late history/activity responses
 * from publishing into the current root while the returned hydration promise
 * makes replacement behavior directly testable.
 */
export function createRootTrackerSwitcher<T extends Pick<AssistantTracker, "hydrate" | "dispose">>(
  initialRootID: string,
  createTracker: (rootSessionID: string) => T,
): RootTrackerSwitcher<T> {
  let activeRootID = initialRootID
  let tracker = createTracker(initialRootID)
  let hydration: Promise<void> | undefined
  let disposed = false

  const hydrateCurrent = (): Promise<void> => {
    if (disposed) return Promise.resolve()
    if (hydration) return hydration
    const candidate = tracker
    try {
      hydration = candidate.hydrate().catch(() => {})
    } catch {
      hydration = Promise.resolve()
    }
    return hydration
  }

  return {
    get activeRootID() {
      return activeRootID
    },
    get tracker() {
      return tracker
    },
    switchTracker(nextRootID) {
      if (disposed) return Promise.resolve()
      if (nextRootID === activeRootID) return hydrateCurrent()
      tracker.dispose()
      activeRootID = nextRootID
      tracker = createTracker(nextRootID)
      hydration = undefined
      return hydrateCurrent()
    },
    hydrateCurrent,
    dispose() {
      if (disposed) return
      disposed = true
      tracker.dispose()
      hydration = undefined
    },
  }
}

export function createAssistantTracker(options: {
  rootSessionID: string
  loadHistory: () => Promise<MessageRecord[]>
  loadChildren: () => Promise<ChildActivity[]>
  onChange?: (model: AssistantViewModel[]) => void
  onHistoryStateChange?: (state: HistoryReliability) => void
  onActivityStateChange?: (state: ActivityReliability) => void
}): AssistantTracker {
  let history = new Map<string, AssistantTaskObservation>()
  const live = new Map<string, AssistantTaskObservation>()
  const removedParts = new Set<string>()
  const removedMessages = new Set<string>()
  let children: ChildActivity[] = []
  const childStatusOverrides = new Map<string, ChildStatusOverride>()
  const removedChildIDs = new Set<string>()
  let generation = 0
  let historyRequest = 0
  let childrenRequest = 0
  let childRevision = 0
  let historyReady = false
  let historyState: HistoryReliability = "loading"
  let activityReady = false
  let activityState: ActivityReliability = "loading"
  let disposed = false

  const setHistoryState = (next: HistoryReliability) => {
    if (disposed || historyState === next) return
    historyState = next
    options.onHistoryStateChange?.(next)
  }
  options.onHistoryStateChange?.(historyState)

  const setActivityState = (next: ActivityReliability) => {
    if (disposed || activityState === next) return
    activityState = next
    options.onActivityStateChange?.(next)
  }
  options.onActivityStateChange?.(activityState)

  const currentMessages = (): MessageRecord[] =>
    [...new Map([...history, ...live].filter(([id]) => !removedParts.has(id))).values()].map((observation) => ({
      info: { id: observation.messageID },
      parts: [
        {
          id: observation.id,
          messageID: observation.messageID,
          type: "tool",
          tool: "task",
          state: { status: observation.status, input: { subagent_type: observation.agent } },
        },
      ],
    }))

  const notify = () => {
    if (!disposed) options.onChange?.(aggregateAssistantModel(currentMessages(), children))
  }

  const setHistory = (messages: MessageRecord[]) => {
    const next = collectTaskObservations(messages)
    for (const [id, observation] of next) {
      if (removedMessages.has(observation.messageID) || removedParts.has(id)) next.delete(id)
    }
    history = next
    for (const [id, observation] of live) {
      if (!removedMessages.has(observation.messageID) && !removedParts.has(id)) next.set(id, observation)
    }
    historyReady = true
    setHistoryState("ready")
    notify()
  }

  const refreshHistory = async () => {
    const requestGeneration = generation
    const requestID = ++historyRequest
    try {
      const messages = await options.loadHistory()
      if (disposed || requestGeneration !== generation || requestID !== historyRequest) return
      setHistory(messages)
    } catch {
      // Keep the last known model. A failed refresh must not erase persisted
      // counts or invent a replacement count.
      if (disposed || requestGeneration !== generation || requestID !== historyRequest) return
      setHistoryState(historyReady ? "stale" : "unavailable")
    }
  }

  const refreshChildren = async () => {
    const requestGeneration = generation
    const requestID = ++childrenRequest
    const requestRevision = childRevision
    try {
      const next = await options.loadChildren()
      if (disposed || requestGeneration !== generation || requestID !== childrenRequest) return
      applyChildrenSnapshot(next, requestRevision)
      activityReady = true
      setActivityState("ready")
      notify()
    } catch {
      if (disposed || requestGeneration !== generation || requestID !== childrenRequest) return
      setActivityState(activityReady ? "stale" : "unavailable")
      // Preserve known child status when the transient children request fails.
    }
  }

  const applyChildrenSnapshot = (next: ChildActivity[], requestRevision: number) => {
    const snapshotIDs = new Set(
      next.flatMap((item) =>
        typeof item.id === "string" && !removedChildIDs.has(item.id) ? [item.id] : [],
      ),
    )
    const merged = next.flatMap((item) => {
      if (typeof item.id === "string" && removedChildIDs.has(item.id)) return []
      if (typeof item.id !== "string") return item
      const override = childStatusOverrides.get(item.id)
      if (!override) return item
      return {
        ...item,
        agent: item.agent ?? override.agent,
        status: override.status,
      }
    })

    for (const [id, override] of childStatusOverrides) {
      if (removedChildIDs.has(id)) {
        childStatusOverrides.delete(id)
        continue
      }
      if (snapshotIDs.has(id)) continue
      if (override.revision > requestRevision) {
        merged.push({ id, agent: override.agent, status: override.status })
        continue
      }
      childStatusOverrides.delete(id)
    }
    children = merged
  }

  const observeChildStatus = (sessionID: string, status: string, agent?: unknown) => {
    if (removedChildIDs.has(sessionID)) return
    childRevision += 1
    childStatusOverrides.set(sessionID, { status, agent, revision: childRevision })
    const child = children.find((item) => item.id === sessionID)
    if (child) {
      child.status = status
      if (child.agent === undefined) child.agent = agent
    } else {
      children.push({ id: sessionID, agent, status })
    }
    notify()
  }

  return {
    getModel() {
      return aggregateAssistantModel(currentMessages(), children)
    },
    getHistoryState() {
      return historyState
    },
    getActivityState() {
      return activityState
    },
    async hydrate() {
      await Promise.all([refreshHistory(), refreshChildren()])
    },
    refreshHistory,
    refreshChildren,
    setPart(part, messageID = "") {
      const observation = getObservation(part, messageID, 0)
      if (!observation) return
      if (removedMessages.has(observation.messageID)) return
      removedParts.delete(observation.id)
      live.set(observation.id, observation)
      notify()
    },
    removePart(partID) {
      const id = `part:${partID}`
      removedParts.add(id)
      live.delete(id)
      history.delete(id)
      notify()
    },
    removeMessage(messageID) {
      removedMessages.add(messageID)
      for (const [id, observation] of history) {
        if (observation.messageID === messageID) history.delete(id)
      }
      for (const [id, observation] of live) {
        if (observation.messageID === messageID) live.delete(id)
      }
      notify()
    },
    setChildStatus(sessionID, status) {
      const child = children.find((item) => item.id === sessionID)
      if (!child) return false
      observeChildStatus(sessionID, status, child.agent)
      return true
    },
    observeChildStatus(sessionID, status, agent) {
      observeChildStatus(sessionID, status, agent)
    },
    hasChild(sessionID) {
      return children.some((item) => item.id === sessionID)
    },
    getChildIDs() {
      return children.flatMap((item) => (typeof item.id === "string" ? [item.id] : []))
    },
    removeChild(sessionID) {
      childRevision += 1
      removedChildIDs.add(sessionID)
      childStatusOverrides.delete(sessionID)
      children = children.filter((item) => item.id !== sessionID)
      notify()
    },
    setChildren(next) {
      applyChildrenSnapshot(next, childRevision)
      activityReady = true
      setActivityState("ready")
      notify()
    },
    dispose() {
      disposed = true
      generation += 1
      historyRequest += 1
      childrenRequest += 1
      childRevision += 1
      history.clear()
      live.clear()
      removedParts.clear()
      removedMessages.clear()
      childStatusOverrides.clear()
      removedChildIDs.clear()
      children = []
    },
  }
}
