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

  test("preserves the exact defaults when permissions are omitted", () => {
    const parsed = parseOptions()
    expect(parsed).toEqual(DEFAULT_OPTIONS)
    expect(parsed).not.toBe(DEFAULT_OPTIONS)
    expect(parsed.permissions).toBeUndefined()

    parsed.models.magician.model = "example/changed"
    expect(DEFAULT_OPTIONS.models.magician.model).toBe("openai/gpt-5.6-sol")
  })

  test("accepts partial synthetic permission overrides for every role", () => {
    expect(
      parseOptions({
        permissions: {
          magician: { bash: { "*": "ask", "git status*": "allow" }, task: { hermit: "ask" } },
          "knight-of-swords": { bash: { "npm test*": "allow" } },
          hermit: { read: "allow" },
          "page-of-swords": { read: { "docs/**": "deny" }, glob: "ask" },
          justice: { bash: "deny" },
        },
      }),
    ).toMatchObject({
      permissions: {
        magician: { bash: { "*": "ask", "git status*": "allow" }, task: { hermit: "ask" } },
        "knight-of-swords": { bash: { "npm test*": "allow" } },
        hermit: { read: "allow" },
        "page-of-swords": { read: { "docs/**": "deny" }, glob: "ask" },
        justice: { bash: "deny" },
      },
    })
  })

  test("rejects unknown agents, tools, and actions", () => {
    expect(() => parseOptions({ permissions: { oracle: { bash: "ask" } } })).toThrow("unknown option: oracle")
    expect(() => parseOptions({ permissions: { magician: { shell: "ask" } } })).toThrow("unknown permission: shell")
    expect(() => parseOptions({ permissions: { magician: { bash: "prompt" } } })).toThrow("exactly allow")
  })

  test("rejects scalar-only maps, arrays, nulls, and empty maps", () => {
    const invalid: unknown[] = [
      { permissions: {} },
      { permissions: { magician: {} } },
      { permissions: { magician: { question: { "*": "deny" } } } },
      { permissions: { magician: { bash: {} } } },
      { permissions: { magician: { bash: [] } } },
      { permissions: { magician: { bash: null } } },
      { permissions: null },
    ]
    for (const input of invalid) expect(() => parseOptions(input as never)).toThrow()
  })

  test("rejects inherited and dangerous properties at every permission level", () => {
    const inheritedAgent = Object.create({ magician: { bash: "ask" } })
    expect(() => parseOptions({ permissions: inheritedAgent })).toThrow("plain object")

    const inheritedPattern = Object.create({ "docs/**": "deny" })
    expect(() => parseOptions({ permissions: { magician: { bash: inheritedPattern } } })).toThrow("plain object")

    for (const level of ["permissions", "agent", "pattern"]) {
      const dangerous = Object.create(null) as Record<string, unknown>
      Object.defineProperty(dangerous, "__proto__", { value: "deny", enumerable: true })
      const input =
        level === "permissions"
          ? { permissions: dangerous }
          : level === "agent"
            ? { permissions: { magician: dangerous } }
            : { permissions: { magician: { bash: dangerous } } }
      expect(() => parseOptions(input)).toThrow("dangerous")
    }
  })

  test("rejects whitespace, control-character, and canonical numeric pattern keys", () => {
    for (const pattern of ["", " docs/**", "docs/** ", "docs\n/**", "0", "4294967294"]) {
      expect(() => parseOptions({ permissions: { magician: { bash: { [pattern]: "deny" } } } })).toThrow()
    }
    expect(
      parseOptions({ permissions: { magician: { bash: { "4294967295": "deny" } } } }).permissions?.magician?.bash,
    ).toEqual({ "4294967295": "deny" })
  })

  test("enforces immutable role permission envelopes", () => {
    const invalid: unknown[] = [
      { permissions: { magician: { "*": "allow" } } },
      { permissions: { magician: { task: "allow" } } },
      { permissions: { magician: { task: { "*": "allow" } } } },
      { permissions: { magician: { task: { "new-worker": "allow" } } } },
      { permissions: { "knight-of-swords": { task: "deny" } } },
      { permissions: { hermit: { task: { "*": "deny" } } } },
    ]
    for (const key of ["edit", "task", "todowrite", "question", "list", "lsp", "doom_loop"]) {
      invalid.push({ permissions: { "page-of-swords": { [key]: "deny" } } })
      invalid.push({ permissions: { justice: { [key]: "deny" } } })
    }
    for (const key of ["read", "bash", "external_directory"]) {
      invalid.push({ permissions: { "page-of-swords": { [key]: "allow" } } })
      invalid.push({ permissions: { justice: { [key]: { "safe/**": "allow" } } } })
    }
    for (const input of invalid) expect(() => parseOptions(input as never)).toThrow()

    expect(
      parseOptions({ permissions: { magician: { task: { hermit: "ask", justice: "deny" } } } }).permissions?.magician
        ?.task,
    ).toEqual({ hermit: "ask", justice: "deny" })
  })

  test("clones permission input and never mutates shared defaults", () => {
    const bash: Record<string, "allow" | "ask" | "deny"> = { "git status*": "allow" }
    const input = { permissions: { hermit: { bash } } }
    const parsed = parseOptions(input)
    bash["new command*"] = "deny"
    ;(parsed.permissions?.hermit?.bash as Record<string, string>)["parsed-only"] = "ask"

    expect(input.permissions.hermit.bash).toEqual({ "git status*": "allow", "new command*": "deny" })
    expect(parsed.permissions?.hermit?.bash as Record<string, string>).toEqual({
      "git status*": "allow",
      "parsed-only": "ask",
    })
    expect(DEFAULT_OPTIONS.permissions).toBeUndefined()
  })
})
