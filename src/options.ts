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

export type PermissionOverrides = Partial<Record<PermissionKey, PermissionRule>>

export type AgentOptions = ModelSelection & {
  permission?: PermissionOverrides
}

export type ArcanaOptions = {
  agents: Record<ArcanaAgentId, AgentOptions>
  wikiPath?: string
}

export const DEFAULT_OPTIONS: ArcanaOptions = {
  agents: {
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

  rejectUnknownKeys(input, ["agents", "wikiPath"], "Arcana plugin options")

  const agents = input.agents === undefined ? structuredClone(DEFAULT_OPTIONS.agents) : parseAgents(input.agents)
  const wikiPath = input.wikiPath === undefined ? undefined : parseWikiPath(input.wikiPath)
  return {
    agents,
    ...(wikiPath === undefined ? {} : { wikiPath }),
  }
}

function parseAgents(input: unknown): ArcanaOptions["agents"] {
  assertPlainRecord(input, "Arcana option agents")

  rejectUnknownKeys(input, [...ARCANA_AGENT_IDS], "Arcana option agents")
  return {
    magician: parseAgent("magician", input.magician, DEFAULT_OPTIONS.agents.magician),
    "knight-of-swords": parseAgent(
      "knight-of-swords",
      input["knight-of-swords"],
      DEFAULT_OPTIONS.agents["knight-of-swords"],
    ),
    hermit: parseAgent("hermit", input.hermit, DEFAULT_OPTIONS.agents.hermit),
    "page-of-swords": parseAgent(
      "page-of-swords",
      input["page-of-swords"],
      DEFAULT_OPTIONS.agents["page-of-swords"],
    ),
    justice: parseAgent("justice", input.justice, DEFAULT_OPTIONS.agents.justice),
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

function parseAgent(name: ArcanaAgentId, input: unknown, fallback: AgentOptions): AgentOptions {
  if (input === undefined) return cloneAgentOptions(fallback)
  assertPlainRecord(input, `Arcana agent ${name}`)

  rejectUnknownKeys(input, ["model", "variant", "permission"], `Arcana agent ${name}`)
  const model = input.model === undefined ? fallback.model : input.model
  const variant = input.variant === undefined ? fallback.variant : input.variant

  if (typeof model !== "string" || !/^[^/\s]+\/\S+$/.test(model)) {
    throw new TypeError(`Arcana agent ${name}.model must use the provider/model format`)
  }
  if (variant !== undefined && (typeof variant !== "string" || !variant.trim())) {
    throw new TypeError(`Arcana agent ${name}.variant must be a non-empty string`)
  }

  const permission =
    input.permission === undefined ? undefined : parsePermissionOverrides(input.permission, `${name}.permission`)
  return {
    model,
    ...(variant === undefined ? {} : { variant }),
    ...(permission === undefined ? {} : { permission }),
  }
}

function cloneAgentOptions(agent: AgentOptions): AgentOptions {
  return {
    model: agent.model,
    ...(agent.variant === undefined ? {} : { variant: agent.variant }),
    ...(agent.permission === undefined ? {} : { permission: clonePermissionOverrides(agent.permission) }),
  }
}

function rejectUnknownKeys(input: Record<string, unknown>, allowed: string[], label: string) {
  const unknown = Object.getOwnPropertyNames(input).filter((key) => !allowed.includes(key))
  if (unknown.length) throw new TypeError(`${label} contains unknown option: ${unknown.join(", ")}`)
}

const ARCANA_AGENT_IDS = ["magician", "knight-of-swords", "hermit", "page-of-swords", "justice"] as const satisfies readonly ArcanaAgentId[]
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

function parsePermissionOverrides(input: unknown, label: string): PermissionOverrides {
  assertPlainRecord(input, `Arcana permission ${label}`)
  const permissionKeys = Object.getOwnPropertyNames(input)
  const permissions: PermissionOverrides = {}
  for (const key of permissionKeys) {
    if (!(PERMISSION_KEYS as readonly string[]).includes(key)) {
      throw new TypeError(`Arcana permission ${label} contains unknown permission: ${key}`)
    }
    permissions[key as PermissionKey] = parsePermissionRule(key as PermissionKey, input[key], `${label}.${key}`)
  }

  return permissions
}

function clonePermissionOverrides(input: PermissionOverrides): PermissionOverrides {
  const clone: PermissionOverrides = {}
  for (const key of Object.keys(input) as PermissionKey[]) {
    const rule = input[key]
    if (rule === undefined) continue
    clone[key] = typeof rule === "string" ? rule : { ...rule }
  }
  return clone
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
