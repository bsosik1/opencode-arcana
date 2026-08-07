import { describe, expect, test } from "bun:test"
import {
  DEFAULT_MAGICIAN_ASSISTANT_NOTIFICATION_DURATION,
  createMagicianAssistantNotificationLedger,
  createMagicianAssistantNotificationStore,
  registerMagicianAssistantNotifications,
  type MagicianAssistantNotificationScheduler,
  type MagicianAssistantNotificationApi,
} from "../src/magician-assistant-notifications.ts"
import { getStableToolPartIdentity, getToolPartIdentity } from "../src/magician-assistants-state.ts"

type LiveEventHandler = (event: { properties: { sessionID: string; part: unknown } }) => void | Promise<void>

const task = (
  id: string | undefined,
  agent: string,
  status: string,
  options: { callID?: string; messageID?: string } = {},
) => ({
  ...(id === undefined ? {} : { id }),
  ...(options.callID === undefined ? {} : { callID: options.callID }),
  ...(options.messageID === undefined ? {} : { messageID: options.messageID }),
  type: "tool",
  tool: "task",
  state: {
    status,
    input: { subagent_type: agent },
  },
})

function createFakeScheduler() {
  let now = 0
  let sequence = 0
  const timers = new Map<number, { at: number; callback: () => void }>()
  const callbacks = new Map<number, () => void>()
  const delays: number[] = []
  let clearCount = 0
  const scheduler: MagicianAssistantNotificationScheduler & {
    advance(delay: number): void
    callbacks: Map<number, () => void>
    clearCount(): number
    delays: number[]
    lastHandle(): number | undefined
    pendingCount(): number
  } = {
    now: () => now,
    setTimeout(callback, delay) {
      const id = ++sequence
      timers.set(id, { at: now + delay, callback })
      callbacks.set(id, callback)
      delays.push(delay)
      return id
    },
    clearTimeout(handle) {
      clearCount += 1
      timers.delete(handle as number)
    },
    advance(delay) {
      now += delay
      while (true) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= now)
          .toSorted(([, left], [, right]) => left.at - right.at)
        const next = due[0]
        if (!next) return
        timers.delete(next[0])
        next[1].callback()
      }
    },
    callbacks,
    clearCount: () => clearCount,
    delays,
    lastHandle: () => (sequence > 0 ? sequence : undefined),
    pendingCount: () => timers.size,
  }
  return scheduler
}

function createSynchronousScheduler() {
  const timers = new Map<number, () => void>()
  let sequence = 0
  let clearCount = 0
  const scheduler: MagicianAssistantNotificationScheduler & {
    clearCount(): number
    pendingCount(): number
  } = {
    now: () => 0,
    setTimeout(callback) {
      const id = ++sequence
      timers.set(id, callback)
      callback()
      return id
    },
    clearTimeout(handle) {
      clearCount += 1
      timers.delete(handle as number)
    },
    clearCount: () => clearCount,
    pendingCount: () => timers.size,
  }
  return scheduler
}

function createHarness(initialSessionID = "root") {
  const handlers = new Set<LiveEventHandler>()
  const disposeHandlers = new Set<() => void>()
  const sessions = new Map<string, { parentID?: string }>([["root", {}]])
  const remoteSessions = new Map<string, { parentID?: string }>([["root", {}]])
  const toasts: Array<Record<string, unknown>> = []
  const registrations: string[] = []
  const scheduler = createFakeScheduler()
  const store = createMagicianAssistantNotificationStore({ scheduler })
  const clientSessionRequests: string[] = []
  let route: { name: "home" } | { name: "session"; params: { sessionID: string } } = {
    name: "session",
    params: { sessionID: initialSessionID },
  }
  let historyReads = 0
  let loadSession = async (sessionID: string): Promise<unknown> => {
    clientSessionRequests.push(sessionID)
    const session = remoteSessions.get(sessionID)
    if (!session) throw new Error(`missing session: ${sessionID}`)
    return { data: session }
  }

  const api = {
    event: {
      on(type: string, handler: LiveEventHandler) {
        registrations.push(type)
        if (type !== "message.part.updated") throw new Error(`unexpected event: ${type}`)
        handlers.add(handler)
        return () => handlers.delete(handler)
      },
    },
    lifecycle: {
      signal: new AbortController().signal,
      onDispose(handler: () => void) {
        disposeHandlers.add(handler)
        return () => disposeHandlers.delete(handler)
      },
    },
    route: {
      get current() {
        return route
      },
    },
    client: {
      session: {
        get({ sessionID }: { sessionID: string }) {
          return loadSession(sessionID)
        },
      },
    },
    state: {
      session: {
        get(sessionID: string) {
          return sessions.get(sessionID)
        },
        messages() {
          historyReads += 1
          return []
        },
      },
    },
    ui: {
      toast(input: Record<string, unknown>) {
        toasts.push(input)
      },
    },
  } as unknown as MagicianAssistantNotificationApi

  const emit = (part: unknown, sessionID = initialSessionID) =>
    Promise.all([...handlers].map((handler) => handler({ properties: { sessionID, part } })))

  return {
    api,
    register(notificationStore = store) {
      return registerMagicianAssistantNotifications(api, { store: notificationStore })
    },
    emit,
    toasts,
    store,
    scheduler,
    get latestToast() {
      return toasts[toasts.length - 1]
    },
    latestToastMessage(): string | undefined {
      const message = toasts[toasts.length - 1]?.message
      return typeof message === "string" ? message : undefined
    },
    get notifications() {
      return store.getEntries()
    },
    registrations,
    clientSessionRequests,
    get historyReads() {
      return historyReads
    },
    get listenerCount() {
      return handlers.size
    },
    addSession(sessionID: string, parentID?: string) {
      sessions.set(sessionID, { parentID })
      remoteSessions.set(sessionID, { parentID })
    },
    removeCachedSession(sessionID: string) {
      sessions.delete(sessionID)
    },
    setRemoteSession(sessionID: string, parentID?: string) {
      remoteSessions.set(sessionID, { parentID })
    },
    setClientSessionGetter(getter: (sessionID: string) => Promise<unknown>) {
      loadSession = getter
    },
    setRoute(next: "home" | string) {
      route = next === "home" ? { name: "home" } : { name: "session", params: { sessionID: next } }
    },
    disposeLifecycle() {
      for (const handler of [...disposeHandlers]) handler()
    },
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

describe("Magician Assistant notification ledger", () => {
  test("does not count a pending-only observation", () => {
    const ledger = createMagicianAssistantNotificationLedger()

    expect(ledger.observe("root", task("pending", "hermit", "pending"))).toBeUndefined()
    ledger.dispose()
  })

  test("emits once on pending to running to completed and ignores updates", () => {
    const ledger = createMagicianAssistantNotificationLedger()
    const pending = task("same", "hermit", "pending")

    expect(ledger.observe("root", pending)).toBeUndefined()
    expect(ledger.observe("root", task("same", "hermit", "running"))).toBe("hermit")
    expect(ledger.observe("root", task("same", "hermit", "completed"))).toBeUndefined()
    ledger.dispose()
  })

  test("emits once when the first live status is running, completed, or error", () => {
    for (const status of ["running", "completed", "error"]) {
      const ledger = createMagicianAssistantNotificationLedger()
      const part = task(status, "justice", status)

      expect(ledger.observe("root", part)).toBe("justice")
      expect(ledger.observe("root", task(status, "justice", "completed"))).toBeUndefined()
      ledger.dispose()
    }
  })

  test("counts distinct invocations for one agent separately", () => {
    const ledger = createMagicianAssistantNotificationLedger()

    expect(ledger.observe("root", task("first", "hermit", "completed"))).toBe("hermit")
    expect(ledger.observe("root", task("second", "hermit", "completed"))).toBe("hermit")
    ledger.dispose()
  })

  test("counts Page and Justice cross-validation invocations separately", () => {
    const ledger = createMagicianAssistantNotificationLedger()

    expect(ledger.observe("root", task("page", "page-of-swords", "completed"))).toBe("page-of-swords")
    expect(ledger.observe("root", task("justice", "justice", "error"))).toBe("justice")
    ledger.dispose()
  })

  test("ignores unknown and external agents", () => {
    const ledger = createMagicianAssistantNotificationLedger()

    expect(ledger.observe("root", task("external", "external-agent", "completed"))).toBeUndefined()
    expect(ledger.observe("root", { type: "tool", tool: "read", state: { status: "completed" } })).toBeUndefined()
    ledger.dispose()
  })

  test("keys the ledger by root and stable ToolPart identity", () => {
    const ledger = createMagicianAssistantNotificationLedger()
    const part = task("shared-id", "knight-of-swords", "completed")

    expect(ledger.observe("root-a", part)).toBe("knight-of-swords")
    expect(ledger.observe("root-a", task("shared-id", "knight-of-swords", "completed"))).toBeUndefined()
    expect(ledger.observe("root-b", part)).toBe("knight-of-swords")
    ledger.dispose()
  })

  test("uses part id, then callID, and declines unstable live fallback identity", () => {
    const byPartID = task("part-id", "hermit", "completed", { callID: "call-a", messageID: "message-a" })
    const byCallID = task(undefined, "hermit", "completed", { callID: "call-b", messageID: "message-a" })
    const withoutStableIdentity = task(undefined, "hermit", "completed", { messageID: "message-a" })

    expect(getStableToolPartIdentity(byPartID)).toBe("part:part-id")
    expect(getStableToolPartIdentity(byCallID)).toBe("call:message-a:call-b")
    expect(getStableToolPartIdentity(withoutStableIdentity)).toBeUndefined()
    expect(getToolPartIdentity(withoutStableIdentity, "message-a", 0)).toBe("fallback:message-a:0:hermit")
    expect(getToolPartIdentity(withoutStableIdentity, "message-a", 1)).toBe("fallback:message-a:1:hermit")

    const ledger = createMagicianAssistantNotificationLedger()
    expect(ledger.observe("root", byPartID)).toBe("hermit")
    expect(ledger.observe("root", task("part-id", "hermit", "completed"))).toBeUndefined()
    expect(ledger.observe("root", byCallID)).toBe("hermit")
    expect(
      ledger.observe("root", task(undefined, "hermit", "completed", { callID: "call-b", messageID: "message-a" })),
    ).toBeUndefined()
    expect(ledger.observe("root", withoutStableIdentity)).toBeUndefined()
    ledger.dispose()
  })
})

describe("Magician Assistant notification store", () => {
  test("normalizes missing and nonfinite durations while preserving finite values", () => {
    const cases: Array<[number | undefined, number]> = [
      [undefined, DEFAULT_MAGICIAN_ASSISTANT_NOTIFICATION_DURATION],
      [Number.NaN, DEFAULT_MAGICIAN_ASSISTANT_NOTIFICATION_DURATION],
      [Number.POSITIVE_INFINITY, DEFAULT_MAGICIAN_ASSISTANT_NOTIFICATION_DURATION],
      [Number.NEGATIVE_INFINITY, DEFAULT_MAGICIAN_ASSISTANT_NOTIFICATION_DURATION],
      [-100, 0],
      [125, 125],
    ]

    for (const [duration, expected] of cases) {
      const scheduler = createFakeScheduler()
      const store = createMagicianAssistantNotificationStore({ duration, scheduler })
      const entry = store.add("Task delegated to Justice")

      expect(entry?.expiresAt).toBe(expected)
      expect(scheduler.delays).toEqual([expected])
      store.dispose()
    }
  })

  test("publishes then immediately removes an entry for a synchronous zero-duration scheduler", () => {
    const scheduler = createSynchronousScheduler()
    const store = createMagicianAssistantNotificationStore({ duration: 0, scheduler })
    const snapshots: string[][] = []
    store.subscribe(() => snapshots.push(store.getEntries().map((entry) => entry.message)))

    expect(store.add("Task delegated to Page of Swords")).toBeUndefined()
    expect(snapshots).toEqual([["Task delegated to Page of Swords"], []])
    expect(store.getEntries()).toEqual([])
    expect(scheduler.pendingCount()).toBe(0)
    expect(scheduler.clearCount()).toBe(1)
    store.dispose()
  })

  test("rolls back the published entry when scheduling throws", () => {
    let clearCount = 0
    const scheduler: MagicianAssistantNotificationScheduler = {
      now: () => 0,
      setTimeout() {
        throw new Error("scheduler unavailable")
      },
      clearTimeout() {
        clearCount += 1
      },
    }
    const store = createMagicianAssistantNotificationStore({ scheduler })
    const snapshots: string[][] = []
    store.subscribe(() => snapshots.push(store.getEntries().map((entry) => entry.message)))

    expect(() => store.add("Task delegated to The Hermit")).not.toThrow()
    expect(store.add("Task delegated to Justice")).toBeUndefined()
    expect(snapshots).toEqual([
      ["Task delegated to The Hermit"],
      [],
      ["Task delegated to Justice"],
      [],
    ])
    expect(store.getEntries()).toEqual([])
    expect(clearCount).toBe(0)
    store.dispose()
  })

  test("appends entries in event order and expires each entry independently", () => {
    const scheduler = createFakeScheduler()
    const store = createMagicianAssistantNotificationStore({ scheduler })

    store.add("Task delegated to Page of Swords")
    scheduler.advance(1_000)
    store.add("Task delegated to Justice")

    expect(store.getEntries().map((entry) => entry.message)).toEqual([
      "Task delegated to Page of Swords",
      "Task delegated to Justice",
    ])

    scheduler.advance(4_000)
    expect(store.getEntries().map((entry) => entry.message)).toEqual(["Task delegated to Justice"])
    scheduler.advance(1_000)
    expect(store.getEntries()).toEqual([])
    store.dispose()
  })

  test("dispose clears entries, timers, listeners, and late mutations", () => {
    const scheduler = createFakeScheduler()
    const store = createMagicianAssistantNotificationStore({ scheduler })
    let changes = 0
    store.subscribe(() => {
      changes += 1
    })
    store.add("Task delegated to The Hermit")
    const handle = scheduler.lastHandle()
    expect(scheduler.pendingCount()).toBe(1)

    store.dispose()
    const changesAfterDispose = changes
    expect(store.getEntries()).toEqual([])
    expect(scheduler.pendingCount()).toBe(0)

    expect(store.add("Task delegated to Justice")).toBeUndefined()
    scheduler.callbacks.get(handle!)?.()
    scheduler.advance(10_000)
    expect(store.getEntries()).toEqual([])
    expect(changes).toBe(changesAfterDispose)
  })
})

describe("Magician Assistant notification controller", () => {
  test("does not let a throwing scheduler escape the live event listener", () => {
    const harness = createHarness()
    const scheduler: MagicianAssistantNotificationScheduler = {
      now: () => 0,
      setTimeout() {
        throw new Error("scheduler unavailable")
      },
      clearTimeout() {},
    }
    const store = createMagicianAssistantNotificationStore({ scheduler })
    harness.register(store)

    expect(() => harness.emit(task("scheduler-error", "justice", "completed"))).not.toThrow()
    expect(store.getEntries()).toEqual([])
  })

  test("registers one live listener and no app slot, and pushes no initial toast", () => {
    const harness = createHarness()
    harness.register()

    expect("slots" in harness.api).toBe(false)
    expect("theme" in harness.api).toBe(false)
    expect(harness.registrations).toEqual(["message.part.updated"])
    expect(harness.toasts).toEqual([])
  })

  test("first delegation pushes one native toast with exactly one line", () => {
    const harness = createHarness()
    harness.register()

    harness.emit(task("first", "knight-of-swords", "running"))

    expect(harness.toasts).toHaveLength(1)
    expect(harness.latestToast).toEqual({
      variant: "info",
      message: "Task delegated to Knight of Swords",
      duration: DEFAULT_MAGICIAN_ASSISTANT_NOTIFICATION_DURATION,
    })
    expect(harness.latestToast?.title).toBeUndefined()
  })

  test("stacks Page and Justice cross-validation entries simultaneously", () => {
    const harness = createHarness()
    harness.register()

    harness.emit(task("page", "page-of-swords", "completed"))
    harness.emit(task("justice", "justice", "error"))

    expect(harness.notifications.map((entry) => entry.message)).toEqual([
      "Task delegated to Page of Swords",
      "Task delegated to Justice",
    ])
    expect(harness.latestToast?.message).toBe(
      "Task delegated to Page of Swords\nTask delegated to Justice",
    )
    expect(harness.latestToastMessage()?.split("\n")).toHaveLength(2)
  })

  test("stacks Knight and Page entries simultaneously", () => {
    const harness = createHarness()
    harness.register()

    harness.emit(task("knight", "knight-of-swords", "running"))
    harness.emit(task("page", "page-of-swords", "completed"))

    expect(harness.notifications.map((entry) => entry.message)).toEqual([
      "Task delegated to Knight of Swords",
      "Task delegated to Page of Swords",
    ])
    expect(harness.latestToast?.message).toBe(
      "Task delegated to Knight of Swords\nTask delegated to Page of Swords",
    )
    expect(harness.latestToastMessage()?.split("\n")).toHaveLength(2)
  })

  test("keeps three different agents in the stack", () => {
    const harness = createHarness()
    harness.register()

    for (const [index, agent] of ["knight-of-swords", "hermit", "justice"].entries()) {
      harness.emit(task(`three-${index}`, agent, "completed"))
    }

    expect(harness.notifications).toHaveLength(3)
    expect(harness.latestToastMessage()?.split("\n")).toHaveLength(3)
    expect(harness.latestToast?.message).toBe(
      "Task delegated to Knight of Swords\nTask delegated to The Hermit\nTask delegated to Justice",
    )
  })

  test("keeps four agents in the stack without a fixed maximum", () => {
    const harness = createHarness()
    harness.register()

    for (const [index, agent] of ["knight-of-swords", "hermit", "page-of-swords", "justice"].entries()) {
      harness.emit(task(`four-${index}`, agent, "completed"))
    }

    expect(harness.notifications).toHaveLength(4)
    expect(new Set(harness.notifications.map((entry) => entry.id)).size).toBe(4)
    expect(harness.latestToastMessage()?.split("\n")).toHaveLength(4)
    expect(harness.latestToast?.message).toBe(
      "Task delegated to Knight of Swords\nTask delegated to The Hermit\nTask delegated to Page of Swords\nTask delegated to Justice",
    )
  })

  test("keeps repeated same-agent invocations separate and duplicate status updates singular", () => {
    const harness = createHarness()
    harness.register()

    harness.emit(task("same-first", "hermit", "running"))
    harness.emit(task("same-first", "hermit", "completed"))
    harness.emit(task("same-second", "hermit", "completed"))

    expect(harness.notifications).toHaveLength(2)
    expect(harness.notifications.map((entry) => entry.message)).toEqual([
      "Task delegated to The Hermit",
      "Task delegated to The Hermit",
    ])
    expect(harness.latestToast?.message).toBe(
      "Task delegated to The Hermit\nTask delegated to The Hermit",
    )
  })

  test("removes one expired entry while retaining later entries", () => {
    const harness = createHarness()
    harness.register()

    harness.emit(task("early", "page-of-swords", "completed"))
    harness.scheduler.advance(1_000)
    harness.emit(task("late", "justice", "completed"))
    harness.scheduler.advance(4_000)

    expect(harness.notifications.map((entry) => entry.message)).toEqual(["Task delegated to Justice"])
    expect(harness.latestToast?.message).toBe("Task delegated to Justice")
    harness.scheduler.advance(1_000)
    expect(harness.notifications).toEqual([])
  })

  test("never pushes an empty toast when all entries expire", () => {
    const harness = createHarness()
    harness.register()

    harness.emit(task("expiring", "justice", "completed"))
    harness.scheduler.advance(1_000)
    harness.emit(task("expiring-two", "page-of-swords", "completed"))
    harness.scheduler.advance(4_000)

    expect(harness.notifications.map((entry) => entry.message)).toEqual([
      "Task delegated to Page of Swords",
    ])
    expect(harness.latestToast?.message).toBe("Task delegated to Page of Swords")

    const toastCountBeforeFinalExpiry = harness.toasts.length
    harness.scheduler.advance(5_000)

    expect(harness.notifications).toEqual([])
    expect(harness.toasts.length).toBe(toastCountBeforeFinalExpiry)
    expect(harness.toasts.some((toast) => toast.message === "")).toBe(false)
    expect(harness.latestToast?.message).toBe("Task delegated to Page of Swords")
  })

  test("registers one live listener without reading history or panel state", () => {
    const harness = createHarness()
    harness.register()

    harness.emit(task("live", "knight-of-swords", "completed"))

    expect(harness.registrations).toEqual(["message.part.updated"])
    expect(harness.historyReads).toBe(0)
    expect(harness.notifications).toHaveLength(1)
  })

  test("filters unrelated background sessions", () => {
    const harness = createHarness("root")
    harness.addSession("background")
    harness.register()

    harness.emit(task("background", "justice", "completed"), "background")

    expect(harness.notifications).toEqual([])
  })

  test("maps a current child route to its parent root", () => {
    const harness = createHarness("root")
    harness.addSession("child", "root")
    harness.setRoute("child")
    harness.register()

    harness.emit(task("root-task", "page-of-swords", "running"), "root")

    expect(harness.notifications).toHaveLength(1)
    expect(harness.notifications[0]?.message).toBe("Task delegated to Page of Swords")
  })

  test("resolves an incomplete cached ancestry through the public client", async () => {
    const harness = createHarness("child")
    harness.addSession("child", "root")
    harness.removeCachedSession("root")
    harness.setRemoteSession("root")
    harness.register()

    await harness.emit(task("async-root", "justice", "completed"), "root")

    expect(harness.clientSessionRequests).toEqual(["root"])
    expect(harness.notifications.map((entry) => entry.message)).toEqual(["Task delegated to Justice"])
  })

  test("does not emit a child-session event after resolving its root", async () => {
    const harness = createHarness("child")
    harness.addSession("child", "root")
    harness.removeCachedSession("root")
    harness.register()

    await harness.emit(task("child-task", "hermit", "running"), "child")

    expect(harness.notifications).toEqual([])
  })

  test("drops an event when the viewed route changes during ancestry resolution", async () => {
    const harness = createHarness("child")
    harness.addSession("child", "root")
    harness.removeCachedSession("root")
    const ancestry = deferred<unknown>()
    harness.setClientSessionGetter(async () => ancestry.promise)
    harness.register()

    const resolving = harness.emit(task("stale-route", "page-of-swords", "completed"), "root")
    harness.setRoute("other")
    ancestry.resolve({ data: {} })
    await resolving

    expect(harness.notifications).toEqual([])
  })

  test("drops an event when disposed during ancestry resolution", async () => {
    const harness = createHarness("child")
    harness.addSession("child", "root")
    harness.removeCachedSession("root")
    const ancestry = deferred<unknown>()
    harness.setClientSessionGetter(async () => ancestry.promise)
    harness.register()

    const resolving = harness.emit(task("disposed", "knight-of-swords", "completed"), "root")
    harness.disposeLifecycle()
    ancestry.resolve({ data: {} })
    await resolving

    expect(harness.notifications).toEqual([])
  })

  test("does not emit when public ancestry resolution fails", async () => {
    const harness = createHarness("child")
    harness.addSession("child", "root")
    harness.removeCachedSession("root")
    harness.setClientSessionGetter(async () => {
      throw new Error("ancestry unavailable")
    })
    harness.register()

    await harness.emit(task("ancestry-error", "justice", "error"), "root")

    expect(harness.notifications).toEqual([])
  })

  test("deduplicates concurrent pending and running events after async resolution", async () => {
    const harness = createHarness("child")
    harness.addSession("child", "root")
    harness.removeCachedSession("root")
    const pendingResolution = deferred<unknown>()
    const runningResolution = deferred<unknown>()
    let request = 0
    harness.setClientSessionGetter(async () => {
      request += 1
      return (request === 1 ? pendingResolution : runningResolution).promise
    })
    harness.register()

    const pending = harness.emit(task("concurrent", "hermit", "pending"), "root")
    const running = harness.emit(task("concurrent", "hermit", "running"), "root")
    runningResolution.resolve({ data: {} })
    pendingResolution.resolve({ data: {} })
    await Promise.all([pending, running])

    expect(harness.notifications.map((entry) => entry.message)).toEqual(["Task delegated to The Hermit"])
  })

  test("does not depend on whether the sidebar is open", () => {
    const harness = createHarness()
    const panelOpen = false
    harness.register()

    harness.emit(task("collapsed", "justice", "completed"))

    expect(panelOpen).toBe(false)
    expect(harness.notifications).toHaveLength(1)
  })

  test("keeps a removed and replayed invocation at most once", () => {
    const harness = createHarness()
    harness.register()
    const part = task("replayed", "hermit", "completed")

    harness.emit(part)
    harness.emit(part)

    expect(harness.notifications).toHaveLength(1)
    expect(harness.latestToast?.message).toBe("Task delegated to The Hermit")
    expect(harness.latestToastMessage()?.split("\n")).toHaveLength(1)
  })

  test("disposes the event listener through the lifecycle", () => {
    const harness = createHarness()
    harness.register()
    expect(harness.listenerCount).toBe(1)

    harness.disposeLifecycle()
    harness.emit(task("after-dispose", "justice", "completed"))

    expect(harness.listenerCount).toBe(0)
    expect(harness.notifications).toEqual([])
    expect(harness.scheduler.pendingCount()).toBe(0)
  })

  test("dispose unsubscribes the store and pushes no late native toasts", () => {
    const harness = createHarness()
    harness.register()

    harness.emit(task("before-dispose", "justice", "completed"))
    const toastCountBeforeDispose = harness.toasts.length
    expect(toastCountBeforeDispose).toBe(1)

    harness.disposeLifecycle()
    harness.scheduler.advance(10_000)

    expect(harness.toasts.length).toBe(toastCountBeforeDispose)
  })

  test("uses the exact compact text-only copy for all four agents", () => {
    const harness = createHarness()
    harness.register()
    const expected = [
      "Task delegated to Knight of Swords",
      "Task delegated to The Hermit",
      "Task delegated to Page of Swords",
      "Task delegated to Justice",
    ]

    for (const [index, agent] of ["knight-of-swords", "hermit", "page-of-swords", "justice"].entries()) {
      harness.emit(task(`copy-${index}`, agent, "completed"))
    }

    expect(harness.notifications.map((entry) => entry.message)).toEqual(expected)
    for (const entry of harness.notifications) {
      expect(entry.message).toMatch(/^[A-Za-z ]+$/)
      expect(entry.message).not.toMatch(/[0-9!]/)
    }

    expect(harness.latestToast?.title).toBeUndefined()
    expect(harness.latestToast?.message).toBe(expected.join("\n"))
    for (const line of harness.latestToastMessage()!.split("\n")) {
      expect(line).toMatch(/^[A-Za-z ]+$/)
      expect(line).not.toMatch(/[0-9!]/)
    }
  })

  test("does not emit while viewing a non-session route", () => {
    const harness = createHarness()
    harness.setRoute("home")
    harness.register()

    harness.emit(task("home", "justice", "completed"))

    expect(harness.notifications).toEqual([])
  })
})
