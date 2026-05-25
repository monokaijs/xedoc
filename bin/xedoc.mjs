#!/usr/bin/env node
import { spawn } from "node:child_process"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
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
  if (options.command === "service") {
    printServiceHelp()
  } else {
    printHelp()
  }
  process.exit(0)
}
if (options.version) {
  console.log(packageJson.version)
  process.exit(0)
}
if (options.command === "service") {
  await handleServiceCommand(options)
  process.exit(0)
}

const runtime = resolveRuntimeOptions(options)
await mkdir(runtime.appHome, { recursive: true, mode: 0o700 })
await mkdir(dirname(runtime.databasePath), { recursive: true, mode: 0o700 })
await mkdir(runtime.accountsHome, { recursive: true, mode: 0o700 })

if (!options.skipPrismaGenerate) {
  await runPrisma(["generate"], runtime.env)
}
if (!options.skipSetup) {
  await setupSqliteDatabase(runtime.env)
}

const url = `http://${runtime.host === "0.0.0.0" ? "localhost" : runtime.host}:${runtime.port}`
console.log(`xedoc: ${url}`)
console.log("Set the server password in your browser on first visit.")
console.log(`Workspace root: ${runtime.workspaceRoot}`)
console.log(`Shared chat store: ${runtime.sharedChatHome}`)
console.log("Press Ctrl+C to stop.")

await runServer(runtime.env)

function parseArgs(argv) {
  const parsed = {}
  const positional = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--help" || arg === "-h") {
      parsed.help = true
    } else if (arg === "--version" || arg === "-v") {
      parsed.version = true
    } else if (arg === "--no-start") {
      parsed.noStart = true
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
      positional.push(arg)
    }
  }
  if (positional.length) {
    if (positional[0] !== "service") {
      fail(`Unknown command: ${positional[0]}`)
    }
    if (positional.length > 2) {
      fail(`Unknown service argument: ${positional[2]}`)
    }
    parsed.command = "service"
    parsed.serviceAction = positional[1]
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
    case "--service-name":
      parsed.serviceName = value
      return
    case "--shared-chat-home":
      parsed.sharedChatHome = value
      return
    case "--workspace-root":
      parsed.workspaceRoot = value
      return
    default:
      fail(`Unknown option: ${name}`)
  }
}

function resolveRuntimeOptions(options) {
  const appHome = resolveHomePath(
    options.home ?? process.env.XEDOC_HOME ?? "~/.xedoc",
  )
  const port = String(options.port ?? process.env.PORT ?? "6354")
  const host = String(options.host ?? process.env.HOST ?? "127.0.0.1")
  const accountsHome = resolveHomePath(
    options.accountsHome ??
      process.env.CODEX_ACCOUNTS_HOME ??
      join(appHome, "accounts"),
  )
  const sharedChatHome = resolveHomePath(
    options.sharedChatHome ??
      process.env.CODEX_SHARED_CHAT_HOME ??
      process.env.CODEX_HOME ??
      "~/.codex",
  )
  const workspaceRoot = resolveHomePath(
    options.workspaceRoot ?? process.env.CODEX_WORKSPACE_ROOT ?? homedir(),
  )
  const databasePath = join(workspaceRoot, ".xedoc", "xedoc.db")
  const databaseUrl = sqliteDatabaseUrl(databasePath)
  const codexBin = require.resolve("@openai/codex/bin/codex.js")
  const codexArgs =
    options.codexArgs ?? process.env.CODEX_ARGS ?? `${codexBin} app-server`
  const codexCommand =
    options.codexCommand ?? process.env.CODEX_COMMAND ?? process.execPath
  const env = {
    ...process.env,
    CODEX_ACCOUNTS_HOME: accountsHome,
    CODEX_ARGS: codexArgs,
    CODEX_COMMAND: codexCommand,
    CODEX_SHARED_CHAT_HOME: sharedChatHome,
    CODEX_WORKSPACE_ROOT: workspaceRoot,
    DATABASE_URL: databaseUrl,
    HOST: host,
    NODE_ENV: "production",
    PORT: port,
  }
  return {
    accountsHome,
    appHome,
    codexArgs,
    codexCommand,
    databasePath,
    databaseUrl,
    env,
    host,
    port,
    sharedChatHome,
    skipPrismaGenerate: !!options.skipPrismaGenerate,
    skipSetup: !!options.skipSetup,
    workspaceRoot,
  }
}

async function handleServiceCommand(options) {
  switch (options.serviceAction) {
    case "install":
      await installUserSystemdService(options)
      return
    case "uninstall":
      await uninstallUserSystemdService(options)
      return
    case undefined:
      printServiceHelp()
      fail("Choose a service command: install or uninstall.")
      return
    default:
      fail(`Unknown service command: ${options.serviceAction}`)
  }
}

async function installUserSystemdService(options) {
  requireLinuxSystemd()
  const runtime = resolveRuntimeOptions(options)
  const serviceName = normalizeServiceName(options.serviceName)
  const unitPath = userSystemdUnitPath(serviceName)
  await mkdir(dirname(unitPath), { recursive: true, mode: 0o700 })
  await writeFile(unitPath, systemdUnitFile(runtime), { mode: 0o644 })
  await runSystemctl(["daemon-reload"])
  await runSystemctl(["enable", ...(options.noStart ? [] : ["--now"]), serviceName])

  const url = `http://${runtime.host === "0.0.0.0" ? "localhost" : runtime.host}:${runtime.port}`
  console.log(`Installed ${serviceName}.`)
  console.log(options.noStart ? "Service is enabled but not started." : `Service is running at ${url}.`)
  console.log(`Logs: systemctl --user status ${serviceName}`)
  console.log(`Uninstall: xedoc service uninstall --service-name ${serviceName.replace(/\.service$/u, "")}`)
}

async function uninstallUserSystemdService(options) {
  requireLinuxSystemd()
  const serviceName = normalizeServiceName(options.serviceName)
  const unitPath = userSystemdUnitPath(serviceName)
  await runSystemctl(["disable", "--now", serviceName]).catch((error) => {
    console.warn(
      `Could not stop or disable ${serviceName}: ${error instanceof Error ? error.message : error}`,
    )
  })
  await rm(unitPath, { force: true })
  await runSystemctl(["daemon-reload"])
  console.log(`Uninstalled ${serviceName}.`)
}

function requireLinuxSystemd() {
  if (process.platform !== "linux") {
    fail("Service install currently supports Linux user systemd services only.")
  }
}

function normalizeServiceName(value) {
  const name = value?.trim() || "xedoc"
  if (!/^[A-Za-z0-9_.@-]+$/u.test(name)) {
    fail("Service name may only contain letters, numbers, dots, underscores, @, and hyphens.")
  }
  return name.endsWith(".service") ? name : `${name}.service`
}

function userSystemdUnitPath(serviceName) {
  return join(homedir(), ".config", "systemd", "user", serviceName)
}

function systemdUnitFile(runtime) {
  const execArgs = [
    process.execPath,
    join(packageRoot, "bin", "xedoc.mjs"),
    ...runtimeServiceArgs(runtime),
  ]
  return `[Unit]
Description=xedoc local Codex web UI
After=network-online.target

[Service]
Type=simple
ExecStart=${execArgs.map(systemdQuoteExecArg).join(" ")}
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
`
}

function runtimeServiceArgs(runtime) {
  const args = [
    "--home",
    runtime.appHome,
    "--host",
    runtime.host,
    "--port",
    runtime.port,
    "--workspace-root",
    runtime.workspaceRoot,
    "--accounts-home",
    runtime.accountsHome,
    "--shared-chat-home",
    runtime.sharedChatHome,
    "--codex-command",
    runtime.codexCommand,
    "--codex-args",
    runtime.codexArgs,
  ]
  if (runtime.skipSetup) {
    args.push("--skip-setup")
  }
  if (runtime.skipPrismaGenerate) {
    args.push("--skip-prisma-generate")
  }
  return args
}

function systemdQuoteExecArg(value) {
  return `"${String(value)
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("%", "%%")}"`
}

async function runSystemctl(args) {
  await run("systemctl", ["--user", ...args], {
    cwd: packageRoot,
    env: process.env,
    stdio: "inherit",
  })
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
  npx xedoc-cli [options]
  xedoc service install [options]
  xedoc service uninstall [options]

Options:
  --port <port>                 Web server port. Defaults to 6354.
  --host <host>                 Web server host. Defaults to 127.0.0.1.
  --workspace-root <path>       Directory tree visible in the app. Defaults to your home directory.
  --accounts-home <path>        Codex account state directory. Defaults to ~/.xedoc/accounts.
  --shared-chat-home <path>     Shared Codex chat store. Defaults to ~/.codex.
  --skip-setup                  Do not create the SQLite database schema.
  --skip-prisma-generate        Do not regenerate Prisma Client.
  --codex-command <command>     Codex command used for new accounts.
  --codex-args <args>           Codex command arguments used for new accounts.
  --home <path>                 App data directory. Defaults to ~/.xedoc.
  --service-name <name>         systemd user service name. Defaults to xedoc.
  --no-start                    Enable service without starting it during install.
  --help                        Show this help.
  --version                     Print the package version.
`)
}

function printServiceHelp() {
  console.log(`xedoc ${packageJson.version}

Usage:
  xedoc service install [options]
  xedoc service uninstall [options]

Linux user systemd service commands:
  install                       Write ~/.config/systemd/user/xedoc.service, reload systemd, and enable --now.
  uninstall                     Stop, disable, and remove the user service file.

Options:
  --service-name <name>         systemd user service name. Defaults to xedoc.
  --no-start                    Enable service without starting it during install.
  --port <port>                 Web server port. Defaults to 6354.
  --host <host>                 Web server host. Defaults to 127.0.0.1.
  --workspace-root <path>       Directory tree visible in the app. Defaults to your home directory.
  --accounts-home <path>        Codex account state directory. Defaults to ~/.xedoc/accounts.
  --shared-chat-home <path>     Shared Codex chat store. Defaults to ~/.codex.
  --home <path>                 App data directory. Defaults to ~/.xedoc.
  --skip-setup                  Do not create the SQLite database schema.
  --skip-prisma-generate        Do not regenerate Prisma Client.
`)
}
