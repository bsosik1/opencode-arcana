import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import {
  formatDossierDetails,
  formatDossierSummary,
  generateDossierReviewHandoff,
  reconstructTaskDossiers,
  wrapHandoffDisplayLines,
  type DossierChildSession,
  type TaskDossier,
} from "./task-dossiers.ts"
import {
  loadFullSessionHistory,
  resolveCachedRootSessionID,
  resolveRootSessionIDAsync,
  type MessageRecord,
} from "./magician-assistants-state.ts"

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

function currentSessionID(api: TuiPluginApi): string | undefined {
  const route = api.route.current
  const params = "params" in route ? route.params : undefined
  return route.name === "session" && params && typeof params.sessionID === "string" ? params.sessionID : undefined
}

async function resolveDossierRoot(api: TuiPluginApi, sessionID: string): Promise<string> {
  const cached = resolveCachedRootSessionID(sessionID, (id) => {
    const session = api.state.session.get(id)
    return session ? { parentID: session.parentID } : undefined
  })
  if (cached.complete) return cached.rootSessionID
  return resolveRootSessionIDAsync(sessionID, async (id) => {
    const response = await api.client.session.get({ sessionID: id })
    const session = unwrap(response, "load session ancestry")
    return session
  })
}

async function loadDossiers(api: TuiPluginApi, rootSessionID: string): Promise<TaskDossier[]> {
  const messages = await loadFullSessionHistory(
    (request) => api.client.session.messages(request),
    rootSessionID,
  )
  const response = await api.client.session.children({ sessionID: rootSessionID })
  const children = unwrap(response, "load child sessions")
  if (!Array.isArray(children)) throw new Error("load child sessions: invalid response")
  const enrichedChildren = (children as DossierChildSession[]).map((child) => {
    let status: unknown
    try {
      status = api.state.session.status(child.id)?.type
    } catch {
      status = undefined
    }
    return { ...child, status }
  })
  return reconstructTaskDossiers(rootSessionID, messages, enrichedChildren)
}

function childOption(dossier: TaskDossier, api: TuiPluginApi) {
  // An unavailable child stays visible as a no-op row: the host omits disabled
  // options, so a disabled row would hide the raw child ID and the user would
  // lose context. The no-op cannot navigate, so the unavailable action remains
  // non-executable while the child ID stays in view.
  if (!dossier.childAvailable) {
    return {
      title: "Open child session (unavailable)",
      value: "child",
      description: dossier.childSessionID ?? "Child session unavailable",
      onSelect: () => {},
    }
  }
  return {
    title: "Open child session",
    value: "child",
    description: dossier.childSessionID ?? "Child session unavailable",
    onSelect: () => {
      if (!dossier.childSessionID) return
      api.ui.dialog.clear()
      api.route.navigate("session", { sessionID: dossier.childSessionID })
    },
  }
}

function showDossierDetails(api: TuiPluginApi, dossier: TaskDossier, showList: () => void): void {
  const showHandoff = () => {
    const generatedLines = generateDossierReviewHandoff(dossier)
    if (!generatedLines) return
    const lines = wrapHandoffDisplayLines(generatedLines)
    api.ui.dialog.setSize("xlarge")
    api.ui.dialog.replace(() =>
      api.ui.DialogSelect({
        title: "Generated handoff (review only)",
        placeholder: "Scroll: ↑/↓ · Page Up/Down · Home/End",
        // Read-only rows must stay enabled: OpenTUI omits disabled options,
        // which made a valid generated handoff appear blank. A no-op handler
        // preserves the read-only boundary without hiding the content. Each
        // payload line is its own navigable row, so arrow/Page/Home/End reach
        // every JSON line and the Back row. skipFilter keeps the list stable
        // so no row can be filtered away during review.
        skipFilter: true,
        options: [
          ...lines.map((line, index) => ({ title: line || " ", value: `handoff:${index}`, onSelect: () => {} })),
          { title: "Back to dossier details", value: "back", onSelect: () => showDossierDetails(api, dossier, showList) },
        ],
      }),
    )
  }
  // Static information rows must stay enabled: the host omits disabled
  // options, which hid the whole detail view. A no-op handler keeps them
  // visible without any selection side effect (same read-only contract as the
  // handoff preview rows).
  const detailOptions = formatDossierDetails(dossier).map((line) => ({
    title: line || " ",
    value: `detail:${line}`,
    onSelect: () => {},
  }))
  api.ui.dialog.setSize("xlarge")
  api.ui.dialog.replace(() =>
    api.ui.DialogSelect({
      title: formatDossierSummary(dossier),
      placeholder: "Select a safe navigation action",
      options: [
        ...detailOptions,
        {
          title: "View generated handoff",
          value: "handoff",
          disabled: dossier.capsule.status !== "valid",
          description: dossier.capsule.status === "valid" ? "Bounded review data; not execution authorization" : "Requires one valid Capsule v1",
          onSelect: showHandoff,
        },
        childOption(dossier, api),
        {
          title: "Open root session",
          value: "root",
          description: dossier.rootSessionID,
          onSelect: () => {
            api.ui.dialog.clear()
            api.route.navigate("session", { sessionID: dossier.rootSessionID })
          },
        },
        {
          title: "Back to dossiers",
          value: "back",
          onSelect: showList,
        },
      ],
    }),
  )
}

function showDossierList(api: TuiPluginApi, dossiers: TaskDossier[]): void {
  let renderList: () => void = () => {}
  renderList = () => {
    api.ui.dialog.setSize("xlarge")
    api.ui.dialog.replace(() =>
      api.ui.DialogSelect({
        title: "Arcana task dossiers",
        placeholder: "● active  ○ verify  ✓ done  ■ blocked",
        options: dossiers.map((dossier) => ({
          title: formatDossierSummary(dossier),
          value: dossier.id,
           description: dossier.childSessionID
             ? `${dossier.capsule.status === "valid" ? `Capsule ${dossier.capsule.evidenceCount}/${dossier.capsule.unresolvedCount}` : "No capsule"} | Child ${dossier.childSessionID}`
             : dossier.capsule.status === "valid" ? `Capsule ${dossier.capsule.evidenceCount}/${dossier.capsule.unresolvedCount} | Child unavailable` : "No capsule | Child unavailable",
          onSelect: () => showDossierDetails(api, dossier, renderList),
        })),
      }),
    )
  }
  renderList()
}

export async function openDossiers(api: TuiPluginApi): Promise<void> {
  const sessionID = currentSessionID(api)
  if (!sessionID) {
    api.ui.toast({ variant: "warning", title: "Arcana dossiers", message: "Open a session first." })
    return
  }

  const rootSessionID = await resolveDossierRoot(api, sessionID)
  const dossiers = await loadDossiers(api, rootSessionID)
  if (dossiers.length === 0) {
    api.ui.toast({ variant: "info", title: "Arcana dossiers", message: "No native Arcana task dossiers found." })
    return
  }
  showDossierList(api, dossiers)
}

export function registerDossierCommand(api: TuiPluginApi): () => void {
  return api.keymap.registerLayer({
    commands: [
      {
        namespace: "palette",
        name: "arcana.dossiers",
        title: "Open Arcana task dossiers",
        desc: "Inspect reconstructed native Arcana task history without resuming work.",
        category: "Arcana",
        suggested: true,
        slashName: "dossiers",
        slashAliases: ["tasks"],
        run() {
          return openDossiers(api).catch((error) => {
            api.ui.toast({
              variant: "error",
              title: "Arcana dossiers",
              message: error instanceof Error ? error.message : String(error),
            })
          })
        },
      },
    ],
    bindings: [
      {
        key: "ctrl+shift+d",
        cmd: "arcana.dossiers",
        desc: "Open Arcana task dossiers",
      },
    ],
  })
}

export function getDossierRootSessionIDForTest(api: TuiPluginApi, sessionID: string): Promise<string> {
  return resolveDossierRoot(api, sessionID)
}
