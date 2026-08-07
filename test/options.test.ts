import { describe, expect, test } from "bun:test"
import { DEFAULT_OPTIONS, parseOptions } from "../src/options.ts"

describe("parseOptions", () => {
  test("uses the local v0.2 defaults", () => {
    expect(parseOptions()).toEqual(DEFAULT_OPTIONS)
    expect("wikiPath" in parseOptions()).toBe(false)
  })

  test("accepts a wiki path without requiring model overrides", () => {
    expect(parseOptions({ wikiPath: "/srv/example-vault" })).toEqual({
      models: DEFAULT_OPTIONS.models,
      wikiPath: "/srv/example-vault",
    })
  })

  test("normalizes Windows and POSIX path separators", () => {
    expect(parseOptions({ wikiPath: "C:\\data\\example-vault\\" }).wikiPath).toBe(
      "C:/data/example-vault",
    )
    expect(parseOptions({ wikiPath: "/srv\\example-vault//wiki/" }).wikiPath).toBe(
      "/srv/example-vault/wiki",
    )
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
        "page-of-swords": DEFAULT_OPTIONS.models["page-of-swords"],
        justice: DEFAULT_OPTIONS.models.justice,
      },
    })
  })

  test("overriding Page leaves Knight unchanged", () => {
    expect(
      parseOptions({
        models: {
          "page-of-swords": { model: "example/page-model", variant: "low" },
        },
      }),
    ).toEqual({
      models: {
        magician: DEFAULT_OPTIONS.models.magician,
        "knight-of-swords": DEFAULT_OPTIONS.models["knight-of-swords"],
        hermit: DEFAULT_OPTIONS.models.hermit,
        "page-of-swords": { model: "example/page-model", variant: "low" },
        justice: DEFAULT_OPTIONS.models.justice,
      },
    })
  })

  test("overriding Justice leaves Hermit unchanged", () => {
    expect(
      parseOptions({
        models: {
          justice: { model: "example/justice-model", variant: "high" },
        },
      }),
    ).toEqual({
      models: {
        magician: DEFAULT_OPTIONS.models.magician,
        "knight-of-swords": DEFAULT_OPTIONS.models["knight-of-swords"],
        hermit: DEFAULT_OPTIONS.models.hermit,
        "page-of-swords": DEFAULT_OPTIONS.models["page-of-swords"],
        justice: { model: "example/justice-model", variant: "high" },
      },
    })
  })

  test("fills Page and Justice from their own defaults in a legacy three-role config", () => {
    expect(
      parseOptions({
        models: {
          magician: { model: "example/magician", variant: "high" },
          "knight-of-swords": { model: "example/fast", variant: "low" },
          hermit: { model: "example/deep", variant: "max" },
        },
      }),
    ).toEqual({
      models: {
        magician: { model: "example/magician", variant: "high" },
        "knight-of-swords": { model: "example/fast", variant: "low" },
        hermit: { model: "example/deep", variant: "max" },
        "page-of-swords": DEFAULT_OPTIONS.models["page-of-swords"],
        justice: DEFAULT_OPTIONS.models.justice,
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

  test("rejects invalid or unknown values for the new role keys", () => {
    expect(() => parseOptions({ models: { "page-of-swords": { model: null } } })).toThrow(
      "provider/model format",
    )
    expect(() => parseOptions({ models: { justice: { variant: "" } } })).toThrow("non-empty string")
    expect(() =>
      parseOptions({ models: { "page-of-swords": { model: "example/model", variant: "low", fast: true } } }),
    ).toThrow("unknown option: fast")
  })

  test("rejects invalid wiki paths before any filesystem access", () => {
    const invalidPaths: unknown[] = [
      null,
      "",
      "   ",
      "relative/wiki",
      "C:relative\\wiki",
      "/",
      "C:/",
      "C:\\",
      "\\\\server\\share",
      "C:/wiki/*",
      "C:/wiki/?",
      "C:/wiki/[notes]",
      "C:/wiki/\0notes",
      "C:/wiki/\nnotes",
      "C:/wiki/`notes",
      "C:/wiki/# instructions",
      "C:/wiki/../other",
    ]

    for (const wikiPath of invalidPaths) {
      expect(() => parseOptions({ wikiPath })).toThrow()
    }
  })

  test("rejects unknown top-level options while accepting wikiPath", () => {
    expect(() => parseOptions({ wikiPath: "/tmp/wiki", quick: true })).toThrow("unknown option: quick")
  })
})
