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
  const [magician, knightOfSwords, hermit, pageOfSwords, justice] = await Promise.all([
    load("magician"),
    load("knight-of-swords"),
    load("hermit"),
    load("page-of-swords"),
    load("justice"),
  ])
  return { magician, knightOfSwords, hermit, pageOfSwords, justice }
}
