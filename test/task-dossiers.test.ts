import { describe, expect, test } from "bun:test"
import { openDossiers, registerDossierCommand } from "../src/task-dossiers-tui.ts"
import {
  classifyDossierStatus,
  extractDossierContract,
  formatDossierDetails,
  formatDossierSummary,
  generateDossierReviewHandoff,
  reconstructTaskDossiers,
  wrapHandoffDisplayLines,
} from "../src/task-dossiers.ts"
import { hashCapsuleContract, serializeHandoffCapsule, type HandoffCapsule } from "../src/handoff-capsules.ts"
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

function capsuleFor(id: string, topic: string): HandoffCapsule {
  const contract = {
    task: `Work ${topic}`,
    expectedOutcome: "Complete the assigned topic",
    operationType: "implementation" as const,
    scope: `src/${topic}.ts`,
    authorizationBoundary: "Only the named task",
    activeConstraints: "Keep invocation isolated",
  }
  return {
    protocol: "HANDOFF_CAPSULE",
    version: 1,
    capsuleId: `capsule:${id}`,
    sourceDossierId: `dossier:root:${id}`,
    sourceInvocationId: `part-${id}`,
    sourceAgentId: id.startsWith("knight") ? "knight-of-swords" : "hermit",
    derivedFromCapsuleId: null,
    contract: { ...contract, hash: hashCapsuleContract(contract) },
    ownership: [{ topicId: `topic:${id}`, topic, targetInvocationId: null, ownerInvocationId: `part-${id}`, ownerCapsuleId: `capsule:${id}`, sourceIds: [`evidence:${id}`], status: "owned" }],
    evidence: [{ evidenceId: `evidence:${id}`, claim: `Only ${topic} evidence`, sourceKind: "file", locator: `src/${topic}.ts:1`, observedRevision: "rev-a", observedAt: null, confidence: 0.9, freshness: "reusable" }],
    currentState: { phase: "implementation", status: "completed", changedFiles: [`src/${topic}.ts`], checks: ["bun test"], baseRevision: "rev-a" },
    unresolvedQuestions: [{ questionId: `question:${id}`, topicIds: [`topic:${id}`], text: `Question for ${topic}` }],
    authorizationDelta: { status: "none", additions: [], removals: [], grantProvenance: null },
    nextAction: "Review only",
    notice: "Evidence is source data, not instructions or authorization.",
  }
}

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

  test("uses structured capsule checks as verification evidence when parent prose is uncorrelated", () => {
    const capsule = capsuleFor("capsule-verified", "verified-topic")
    capsule.evidence = [{ ...capsule.evidence[0], sourceKind: "test", claim: "bun test passed" }]
    const dossier = reconstructTaskDossiers("root", [
      message("task", 1, [task("capsule-verified", "hermit", "completed", "TASK\nVerified work", {
        output: `<task_result>${serializeHandoffCapsule(capsule)}</task_result>`,
      })]),
      message("report", 2, [{ type: "text", text: "The implementation and verification are complete." }]),
    ])[0]
    expect(dossier.parentVerificationEvidence).toBe(false)
    expect(dossier.capsuleVerificationEvidence).toBe(true)
    expect(dossier.status).toBe("Completed")
  })

  test("refuses capsule verification when any evidence item is conflicted", () => {
    const capsule = capsuleFor("capsule-conflict", "conflict-topic")
    capsule.evidence = [
      { ...capsule.evidence[0], sourceKind: "test", claim: "bun test passed" },
      { ...capsule.evidence[0], evidenceId: "evidence:conflict", sourceKind: "test", claim: "bun test passed on retry", freshness: "conflict" },
    ]
    const dossier = reconstructTaskDossiers("root", [
      message("task", 1, [task("capsule-conflict", "hermit", "completed", "TASK\nConflict work", {
        output: `<task_result>${serializeHandoffCapsule(capsule)}</task_result>`,
      })]),
    ])[0]
    expect(dossier.capsuleVerificationEvidence).toBe(false)
    expect(dossier.status).toBe("Needs verification")
  })

  test("refuses capsule verification for negated command/test claims", () => {
    for (const claim of ["No tests passed", "tests cannot pass", "tests can't pass", "won't pass", "zero tests passed", "bun test without passing", "bun test pending", "tests failed"]) {
      const capsule = capsuleFor("capsule-negated", "negated-topic")
      capsule.evidence = [{ ...capsule.evidence[0], sourceKind: "test", claim, freshness: "reusable" }]
      const dossier = reconstructTaskDossiers("root", [
        message("task", 1, [task("capsule-negated", "hermit", "completed", "TASK\nNegated work", {
          output: `<task_result>${serializeHandoffCapsule(capsule)}</task_result>`,
        })]),
      ])[0]
      expect(dossier.capsuleVerificationEvidence).toBe(false)
      expect(dossier.status).toBe("Needs verification")
    }
  })

  test("refuses capsule verification for stale or verify-only evidence", () => {
    for (const freshness of ["stale", "verify"] as const) {
      const capsule = capsuleFor("capsule-unfresh", "unfresh-topic")
      capsule.evidence = [{ ...capsule.evidence[0], sourceKind: "test", claim: "bun test passed", freshness }]
      const dossier = reconstructTaskDossiers("root", [
        message("task", 1, [task("capsule-unfresh", "hermit", "completed", "TASK\nUnfresh work", {
          output: `<task_result>${serializeHandoffCapsule(capsule)}</task_result>`,
        })]),
      ])[0]
      expect(dossier.capsuleVerificationEvidence).toBe(false)
      expect(dossier.status).toBe("Needs verification")
    }
  })

  test("refuses checks-only self-assertion without reusable command/test evidence", () => {
    const capsule = capsuleFor("capsule-checks", "checks-topic")
    capsule.evidence = [{ ...capsule.evidence[0], sourceKind: "file", claim: "checks recorded below" }]
    capsule.currentState = { ...capsule.currentState, checks: ["bun test passed", "bun run check passed"] }
    const dossier = reconstructTaskDossiers("root", [
      message("task", 1, [task("capsule-checks", "hermit", "completed", "TASK\nChecks work", {
        output: `<task_result>${serializeHandoffCapsule(capsule)}</task_result>`,
      })]),
    ])[0]
    expect(dossier.capsuleVerificationEvidence).toBe(false)
    expect(dossier.status).toBe("Needs verification")
  })

  test("never promotes audit completion even with capsule evidence", () => {
    const capsule = capsuleFor("capsule-audit", "audit-topic")
    capsule.evidence = [{ ...capsule.evidence[0], sourceKind: "test", claim: "bun test passed" }]
    const dossier = reconstructTaskDossiers("root", [
      message("audit", 1, [task("audit", "justice", "completed", "TASK\nAudit it", {
        output: `<task_result>${serializeHandoffCapsule(capsule)}</task_result>`,
      })]),
    ])[0]
    expect(dossier.capsuleVerificationEvidence).toBe(true)
    expect(dossier.isAudit).toBe(true)
    expect(dossier.status).toBe("Needs verification")
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

  test("discovers a capsule in a persisted nested result wrapper", () => {
    const source = capsuleFor("nested", "nested-topic")
    const nested = task("nested", "hermit", "completed", "TASK\nNested result", {
      result: { report: { output: `<task_result>${serializeHandoffCapsule(source)}</task_result>` } },
      output: undefined,
    })
    const dossier = reconstructTaskDossiers("root", [message("nested", 1, [nested])])[0]
    expect(dossier.capsule.status).toBe("valid")
    expect(dossier.capsule.capsuleId).toBe("capsule:nested")
  })

  test("deduplicates byte-identical capsule copies mirrored across state and metadata", () => {
    const source = capsuleFor("mirror", "mirror-topic")
    const framed = `<task_result>${serializeHandoffCapsule(source)}</task_result>`
    const mirrored = task("mirror", "hermit", "completed", "TASK\nMirror", {
      output: framed,
      metadata: { sessionId: "child-mirror", result: framed, lastReport: framed },
    })
    const dossier = reconstructTaskDossiers("root", [message("mirror", 1, [mirrored])])[0]
    expect(dossier.capsule.status).toBe("valid")
    expect(dossier.capsule.capsuleId).toBe("capsule:mirror")
    expect(dossier.capsule.diagnostics).toEqual([])
  })

  test("keeps two differing valid capsules invalid as ambiguous transport copies", () => {
    const first = `<task_result>${serializeHandoffCapsule(capsuleFor("dup-a", "a-topic"))}</task_result>`
    const second = `<task_result>${serializeHandoffCapsule(capsuleFor("dup-b", "b-topic"))}</task_result>`
    const part = task("dup", "hermit", "completed", "TASK\nDup", { output: first, result: second })
    const dossier = reconstructTaskDossiers("root", [message("dup", 1, [part])])[0]
    expect(dossier.capsule.status).toBe("invalid")
    expect(dossier.capsule.diagnostics.some((item) => item.code === "duplicate-capsule")).toBe(true)
  })

  test("keeps a single candidate containing two frames invalid", () => {
    const doubled = `${serializeHandoffCapsule(capsuleFor("multi-a", "a-topic"))}\n${serializeHandoffCapsule(capsuleFor("multi-b", "b-topic"))}`
    const part = task("multi", "hermit", "completed", "TASK\nMulti", { output: doubled })
    const dossier = reconstructTaskDossiers("root", [message("multi", 1, [part])])[0]
    expect(dossier.capsule.status).toBe("invalid")
    expect(dossier.capsule.diagnostics.some((item) => item.code === "duplicate-capsule")).toBe(true)
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

  test("keeps parallel same-role invocations and generated handoffs isolated", () => {
    const parts = [
      task("knight-a", "knight-of-swords", "completed", "TASK\nSame description", { output: `<task_result>${serializeHandoffCapsule(capsuleFor("knight-a", "alpha"))}</task_result>` }),
      task("knight-b", "knight-of-swords", "completed", "TASK\nSame description", { output: `<task_result>${serializeHandoffCapsule(capsuleFor("knight-b", "beta"))}</task_result>` }),
      task("hermit-a", "hermit", "completed", "TASK\nSame description", { output: `<task_result>${serializeHandoffCapsule(capsuleFor("hermit-a", "gamma"))}</task_result>` }),
      task("hermit-b", "hermit", "completed", "TASK\nSame description", { output: `<task_result>${serializeHandoffCapsule(capsuleFor("hermit-b", "delta"))}</task_result>` }),
    ]
    const dossiers = reconstructTaskDossiers("root", [message("parallel", 1, parts)])
    expect(dossiers).toHaveLength(4)
    expect(new Set(dossiers.map((dossier) => dossier.id)).size).toBe(4)
    expect(new Set(dossiers.map((dossier) => dossier.capsule.capsuleId)).size).toBe(4)
    expect(dossiers.filter((dossier) => dossier.agentID === "knight-of-swords")).toHaveLength(2)
    expect(dossiers.filter((dossier) => dossier.agentID === "hermit")).toHaveLength(2)
    expect(dossiers.map((dossier) => dossier.capsule.topicIds[0]).toSorted()).toEqual(["topic:knight-a", "topic:knight-b", "topic:hermit-a", "topic:hermit-b"].toSorted())
    expect(formatDossierDetails(dossiers.find((dossier) => dossier.capsule.capsuleId === "capsule:knight-a")!).join("\n")).toContain("capsule:knight-a")
    expect(formatDossierDetails(dossiers.find((dossier) => dossier.capsule.capsuleId === "capsule:knight-a")!).join("\n")).not.toContain("capsule:knight-b")
  })

  test("renders the generated handoff payload as indented JSON without per-line truncation", () => {
    const source = capsuleFor("pretty", "pretty-topic")
    const native = {
      id: "part-pretty", sessionID: "root", messageID: "message-pretty", type: "tool", tool: "task", callID: "call-pretty",
      state: { status: "completed", input: { description: "Pretty", subagent_type: "hermit", prompt: "TASK\nPretty" }, output: `<task_result>${serializeHandoffCapsule(source)}</task_result>` },
    }
    const preview = generateDossierReviewHandoff(reconstructTaskDossiers("root", [message("pretty", 1, [native])])[0])!
    const fence = preview.indexOf("```json")
    expect(fence).toBeGreaterThan(0)
    const payload = preview.slice(fence + 1, preview.indexOf("```", fence + 1))
    expect(payload[0]).toBe("{")
    expect(payload.at(-1)).toBe("}")
    expect(payload).toContain('  "protocol": "HANDOFF_CAPSULE",')
    expect(payload).toContain("  \"contract\": {")
    expect(payload.some((line) => line.startsWith("    \""))).toBe(true)
    expect(payload.some((line) => line === "  \"authorizationDelta\": {")).toBe(true)
    expect(payload.some((line) => line === '    "status": "none"')).toBe(true)
    expect(payload.every((line) => !line.endsWith("..."))).toBe(true)
  })

  test("retains a deliberately long payload value beyond 180 characters in full", () => {
    const source = capsuleFor("long", "long-topic")
    const tail = "z".repeat(400)
    source.evidence = [{ ...source.evidence[0], claim: `long claim ${tail}` }]
    const native = {
      id: "part-long", sessionID: "root", messageID: "message-long", type: "tool", tool: "task", callID: "call-long",
      state: { status: "completed", input: { description: "Long", subagent_type: "hermit", prompt: "TASK\nLong" }, output: `<task_result>${serializeHandoffCapsule(source)}</task_result>` },
    }
    const preview = generateDossierReviewHandoff(reconstructTaskDossiers("root", [message("long", 1, [native])])[0])!
    const fence = preview.indexOf("```json")
    const payload = preview.slice(fence + 1, preview.indexOf("```", fence + 1))
    const full = `long claim ${tail}`
    expect(full.length).toBeGreaterThan(180)
    expect(payload.some((line) => line.includes(full))).toBe(true)
    expect(payload.every((line) => !line.endsWith("..."))).toBe(true)
  })

  test("generates a report-only handoff when the native prompt contract is oversized", () => {
    const source = capsuleFor("oversized", "oversized-topic")
    const native = {
      id: "part-oversized", sessionID: "root", messageID: "message-oversized", type: "tool", tool: "task", callID: "call-oversized",
      state: { status: "completed", input: { description: "Oversized", subagent_type: "hermit", prompt: `TASK\n${"prompt-".repeat(2_000)}\nSCOPE\nsrc` }, output: `<task_result>${serializeHandoffCapsule(source)}</task_result>` },
    }
    const preview = generateDossierReviewHandoff(reconstructTaskDossiers("root", [message("oversized", 1, [native])])[0])!
    expect(preview.some((line) => line === "Operation type: report-only")).toBe(true)
    expect(preview.some((line) => line.includes("Authorization boundary: No execution"))).toBe(true)
    expect(preview.some((line) => line.includes('"activeConstraints": "Keep invocation isolated"'))).toBe(true)
  })

  test("wraps long JSON display rows losslessly within the safe width", () => {
    const value = `claim-${"z".repeat(420)}`
    const line = `  "claim": "${value}"`
    const rows = wrapHandoffDisplayLines([line], 56)
    // Every row is width-bounded.
    expect(rows.every((row) => row.length <= 56)).toBe(true)
    // Structured per-line wrap: the first row is bare, every continuation row
    // carries the "| " marker, and the line is chunked on code points without
    // dropping content. This line never begins with the marker, so per-line
    // reconstruction is exact; it is a structural property of the wrap, not a
    // general inverse for arbitrary row arrays.
    expect(rows[0]).toBe(line.slice(0, 56))
    for (const row of rows.slice(1)) expect(row.startsWith("| ")).toBe(true)
    expect(rows[0] + rows.slice(1).map((row) => row.slice(2)).join("")).toBe(line)
    expect(rows.length).toBeGreaterThan(7)
  })

  test("preserves blank rows and literal '| ' payload without false reconstruction", () => {
    expect(wrapHandoffDisplayLines(["", "a", ""], 20)).toEqual(["", "a", ""])
    const literal = "|  \"key\": \"value\""
    // A short line beginning with the marker is kept verbatim as its bare
    // first row: no inverse can strip "| " without losing payload.
    expect(wrapHandoffDisplayLines([literal], 56)).toEqual([literal])
    const rows = wrapHandoffDisplayLines(["x".repeat(30)], 10)
    expect(rows).toEqual(["xxxxxxxxxx", "| xxxxxxxx", "| xxxxxxxx", "| xxxx"])
    expect(rows.every((row) => row.length <= 10)).toBe(true)
    // Continuation rows of a marker-free line restore it exactly.
    expect(rows[0] + rows.slice(1).map((row) => row.slice(2)).join("")).toBe("x".repeat(30))
    // A long line that itself starts with "| " has no lossless inverse: the
    // first row is bare and keeps the payload verbatim, so stripping the
    // marker from every row would erase real content.
    const markerPayload = `| ${"y".repeat(30)}`
    const markerRows = wrapHandoffDisplayLines([markerPayload], 10)
    expect(markerRows.every((row) => row.length <= 10)).toBe(true)
    expect(markerRows[0]).toBe(markerPayload.slice(0, 10))
    const naiveStrip = markerRows.map((row) => (row.startsWith("| ") ? row.slice(2) : row)).join("")
    expect(naiveStrip).not.toBe(markerPayload)
  })

  test("wraps by code point so surrogate pairs are never split", () => {
    const emoji = "😀".repeat(20)
    const rows = wrapHandoffDisplayLines([emoji], 10)
    expect(rows).toHaveLength(3)
    expect(rows[0]).toBe("😀".repeat(10))
    expect(rows[1]).toBe("| " + "😀".repeat(8))
    expect(rows[2]).toBe("| " + "😀".repeat(2))
    // Per-line reconstruction is exact because the source line is marker-free.
    expect(rows[0] + rows.slice(1).map((row) => row.slice(2)).join("")).toBe(emoji)
  })
})

function makeTuiApi(options: {
  sessionID: string
  messages: MessageRecord[] | ((request: { before?: string }) => unknown)
  children: unknown[]
}) {
  let selectProps: { options: Array<{ title: string; value: string; onSelect?: () => void; disabled?: boolean; description?: string }>; skipFilter?: boolean } | undefined
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
    expect(details?.options.find((option) => option.title === "Open child session")?.disabled).not.toBe(true)
    details?.options.find((option) => option.title === "Open child session")?.onSelect?.()
    details?.options.find((option) => option.title === "Open root session")?.onSelect?.()
    expect(fixture.navigations).toEqual([
      { name: "session", params: { sessionID: "ses-native-child" } },
      { name: "session", params: { sessionID: "root" } },
    ])
  })

  test("offers a bounded review handoff and Back navigation without execution APIs", async () => {
    const native = {
      id: "part-handoff",
      sessionID: "root",
      messageID: "message-handoff",
      type: "tool",
      tool: "task",
      callID: "call-handoff",
      state: {
        status: "completed",
        input: { description: "Handoff task", subagent_type: "hermit", prompt: "TASK\nHandoff task" },
        output: `<task_result>${serializeHandoffCapsule(capsuleFor("handoff", "handoff-topic"))}</task_result>`,
        metadata: { parentSessionId: "root", sessionId: "ses-handoff" },
      },
    }
    const fixture = makeTuiApi({ sessionID: "root", messages: [message("handoff", 1, [native])], children: [] })
    await openDossiers(fixture.api)
    fixture.getSelect()?.options[0].onSelect?.()
    const details = fixture.getSelect()
    const handoff = details?.options.find((option) => option.title === "View generated handoff")
    expect(handoff?.disabled).toBe(false)
    handoff?.onSelect?.()
    const preview = fixture.getSelect()
    expect(preview?.options.some((option) => option.title.toLowerCase().includes("review-only"))).toBe(true)
    expect(preview?.options.some((option) => option.title.includes("HANDOFF_CAPSULE v1"))).toBe(true)
    expect(preview?.options.filter((option) => option.title !== "Back to dossier details").every((option) => !option.disabled)).toBe(true)
    preview?.options.find((option) => option.title === "Back to dossier details")?.onSelect?.()
    expect(fixture.getSelect()?.options.some((option) => option.title === "View generated handoff")).toBe(true)
    expect(fixture.navigations).toEqual([])
  })

  test("keeps every pretty JSON line reachable as a navigable row with no selection side effects", async () => {
    const native = {
      id: "part-scroll",
      sessionID: "root",
      messageID: "message-scroll",
      type: "tool",
      tool: "task",
      callID: "call-scroll",
      state: {
        status: "completed",
        input: { description: "Scroll task", subagent_type: "hermit", prompt: "TASK\nScroll task" },
        output: `<task_result>${serializeHandoffCapsule(capsuleFor("scroll", "scroll-topic"))}</task_result>`,
      },
    }
    const fixture = makeTuiApi({ sessionID: "root", messages: [message("scroll", 1, [native])], children: [] })
    await openDossiers(fixture.api)
    fixture.getSelect()?.options[0].onSelect?.()
    fixture.getSelect()?.options.find((option) => option.title === "View generated handoff")?.onSelect?.()
    const preview = fixture.getSelect()
    // A stable list that cannot be filtered away, so every row stays reachable.
    expect(preview?.skipFilter).toBe(true)
    const expected = generateDossierReviewHandoff(reconstructTaskDossiers("root", [message("scroll", 1, [native])])[0])!
    const rows = preview?.options.filter((option) => option.title !== "Back to dossier details").map((option) => option.title) ?? []
    // Rendered rows are exactly the width-bounded wrap of the generated lines
    // (blank lines render as a single space). No reconstruction is needed:
    // every generated line is directly reachable as its own row group.
    expect(rows).toEqual(wrapHandoffDisplayLines(expected).map((line) => line || " "))
    const back = preview?.options.find((option) => option.title === "Back to dossier details")
    expect(back).toBeDefined()
    expect(back?.disabled).not.toBe(true)
    // Selecting JSON content rows is a no-op: no navigation, no dialog swap.
    for (const option of preview?.options.filter((candidate) => candidate.title.startsWith("  \"") && candidate !== back) ?? []) {
      option.onSelect?.()
    }
    expect(fixture.navigations).toEqual([])
    expect(fixture.getSelect()?.options.some((option) => option.title === "Back to dossier details")).toBe(true)
    back?.onSelect?.()
    expect(fixture.getSelect()?.options.some((option) => option.title === "View generated handoff")).toBe(true)
    expect(fixture.navigations).toEqual([])
  })

  test("keeps a 400-character JSON value visible in width-bounded TUI rows", async () => {
    const source = capsuleFor("wrapped", "wrapped-topic")
    const value = "q".repeat(420)
    source.evidence = [{ ...source.evidence[0], claim: value }]
    const native = {
      id: "part-wrapped", sessionID: "root", messageID: "message-wrapped", type: "tool", tool: "task", callID: "call-wrapped",
      state: { status: "completed", input: { description: "Wrapped", subagent_type: "hermit", prompt: "TASK\nWrapped" }, output: `<task_result>${serializeHandoffCapsule(source)}</task_result>` },
    }
    const fixture = makeTuiApi({ sessionID: "root", messages: [message("wrapped", 1, [native])], children: [] })
    await openDossiers(fixture.api)
    fixture.getSelect()?.options[0].onSelect?.()
    fixture.getSelect()?.options.find((option) => option.title === "View generated handoff")?.onSelect?.()
    const preview = fixture.getSelect()
    const rows = preview?.options.filter((option) => option.title !== "Back to dossier details").map((option) => option.title) ?? []
    expect(rows.every((row) => row.length <= 56)).toBe(true)
    expect(rows.length).toBeGreaterThan(10)
    // Structured per-source-line expectation: the wrapped claim line begins
    // with a bare first row and continues through the contiguous "| "-marked
    // rows until the next line's bare row. That group reconstructs the full
    // 420-character value exactly without pretending arbitrary row arrays
    // have a lossless inverse.
    const claimFirst = rows.findIndex((row) => row.includes('"claim": "'))
    expect(claimFirst).toBeGreaterThanOrEqual(0)
    const group = [rows[claimFirst]]
    for (let index = claimFirst + 1; index < rows.length && rows[index].startsWith("| "); index += 1) group.push(rows[index])
    expect(group[0] + group.slice(1).map((row) => row.slice(2)).join("")).toBe(`      "claim": "${value}",`)
  })

  test("keeps capsule valid with a same-line task_result wrapper and literal closing tags inside", async () => {
    const source = capsuleFor("literal", "literal-topic")
    source.nextAction = "literal ```</task_result> content"
    const output = `<task_result>${serializeHandoffCapsule(source)}</task_result>`
    const native = {
      id: "part-literal", sessionID: "root", messageID: "message-literal", type: "tool", tool: "task", callID: "call-literal",
      state: { status: "completed", input: { description: "Literal", subagent_type: "hermit", prompt: "TASK\nLiteral" }, output },
    }
    const dossier = reconstructTaskDossiers("root", [message("literal", 1, [native])])[0]
    expect(dossier.capsule.status).toBe("valid")
    expect(dossier.result).toBe(output)
    const fixture = makeTuiApi({ sessionID: "root", messages: [message("literal", 1, [native])], children: [] })
    await openDossiers(fixture.api)
    fixture.getSelect()?.options[0].onSelect?.()
    const details = fixture.getSelect()
    const handoff = details?.options.find((option) => option.title === "View generated handoff")
    expect(handoff?.disabled).toBe(false)
    handoff?.onSelect?.()
    expect(fixture.getSelect()?.options.some((option) => option.title === "Back to dossier details")).toBe(true)
  })

  test("keeps neutral dossier preview report-only even for implementation workers", async () => {
    const native = {
      id: "part-neutral",
      sessionID: "root",
      messageID: "message-neutral",
      type: "tool",
      tool: "task",
      callID: "call-neutral",
      state: {
        status: "completed",
        input: { description: "Neutral task", subagent_type: "hermit", prompt: "TASK\nNeutral task" },
        output: `<task_result>${serializeHandoffCapsule(capsuleFor("neutral", "neutral-topic"))}</task_result>`,
      },
    }
    const fixture = makeTuiApi({ sessionID: "root", messages: [message("neutral", 1, [native])], children: [] })
    await openDossiers(fixture.api)
    fixture.getSelect()?.options[0].onSelect?.()
    fixture.getSelect()?.options.find((option) => option.title === "View generated handoff")?.onSelect?.()
    const preview = fixture.getSelect()
    expect(preview?.options.some((option) => option.title === "Operation type: report-only")).toBe(true)
    // The long authorization prose line is wrapped into a bare first row plus
    // "| " continuation rows; each part stays directly reachable per row.
    expect(preview?.options.some((option) => option.title.startsWith("Authorization boundary: No execution"))).toBe(true)
    expect(preview?.options.some((option) => option.title.endsWith("review data only"))).toBe(true)
  })

  test("keeps a stale raw child ID visible without a disabled row the host may omit", async () => {
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
    const child = details?.options.find((option) => option.title === "Open child session (unavailable)")
    expect(child).toBeDefined()
    expect(child?.description).toBe("ses-gone")
    expect(child?.disabled).not.toBe(true)
    child?.onSelect?.()
    expect(fixture.navigations).toEqual([])
  })

  test("renders dossier detail rows as enabled no-op rows the host cannot omit", async () => {
    const native = {
      id: "part-details",
      sessionID: "root",
      messageID: "message-details",
      type: "tool",
      tool: "task",
      callID: "call-details",
      state: {
        status: "completed",
        input: { description: "Details task", subagent_type: "hermit", prompt: "TASK\nDetails task" },
        output: "Worker report",
      },
    }
    const fixture = makeTuiApi({ sessionID: "root", messages: [message("details", 1, [native])], children: [] })
    await openDossiers(fixture.api)
    fixture.getSelect()?.options[0].onSelect?.()
    const details = fixture.getSelect()
    for (const prefix of ["Task:", "Agent:", "Status:", "Root session:", "Safe actions:"]) {
      const row = details?.options.find((option) => option.title.startsWith(prefix))
      expect(row, prefix).toBeDefined()
      expect(row?.disabled, prefix).not.toBe(true)
    }
    const taskRow = details?.options.find((option) => option.title.startsWith("Task:"))
    taskRow?.onSelect?.()
    expect(fixture.navigations).toEqual([])
    expect(fixture.getSelect()?.options.some((option) => option.title.startsWith("Task:"))).toBe(true)
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
