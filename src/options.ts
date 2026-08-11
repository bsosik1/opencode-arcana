import type { PluginOptions } from "@opencode-ai/plugin"
import type { ArcanaAgentId } from "./agents.ts"

export type ModelSelection = {
  model: string
  variant?: string
}

export type PermissionAction = "allow" | "ask" | "deny"
export type PermissionPatternMap = Record<string, PermissionAction>
export type PermissionRule = PermissionAction | PermissionPatternMap
export type PermissionKey =
  | "*"
  | "read"
  | "edit"
  | "glob"
  | "grep"
  | "list"
  | "bash"
  | "task"
  | "external_directory"
  | "lsp"
  | "skill"
  | "todowrite"
  | "question"
  | "webfetch"
  | "websearch"
  | "doom_loop"

export type AgentPermissionOverrides = Partial<
  Record<ArcanaAgentId, Partial<Record<PermissionKey, PermissionRule>>>
>

export type ArcanaOptions = {
  models: {
    magician: ModelSelection
    "knight-of-swords": ModelSelection
    hermit: ModelSelection
    "page-of-swords": ModelSelection
    justice: ModelSelection
  }
  wikiPath?: string
  permissions?: AgentPermissionOverrides
}

export const DEFAULT_OPTIONS: ArcanaOptions = {
  models: {
    magician: { model: "openai/gpt-5.6-sol", variant: "xhigh" },
    "knight-of-swords": { model: "opencode-go/deepseek-v4-flash", variant: "max" },
    hermit: { model: "openai/gpt-5.6-luna", variant: "xhigh" },
    "page-of-swords": { model: "opencode-go/deepseek-v4-flash", variant: "max" },
    justice: { model: "openai/gpt-5.6-luna", variant: "xhigh" },
  },
}

export function parseOptions(input?: PluginOptions): ArcanaOptions {
  if (input === undefined) return structuredClone(DEFAULT_OPTIONS)
  assertPlainRecord(input, "Arcana plugin options")

  rejectUnknownKeys(input, ["models", "wikiPath", "permissions"], "Arcana plugin options")

  const models = input.models === undefined ? structuredClone(DEFAULT_OPTIONS.models) : parseModels(input.models)
  const wikiPath = input.wikiPath === undefined ? undefined : parseWikiPath(input.wikiPath)
  const permissions = input.permissions === undefined ? undefined : parsePermissions(input.permissions)
  return {
    models,
    ...(wikiPath === undefined ? {} : { wikiPath }),
    ...(permissions === undefined ? {} : { permissions }),
  }
}

function parseModels(input: unknown): ArcanaOptions["models"] {
  assertPlainRecord(input, "Arcana option models")

  rejectUnknownKeys(
    input,
    ["magician", "knight-of-swords", "hermit", "page-of-swords", "justice"],
    "Arcana option models",
  )
  return {
    magician: parseModel("magician", input.magician, DEFAULT_OPTIONS.models.magician),
    "knight-of-swords": parseModel(
      "knight-of-swords",
      input["knight-of-swords"],
      DEFAULT_OPTIONS.models["knight-of-swords"],
    ),
    hermit: parseModel("hermit", input.hermit, DEFAULT_OPTIONS.models.hermit),
    "page-of-swords": parseModel(
      "page-of-swords",
      input["page-of-swords"],
      DEFAULT_OPTIONS.models["page-of-swords"],
    ),
    justice: parseModel("justice", input.justice, DEFAULT_OPTIONS.models.justice),
  }
}

function parseWikiPath(input: unknown): string {
  if (typeof input !== "string" || !input.trim()) {
    throw new TypeError("Arcana option wikiPath must be a non-empty string")
  }
  if (/[\u0000-\u001f\u007f]/.test(input)) {
    throw new TypeError("Arcana option wikiPath contains control or newline characters")
  }

  const value = input.trim()
  if (/[*?\[\]{}]/.test(value)) {
    throw new TypeError("Arcana option wikiPath must not contain glob metacharacters")
  }
  if (/[`<>\"'#$&|;!]/.test(value)) {
    throw new TypeError("Arcana option wikiPath contains unsupported prompt-injection characters")
  }

  const normalized = normalizePathSeparators(value)
  if (!normalized.startsWith("/") && !/^[A-Za-z]:\//.test(normalized)) {
    throw new TypeError("Arcana option wikiPath must be an absolute Windows or POSIX path")
  }
  if (isFilesystemRoot(normalized)) {
    throw new TypeError("Arcana option wikiPath must not be a filesystem root")
  }
  if (normalized.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new TypeError("Arcana option wikiPath must not contain . or .. path segments")
  }

  return normalized.replace(/\/+$/, "")
}

function normalizePathSeparators(value: string): string {
  const replaced = value.replaceAll("\\", "/")
  if (replaced.startsWith("//") && !replaced.startsWith("///")) {
    return `//${replaced.slice(2).replace(/\/{2,}/g, "/")}`
  }
  return replaced.replace(/\/{2,}/g, "/")
}

function isFilesystemRoot(value: string): boolean {
  return value === "/" || /^\/[\/]?$/.test(value) || /^[A-Za-z]:\/$/.test(value) || /^\/\/[^/]+\/[^/]+\/?$/.test(value)
}

function parseModel(name: string, input: unknown, fallback: ModelSelection): ModelSelection {
  if (input === undefined) return { ...fallback }
  assertPlainRecord(input, `Arcana model ${name}`)

  rejectUnknownKeys(input, ["model", "variant"], `Arcana model ${name}`)
  const model = input.model === undefined ? fallback.model : input.model
  const variant = input.variant === undefined ? fallback.variant : input.variant

  if (typeof model !== "string" || !/^[^/\s]+\/\S+$/.test(model)) {
    throw new TypeError(`Arcana model ${name}.model must use the provider/model format`)
  }
  if (variant !== undefined && (typeof variant !== "string" || !variant.trim())) {
    throw new TypeError(`Arcana model ${name}.variant must be a non-empty string`)
  }

  return { model, ...(variant === undefined ? {} : { variant }) }
}

function rejectUnknownKeys(input: Record<string, unknown>, allowed: string[], label: string) {
  const unknown = Object.getOwnPropertyNames(input).filter((key) => !allowed.includes(key))
  if (unknown.length) throw new TypeError(`${label} contains unknown option: ${unknown.join(", ")}`)
}

const ARCANA_AGENT_IDS = ["magician", "knight-of-swords", "hermit", "page-of-swords", "justice"] as const
const GRANULAR_PERMISSION_KEYS = new Set<PermissionKey>([
  "read",
  "edit",
  "glob",
  "grep",
  "list",
  "bash",
  "task",
  "external_directory",
  "lsp",
  "skill",
])
const SCALAR_PERMISSION_KEYS = new Set<PermissionKey>([
  "todowrite",
  "question",
  "webfetch",
  "websearch",
  "doom_loop",
])
const PERMISSION_KEYS = [
  "*",
  "read",
  "edit",
  "glob",
  "grep",
  "list",
  "bash",
  "task",
  "external_directory",
  "lsp",
  "skill",
  "todowrite",
  "question",
  "webfetch",
  "websearch",
  "doom_loop",
] as const
const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"])

function parsePermissions(input: unknown): AgentPermissionOverrides {
  assertPlainRecord(input, "Arcana option permissions")
  const agentKeys = Object.getOwnPropertyNames(input)
  if (agentKeys.length === 0) throw new TypeError("Arcana option permissions must not be empty")
  rejectUnknownKeys(input, [...ARCANA_AGENT_IDS], "Arcana option permissions")

  const permissions: AgentPermissionOverrides = {}
  for (const agent of agentKeys) {
    const roleInput = input[agent]
    assertPlainRecord(roleInput, `Arcana permissions for ${agent}`)
    const roleKeys = Object.getOwnPropertyNames(roleInput)
    if (roleKeys.length === 0) throw new TypeError(`Arcana permissions for ${agent} must not be empty`)

    const rolePermissions: Partial<Record<PermissionKey, PermissionRule>> = {}
    for (const key of roleKeys) {
      if (!(PERMISSION_KEYS as readonly string[]).includes(key)) {
        throw new TypeError(`Arcana permissions for ${agent} contains unknown permission: ${key}`)
      }
      const rule = parsePermissionRule(key as PermissionKey, roleInput[key], `${agent}.${key}`)
      validateRoleEnvelope(agent as ArcanaAgentId, key as PermissionKey, rule)
      rolePermissions[key as PermissionKey] = rule
    }
    permissions[agent as ArcanaAgentId] = rolePermissions
  }

  return permissions
}

function parsePermissionRule(key: PermissionKey, input: unknown, label: string): PermissionRule {
  if (typeof input === "string") return parsePermissionAction(input, label)
  if (!GRANULAR_PERMISSION_KEYS.has(key)) {
    if (!SCALAR_PERMISSION_KEYS.has(key) && key !== "*") {
      throw new TypeError(`Arcana permission ${label} uses an unsupported permission classification`)
    }
    throw new TypeError(`Arcana permission ${label} must be a scalar action`)
  }

  assertPlainRecord(input, `Arcana permission ${label}`)
  const patterns = Object.getOwnPropertyNames(input)
  if (patterns.length === 0) throw new TypeError(`Arcana permission ${label} map must not be empty`)

  const cloned: PermissionPatternMap = {}
  for (const pattern of patterns) {
    validatePatternKey(pattern, label)
    cloned[pattern] = parsePermissionAction(input[pattern], `${label}.${pattern}`)
  }
  return cloned
}

function parsePermissionAction(input: unknown, label: string): PermissionAction {
  if (input !== "allow" && input !== "ask" && input !== "deny") {
    throw new TypeError(`Arcana permission ${label} must be exactly allow, ask, or deny`)
  }
  return input
}

function validatePatternKey(pattern: string, label: string) {
  if (!pattern || pattern.trim() !== pattern || /[\u0000-\u001f\u007f]/.test(pattern)) {
    throw new TypeError(`Arcana permission ${label} contains an invalid pattern key`)
  }
  if (DANGEROUS_KEYS.has(pattern)) {
    throw new TypeError(`Arcana permission ${label} contains a dangerous pattern key`)
  }
  if (/^(0|[1-9]\d*)$/.test(pattern) && Number(pattern) < 2 ** 32 - 1) {
    throw new TypeError(`Arcana permission ${label} contains a numeric pattern key`)
  }
}

function validateRoleEnvelope(agent: ArcanaAgentId, key: PermissionKey, rule: PermissionRule) {
  if (key === "*" && rule !== "deny") {
    throw new TypeError(`Arcana permissions for ${agent} must keep the outer * permission denied`)
  }

  if (agent === "magician" && key === "task") {
    if (typeof rule === "string") {
      if (rule !== "deny") throw new TypeError("Arcana magician.task may only be deny when scalar")
      return
    }
    for (const target of Object.getOwnPropertyNames(rule)) {
      if (target === "*") {
        if (rule[target] !== "deny") throw new TypeError("Arcana magician.task.* may only be deny")
      } else if (!(ACTIVE_WORKER_IDS as readonly string[]).includes(target)) {
        throw new TypeError(`Arcana magician.task contains an unknown target: ${target}`)
      }
    }
    return
  }

  if ((agent === "knight-of-swords" || agent === "hermit") && key === "task") {
    throw new TypeError(`Arcana ${agent} task permission is immutable`)
  }

  if ((agent === "page-of-swords" || agent === "justice") && AUDITOR_FORBIDDEN_KEYS.has(key)) {
    throw new TypeError(`Arcana ${agent}.${key} permission is immutable`)
  }

  if (
    (agent === "page-of-swords" || agent === "justice") &&
    AUDITOR_DENY_ONLY_KEYS.has(key) &&
    (rule === "allow" || rule === "ask" || (typeof rule !== "string" && Object.values(rule).some((action) => action !== "deny")))
  ) {
    throw new TypeError(`Arcana ${agent}.${key} may only be denied`)
  }
}

const ACTIVE_WORKER_IDS = ["knight-of-swords", "hermit", "page-of-swords", "justice"] as const
const AUDITOR_FORBIDDEN_KEYS = new Set<PermissionKey>([
  "edit",
  "task",
  "todowrite",
  "question",
  "list",
  "lsp",
  "doom_loop",
])
const AUDITOR_DENY_ONLY_KEYS = new Set<PermissionKey>(["read", "bash", "external_directory"])

function assertPlainRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!isPlainRecord(value)) throw new TypeError(`${label} must be a plain object`)

  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") throw new TypeError(`${label} contains an unsupported property`)
    if (DANGEROUS_KEYS.has(key)) throw new TypeError(`${label} contains a dangerous property: ${key}`)
  }
  for (const key in value) {
    if (!Object.hasOwn(value, key)) throw new TypeError(`${label} contains an inherited property: ${key}`)
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
