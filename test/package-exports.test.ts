import { describe, expect, test } from "bun:test"
import server from "../src/server.ts"
import tui from "../src/tui.ts"

describe("local package entrypoints", () => {
  test("declares separate server and TUI exports", async () => {
    const pkg = await Bun.file(new URL("../package.json", import.meta.url)).json()
    expect(pkg.private).toBe(true)
    expect(pkg.exports).toEqual({
      "./server": "./src/server.ts",
      "./tui": "./src/tui.ts",
    })
  })

  test("uses stable file-plugin IDs", () => {
    expect(server.id).toBe("opencode-arcana")
    expect(typeof server.server).toBe("function")
    expect(tui.id).toBe("opencode-arcana")
    expect(typeof tui.tui).toBe("function")
  })
})
