import type { TuiPluginModule } from "@opencode-ai/plugin/tui"
import {
  AGENT_IDENTITIES,
  formatChildDescription,
  formatChildTitle,
  getAgentIdentity,
  type AgentIdentity,
  type ArcanaAgentId,
} from "./agents.ts"
import { registerMagicianAssistantNotifications } from "./magician-assistant-notifications.ts"
import { registerMagicianAssistantsSidebar } from "./magician-assistants.tsx"
import { registerDossierCommand } from "./task-dossiers-tui.ts"

export { AGENT_IDENTITIES, formatChildDescription, formatChildTitle, getAgentIdentity }
export type { AgentIdentity, ArcanaAgentId }

function unwrap<T>(result: T | { data?: T; error?: unknown }, operation: string): T {
  if (result && typeof result === "object" && "error" in result && result.error) {
    throw new Error(`${operation}: ${JSON.stringify(result.error)}`)
  }
  if (result && typeof result === "object" && "data" in result) {
    if (result.data === undefined) throw new Error(`${operation}: empty response`)
    return result.data
  }
  return result as T
}

const plugin: TuiPluginModule = {
  id: "opencode-arcana",
  async tui(api) {
    async function openSubagents() {
      const route = api.route.current
      const currentID = "params" in route ? route.params?.sessionID : undefined
      if (route.name !== "session" || typeof currentID !== "string") {
        api.ui.toast({ variant: "warning", title: "Arcana subagents", message: "Open a session first." })
        return
      }

      const current = api.state.session.get(currentID)
      const parentID = current?.parentID ?? currentID
      const response = await api.client.session.children({ sessionID: parentID })
      const children = unwrap(response, "load child sessions")

      if (!Array.isArray(children) || children.length === 0) {
        api.ui.toast({
          variant: "info",
          title: "Arcana subagents",
          message: "This session has no child sessions yet.",
        })
        return
      }

      const options = children
        .toSorted((left, right) => {
          const leftTime = left.time?.updated ?? left.time?.created ?? 0
          const rightTime = right.time?.updated ?? right.time?.created ?? 0
          return rightTime - leftTime
        })
        .map((session) => ({
          title: formatChildTitle(session),
          value: session.id,
          description: formatChildDescription(session.agent, api.state.session.status(session.id)?.type),
        }))

      api.ui.dialog.setSize("large")
      api.ui.dialog.replace(() =>
        api.ui.DialogSelect({
          title: "Arcana subagents",
          placeholder: "Select a native task child session",
          options,
          onSelect(option) {
            api.ui.dialog.clear()
            api.route.navigate("session", { sessionID: option.value })
          },
        }),
      )
    }

    const unregister = api.keymap.registerLayer({
      commands: [
        {
          namespace: "palette",
          name: "arcana.subagents",
          title: "Open Arcana subagents",
          desc: "Open and inspect a child session created by the native task tool.",
          category: "Arcana",
          suggested: true,
          slashName: "subagents",
          slashAliases: ["children"],
          run() {
            return openSubagents().catch((error) => {
              api.ui.toast({
                variant: "error",
                title: "Arcana subagents",
                message: error instanceof Error ? error.message : String(error),
              })
            })
          },
        },
      ],
      bindings: [
        {
          key: "ctrl+shift+s",
          cmd: "arcana.subagents",
          desc: "Open Arcana subagents",
        },
      ],
    })

    api.lifecycle.onDispose(unregister)
    api.lifecycle.onDispose(registerDossierCommand(api))
    registerMagicianAssistantNotifications(api)
    registerMagicianAssistantsSidebar(api)
  },
}

export default plugin
