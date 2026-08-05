import { describe, expect, test } from "bun:test"
import { DEFAULT_OPTIONS, parseOptions } from "../src/options.ts"

describe("parseOptions", () => {
  test("uses the local v0.2 defaults", () => {
    expect(parseOptions()).toEqual(DEFAULT_OPTIONS)
  })

  test("overrides one role while preserving the other defaults", () => {
    expect(
      parseOptions({
        models: {
          "knight-of-swords": { model: "example/fast-model", variant: "high" },
        },
      }),
    ).toEqual({
      models: {
        magician: DEFAULT_OPTIONS.models.magician,
        "knight-of-swords": { model: "example/fast-model", variant: "high" },
        hermit: DEFAULT_OPTIONS.models.hermit,
      },
    })
  })

  test("rejects a model without a provider prefix", () => {
    expect(() => parseOptions({ models: { "knight-of-swords": { model: "deepseek-v4-flash" } } })).toThrow(
      "provider/model format",
    )
  })

  test("accepts provider model IDs containing nested path segments", () => {
    expect(
      parseOptions({ models: { "knight-of-swords": { model: "openrouter/openai/gpt-4o" } } }).models[
        "knight-of-swords"
      ].model,
    ).toBe(
      "openrouter/openai/gpt-4o",
    )
  })

  test("rejects explicit null instead of silently selecting a default", () => {
    expect(() => parseOptions({ models: { "knight-of-swords": { model: null } } })).toThrow("provider/model format")
    expect(() => parseOptions({ models: { "knight-of-swords": { variant: null } } })).toThrow("non-empty string")
  })

  test("rejects unknown options to expose configuration typos", () => {
    expect(() => parseOptions({ fallback: true })).toThrow("unknown option: fallback")
    expect(() => parseOptions({ models: { quick: { model: "example/model" } } })).toThrow(
      "unknown option: quick",
    )
  })
})
