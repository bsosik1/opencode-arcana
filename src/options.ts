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
  }
}

export const DEFAULT_OPTIONS: ArcanaOptions = {
  models: {
    magician: { model: "openai/gpt-5.6-sol", variant: "xhigh" },
    "knight-of-swords": { model: "opencode-go/deepseek-v4-flash", variant: "max" },
    hermit: { model: "openai/gpt-5.6-luna", variant: "xhigh" },
  },
}

export function parseOptions(input?: PluginOptions): ArcanaOptions {
  if (input === undefined) return structuredClone(DEFAULT_OPTIONS)
  if (!isRecord(input)) throw new TypeError("Arcana plugin options must be an object")

  rejectUnknownKeys(input, ["models"], "Arcana plugin options")
  if (input.models === undefined) return structuredClone(DEFAULT_OPTIONS)
  if (!isRecord(input.models)) throw new TypeError("Arcana option models must be an object")

  rejectUnknownKeys(input.models, ["magician", "knight-of-swords", "hermit"], "Arcana option models")
  return {
    models: {
      magician: parseModel("magician", input.models.magician, DEFAULT_OPTIONS.models.magician),
      "knight-of-swords": parseModel(
        "knight-of-swords",
        input.models["knight-of-swords"],
        DEFAULT_OPTIONS.models["knight-of-swords"],
      ),
      hermit: parseModel("hermit", input.models.hermit, DEFAULT_OPTIONS.models.hermit),
    },
  }
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
