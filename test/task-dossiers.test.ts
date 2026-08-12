import { describe, expect, test } from "bun:test"
import { openDossiers, registerDossierCommand } from "../src/task-dossiers-tui.ts"
import {
  classifyDossierStatus,
  extractDossierContract,
  formatDossierDetails,
  formatDossierSummary,
  reconstructTaskDossiers,
} from "../src/task-dossiers.ts"
import { encodeMessageCursor, type MessageRecord } from "../src/magician-assistants-state.ts"

const task = (id: string, agent: string, status: string, prompt?: string, extra: Record<string, unknown> = {}) => ({
  id,
  type: "tool",
  tool: "task",
  callID: `call-${id}`,
  state: {
    status,
    input: { subagent_type: agent, task_id: `child-${id}`, prompt, description: `Work ${id}` },
    ...extra,
  },
})

const actualNativeTask = (id: string, childID: string, output: string, description = `Actual task ${id}`) => ({
  id: `part-${id}`,
  sessionID: "root-session",
  messageID: `message-${id}`,
  type: "tool",
  tool: "task",
  callID: `call-${id}`,
  state: {
    status: "completed",
    input: {
      description,
      subagent_type: "hermit",
      prompt: `TASK\n${description}\nSCOPE\nsrc`,
    },
    output,
    metadata: { parentSessionId: "root-session", sessionId: childID },
  },
})

const message = (id: string, created: number, parts: unknown[], role = "assistant"): MessageRecord => ({
  info: { id, sessionID: "root", role, time: { created } },
  parts,
})

describe("Arcana task dossier reconstruction", () => {
  test("keeps unknown all-caps lines as content of the current known section", () => {
    expect(extractDossierContract(`TASK\nBuild it\n\nSCOPE:\nsrc only\nAUTHORIZATION\nexplicit result\nVERIFICATION\nbun test\nUNKNOWN\nignored`)).toEqual({
      task: "Build it",
      scope: "src only",
      authorization: "explicit result",
      verification: "bun test\nUNKNOWN\nignored",
    })
  })

  test("deduplicates paginated updates by stable native part identity and keeps latest state", () => {
    const first = task("same", "hermit", "running", "TASK\nInvestigate")
    const latest = { ...first, state: { ...first.state, status: "completed", output: "BLOCKED by provider" } }
    const dossiers = reconstructTaskDossiers("root", [message("old", 1, [first]), message("new", 2, [latest])], [
      { id: "child-same", status: "idle", agent: "hermit" },
    ])
    expect(dossiers).toHaveLength(1)
    expect(dossiers[0]).toMatchObject({ nativeStatus: "completed", result: "BLOCKED by provider", status: "Blocked/Failed" })
  })

  test("keeps missing child and malformed task data available without crashing", () => {
    const malformed = task("one", "hermit", "completed")
    ;(malformed.state.input as Record<string, unknown>).task_id = undefined
    const dossiers = reconstructTaskDossiers("root", [message("one", 1, [malformed])])
    expect(dossiers[0]).toMatchObject({ childSessionID: undefined, status: "Needs verification" })
    expect(dossiers[0].contract).toEqual({})
  })

  test("classifies active, failed, and conservative completion states", () => {
    expect(classifyDossierStatus({ nativeStatus: "running" })).toBe("Active")
    expect(classifyDossierStatus({ nativeStatus: "completed", result: "BLOCKED: no access" })).toBe("Blocked/Failed")
    expect(classifyDossierStatus({ nativeStatus: "completed" })).toBe("Needs verification")
    expect(classifyDossierStatus({ nativeStatus: "completed", parentVerificationEvidence: true })).toBe("Completed")
  })

  test("never promotes audit completion to implementation completion", () => {
    expect(classifyDossierStatus({ nativeStatus: "completed", isAudit: true, parentVerificationEvidence: true })).toBe(
      "Needs verification",
    )
    const dossier = reconstructTaskDossiers("root", [
      message("audit", 1, [task("audit", "justice", "completed", "TASK\nAudit it")]),
    ])[0]
    expect(dossier.isAudit).toBe(true)
    expect(dossier.status).toBe("Needs verification")
  })

  test("uses later parent verification evidence only for non-audit worker completion", () => {
    const dossier = reconstructTaskDossiers("root", [
      message("task", 1, [task("task", "hermit", "completed", "TASK\nImplement it")]),
      message("report", 2, [{ type: "text", text: "VERIFICATION\nVerification passed for child-task." }]),
    ])[0]
    expect(dossier.parentVerificationEvidence).toBe(true)
    expect(dossier.status).toBe("Completed")
  })

  test("treats negated verification statements as no verification evidence", () => {
    const negated = [
      "VERIFICATION\nNot verified for child-task.",
      "VERIFICATION\nVerification not passed for child-task.",
      "VERIFICATION\nNever verified for child-task.",
      "VERIFICATION\nVerification failed for child-task.",
      "VERIFICATION\nVerification incomplete for child-task.",
    ]
    for (const statement of negated) {
      const dossier = reconstructTaskDossiers("root", [
        message("task", 1, [task("task", "hermit", "completed", "TASK\nImplement it")]),
        message("report", 2, [{ type: "text", text: statement }]),
      ])[0]
      expect(dossier.parentVerificationEvidence).toBe(false)
      expect(dossier.status).toBe("Needs verification")
    }
  })

  test("supports actual native metadata and task_result output", () => {
    const native = {
      id: "part-one",
      sessionID: "root-session",
      messageID: "message-native",
      type: "tool",
      tool: "task",
      callID: "call-one",
      state: {
        status: "completed",
        input: { description: "Actual task", subagent_type: "hermit", prompt: "TASK\nActual task\nSCOPE\nsrc" },
        output: '<task id="ses-child" state="completed"><task_result>Worker report</task_result></task>',
        metadata: { parentSessionId: "root-session", sessionId: "ses-child" },
      },
    }
    const dossier = reconstructTaskDossiers("root-session", [message("native", 1, [native])], [
      { id: "ses-child", agent: "hermit", status: "idle" },
    ])[0]
    expect(dossier).toMatchObject({ childSessionID: "ses-child", result: "Worker report", nativeStatus: "completed" })
  })

  test("renders an empty task_result wrapper as unavailable", () => {
    const empty = {
      id: "part-empty",
      sessionID: "root-session",
      messageID: "message-empty",
      type: "tool",
      tool: "task",
      callID: "call-empty",
      state: {
        status: "completed",
        input: { description: "Empty result", subagent_type: "hermit", prompt: "TASK\nEmpty result" },
        output: '<task id="ses-empty" state="completed"><task_result></task_result></task>',
        metadata: { parentSessionId: "root-session", sessionId: "ses-empty" },
      },
    }
    const dossier = reconstructTaskDossiers("root-session", [message("empty", 1, [empty])])[0]
    expect(dossier.result).toBeUndefined()
    expect(dossier.lastReport).toBeUndefined()
    expect(formatDossierDetails(dossier).find((line) => line.startsWith("Result:"))).toBe("Result: unavailable")
  })

  test("extracts native ToolStateError text as a failed result", () => {
    const failed = task("failed", "hermit", "error", "TASK\nFail", { error: "Provider unavailable" })
    const dossier = reconstructTaskDossiers("root", [message("failed", 1, [failed])])[0]
    expect(dossier).toMatchObject({ result: "Provider unavailable", status: "Blocked/Failed" })
  })

  test("supports continuation task_id and never uses root part sessionID", () => {
    const continuation = task("continuation", "hermit", "completed", "TASK\nContinue")
    const dossier = reconstructTaskDossiers("root", [message("one", 1, [continuation])], [
      { id: "child-continuation", status: "idle" },
    ])[0]
    expect(dossier.childSessionID).toBe("child-continuation")
    expect(dossier.childSessionID).not.toBe("root")
  })

  test("tracks child availability separately from the preserved raw child ID", () => {
    const stale = reconstructTaskDossiers("root", [
      message("task", 1, [task("stale", "hermit", "completed", "TASK\nStale")]),
    ])[0]
    expect(stale.childSessionID).toBe("child-stale")
    expect(stale.childAvailable).toBe(false)
    const live = reconstructTaskDossiers("root", [
      message("task", 1, [task("live", "hermit", "completed", "TASK\nLive")]),
    ], [{ id: "child-live", status: "idle" }])[0]
    expect(live.childSessionID).toBe("child-live")
    expect(live.childAvailable).toBe(true)
  })

  test("does not correlate generic verification with parallel or duplicate work", () => {
    const dossiers = reconstructTaskDossiers("root", [
      message("one", 1, [task("one", "hermit", "completed", "TASK\nSame work")]),
      message("two", 2, [task("two", "knight-of-swords", "completed", "TASK\nSame work")]),
      message("report", 3, [{ type: "text", text: "VERIFICATION\nVerification passed." }]),
    ])
    expect(dossiers.map((dossier) => dossier.status)).toEqual(["Needs verification", "Needs verification"])
  })

  test("bounds detail fields to readable single-line summaries", () => {
    const dossier = reconstructTaskDossiers("root", [message("one", 1, [task("one", "hermit", "completed", "TASK\nShort")])])[0]
    dossier.contract.scope = "line one\nline two\n" + "x".repeat(300)
    dossier.lastReport = "result\n" + "y".repeat(300)
    const details = formatDossierDetails(dossier)
    expect(details.every((line) => !line.includes("\n"))).toBe(true)
    expect(details.find((line) => line.startsWith("Scope:"))!.length).toBeLessThanOrEqual(190)
    expect(details.find((line) => line.startsWith("Result:"))!.endsWith("...")).toBe(true)
  })

  test("renders compact status icons instead of long status labels", () => {
    const base = reconstructTaskDossiers("root", [message("one", 1, [task("one", "hermit", "running")])])[0]
    expect(formatDossierSummary(base)).toStartWith("● The Hermit - ")
    expect(formatDossierSummary({ ...base, status: "Needs verification" })).toStartWith("○ The Hermit - ")
    expect(formatDossierSummary({ ...base, status: "Completed" })).toStartWith("✓ The Hermit - ")
    expect(formatDossierSummary({ ...base, status: "Blocked/Failed" })).toStartWith("■ The Hermit - ")
    expect(formatDossierSummary({ ...base, description: "x".repeat(200) }).length).toBeLessThan(100)

    const knight = reconstructTaskDossiers("root", [message("knight", 1, [task("knight", "knight-of-swords", "running")])])[0]
    const page = reconstructTaskDossiers("root", [message("page", 1, [task("page", "page-of-swords", "running")])])[0]
    expect(formatDossierSummary(knight)).toStartWith("● Knight - ")
    expect(formatDossierSummary(page)).toStartWith("● Page - ")
  })
})

function makeTuiApi(options: {
  sessionID: string
  messages: MessageRecord[] | ((request: { before?: string }) => unknown)
  children: unknown[]
}) {
  let selectProps: { options: Array<{ title: string; value: string; onSelect?: () => void; disabled?: boolean }> } | undefined
  const dialogSizes: string[] = []
  const navigations: Array<{ name: string; params?: Record<string, unknown> }> = []
  const toasts: string[] = []
  const api = {
    route: {
      current: { name: "session", params: { sessionID: options.sessionID } },
      navigate(name: string, params?: Record<string, unknown>) {
        navigations.push({ name, params })
      },
    },
    state: {
      session: {
        get(id: string) {
          return id === "root" ? { id: "root" } : id === "child" ? { id: "child", parentID: "root" } : undefined
        },
        status(id: string) {
          return id === "child-task" ? { type: "idle" } : undefined
        },
      },
    },
    client: {
      session: {
        messages: async (request: { before?: string }) => typeof options.messages === "function" ? options.messages(request) : { data: options.messages },
        children: async () => ({ data: options.children }),
        get: async ({ sessionID }: { sessionID: string }) => ({ data: sessionID === "child" ? { parentID: "root" } : {} }),
      },
    },
    ui: {
      dialog: {
        setSize(size: string) {
          dialogSizes.push(size)
        },
        replace(render: () => unknown) {
          selectProps = (render() as { props?: unknown } | undefined)?.props as typeof selectProps
        },
        clear() {},
      },
      DialogSelect(props: typeof selectProps) {
        return { props }
      },
      toast(input: { message: string }) {
        toasts.push(input.message)
      },
    },
    keymap: {
      registerLayer(layer: { commands: Array<{ slashName?: string; run: () => unknown }> }) {
        return layer
      },
    },
  } as never
  return { api, getSelect: () => selectProps, dialogSizes, navigations, toasts }
}

describe("Arcana dossier TUI workflow", () => {
  test("registers /dossiers and tasks alias without an execution API", () => {
    let layer: { commands: Array<{ slashName?: string; slashAliases?: string[] }> } | undefined
    const api = {
      keymap: {
        registerLayer(value: typeof layer) {
          layer = value
          return () => {}
        },
      },
    } as never
    registerDossierCommand(api)
    expect(layer?.commands[0]).toMatchObject({ slashName: "dossiers", slashAliases: ["tasks"] })
  })

  test("resolves a child to its root, shows a dossier, and navigates safely", async () => {
    const native = {
      id: "part-native",
      sessionID: "root",
      messageID: "message-native",
      type: "tool",
      tool: "task",
      callID: "call-native",
      state: {
        status: "completed",
        input: { description: "Native child", subagent_type: "hermit", prompt: "TASK\nNative child" },
        output: '<task id="ses-native-child" state="completed"><task_result>Report</task_result></task>',
        metadata: { parentSessionId: "root", sessionId: "ses-native-child" },
      },
    }
    const fixture = makeTuiApi({
      sessionID: "child",
      messages: [message("task", 1, [native])],
      children: [{ id: "ses-native-child", agent: "hermit", status: "idle" }],
    })
    await openDossiers(fixture.api)
    expect(fixture.dialogSizes).toEqual(["xlarge"])
    const list = fixture.getSelect()
    expect(list?.options[0].title).toStartWith("○ The Hermit - ")
    list?.options[0].onSelect?.()
    const details = fixture.getSelect()
    expect(details?.options.find((option) => option.title === "Open child session")?.disabled).toBe(false)
    details?.options.find((option) => option.title === "Open child session")?.onSelect?.()
    details?.options.find((option) => option.title === "Open root session")?.onSelect?.()
    expect(fixture.navigations).toEqual([
      { name: "session", params: { sessionID: "ses-native-child" } },
      { name: "session", params: { sessionID: "root" } },
    ])
  })

  test("keeps a stale raw child ID visible but disables navigation to it", async () => {
    const native = {
      id: "part-stale",
      sessionID: "root",
      messageID: "message-stale",
      type: "tool",
      tool: "task",
      callID: "call-stale",
      state: {
        status: "completed",
        input: { description: "Stale child", subagent_type: "hermit", prompt: "TASK\nStale child" },
        output: '<task id="ses-gone" state="completed"><task_result>Report</task_result></task>',
        metadata: { parentSessionId: "root", sessionId: "ses-gone" },
      },
    }
    const fixture = makeTuiApi({
      sessionID: "root",
      messages: [message("task", 1, [native])],
      children: [],
    })
    await openDossiers(fixture.api)
    fixture.getSelect()?.options[0].onSelect?.()
    const details = fixture.getSelect()
    expect(details?.options.some((option) => option.title.includes("ses-gone"))).toBe(true)
    const child = details?.options.find((option) => option.title === "Open child session")
    expect(child).toMatchObject({ disabled: true, description: "ses-gone" })
    child?.onSelect?.()
    expect(fixture.navigations).toEqual([])
  })

  test("reconstructs an older-page dossier through command pagination", async () => {
    const oldPage: MessageRecord[] = [message("old", 1, [task("old", "hermit", "completed", "TASK\nOld page")])]
    const newPage: MessageRecord[] = Array.from({ length: 100 }, (_, index) =>
      message(`new-${index}`, index + 3, index === 99 ? [task("new", "justice", "completed", "TASK\nNew page")] : []),
    )
    const cursor = encodeMessageCursor(newPage[0])!
    const fixture = makeTuiApi({
      sessionID: "root",
      messages: (request) => request.before ? request.before === cursor ? { data: oldPage } : { data: [] } : { data: newPage },
      children: [],
    })
    await openDossiers(fixture.api)
    expect(fixture.getSelect()?.options.some((option) => option.title.includes("Work old"))).toBe(true)
  })

  test("reports no dossiers and unavailable history through the native toast", async () => {
    const empty = makeTuiApi({ sessionID: "root", messages: [], children: [] })
    await openDossiers(empty.api)
    expect(empty.toasts).toEqual(["No native Arcana task dossiers found."])

    const unavailable = makeTuiApi({ sessionID: "root", messages: [], children: [] })
    ;(unavailable.api as unknown as { client: { session: { messages: () => Promise<unknown> } } }).client.session.messages = async () => ({
      error: "offline",
    })
    await expect(openDossiers(unavailable.api)).rejects.toThrow("load session messages")
  })
})
