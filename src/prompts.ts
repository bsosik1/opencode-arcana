import { readFile } from "node:fs/promises"

export type Prompts = {
  magician: string
  knightOfSwords: string
  hermit: string
  pageOfSwords: string
  justice: string
}

export async function loadPrompts(): Promise<Prompts> {
  const load = (name: string) => readFile(new URL(`../prompts/${name}.md`, import.meta.url), "utf8")
  const [magician, knightOfSwords, hermit, pageOfSwords, justice, producer, broker] = await Promise.all([
    load("magician"),
    load("knight-of-swords"),
    load("hermit"),
    load("page-of-swords"),
    load("justice"),
    load("handoff-capsule-producer"),
    load("handoff-capsule-broker"),
  ])
  return {
    magician: `${magician.trim()}\n\n${broker.trim()}\n`,
    knightOfSwords: `${knightOfSwords.trim()}\n\n${producer.trim()}\n`,
    hermit: `${hermit.trim()}\n\n${producer.trim()}\n`,
    pageOfSwords: `${pageOfSwords.trim()}\n\n${producer.trim()}\n`,
    justice: `${justice.trim()}\n\n${producer.trim()}\n`,
  }
}
