import { getAgentIdentity, type ArcanaAgentId } from "./agents.ts"
import {
  getAssistantIdFromTaskPart,
  getTaskPartStatus,
  getToolPartIdentity,
  type MessageRecord,
  type ToolPartLike,
} from "./magician-assistants-state.ts"
import {
  extractHandoffCapsule,
  generateRelevantHandoff,
  type CapsuleDiagnostic,
  type CapsuleEvidenceFreshness,
  type HandoffCapsule,
} from "./handoff-capsules.ts"

export type DossierStatus = "Active" | "Blocked/Failed" | "Needs verification" | "Completed"

const DOSSIER_STATUS_ICONS: Record<DossierStatus, string> = {
  Active: "●",
  "Needs verification": "○",
  Completed: "✓",
  "Blocked/Failed": "■",
}

const DOSSIER_AGENT_NAMES: Partial<Record<ArcanaAgentId, string>> = {
  "knight-of-swords": "Knight",
  "page-of-swords": "Page",
}

export type DossierContract = {
  task?: string
  expectedOutcome?: string
  scope?: string
  context?: string
  authorization?: string
  activeConstraints?: string
  sourceData?: string
  mustDo?: string
  mustNotDo?: string
  verification?: string
  finalResponse?: string
}

export type DossierCapsuleStatus = "valid" | "invalid" | "missing"

export type DossierCapsuleHealth = {
  status: DossierCapsuleStatus
  capsule?: HandoffCapsule
  diagnostics: CapsuleDiagnostic[]
  evidenceCount: number
  unresolvedCount: number
  freshness: Record<CapsuleEvidenceFreshness, number>
  capsuleId?: string
  topicIds: string[]
}

export type DossierChildSession = {
  id: string
  agent?: unknown
  title?: unknown
  status?: unknown
}

export type TaskDossier = {
  id: string
  rootSessionID: string
  childSessionID?: string
  /** True only when the child is a current direct child session. */
  childAvailable: boolean
  agent: string
  agentID: ArcanaAgentId
  description: string
  title: string
  prompt?: string
  nativeStatus: string
  childStatus?: string
  result?: string
  lastReport?: string
  contract: DossierContract
  status: DossierStatus
  isAudit: boolean
  createdAt?: number
  parentVerificationEvidence: boolean
  capsuleVerificationEvidence: boolean
  capsule: DossierCapsuleHealth
}

type RecordLike = Record<string, unknown>

function isRecord(value: unknown): value is RecordLike {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function statusValue(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim().toLowerCase() || undefined
  return isRecord(value) && typeof value.type === "string" ? statusValue(value.type) : undefined
}

function nestedString(record: RecordLike | undefined, keys: readonly string[]): string | undefined {
  if (!record) return undefined
  for (const key of keys) {
    const value = stringValue(record[key])
    if (value) return value
  }
  return undefined
}

function taskInput(part: ToolPartLike): RecordLike | undefined {
  const state = isRecord(part.state) ? part.state : undefined
  return state && isRecord(state.input) ? state.input : undefined
}

function taskState(part: ToolPartLike): RecordLike | undefined {
  return isRecord(part.state) ? part.state : undefined
}

function taskMetadata(part: ToolPartLike): RecordLike | undefined {
  const state = taskState(part)
  return state && isRecord(state.metadata) ? state.metadata : undefined
}

const RESULT_WRAPPER_KEYS = ["output", "result", "report", "error", "lastReport"] as const

function resultStrings(value: unknown, depth = 0): string[] {
  if (typeof value === "string") return [value]
  if (depth >= 4 || !isRecord(value)) return []
  const result: string[] = []
  for (const key of RESULT_WRAPPER_KEYS) {
    if (Object.prototype.hasOwnProperty.call(value, key)) result.push(...resultStrings(value[key], depth + 1))
  }
  return result
}

function childIDFor(part: ToolPartLike): string | undefined {
  const input = taskInput(part)
  const metadata = taskMetadata(part)
  return nestedString(metadata, ["sessionID", "sessionId", "childSessionID", "child_session_id"])
    ?? nestedString(input, ["task_id", "taskID", "session_id", "sessionID", "child_session_id", "childSessionID"])
}

function resultFor(part: ToolPartLike): string | undefined {
  const state = taskState(part)
  const metadata = taskMetadata(part)
  // Mirrored transport copies (identical state and metadata snapshots) can
  // duplicate one byte-identical capsule string. Deduplicate exact strings at
  // collection time, keeping first-seen order, so a mirror yields exactly one
  // frame. Different candidates are never merged: malformed or multi-frame
  // input still fails closed in capsuleHealthFor.
  const seen = new Set<string>()
  const candidates = [...resultStrings(state), ...resultStrings(metadata)].filter((candidate) => {
    if (candidate.trim().length === 0 || seen.has(candidate)) return false
    seen.add(candidate)
    return true
  })
  const capsuleCandidates = candidates
    .filter((candidate) => extractHandoffCapsule(candidate).blocksFound > 0)
  if (capsuleCandidates.length > 0) return capsuleCandidates.join("\n")
  const output = candidates.find((candidate) => candidate.trim().length > 0)
  if (output) {
    // Capsule-bearing output is preserved verbatim: the capsule scanner's
    // standalone-line grammar, never XML parsing, decides where the framed
    // block starts and ends, so a literal task_result tag inside capsule
    // JSON (including a same-line <task_result> wrapper prefix) cannot
    // truncate the result. capsuleHealth scans the full output.
    if (extractHandoffCapsule(output).blocksFound > 0) return output
    // Legacy task_result wrapper without a capsule owns the result channel:
    // an empty wrapper means no result (unavailable), never a fallback to
    // the raw XML output.
    const wrapperStart = output.search(/<task_result\b[^>]*>/i)
    if (wrapperStart >= 0) {
      const contentStart = output.indexOf(">", wrapperStart) + 1
      const closeIndex = output.indexOf("</task_result>", contentStart)
      if (closeIndex >= 0) {
        const content = output.slice(contentStart, closeIndex).trim()
        return content || undefined
      }
    }
    return output
  }
  return output
}

function capsuleHealthFor(result: string | undefined): DossierCapsuleHealth {
  if (!result) return { status: "missing", diagnostics: [], evidenceCount: 0, unresolvedCount: 0, freshness: { reusable: 0, verify: 0, stale: 0, conflict: 0 }, topicIds: [] }
  const parsed = extractHandoffCapsule(result)
  if (parsed.blocksFound === 0) return { status: "missing", diagnostics: parsed.diagnostics, evidenceCount: 0, unresolvedCount: 0, freshness: { reusable: 0, verify: 0, stale: 0, conflict: 0 }, topicIds: [] }
  if (!parsed.valid || !parsed.capsule) return { status: "invalid", diagnostics: parsed.diagnostics, evidenceCount: 0, unresolvedCount: 0, freshness: { reusable: 0, verify: 0, stale: 0, conflict: 0 }, topicIds: [] }
  const freshness = { reusable: 0, verify: 0, stale: 0, conflict: 0 }
  for (const item of parsed.capsule.evidence) freshness[item.freshness] += 1
  return {
    status: "valid",
    capsule: parsed.capsule,
    diagnostics: [],
    evidenceCount: parsed.capsule.evidence.length,
    unresolvedCount: parsed.capsule.unresolvedQuestions.length,
    freshness,
    capsuleId: parsed.capsule.capsuleId,
    topicIds: parsed.capsule.ownership.map((item) => item.topicId),
  }
}

const CAPSULE_POSITIVE_RESULT = /\b(?:pass(?:ed|es)?|successful(?:ly)?|verified|clean)\b/i
const CAPSULE_NEGATED_RESULT = /\b(?:not|never|no|failed|failing|failure|without|cannot|can't|won't|zero|incomplete|inconclusive|pending|unverified|denied)\b/i

/**
 * A valid worker capsule can carry structured verification evidence even when
 * the parent only summarizes the result in prose.  Promotion requires a
 * completed state with at least one recorded check as corroboration plus a
 * reusable command/test evidence item carrying an explicit positive claim.
 * A conflicted evidence item, negative command/test language, or checks-only
 * self-assertion never promotes a dossier.
 */
function hasCapsuleVerificationEvidence(capsule: DossierCapsuleHealth): boolean {
  if (capsule.status !== "valid" || !capsule.capsule) return false
  const state = capsule.capsule.currentState
  if (state.status !== "completed" || state.checks.length === 0) return false
  const evidence = capsule.capsule.evidence
  // Any conflicted evidence item makes the verification claim untrustworthy.
  if (evidence.some((item) => item.freshness === "conflict")) return false
  const hasPositiveResult = (text: string) => CAPSULE_POSITIVE_RESULT.test(text) && !CAPSULE_NEGATED_RESULT.test(text)
  // Explicit negative or negated command/test language blocks promotion.
  if (evidence.some((item) =>
    (item.sourceKind === "command" || item.sourceKind === "test")
      && CAPSULE_NEGATED_RESULT.test(item.claim),
  )) return false
  // Recorded checks corroborate but never substitute for reusable evidence.
  return evidence.some((item) =>
    (item.sourceKind === "command" || item.sourceKind === "test")
      && item.freshness === "reusable"
      && hasPositiveResult(item.claim),
  )
}

function descriptionFor(part: ToolPartLike, contract: DossierContract): string {
  const input = taskInput(part)
  return nestedString(input, ["description", "title"])
    ?? contract.task?.split("\n")[0]?.trim()
    ?? "Untitled Arcana task"
}

function normalizeSectionName(name: string): keyof DossierContract | undefined {
  const normalized = name.trim().toUpperCase().replace(/[ -]+/g, "_")
  const names: Record<string, keyof DossierContract> = {
    TASK: "task",
    EXPECTED_OUTCOME: "expectedOutcome",
    SCOPE: "scope",
    CONTEXT: "context",
    AUTHORIZATION: "authorization",
    ACTIVE_CONSTRAINTS: "activeConstraints",
    SOURCE_DATA: "sourceData",
    MUST_DO: "mustDo",
    MUST_NOT_DO: "mustNotDo",
    VERIFICATION: "verification",
    FINAL_RESPONSE: "finalResponse",
  }
  return names[normalized]
}

/** Parse only the fixed Arcana contract headings; arbitrary prompt text is left untouched. */
export function extractDossierContract(prompt: unknown): DossierContract {
  if (typeof prompt !== "string" || !prompt.trim()) return {}
  const sections: DossierContract = {}
  let active: keyof DossierContract | undefined
  const lines = prompt.replace(/\r\n?/g, "\n").split("\n")
  for (const line of lines) {
    const heading = /^\s*([A-Z][A-Z _-]+)\s*:?\s*$/.exec(line)
    const next = heading ? normalizeSectionName(heading[1]) : undefined
    if (next) {
      active = next
      sections[active] = ""
      continue
    }
    // Unknown all-caps lines are not section boundaries: keep them as content
    // of the current known section instead of clearing it.
    if (active) sections[active] = `${sections[active] ?? ""}${sections[active] ? "\n" : ""}${line}`
  }
  for (const key of Object.keys(sections) as Array<keyof DossierContract>) {
    const value = sections[key]?.trim()
    if (value) sections[key] = value
    else delete sections[key]
  }
  return sections
}

function partTime(message: MessageRecord): number | undefined {
  const value = message.info?.time?.created
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function textParts(message: MessageRecord): string[] {
  return (message.parts ?? []).flatMap((part) => {
    if (!isRecord(part) || part.type !== "text") return []
    const text = stringValue(part.text)
    return text ? [text] : []
  })
}

const VERIFICATION_NEGATION = /\b(?:not|never|no|failed|failing|failure|without|incomplete|inconclusive|pending|unverified|denied)\b/i

/**
 * Accept only explicit positive verification statements. A marker such as
 * "VERIFICATION" must be followed by a positive word within a bounded window,
 * and the region between the marker and that word must not contain a negation.
 * Explicit phrases such as "successfully verified" are also accepted unless a
 * negation appears nearby. Bare "verified" is never positive, so statements
 * like "NOT VERIFIED" or "never verified" produce no evidence.
 */
function hasPositiveVerificationStatement(text: string): boolean {
  const marker = /\bverification\b[\s\S]{0,240}?\b(?:passed|successful|succeeded|complete|completed|confirmed|approved|positive)\b/gi
  let match = marker.exec(text)
  while (match !== null) {
    // A "no verification" phrasing can negate before the marker itself.
    const context = text.slice(Math.max(0, match.index - 40), match.index + 12)
    if (/\b(?:not|never|no)\s+verification\b/i.test(context)) {
      match = marker.exec(text)
      continue
    }
    if (!VERIFICATION_NEGATION.test(match[0].slice("verification".length))) return true
    match = marker.exec(text)
  }
  const phrase = /\b(?:verified\s+completion|completion\s+verified|successfully\s+verified|verified\s+successfully|passed\s+(?:the\s+)?verification)\b/i.exec(text)
  if (!phrase) return false
  return !VERIFICATION_NEGATION.test(text.slice(Math.max(0, phrase.index - 60), phrase.index))
}

function hasVerificationEvidence(
  messages: readonly MessageRecord[],
  invocation: MessageRecord,
  correlationTokens: readonly string[],
): boolean {
  if (correlationTokens.length === 0) return false
  const invocationTime = partTime(invocation)
  return messages.some((message) => {
    if (message === invocation) return false
    const role = message.info?.role
    if (role !== "assistant") return false
    const time = partTime(message)
    if (invocationTime !== undefined && (time === undefined || time <= invocationTime)) return false
    return textParts(message).some((text) => {
      if (!hasPositiveVerificationStatement(text)) return false
      const haystack = text.toLocaleLowerCase()
      return correlationTokens.some((token) => haystack.includes(token.toLocaleLowerCase()))
    })
  })
}

function compactText(value: string | undefined, maxLength = 180): string {
  const normalized = value?.replace(/\s+/g, " ").trim()
  if (!normalized) return "unavailable"
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, Math.max(1, maxLength - 3)).trimEnd()}...`
}

function isFailureResult(result: string | undefined): boolean {
  if (!result) return false
  return /^\s*(?:BLOCKED|FAILED|ERROR|CANCELLED)\b/im.test(result)
}

export function classifyDossierStatus(input: {
  nativeStatus?: unknown
  childStatus?: unknown
  result?: string
  isAudit?: boolean
  parentVerificationEvidence?: boolean
  capsuleVerificationEvidence?: boolean
}): DossierStatus {
  const native = statusValue(input.nativeStatus)
  const child = statusValue(input.childStatus)
  if (["error", "failed", "failure", "cancelled", "canceled", "dead"].includes(native ?? "")
    || ["error", "failed", "failure", "cancelled", "canceled", "dead"].includes(child ?? "")
    || isFailureResult(input.result)) return "Blocked/Failed"
  if (native === "pending" || native === "running" || child === "busy" || child === "retry") return "Active"
  if (native === "completed" || native === "success" || child === "idle" || child === "completed") {
    // An audit report is never evidence that an implementation was approved.
    if (input.isAudit || (!input.parentVerificationEvidence && !input.capsuleVerificationEvidence)) return "Needs verification"
    return "Completed"
  }
  return "Needs verification"
}

function compareMessages(left: MessageRecord, right: MessageRecord): number {
  const leftTime = partTime(left) ?? Number.POSITIVE_INFINITY
  const rightTime = partTime(right) ?? Number.POSITIVE_INFINITY
  return leftTime - rightTime || (stringValue(left.info?.id) ?? "").localeCompare(stringValue(right.info?.id) ?? "")
}

function childByID(children: readonly DossierChildSession[]): Map<string, DossierChildSession> {
  return new Map(children.filter((child) => typeof child.id === "string" && child.id.length > 0).map((child) => [child.id, child]))
}

/** Reconstruct stable dossier cards from complete root history and current direct-child status. */
export function reconstructTaskDossiers(
  rootSessionID: string,
  messages: Iterable<MessageRecord>,
  children: Iterable<DossierChildSession> = [],
): TaskDossier[] {
  const ordered = [...messages].toSorted(compareMessages)
  const childMap = childByID([...children])
  const invocations = new Map<string, { part: ToolPartLike; message: MessageRecord }>()

  for (const message of ordered) {
    for (const [partIndex, candidate] of (message.parts ?? []).entries()) {
      const part = candidate as ToolPartLike
      if (!getAssistantIdFromTaskPart(part)) continue
      invocations.set(getToolPartIdentity(part, stringValue(message.info?.id), partIndex), { part, message })
    }
  }

  const invocationDescriptions = [...invocations.values()].map((invocation) => {
    const input = taskInput(invocation.part)
    const prompt = nestedString(input, ["prompt", "task", "contract"])
    return descriptionFor(invocation.part, extractDossierContract(prompt))
  })

  return [...invocations.entries()].map(([identity, invocation]) => {
    const agentID = getAssistantIdFromTaskPart(invocation.part)!
    const input = taskInput(invocation.part)
    const prompt = nestedString(input, ["prompt", "task", "contract"])
    const contract = extractDossierContract(prompt)
    const description = descriptionFor(invocation.part, contract)
    const childSessionID = childIDFor(invocation.part)
    const child = childSessionID ? childMap.get(childSessionID) : undefined
    const nativeStatus = getTaskPartStatus(invocation.part) ?? "unknown"
    const childStatus = statusValue(child?.status)
    const result = resultFor(invocation.part)
    const capsule = capsuleHealthFor(result)
    const capsuleVerificationEvidence = hasCapsuleVerificationEvidence(capsule)
    const audit = agentID === "page-of-swords" || agentID === "justice"
    const distinctDescription = invocationDescriptions.filter((candidate) => candidate === description).length === 1
    const correlationTokens = [childSessionID, distinctDescription ? description : undefined]
      .filter((token): token is string => !!token && token.length >= 4)
    const parentVerificationEvidence = !audit && hasVerificationEvidence(ordered, invocation.message, correlationTokens)
    const identitySuffix = identity.replace(/^[^:]+:/, "") || identity
    const title = `${getAgentIdentity(agentID).displayName} - ${description}`
    return {
      id: `dossier:${rootSessionID}:${identitySuffix}`,
      rootSessionID,
      childSessionID: child?.id ?? childSessionID,
      childAvailable: child !== undefined,
      agent: getAgentIdentity(agentID).displayName,
      agentID,
      description,
      title,
      prompt,
      nativeStatus,
      childStatus,
      result,
      lastReport: result,
      contract,
      status: classifyDossierStatus({
        nativeStatus,
        childStatus,
        result,
        isAudit: audit,
        parentVerificationEvidence,
        capsuleVerificationEvidence,
      }),
      isAudit: audit,
      createdAt: partTime(invocation.message),
      parentVerificationEvidence,
      capsuleVerificationEvidence,
      capsule,
    }
  }).toSorted((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0) || left.id.localeCompare(right.id))
}

export function formatDossierSummary(dossier: TaskDossier): string {
  const agent = DOSSIER_AGENT_NAMES[dossier.agentID] ?? dossier.agent
  const capsule = dossier.capsule.status === "valid" ? ` C${dossier.capsule.evidenceCount}/${dossier.capsule.unresolvedCount}` : ""
  return `${DOSSIER_STATUS_ICONS[dossier.status]} ${agent} - ${compactText(dossier.description, 72)}${capsule}`
}

export function formatCapsuleHealth(capsule: DossierCapsuleHealth): string {
  if (capsule.status === "missing") return "Capsule: missing (legacy result)"
  if (capsule.status === "invalid") return `Capsule: invalid (${capsule.diagnostics.length} diagnostic${capsule.diagnostics.length === 1 ? "" : "s"})`
  const freshness = Object.entries(capsule.freshness).filter(([, count]) => count > 0).map(([name, count]) => `${name}=${count}`).join(", ") || "none"
  return `Capsule: valid | evidence=${capsule.evidenceCount} | unresolved=${capsule.unresolvedCount} | freshness=${freshness}`
}

/**
 * Re-render the validated capsule payload as indented JSON for review.  The
 * compact wire form stays single-line; only the review view expands it.  The
 * payload is already strictly validated by generateRelevantHandoff, so parsing
 * cannot fail for a generated handoff; on any unexpected shape the original
 * lines are kept verbatim so no content is ever dropped.
 */
function prettyHandoffPayload(serialized: string): string[] {
  const lines = serialized.split("\n")
  const open = lines.indexOf("```json")
  const close = open >= 0 ? lines.findIndex((line, index) => index > open && line === "```") : -1
  if (open < 0 || close < 0) return lines
  const raw = lines.slice(open + 1, close).join("\n")
  try {
    const parsed: unknown = JSON.parse(raw)
    return [...lines.slice(0, open + 1), ...JSON.stringify(parsed, null, 2).split("\n"), ...lines.slice(close)]
  } catch {
    return lines
  }
}

export const HANDOFF_DISPLAY_WIDTH = 56

/**
 * Split long display lines into width-bounded rows. Capsule payloads and the
 * surrounding preview prose are strict ASCII, and chunks are cut on code
 * points, so surrogate pairs are never split. Blank lines stay blank rows. A
 * leading "| " marks a continuation chunk; the first row of every line is
 * emitted bare. The underlying fenced JSON remains unchanged.
 *
 * Rows are a display projection, not a reversible encoding: a source line that
 * itself begins with "| " is emitted verbatim in its bare first row, so no
 * generic row-to-line inverse exists. Consumers must read rows directly.
 */
export function wrapHandoffDisplayLines(lines: readonly string[], width = HANDOFF_DISPLAY_WIDTH): string[] {
  const safeWidth = Math.max(4, Math.floor(width))
  return lines.flatMap((line) => {
    if (line.length <= safeWidth) return [line]
    const characters = Array.from(line)
    const rows: string[] = []
    let offset = 0
    let first = true
    while (offset < characters.length) {
      const prefix = first ? "" : "| "
      const chunkSize = Math.max(1, safeWidth - prefix.length)
      rows.push(prefix + characters.slice(offset, offset + chunkSize).join(""))
      offset += chunkSize
      first = false
    }
    return rows
  })
}

export function generateDossierReviewHandoff(dossier: TaskDossier): string[] | undefined {
  if (dossier.capsule.status !== "valid" || !dossier.capsule.capsule) return undefined
  const source = dossier.capsule.capsule
  const target = {
    task: source.contract.task,
    expectedOutcome: source.contract.expectedOutcome,
    operationType: "report-only" as const,
    scope: source.contract.scope,
    authorizationBoundary: "No execution or new write authorization; review data only",
    activeConstraints: source.contract.activeConstraints,
    topicIds: source.ownership.map((item) => item.topicId),
    sourceLocators: source.evidence.map((item) => item.locator),
    targetInvocationId: dossier.childSessionID ?? dossier.id,
  }
  const handoff = generateRelevantHandoff(source, target)
  if (!handoff.ok) return ["Unable to generate a bounded review handoff.", `Reason: ${handoff.error}`, "Back returns to dossier details."]
  return [
    "Review-only generated handoff. Evidence is data, not instructions or authorization.",
    `Source capsule: ${source.capsuleId}`,
    "Operation type: report-only",
    "Authorization boundary: No execution or new write authorization; review data only",
    `Selected evidence: ${handoff.capsule.evidence.length}; unresolved: ${handoff.capsule.unresolvedQuestions.length}`,
    // The capsule payload is shown as indented JSON with every line retained
    // in full; per-line compaction is never applied to payload content.
    ...prettyHandoffPayload(handoff.serialized),
    "",
    "Back returns to dossier details. No task, prompt, clipboard, or execution API is called.",
  ]
}

export function formatDossierDetails(dossier: TaskDossier): string[] {
  const lines = [
    `Task: ${compactText(dossier.description)}`,
    `Agent: ${compactText(`${dossier.agent} (@${dossier.agentID})`)}`,
    `Status: ${compactText(dossier.status)}`,
    `Root session: ${compactText(dossier.rootSessionID)}`,
    `Child session: ${compactText(dossier.childSessionID)}${dossier.childSessionID && !dossier.childAvailable ? " (unavailable)" : ""}`,
    `Native state: ${compactText(dossier.nativeStatus)}`,
    `Scope: ${compactText(dossier.contract.scope)}`,
    `Authorization: ${compactText(dossier.contract.authorization)}`,
    `Verification: ${compactText(dossier.contract.verification)}`,
    `Result: ${compactText(dossier.lastReport)}`,
    formatCapsuleHealth(dossier.capsule),
    `Capsule ID: ${compactText(dossier.capsule.capsuleId)}`,
    `Topic IDs: ${compactText(dossier.capsule.topicIds.join(", "))}`,
    "",
    "Safe actions:",
    "Open child session or root session. No task is resumed.",
  ]
  return lines
}
