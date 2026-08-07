import type { PluginOptions } from "@opencode-ai/plugin"

export type ModelSelection = {
  model: string
  variant?: string
}

export type ArcanaOptions = {
  models: {
    magician: ModelSelection
    "knight-of-swords": ModelSelection
    hermit: ModelSelection
    "page-of-swords": ModelSelection
    justice: ModelSelection
  }
  wikiPath?: string
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
  if (!isRecord(input)) throw new TypeError("Arcana plugin options must be an object")

  rejectUnknownKeys(input, ["models", "wikiPath"], "Arcana plugin options")

  const models = input.models === undefined ? structuredClone(DEFAULT_OPTIONS.models) : parseModels(input.models)
  const wikiPath = input.wikiPath === undefined ? undefined : parseWikiPath(input.wikiPath)
  return {
    models,
    ...(wikiPath === undefined ? {} : { wikiPath }),
  }
}

function parseModels(input: unknown): ArcanaOptions["models"] {
  if (!isRecord(input)) throw new TypeError("Arcana option models must be an object")

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
  if (!isRecord(input)) throw new TypeError(`Arcana model ${name} must be an object`)

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
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key))
  if (unknown.length) throw new TypeError(`${label} contains unknown option: ${unknown.join(", ")}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}
