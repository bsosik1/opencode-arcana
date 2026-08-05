import type { PluginModule } from "@opencode-ai/plugin"
import { configureAgents } from "./configure-agents.ts"
import { configureCommands } from "./configure-commands.ts"
import { parseOptions } from "./options.ts"
import { loadPrompts } from "./prompts.ts"

const plugin: PluginModule = {
  id: "opencode-arcana",
  async server(_input, rawOptions) {
    const options = parseOptions(rawOptions)
    const prompts = await loadPrompts()
    return {
      async config(config) {
        configureAgents(config, options, prompts)
        configureCommands(config)
      },
    }
  },
}

export default plugin
