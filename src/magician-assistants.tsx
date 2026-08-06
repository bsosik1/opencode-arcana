/** @jsxImportSource @opentui/solid */

import type { TuiPluginApi, TuiSlotPlugin } from "@opencode-ai/plugin/tui"
import type { MouseEvent } from "@opentui/core"
import { For, Show, createEffect, createSignal, onCleanup } from "solid-js"
import { MAGICIAN_ASSISTANTS } from "./agents.ts"
import {
  MAGICIAN_ASSISTANTS_SLOT_ORDER,
  createAssistantTracker,
  createInitialAssistantModel,
  createRootTrackerSwitcher,
  getActivityReliabilityText,
  getHistoryReliabilityText,
  isRelevantChildSessionEvent,
  loadFullSessionHistory,
  readSidebarOpenPreference,
  resolveCachedRootSessionID,
  resolveRootSessionIDAsync,
  writeSidebarOpenPreference,
  type AssistantViewModel,
  type ChildActivity,
  type HistoryReliability,
} from "./magician-assistants-state.ts"

export type { AssistantViewModel, ChildActivity } from "./magician-assistants-state.ts"
export {
  MAGICIAN_ASSISTANTS_PREFERENCE_KEY,
  MAGICIAN_ASSISTANTS_SLOT_ORDER,
  aggregateAssistantModel,
  createAssistantTracker,
  createInitialAssistantModel,
  createRootTrackerSwitcher,
  deriveBeforeCursor,
  encodeMessageCursor,
  getActivityReliabilityText,
  getAssistantIdFromTaskPart,
  getHistoryReliabilityText,
  isRelevantChildSessionEvent,
  getSidebarRenderModel,
  getToolPartIdentity,
  loadFullSessionHistory,
  readSidebarOpenPreference,
  resolveCachedRootSessionID,
  resolveRootSessionID,
  resolveRootSessionIDAsync,
  writeSidebarOpenPreference,
} from "./magician-assistants-state.ts"

/**
 * Fixed width (in columns) of the assistant name cell in the sidebar rows.
 * Matches the longest accepted display name, "Knight of Swords" (16 chars),
 * so every row's count starts at the same horizontal position.
 */
export const MAGICIAN_ASSISTANTS_NAME_COLUMN_WIDTH = 16

function unwrap<T>(result: T | { data?: T; error?: unknown }, operation: string): T {
  if (result && typeof result === "object" && "error" in result && result.error) {
    throw new Error(`${operation}: ${JSON.stringify(result.error)}`)
  }
  if (result && typeof result === "object" && "data" in result) {
    if (result.data === undefined) throw new Error(`${operation}: empty response`)
    return result.data
  }
  return result as T
}

function childActivities(api: TuiPluginApi, children: readonly { id: string; agent?: unknown }[]): ChildActivity[] {
  return children.map((child) => {
    let status: string | undefined
    try {
      status = api.state.session.status(child.id)?.type
    } catch {
      status = undefined
    }
    return { id: child.id, agent: child.agent, status }
  })
}

function MagicianAssistantsPanel(props: { api: TuiPluginApi; sessionID: () => string }) {
  const [open, setOpen] = createSignal(readSidebarOpenPreference((key, fallback) => props.api.kv.get(key, fallback)))
  const [rows, setRows] = createSignal<AssistantViewModel[]>(createInitialAssistantModel())
  const [historyState, setHistoryState] = createSignal<HistoryReliability>("loading")
  const [activityState, setActivityState] = createSignal<HistoryReliability>("loading")
  const [rootState, setRootState] = createSignal<"loading" | "ready" | "unavailable">("loading")
  const rootFor = (sessionID: string) =>
    resolveCachedRootSessionID(sessionID, (id) => props.api.state.session.get(id))
  const initialRoot = rootFor(props.sessionID())
  let rootNeedsReconciliation = !initialRoot.complete

  const makeTracker = (rootSessionID: string) => {
    const loadHistory = () =>
      loadFullSessionHistory(
        (request) => props.api.client.session.messages(request),
        rootSessionID,
      )

    const loadChildren = async (): Promise<ChildActivity[]> => {
      const response = await props.api.client.session.children({ sessionID: rootSessionID })
      const children = unwrap(response, "load child sessions")
      if (!Array.isArray(children)) throw new Error("load child sessions: invalid response")
      return childActivities(props.api, children)
    }

    return createAssistantTracker({
      rootSessionID,
      loadHistory,
      loadChildren,
      onChange: setRows,
      onHistoryStateChange: setHistoryState,
      onActivityStateChange: setActivityState,
    })
  }

  const rootTrackers = createRootTrackerSwitcher(initialRoot.rootSessionID, makeTracker)
  let activeRootID = rootTrackers.activeRootID
  let tracker = rootTrackers.tracker

  let disposed = false
  let rootRequest = 0

  const switchTracker = (nextRootID: string) => {
    const changed = nextRootID !== activeRootID
    void rootTrackers.switchTracker(nextRootID)
    activeRootID = rootTrackers.activeRootID
    tracker = rootTrackers.tracker
    if (!changed) return
    setRows(createInitialAssistantModel())
  }

  const reconcileRoot = async (viewedSessionID: string) => {
    const requestID = ++rootRequest
    const cached = rootFor(viewedSessionID)
    rootNeedsReconciliation = !cached.complete
    switchTracker(cached.rootSessionID)
    setRootState("loading")

    try {
      const resolvedRootID = await resolveRootSessionIDAsync(viewedSessionID, async (sessionID) => {
        const response = await props.api.client.session.get({ sessionID })
        return unwrap(response, "load session ancestry")
      })
      if (disposed || requestID !== rootRequest || props.sessionID() !== viewedSessionID) return
      switchTracker(resolvedRootID)
      rootNeedsReconciliation = false
      setRootState("ready")
    } catch {
      if (disposed || requestID !== rootRequest || props.sessionID() !== viewedSessionID) return
      rootNeedsReconciliation = true
      setRootState("unavailable")
    }
  }

  const toggle = () => {
    const next = !open()
    setOpen(next)
    writeSidebarOpenPreference((key, value) => props.api.kv.set(key, value), next)
  }

  /**
   * The OpenTUI renderer starts text selection on `mousedown` before
   * dispatching the handler, so the heading text stays selectable=false and
   * every click clears any prior selection and stops the event from reaching
   * parent renderables, leaving only the collapse toggle behavior.
   */
  const handleHeadingMouseDown = (event: MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    props.api.renderer.clearSelection()
    toggle()
  }

  const isRelevantChildEvent = (sessionID: string, parentID?: string): boolean => {
    if (isRelevantChildSessionEvent(activeRootID, sessionID, tracker.getChildIDs(), parentID)) return true
    if (parentID !== undefined) return false
    return props.api.state.session.get(sessionID)?.parentID === activeRootID
  }

  const refreshUnknownChildEvent = async (sessionID: string, status: string) => {
    if (sessionID === activeRootID || tracker.hasChild(sessionID)) return
    try {
      const response = await props.api.client.session.get({ sessionID })
      const session = unwrap(response, "load session event context")
      if (session.parentID === activeRootID) {
        tracker.observeChildStatus(sessionID, status, session.agent)
        void tracker.refreshChildren()
      }
    } catch {
      // A status event for an unrelated or already-deleted session is benign.
    }
  }

  const cleanup = [
    props.api.event.on("message.part.updated", (event) => {
      const part = event.properties.part
      if (part.sessionID !== activeRootID) return
      tracker.setPart(part, part.messageID)
    }),
    props.api.event.on("message.part.removed", (event) => {
      if (event.properties.sessionID !== activeRootID) return
      tracker.removePart(event.properties.partID)
    }),
    props.api.event.on("message.removed", (event) => {
      if (event.properties.sessionID !== activeRootID) return
      tracker.removeMessage(event.properties.messageID)
      void tracker.refreshHistory()
    }),
    props.api.event.on("session.status", (event) => {
      if (tracker.setChildStatus(event.properties.sessionID, event.properties.status.type)) return
      void refreshUnknownChildEvent(event.properties.sessionID, event.properties.status.type)
    }),
    props.api.event.on("session.idle", (event) => {
      if (tracker.setChildStatus(event.properties.sessionID, "idle")) return
      void refreshUnknownChildEvent(event.properties.sessionID, "idle")
    }),
    props.api.event.on("session.created", (event) => {
      if (rootNeedsReconciliation || event.properties.info.id === props.sessionID()) {
        void reconcileRoot(props.sessionID())
      }
      if (isRelevantChildEvent(event.properties.info.id, event.properties.info.parentID)) void tracker.refreshChildren()
    }),
    props.api.event.on("session.updated", (event) => {
      if (rootNeedsReconciliation || event.properties.info.id === props.sessionID()) {
        void reconcileRoot(props.sessionID())
      }
      const knownChild = tracker.hasChild(event.properties.info.id)
      if (knownChild && event.properties.info.parentID !== undefined && event.properties.info.parentID !== activeRootID) {
        tracker.removeChild(event.properties.info.id)
      }
      if (isRelevantChildEvent(event.properties.info.id, event.properties.info.parentID)) void tracker.refreshChildren()
    }),
    props.api.event.on("session.deleted", (event) => {
      const relevantChild = isRelevantChildEvent(event.properties.info.id, event.properties.info.parentID)
      if (!relevantChild) return
      tracker.removeChild(event.properties.info.id)
      void tracker.refreshChildren()
    }),
  ]

  const dispose = () => {
    if (disposed) return
    disposed = true
    rootRequest += 1
    for (const remove of cleanup) remove()
    rootTrackers.dispose()
  }
  props.api.lifecycle.signal.addEventListener("abort", dispose, { once: true })
  onCleanup(() => {
    props.api.lifecycle.signal.removeEventListener("abort", dispose)
    dispose()
  })

  createEffect(() => {
    const viewedSessionID = props.sessionID()
    void reconcileRoot(viewedSessionID)
  })

  void rootTrackers.hydrateCurrent()

  return (
    <box flexDirection="column">
      <box
        flexDirection="row"
        onMouseDown={handleHeadingMouseDown}
        ref={(node) => {
          // BoxProps does not expose `selectable` (the reconciler assigns any
          // prop onto the instance, but the shipped types omit it for boxes),
          // so mirror it through the ref to keep the container non-selectable.
          node.selectable = false
        }}
      >
        <Show
          when={open()}
          fallback={
            <text fg={props.api.theme.current.text} wrapMode="none" selectable={false}>
              <b>▶ Magician Assistants (4)</b>
            </text>
          }
        >
          <text fg={props.api.theme.current.text} wrapMode="none" selectable={false}>
            <b>▼ Magician Assistants</b>
          </text>
        </Show>
      </box>
      <Show when={open()}>
        <Show when={rootState() === "loading"}>
          <text fg={props.api.theme.current.textMuted} wrapMode="none">
            {getHistoryReliabilityText("loading")}
          </text>
        </Show>
        <Show when={rootState() === "unavailable"}>
          <text fg={props.api.theme.current.textMuted} wrapMode="none">
            {getHistoryReliabilityText("unavailable")}
          </text>
        </Show>
        <Show when={rootState() === "ready" && historyState() === "loading"}>
          <text fg={props.api.theme.current.textMuted} wrapMode="none">
            {getHistoryReliabilityText("loading")}
          </text>
        </Show>
        <Show when={rootState() === "ready" && historyState() === "unavailable"}>
          <text fg={props.api.theme.current.textMuted} wrapMode="none">
            {getHistoryReliabilityText("unavailable")}
          </text>
        </Show>
        <Show when={rootState() === "ready" && historyState() === "stale"}>
          <text fg={props.api.theme.current.textMuted} wrapMode="none">
            {getHistoryReliabilityText("stale")}
          </text>
        </Show>
        <Show when={activityState() === "loading"}>
          <text fg={props.api.theme.current.textMuted} wrapMode="none">
            {getActivityReliabilityText("loading")}
          </text>
        </Show>
        <Show when={activityState() === "unavailable"}>
          <text fg={props.api.theme.current.textMuted} wrapMode="none">
            {getActivityReliabilityText("unavailable")}
          </text>
        </Show>
        <Show when={activityState() === "stale"}>
          <text fg={props.api.theme.current.textMuted} wrapMode="none">
            {getActivityReliabilityText("stale")}
          </text>
        </Show>
        <box flexDirection="column">
          <For each={rows()}>
            {(row) => (
              <box flexDirection="row" gap={1}>
                <text
                  fg={row.active ? props.api.theme.current.success : props.api.theme.current.textMuted}
                  flexShrink={0}
                  wrapMode="none"
                >
                  •
                </text>
                <box width={MAGICIAN_ASSISTANTS_NAME_COLUMN_WIDTH} flexShrink={0}>
                  <text fg={props.api.theme.current.text} wrapMode="none">
                    {row.displayName}
                  </text>
                </box>
                <text fg={props.api.theme.current.textMuted} flexShrink={0} wrapMode="none">
                  {row.count}
                </text>
              </box>
            )}
          </For>
        </box>
      </Show>
    </box>
  )
}

export function registerMagicianAssistantsSidebar(api: TuiPluginApi): string {
  const slot: TuiSlotPlugin = {
    order: MAGICIAN_ASSISTANTS_SLOT_ORDER,
    slots: {
      sidebar_content(_ctx, value) {
        return <MagicianAssistantsPanel api={api} sessionID={() => value.session_id} />
      },
    },
  }
  return api.slots.register(slot)
}

export { MAGICIAN_ASSISTANTS }
