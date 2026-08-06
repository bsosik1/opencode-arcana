import { describe, expect, test } from "bun:test"
import { MAGICIAN_ASSISTANTS } from "../src/agents.ts"
import { MAGICIAN_ASSISTANTS_NAME_COLUMN_WIDTH, registerMagicianAssistantsSidebar } from "../src/magician-assistants.tsx"
import {
  MAGICIAN_ASSISTANTS_PREFERENCE_KEY,
  MAGICIAN_ASSISTANTS_SLOT_ORDER,
  aggregateAssistantModel,
  createAssistantTracker,
  createInitialAssistantModel,
  createRootTrackerSwitcher,
  deriveBeforeCursor,
  encodeMessageCursor,
  getActivityReliabilityText,
  getHistoryReliabilityText,
  getSidebarRenderModel,
  isRelevantChildSessionEvent,
  loadFullSessionHistory,
  readSidebarOpenPreference,
  resolveCachedRootSessionID,
  resolveRootSessionID,
  resolveRootSessionIDAsync,
  type ChildActivity,
  writeSidebarOpenPreference,
  type MessageRecord,
} from "../src/magician-assistants-state.ts"

let messageNumber = 0
const message = (...parts: unknown[]): MessageRecord => ({
  info: { id: `message-${messageNumber++}`, time: { created: messageNumber } },
  parts,
})

const task = (id: string, agent: string, status: string, taskID = id) => ({
  id,
  type: "tool",
  tool: "task",
  callID: `call-${id}`,
  state: {
    status,
    input: { subagent_type: agent, task_id: taskID },
  },
})

describe("Magician Assistants identity and render contract", () => {
  test("keeps the accepted four-agent order and display names", () => {
    const longestName = Math.max(...MAGICIAN_ASSISTANTS.map((assistant) => assistant.displayName.length))
    expect({ assistants: MAGICIAN_ASSISTANTS, nameColumnWidth: MAGICIAN_ASSISTANTS_NAME_COLUMN_WIDTH, longestName }).toEqual({
      assistants: [
        { id: "knight-of-swords", displayName: "Knight of Swords" },
        { id: "hermit", displayName: "The Hermit" },
        { id: "page-of-swords", displayName: "Page of Swords" },
        { id: "justice", displayName: "Justice" },
      ],
      nameColumnWidth: 16,
      longestName: 16,
    })
  })

  test("has a fixed expanded and collapsed structure", () => {
    const rows = createInitialAssistantModel()
    const expanded = getSidebarRenderModel(rows, true)
    const collapsed = getSidebarRenderModel(rows, false)

    expect(expanded.heading).toBe("▼ Magician Assistants")
    expect(expanded.rows).toHaveLength(4)
    expect(expanded.bodyVisible).toBe(true)
    expect(collapsed.heading).toBe("▶ Magician Assistants (4)")
    expect(collapsed.rows).toEqual([])
    expect(collapsed.bodyVisible).toBe(false)
  })

  test("uses minimal non-authoritative history status copy", () => {
    expect(getHistoryReliabilityText("loading")).toBe("Loading history…")
    expect(getHistoryReliabilityText("unavailable")).toBe("History unavailable")
    expect(getHistoryReliabilityText("stale")).toBe("History stale")
    expect(getHistoryReliabilityText("ready")).toBeUndefined()
    expect(getActivityReliabilityText("loading")).toBe("Activity loading…")
    expect(getActivityReliabilityText("unavailable")).toBe("Activity unavailable")
    expect(getActivityReliabilityText("stale")).toBe("Activity stale")
    expect(getActivityReliabilityText("ready")).toBeUndefined()
  })

  test("persists only the open/collapsed preference", () => {
    let stored: unknown
    const get = (key: string, fallback: boolean) => (key === MAGICIAN_ASSISTANTS_PREFERENCE_KEY ? stored ?? fallback : fallback)
    const set = (key: string, value: boolean) => {
      stored = key === MAGICIAN_ASSISTANTS_PREFERENCE_KEY ? value : stored
    }

    expect(readSidebarOpenPreference(get)).toBe(true)
    writeSidebarOpenPreference(set, false)
    expect(readSidebarOpenPreference(get)).toBe(false)
    expect(stored).toBe(false)
    stored = "invalid"
    expect(readSidebarOpenPreference(get)).toBe(true)
  })

  test("registers between Quota and MCP", () => {
    let registration: { order?: number } | undefined
    const api = {
      slots: {
        register(slot: { order?: number }) {
          registration = slot
          return "arcana-slot"
        },
      },
    } as never

    expect(registerMagicianAssistantsSidebar(api)).toBe("arcana-slot")
    expect(registration?.order).toBe(MAGICIAN_ASSISTANTS_SLOT_ORDER)
    expect(MAGICIAN_ASSISTANTS_SLOT_ORDER).toBe(175)
  })
})

describe("Magician Assistants aggregation", () => {
  test("starts with four idle zero-count rows", () => {
    expect(createInitialAssistantModel()).toEqual([
      { id: "knight-of-swords", displayName: "Knight of Swords", active: false, count: 0 },
      { id: "hermit", displayName: "The Hermit", active: false, count: 0 },
      { id: "page-of-swords", displayName: "Page of Swords", active: false, count: 0 },
      { id: "justice", displayName: "Justice", active: false, count: 0 },
    ])
  })

  test("counts running, completed, and error tasks but not pending", () => {
    const rows = aggregateAssistantModel([
      message(
        task("running", "knight-of-swords", "running"),
        task("completed", "knight-of-swords", "completed"),
        task("error", "knight-of-swords", "error"),
        task("pending", "knight-of-swords", "pending"),
      ),
    ])

    expect(rows[0]).toMatchObject({ count: 3, active: true })
  })

  test("deduplicates streaming updates by ToolPart id", () => {
    const rows = aggregateAssistantModel([
      message(task("same", "hermit", "running"), task("same", "hermit", "completed")),
    ])

    expect(rows[1]).toMatchObject({ count: 1, active: false })
  })

  test("counts continuation calls with the same task_id as distinct parts", () => {
    const rows = aggregateAssistantModel([
      message(task("first-part", "hermit", "completed", "same-task"), task("second-part", "hermit", "completed", "same-task")),
    ])

    expect(rows[1].count).toBe(2)
  })

  test("distributes cross-validation calls independently", () => {
    const rows = aggregateAssistantModel([
      message(task("page", "page-of-swords", "completed"), task("justice", "justice", "error")),
    ])

    expect(rows[2].count).toBe(1)
    expect(rows[3].count).toBe(1)
  })

  test("marks activity from a running parent task and busy/retry children", () => {
    const rows = aggregateAssistantModel(
      [message(task("running", "knight-of-swords", "running"))],
      [
        { id: "busy-child", agent: "hermit", status: "busy" },
        { id: "retry-child", agent: "page-of-swords", status: "retry" },
      ],
    )

    expect(rows.map((row) => row.active)).toEqual([true, true, true, false])
  })

  test("keeps completed, error, idle, and pending activity gray/inactive", () => {
    const rows = aggregateAssistantModel(
      [
        message(
          task("completed", "knight-of-swords", "completed"),
          task("error", "hermit", "error"),
          task("pending", "page-of-swords", "pending"),
        ),
      ],
      [{ id: "idle-child", agent: "justice", status: "idle" }],
    )

    expect(rows.map((row) => row.active)).toEqual([false, false, false, false])
  })
})

describe("Magician Assistants history and roots", () => {
  test("hydrates a replacement root tracker exactly once and populates its model", async () => {
    const calls = new Map<string, { history: number; children: number }>()
    const models: Array<{ rootID: string; model: ReturnType<typeof createInitialAssistantModel> }> = []
    const createTracker = (rootID: string) => {
      calls.set(rootID, { history: 0, children: 0 })
      return createAssistantTracker({
        rootSessionID: rootID,
        loadHistory: async () => {
          calls.get(rootID)!.history += 1
          return [message(task(`${rootID}-history`, "justice", "completed"))]
        },
        loadChildren: async () => {
          calls.get(rootID)!.children += 1
          return [{ id: `${rootID}-child`, agent: "hermit", status: "busy" }]
        },
        onChange: (model) => models.push({ rootID, model }),
      })
    }
    const switcher = createRootTrackerSwitcher("child", createTracker)

    await switcher.hydrateCurrent()
    await switcher.switchTracker("root")
    await switcher.switchTracker("root")

    expect(calls.get("child")).toEqual({ history: 1, children: 1 })
    expect(calls.get("root")).toEqual({ history: 1, children: 1 })
    expect(switcher.activeRootID).toBe("root")
    expect(models.at(-1)?.rootID).toBe("root")
    expect(models.at(-1)?.model[3]).toMatchObject({ count: 1 })
    expect(models.at(-1)?.model[1]).toMatchObject({ active: true })
    switcher.dispose()
  })

  test("prevents rapid root switches from publishing disposed hydration", async () => {
    let resolveFirstHistory!: (messages: MessageRecord[]) => void
    let resolveFirstChildren!: (children: ChildActivity[]) => void
    const models: Array<{ rootID: string; model: ReturnType<typeof createInitialAssistantModel> }> = []
    const createTracker = (rootID: string) =>
      createAssistantTracker({
        rootSessionID: rootID,
        loadHistory: async () => {
          if (rootID === "first") return new Promise((resolve) => (resolveFirstHistory = resolve))
          return [message(task(`${rootID}-history`, "page-of-swords", "completed"))]
        },
        loadChildren: async () => {
          if (rootID === "first") return new Promise((resolve) => (resolveFirstChildren = resolve))
          return []
        },
        onChange: (model) => models.push({ rootID, model }),
      })
    const switcher = createRootTrackerSwitcher("child", createTracker)

    const firstHydration = switcher.switchTracker("first")
    const secondHydration = switcher.switchTracker("second")
    await secondHydration
    resolveFirstHistory([message(task("stale", "justice", "completed"))])
    resolveFirstChildren([{ id: "stale-child", agent: "hermit", status: "busy" }])
    await firstHydration

    expect(switcher.activeRootID).toBe("second")
    expect(models.at(-1)?.rootID).toBe("second")
    expect(models.at(-1)?.model[2]).toMatchObject({ count: 1 })
    expect(models.at(-1)?.model[3]).toMatchObject({ count: 0 })
    switcher.dispose()
  })

  test("resolves the highest available parent", () => {
    const sessions = new Map([
      ["child", { parentID: "middle" }],
      ["middle", { parentID: "root" }],
      ["root", {}],
    ])

    expect(resolveRootSessionID("child", (id) => sessions.get(id))).toBe("root")
  })

  test("uses the viewed session as a safe cycle fallback", () => {
    const sessions = new Map([
      ["a", { parentID: "b" }],
      ["b", { parentID: "a" }],
    ])

    expect(resolveRootSessionID("a", (id) => sessions.get(id))).toBe("a")
    expect(resolveRootSessionID("b", (id) => sessions.get(id))).toBe("b")
  })

  test("uses cached ancestry immediately and resolves missing ancestry asynchronously", async () => {
    const sessions = new Map<string, { parentID?: string }>([["child", { parentID: "root" }]])
    expect(resolveCachedRootSessionID("child", (id) => sessions.get(id))).toEqual({
      rootSessionID: "child",
      complete: false,
    })

    sessions.set("root", {})
    await expect(resolveRootSessionIDAsync("child", async (id) => sessions.get(id))).resolves.toBe("root")
  })

  test("rejects asynchronous ancestry cycles instead of choosing a stale root", async () => {
    const sessions = new Map([
      ["a", { parentID: "b" }],
      ["b", { parentID: "a" }],
    ])

    await expect(resolveRootSessionIDAsync("a", async (id) => sessions.get(id))).rejects.toThrow("ancestry cycle")
  })

  test("filters child events by root, known child, or explicit parent", () => {
    expect(isRelevantChildSessionEvent("root", "root", ["child"])).toBe(false)
    expect(isRelevantChildSessionEvent("root", "child", ["child"])).toBe(true)
    expect(isRelevantChildSessionEvent("root", "new-child", [], "root")).toBe(true)
    expect(isRelevantChildSessionEvent("root", "other", [], "other-root")).toBe(false)
  })

  test("does not treat an unrelated session deletion as an active-root child event", () => {
    expect(isRelevantChildSessionEvent("root", "unrelated", ["child"], "other-root")).toBe(false)
    expect(isRelevantChildSessionEvent("root", "child", ["child"], "other-root")).toBe(true)
  })

  test("reconstructs each root independently without cross-session leakage", () => {
    const rootA = aggregateAssistantModel([message(task("a", "hermit", "completed"))])
    const rootB = aggregateAssistantModel([message(task("b", "justice", "completed"))])

    expect(rootA[1].count).toBe(1)
    expect(rootA[3].count).toBe(0)
    expect(rootB[1].count).toBe(0)
    expect(rootB[3].count).toBe(1)
  })

  test("follows multiple pages using a cursor derived from returned records", async () => {
    const requests: Array<{ sessionID: string; limit: number; before?: string }> = []
    const record = (id: number): MessageRecord => ({
      info: { id: `message-${id}`, sessionID: "root", time: { created: id } },
      parts: [task(`part-${id}`, "justice", "completed")],
    })
    const first = [record(100), record(101)]
    const second = [record(98), record(99)]
    const cursorOne = encodeMessageCursor(first[0])
    const cursorTwo = encodeMessageCursor(second[0])

    const history = await loadFullSessionHistory(
      async (request) => {
        requests.push(request)
        if (!request.before) return { data: first }
        if (request.before === cursorOne) return { data: second }
        return { data: [] }
      },
      "root",
      { limit: 2 },
    )

    expect(requests).toEqual([
      { sessionID: "root", limit: 2, before: undefined },
      { sessionID: "root", limit: 2, before: cursorOne },
      { sessionID: "root", limit: 2, before: cursorTwo },
    ])
    expect(history.map((record) => record.info?.id)).toEqual(["message-98", "message-99", "message-100", "message-101"])
    expect(deriveBeforeCursor(first)).toBe(cursorOne)
  })

  test("keeps overlapping message records so distinct ToolParts are unioned", async () => {
    const record = (id: number, parts: unknown[]): MessageRecord => ({
      info: { id: `message-${id}`, sessionID: "root", time: { created: id } },
      parts,
    })
    const overlapping = task("overlap", "justice", "completed")
    const first = [record(100, [overlapping]), record(101, [task("newer", "justice", "completed")])]
    const second = [
      record(98, [task("old", "justice", "completed")]),
      record(100, [task("overlap", "justice", "pending"), task("union", "justice", "completed")]),
    ]
    let calls = 0
    const history = await loadFullSessionHistory(
      async () => {
        calls += 1
        if (calls === 1) return { data: first }
        if (calls === 2) return { data: second }
        return { data: [] }
      },
      "root",
      { limit: 2 },
    )

    expect(aggregateAssistantModel(history)[3].count).toBe(4)
  })

  test("accepts an older short terminal page but rejects malformed short pages", async () => {
    let calls = 0
    const history = await loadFullSessionHistory(
      async () => {
        calls += 1
        if (calls === 1) {
          return [
            { info: { id: "new", time: { created: 3 } }, parts: [] },
            { info: { id: "newer", time: { created: 4 } }, parts: [] },
          ]
        }
        return [{ info: { id: "old", time: { created: 1 } }, parts: [] }]
      },
      "root",
      { limit: 2 },
    )
    expect(history.map((record) => record.info?.id)).toEqual(["old", "new", "newer"])

    let malformedCalls = 0
    const malformed = loadFullSessionHistory(
      async () => {
        malformedCalls += 1
        if (malformedCalls === 1) {
          return [
            { info: { id: "new", time: { created: 3 } }, parts: [] },
            { info: { id: "newer", time: { created: 4 } }, parts: [] },
          ]
        }
        return [{ info: { id: "missing-position" } }, { info: { id: "also-missing" } }]
      },
      "root",
      { limit: 2 },
    )
    await expect(malformed).rejects.toThrow("missing cursor")
  })

  test("rejects a repeated cursor rather than accepting partial history", async () => {
    let calls = 0
    const page: MessageRecord[] = [
      { info: { id: "one", time: { created: 1 } }, parts: [] },
      { info: { id: "two", time: { created: 2 } }, parts: [] },
    ]
    const history = loadFullSessionHistory(
      async () => {
        calls += 1
        return page
      },
      "root",
      { limit: 2 },
    )

    await expect(history).rejects.toThrow("cursor did not advance")
    expect(calls).toBe(2)
  })

  test("rejects a full page with no derivable cursor", async () => {
    const history = loadFullSessionHistory(
      async () => [
        { info: { id: "one" }, parts: [] },
        { info: { id: "two" }, parts: [] },
      ],
      "root",
      { limit: 2 },
    )

    await expect(history).rejects.toThrow("missing cursor")
  })

  test("rejects a changing cursor when the oldest message does not advance", async () => {
    let calls = 0
    const history = loadFullSessionHistory(
      async () => {
        calls += 1
        if (calls === 1) {
          return [
            { info: { id: "one", time: { created: 1 } }, parts: [] },
            { info: { id: "two", time: { created: 2 } }, parts: [] },
          ]
        }
        return [
          { info: { id: "one", time: { created: 3 } }, parts: [] },
          { info: { id: "three", time: { created: 4 } }, parts: [] },
        ]
      },
      "root",
      { limit: 2 },
    )

    await expect(history).rejects.toThrow("oldest message did not advance")
    expect(calls).toBe(2)
  })

  test("rejects a cursor that returns a newer page", async () => {
    let calls = 0
    const history = loadFullSessionHistory(
      async () => {
        calls += 1
        if (calls === 1) {
          return [
            { info: { id: "one", time: { created: 1 } }, parts: [] },
            { info: { id: "two", time: { created: 2 } }, parts: [] },
          ]
        }
        return [
          { info: { id: "three", time: { created: 3 } }, parts: [] },
          { info: { id: "four", time: { created: 4 } }, parts: [] },
        ]
      },
      "root",
      { limit: 2 },
    )

    await expect(history).rejects.toThrow("did not advance to older messages")
    expect(calls).toBe(2)
  })

  test("rejects when the configured page limit is exhausted", async () => {
    const history = loadFullSessionHistory(
      async () => [
        { info: { id: "one", time: { created: 1 } }, parts: [] },
        { info: { id: "two", time: { created: 2 } }, parts: [] },
      ],
      "root",
      { limit: 1, maxPages: 1 },
    )

    await expect(history).rejects.toThrow("page limit reached")
  })

  test("marks initial history failure unavailable while preserving live state", async () => {
    const states: string[] = []
    const tracker = createAssistantTracker({
      rootSessionID: "root",
      loadHistory: async () => {
        throw new Error("temporary API failure")
      },
      loadChildren: async () => [],
      onHistoryStateChange: (state) => states.push(state),
    })
    expect(tracker.getHistoryState()).toBe("loading")
    tracker.setPart(task("live", "knight-of-swords", "completed"), "message")
    await tracker.refreshHistory()

    expect(states).toEqual(["loading", "unavailable"])
    expect(tracker.getHistoryState()).toBe("unavailable")
    expect(tracker.getModel()[0].count).toBe(1)
    tracker.dispose()
  })

  test("marks successful hydration ready and later failure stale", async () => {
    let fail = false
    const states: string[] = []
    const tracker = createAssistantTracker({
      rootSessionID: "root",
      loadHistory: async () => {
        if (fail) throw new Error("temporary API failure")
        return [message(task("known", "justice", "completed"))]
      },
      loadChildren: async () => [],
      onHistoryStateChange: (state) => states.push(state),
    })

    await tracker.refreshHistory()
    expect(tracker.getHistoryState()).toBe("ready")
    expect(tracker.getModel()[3].count).toBe(1)
    fail = true
    await tracker.refreshHistory()

    expect(states).toEqual(["loading", "ready", "stale"])
    expect(tracker.getHistoryState()).toBe("stale")
    expect(tracker.getModel()[3].count).toBe(1)
    tracker.dispose()
  })

  test("tracks activity reliability and preserves observed child status across refresh races", async () => {
    let fail = true
    const states: string[] = []
    let resolveChildren!: (children: ChildActivity[]) => void
    const tracker = createAssistantTracker({
      rootSessionID: "root",
      loadHistory: async () => [],
      loadChildren: async () => {
        if (fail) throw new Error("temporary child API failure")
        return new Promise((resolve) => (resolveChildren = resolve))
      },
      onActivityStateChange: (state) => states.push(state),
    })

    await tracker.refreshChildren()
    expect(tracker.getActivityState()).toBe("unavailable")

    fail = false
    const hydration = tracker.refreshChildren()
    tracker.observeChildStatus("child", "busy", "hermit")
    resolveChildren([{ id: "child", agent: "hermit", status: "idle" }])
    await hydration

    expect(tracker.getActivityState()).toBe("ready")
    expect(tracker.getModel()[1].active).toBe(true)
    expect(states).toEqual(["loading", "unavailable", "ready"])

    fail = true
    await tracker.refreshChildren()
    expect(tracker.getActivityState()).toBe("stale")
    expect(tracker.getModel()[1].active).toBe(true)
    tracker.dispose()
  })

  test("removes deleted messages from history and live observations", async () => {
    const removed: MessageRecord = {
      info: { id: "removed-message", time: { created: 1 } },
      parts: [task("removed-part", "justice", "completed")],
    }
    const tracker = createAssistantTracker({
      rootSessionID: "root",
      loadHistory: async () => [removed],
      loadChildren: async () => [],
    })

    await tracker.refreshHistory()
    expect(tracker.getModel()[3].count).toBe(1)
    tracker.setPart(task("live-part", "justice", "completed"), "live-message")
    expect(tracker.getModel()[3].count).toBe(2)
    tracker.removeMessage("removed-message")
    tracker.removeMessage("live-message")
    await tracker.refreshHistory()

    expect(tracker.getModel()[3].count).toBe(0)
    tracker.dispose()
  })

  test("keeps child deletion ahead of an in-flight children snapshot", async () => {
    let resolveChildren!: (children: ChildActivity[]) => void
    const tracker = createAssistantTracker({
      rootSessionID: "root",
      loadHistory: async () => [],
      loadChildren: () => new Promise((resolve) => (resolveChildren = resolve)),
    })
    const refresh = tracker.refreshChildren()
    tracker.observeChildStatus("child", "busy", "hermit")
    tracker.removeChild("child")
    resolveChildren([{ id: "child", agent: "hermit", status: "busy" }])
    await refresh

    expect(tracker.hasChild("child")).toBe(false)
    expect(tracker.getModel()[1].active).toBe(false)
    tracker.dispose()
  })

  test("keeps deleted children absent after late status events", () => {
    const tracker = createAssistantTracker({
      rootSessionID: "root",
      loadHistory: async () => [],
      loadChildren: async () => [],
    })
    tracker.setChildren([{ id: "deleted-child", agent: "hermit", status: "idle" }])
    tracker.removeChild("deleted-child")
    tracker.observeChildStatus("deleted-child", "busy", "hermit")
    tracker.observeChildStatus("deleted-child", "retry", "hermit")

    expect(tracker.hasChild("deleted-child")).toBe(false)
    expect(tracker.getModel()[1].active).toBe(false)
    tracker.dispose()
  })

  test("keeps deleted children absent from post-removal snapshots", async () => {
    const tracker = createAssistantTracker({
      rootSessionID: "root",
      loadHistory: async () => [],
      loadChildren: async () => [{ id: "deleted-child", agent: "hermit", status: "busy" }],
    })
    tracker.setChildren([{ id: "deleted-child", agent: "hermit", status: "busy" }])
    tracker.removeChild("deleted-child")
    await tracker.refreshChildren()

    expect(tracker.hasChild("deleted-child")).toBe(false)
    expect(tracker.getModel()[1].active).toBe(false)
    tracker.dispose()
  })

  test("flows pagination non-advance errors into unavailable state", async () => {
    const page: MessageRecord[] = [
      { info: { id: "one", time: { created: 1 } }, parts: [] },
      { info: { id: "two", time: { created: 2 } }, parts: [] },
    ]
    const states: string[] = []
    const tracker = createAssistantTracker({
      rootSessionID: "root",
      loadHistory: () => loadFullSessionHistory(async () => page, "root", { limit: 2 }),
      loadChildren: async () => [],
      onHistoryStateChange: (state) => states.push(state),
    })

    await tracker.refreshHistory()

    expect(states).toEqual(["loading", "unavailable"])
    expect(tracker.getHistoryState()).toBe("unavailable")
    tracker.dispose()
  })

  test("ignores stale hydration after disposal", async () => {
    let resolve!: (value: MessageRecord[]) => void
    const changed: unknown[] = []
    const tracker = createAssistantTracker({
      rootSessionID: "root",
      loadHistory: () => new Promise((done) => (resolve = done)),
      loadChildren: async () => [],
      onChange: (value) => changed.push(value),
    })
    const hydration = tracker.hydrate()
    tracker.dispose()
    resolve([message(task("late", "justice", "completed"))])
    await hydration

    expect(changed).toEqual([])
  })
})
