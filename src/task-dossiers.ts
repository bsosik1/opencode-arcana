import { getAgentIdentity, type ArcanaAgentId } from "./agents.ts"
import {
  getAssistantIdFromTaskPart,
  getTaskPartStatus,
  getToolPartIdentity,
  type MessageRecord,
  type ToolPartLike,
} from "./magician-assistants-state.ts"

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

function childIDFor(part: ToolPartLike): string | undefined {
  const input = taskInput(part)
  const metadata = taskMetadata(part)
  return nestedString(metadata, ["sessionID", "sessionId", "childSessionID", "child_session_id"])
    ?? nestedString(input, ["task_id", "taskID", "session_id", "sessionID", "child_session_id", "childSessionID"])
}

function resultFor(part: ToolPartLike): string | undefined {
  const state = taskState(part)
  const metadata = taskMetadata(part)
  const output = nestedString(state, ["output"])
  if (output) {
    // A task_result wrapper owns the result channel: an empty wrapper means
    // no result (unavailable), never a fallback to the raw XML output.
    const taskResult = /<task_result\b[^>]*>([\s\S]*?)<\/task_result>/i.exec(output)
    if (taskResult) return taskResult[1].trim() || undefined
    return output
  }
  return nestedString(state, ["result", "report", "error"])
    ?? nestedString(metadata, ["result", "report", "output", "lastReport"])
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
}): DossierStatus {
  const native = statusValue(input.nativeStatus)
  const child = statusValue(input.childStatus)
  if (["error", "failed", "failure", "cancelled", "canceled", "dead"].includes(native ?? "")
    || ["error", "failed", "failure", "cancelled", "canceled", "dead"].includes(child ?? "")
    || isFailureResult(input.result)) return "Blocked/Failed"
  if (native === "pending" || native === "running" || child === "busy" || child === "retry") return "Active"
  if (native === "completed" || native === "success" || child === "idle" || child === "completed") {
    // An audit report is never evidence that an implementation was approved.
    if (input.isAudit || !input.parentVerificationEvidence) return "Needs verification"
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
      }),
      isAudit: audit,
      createdAt: partTime(invocation.message),
      parentVerificationEvidence,
    }
  }).toSorted((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0) || left.id.localeCompare(right.id))
}

export function formatDossierSummary(dossier: TaskDossier): string {
  const agent = DOSSIER_AGENT_NAMES[dossier.agentID] ?? dossier.agent
  return `${DOSSIER_STATUS_ICONS[dossier.status]} ${agent} - ${compactText(dossier.description, 72)}`
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
    "",
    "Safe actions:",
    "Open child session or root session. No task is resumed.",
  ]
  return lines
}
