import type { Config } from "@opencode-ai/plugin"
import type { ArcanaOptions } from "./options.ts"
import type { Prompts } from "./prompts.ts"

export const ACTIVE_SUBAGENTS = [
  "knight-of-swords",
  "hermit",
  "page-of-swords",
  "justice",
] as const

export function configureAgents(config: Config, options: ArcanaOptions, prompts: Prompts) {
  config.agent = {
    ...config.agent,
    magician: {
      description:
        "The Magician / Primary orchestrator. Analyzes software work, routes bounded tasks to native workers, and verifies integrated results.",
      mode: "primary",
      model: options.models.magician.model,
      variant: options.models.magician.variant,
      color: "#F97316",
      prompt: prompts.magician,
      permission: magicianPermission(),
    },
    "knight-of-swords": {
      description:
        "Knight of Swords / Fast implementation. Use for atomic, low-ambiguity work in a small known scope; never use for architecture or broad debugging.",
      mode: "subagent",
      hidden: true,
      model: options.models["knight-of-swords"].model,
      variant: options.models["knight-of-swords"].variant,
      prompt: prompts.knightOfSwords,
      permission: implementationPermission(false),
    },
    hermit: {
      description:
        "The Hermit / Deep implementation. Use for complex, ambiguous, multi-file, architectural, root-cause, security, concurrency, migration, or data-sensitive work.",
      mode: "subagent",
      hidden: true,
      model: options.models.hermit.model,
      variant: options.models.hermit.variant,
      prompt: prompts.hermit,
      permission: implementationPermission(true),
    },
    "page-of-swords": {
      description: "Page of Swords / Fast Audit. Independent read-only auditor for focused checks and quick validation.",
      mode: "subagent",
      hidden: true,
      model: options.models["knight-of-swords"].model,
      variant: options.models["knight-of-swords"].variant,
      prompt: prompts.pageOfSwords,
      permission: auditPermission(),
    },
    justice: {
      description: "Justice / Deep Audit. Independent read-only auditor for thorough behavioral and architectural validation.",
      mode: "subagent",
      hidden: true,
      model: options.models.hermit.model,
      variant: options.models.hermit.variant,
      prompt: prompts.justice,
      permission: auditPermission(),
    },
  }
}

function magicianPermission() {
  return {
    question: "allow" as const,
    todowrite: "allow" as const,
    edit: "allow" as const,
    task: {
      "*": "deny" as const,
      "knight-of-swords": "allow" as const,
      hermit: "allow" as const,
      "page-of-swords": "allow" as const,
      justice: "allow" as const,
    },
    bash: safeImplementationBash(),
  }
}

function implementationPermission(deep: boolean) {
  return {
    question: "deny" as const,
    todowrite: deep ? ("allow" as const) : ("deny" as const),
    task: "deny" as const,
    edit: "allow" as const,
    bash: safeImplementationBash(),
  }
}

function auditPermission() {
  return {
    "*": "deny" as const,
    read: {
      "*": "allow" as const,
      "*.env": "deny" as const,
      "*.env.*": "deny" as const,
      "**/.env": "deny" as const,
      "**/.env.*": "deny" as const,
      ".npmrc": "deny" as const,
      "**/.npmrc": "deny" as const,
      "**/.ssh/**": "deny" as const,
      "**/.aws/**": "deny" as const,
      ".git/config": "deny" as const,
      "**/.git/config": "deny" as const,
      ".docker/config.json": "deny" as const,
      "**/.docker/config.json": "deny" as const,
      ".kube/config": "deny" as const,
      "**/.kube/config": "deny" as const,
      "*.pem": "deny" as const,
      "**/*.pem": "deny" as const,
      "*.key": "deny" as const,
      "**/*.key": "deny" as const,
      "*.p12": "deny" as const,
      "**/*.p12": "deny" as const,
      "*.pfx": "deny" as const,
      "**/*.pfx": "deny" as const,
      "credentials": "deny" as const,
      "**/credentials": "deny" as const,
      "*.env.example": "allow" as const,
      "**/.env.example": "allow" as const,
    },
    glob: "allow" as const,
    grep: "allow" as const,
    bash: "deny" as const,
  }
}

function safeImplementationBash() {
  return {
    "*": "ask" as const,
    "git status*": "allow" as const,
    "git diff*": "allow" as const,
    "git log*": "allow" as const,
    "git show*": "allow" as const,
    "git rev-parse*": "allow" as const,
    "git grep*": "allow" as const,
    "git ls-files*": "allow" as const,
    "rg *": "allow" as const,
    "npm test*": "allow" as const,
    "npm run test*": "allow" as const,
    "npm run lint*": "allow" as const,
    "npm run typecheck*": "allow" as const,
    "npm run check*": "allow" as const,
    "npm run build*": "allow" as const,
    "pnpm test*": "allow" as const,
    "pnpm run test*": "allow" as const,
    "pnpm lint*": "allow" as const,
    "pnpm run lint*": "allow" as const,
    "pnpm typecheck*": "allow" as const,
    "pnpm run typecheck*": "allow" as const,
    "pnpm check*": "allow" as const,
    "pnpm run check*": "allow" as const,
    "pnpm build*": "allow" as const,
    "pnpm run build*": "allow" as const,
    "bun test*": "allow" as const,
    "bun run test*": "allow" as const,
    "bun run lint*": "allow" as const,
    "bun run typecheck*": "allow" as const,
    "bun run check*": "allow" as const,
    "bun run build*": "allow" as const,
    "yarn test*": "allow" as const,
    "yarn lint*": "allow" as const,
    "yarn typecheck*": "allow" as const,
    "yarn build*": "allow" as const,
    "dotnet test*": "allow" as const,
    "dotnet build*": "allow" as const,
    "pytest*": "allow" as const,
    "python -m pytest*": "allow" as const,
    "py -m pytest*": "allow" as const,
    "cargo test*": "allow" as const,
    "cargo check*": "allow" as const,
    "cargo clippy*": "allow" as const,
    "cargo build*": "allow" as const,
    "go test*": "allow" as const,
    "go vet*": "allow" as const,
    "go build*": "allow" as const,
    "mvn test*": "allow" as const,
    "mvn verify*": "allow" as const,
    "gradle test*": "allow" as const,
    "gradlew test*": "allow" as const,
    ".\\gradlew test*": "allow" as const,
    "git reset --hard*": "deny" as const,
    "git clean -f*": "deny" as const,
    "rm -rf*": "deny" as const,
    "Remove-Item *-Recurse*-Force*": "deny" as const,
    "Remove-Item *-Force*-Recurse*": "deny" as const,
  }
}
