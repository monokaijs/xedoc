#!/usr/bin/env node
import { spawn } from "node:child_process"
import { mkdir, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { createRequire } from "node:module"

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const require = createRequire(import.meta.url)
const packageJson = JSON.parse(
  await readFile(join(packageRoot, "package.json"), "utf8"),
)

const options = parseArgs(process.argv.slice(2))
if (options.help) {
  printHelp()
  process.exit(0)
}
if (options.version) {
  console.log(packageJson.version)
  process.exit(0)
}

const appHome = resolveHomePath(
  options.home ?? process.env.XEDOC_HOME ?? "~/.xedoc",
)
await mkdir(appHome, { recursive: true, mode: 0o700 })

const port = options.port ?? process.env.PORT ?? "6354"
const host = options.host ?? process.env.HOST ?? "127.0.0.1"
const accountsHome = resolveHomePath(
  options.accountsHome ??
    process.env.CODEX_ACCOUNTS_HOME ??
    join(appHome, "accounts"),
)
const workspaceRoot = resolveHomePath(
  options.workspaceRoot ?? process.env.CODEX_WORKSPACE_ROOT ?? homedir(),
)
const databasePath = join(workspaceRoot, ".xedoc", "xedoc.db")
await mkdir(dirname(databasePath), { recursive: true, mode: 0o700 })
const databaseUrl = sqliteDatabaseUrl(databasePath)

const codexBin = require.resolve("@openai/codex/bin/codex.js")
const env = {
  ...process.env,
  CODEX_ACCOUNTS_HOME: accountsHome,
  CODEX_ARGS: options.codexArgs ?? process.env.CODEX_ARGS ?? `${codexBin} app-server`,
  CODEX_COMMAND: options.codexCommand ?? process.env.CODEX_COMMAND ?? process.execPath,
  CODEX_WORKSPACE_ROOT: workspaceRoot,
  DATABASE_URL: databaseUrl,
  HOST: host,
  NODE_ENV: "production",
  PORT: port,
}

await mkdir(accountsHome, { recursive: true, mode: 0o700 })
if (!options.skipPrismaGenerate) {
  await runPrisma(["generate"], env)
}
if (!options.skipSetup) {
  await setupSqliteDatabase(env)
}

const url = `http://${host === "0.0.0.0" ? "localhost" : host}:${port}`
console.log(`xedoc: ${url}`)
console.log("Set the server password in your browser on first visit.")
console.log(`Workspace root: ${workspaceRoot}`)
console.log("Press Ctrl+C to stop.")

await runServer(env)

function parseArgs(argv) {
  const parsed = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--help" || arg === "-h") {
      parsed.help = true
    } else if (arg === "--version" || arg === "-v") {
      parsed.version = true
    } else if (arg === "--skip-setup") {
      parsed.skipSetup = true
    } else if (arg === "--skip-prisma-generate") {
      parsed.skipPrismaGenerate = true
    } else if (arg.startsWith("--")) {
      const [name, inlineValue] = arg.split("=", 2)
      const value = inlineValue ?? argv[++index]
      if (!value || value.startsWith("--")) {
        fail(`${name} requires a value.`)
      }
      assignOption(parsed, name, value)
    } else {
      fail(`Unknown argument: ${arg}`)
    }
  }
  return parsed
}

function assignOption(parsed, name, value) {
  switch (name) {
    case "--accounts-home":
      parsed.accountsHome = value
      return
    case "--codex-args":
      parsed.codexArgs = value
      return
    case "--codex-command":
      parsed.codexCommand = value
      return
    case "--home":
      parsed.home = value
      return
    case "--host":
      parsed.host = value
      return
    case "--port":
      parsed.port = value
      return
    case "--workspace-root":
      parsed.workspaceRoot = value
      return
    default:
      fail(`Unknown option: ${name}`)
  }
}

async function runPrisma(args, env) {
  await run(process.execPath, [
    require.resolve("prisma/build/index.js"),
    ...args,
    "--schema",
    join(packageRoot, "prisma/schema.prisma"),
  ], {
    cwd: packageRoot,
    env,
    stdio: "inherit",
  })
}

async function runServer(env) {
  await run(process.execPath, [join(packageRoot, "server/index.mjs")], {
    cwd: packageRoot,
    env,
    stdio: "inherit",
  })
}

async function setupSqliteDatabase(env) {
  const previousDatabaseUrl = process.env.DATABASE_URL
  const previousWorkspaceRoot = process.env.CODEX_WORKSPACE_ROOT
  process.env.DATABASE_URL = env.DATABASE_URL
  process.env.CODEX_WORKSPACE_ROOT = env.CODEX_WORKSPACE_ROOT
  try {
    const setupModuleUrl = pathToFileURL(
      join(packageRoot, "server/sqlite-setup.mjs"),
    ).href
    const { setupSqliteDatabase } = await import(setupModuleUrl)
    await setupSqliteDatabase()
  } finally {
    if (previousDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL
    } else {
      process.env.DATABASE_URL = previousDatabaseUrl
    }
    if (previousWorkspaceRoot === undefined) {
      delete process.env.CODEX_WORKSPACE_ROOT
    } else {
      process.env.CODEX_WORKSPACE_ROOT = previousWorkspaceRoot
    }
  }
}

function run(command, args, options) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, options)
    const forwardSigint = () => child.kill("SIGINT")
    const forwardSigterm = () => child.kill("SIGTERM")
    process.once("SIGINT", forwardSigint)
    process.once("SIGTERM", forwardSigterm)
    child.on("exit", (code, signal) => {
      process.removeListener("SIGINT", forwardSigint)
      process.removeListener("SIGTERM", forwardSigterm)
      if (code === 0 || signal) {
        resolveRun()
      } else {
        rejectRun(new Error(`${command} exited with code ${code}`))
      }
    })
    child.on("error", rejectRun)
  })
}

function resolveHomePath(path) {
  if (path === "~") {
    return homedir()
  }
  if (path.startsWith("~/")) {
    return join(homedir(), path.slice(2))
  }
  return resolve(path)
}

function sqliteDatabaseUrl(databasePath) {
  return `file:${databasePath}?connection_limit=1&pool_timeout=30`
}

function fail(message) {
  console.error(message)
  process.exit(1)
}

function printHelp() {
  console.log(`xedoc ${packageJson.version}

Usage:
  npx xedoc [options]

Options:
  --port <port>                 Web server port. Defaults to 6354.
  --host <host>                 Web server host. Defaults to 127.0.0.1.
  --workspace-root <path>       Directory tree visible in the app. Defaults to your home directory.
  --accounts-home <path>        Codex account state directory. Defaults to ~/.xedoc/accounts.
  --skip-setup                  Do not create the SQLite database schema.
  --codex-command <command>     Codex command used for new accounts.
  --codex-args <args>           Codex command arguments used for new accounts.
  --home <path>                 App data directory. Defaults to ~/.xedoc.
  --help                        Show this help.
  --version                     Print the package version.
`)
}
