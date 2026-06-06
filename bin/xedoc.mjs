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
await mkdir(runtime.historyHome, { recursive: true, mode: 0o700 })

if (!options.skipPrismaGenerate) {
  await runPrisma(["generate"], runtime.env)
}
if (!options.skipSetup) {
  await setupSqliteDatabase(runtime.env)
}

const url = `http://${runtime.host === "0.0.0.0" ? "localhost" : runtime.host}:${runtime.port}`
console.log(`xedoc: ${url}`)
console.log("Set the server password in your browser on first visit.")
console.log(`File browser home: ${runtime.workspaceRoot}`)
console.log(`History store: ${runtime.historyHome}`)
console.log(`External Codex sync: ${runtime.sharedChatHome}`)
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
    } else if (arg === "--debug") {
      parsed.debug = true
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
    case "--forever-command":
      parsed.foreverCommand = value
      return
    case "--home":
      parsed.home = value
      return
    case "--host":
      parsed.host = value
      return
    case "--history-home":
      parsed.historyHome = value
      return
    case "--port":
      parsed.port = value
      return
    case "--service-name":
      parsed.serviceName = value
      return
    case "--service-driver":
      parsed.serviceDriver = value
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
  const historyHome = resolveHomePath(
    options.historyHome ??
      process.env.XEDOC_HISTORY_HOME ??
      join(appHome, "history"),
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
    XEDOC_DEBUG: options.debug ? "1" : process.env.XEDOC_DEBUG,
    XEDOC_HISTORY_HOME: historyHome,
  }
  return {
    accountsHome,
    appHome,
    codexArgs,
    codexCommand,
    databasePath,
    databaseUrl,
    debug: !!options.debug || isDebugEnabled(process.env.XEDOC_DEBUG),
    env,
    historyHome,
    host,
    port,
    sharedChatHome,
    skipPrismaGenerate: !!options.skipPrismaGenerate,
    skipSetup: !!options.skipSetup,
    workspaceRoot,
  }
}

async function handleServiceCommand(options) {
  const driver = resolveServiceDriver(options.serviceDriver)
  switch (options.serviceAction) {
    case "install":
      await installBackgroundService(options, driver)
      return
    case "uninstall":
      await uninstallBackgroundService(options, driver)
      return
    case undefined:
      printServiceHelp()
      fail("Choose a service command: install or uninstall.")
      return
    default:
      fail(`Unknown service command: ${options.serviceAction}`)
  }
}

async function installBackgroundService(options, driver) {
  switch (driver) {
    case "systemd":
      await installSystemdService(options)
      return
    case "launchd":
      await installLaunchdService(options)
      return
    case "windows-task":
      await installWindowsTaskService(options)
      return
    case "forever":
      await installForeverService(options)
      return
    default:
      fail(`Unsupported service driver: ${driver}`)
  }
}

async function uninstallBackgroundService(options, driver) {
  switch (driver) {
    case "systemd":
      await uninstallSystemdService(options)
      return
    case "launchd":
      await uninstallLaunchdService(options)
      return
    case "windows-task":
      await uninstallWindowsTaskService(options)
      return
    case "forever":
      await uninstallForeverService(options)
      return
    default:
      fail(`Unsupported service driver: ${driver}`)
  }
}

function resolveServiceDriver(value) {
  const driver = value?.trim() || "auto"
  if (driver === "auto") {
    if (process.platform === "linux") {
      return "systemd"
    }
    if (process.platform === "darwin") {
      return "launchd"
    }
    if (process.platform === "win32") {
      return "windows-task"
    }
    fail(
      `No native service driver is available for ${process.platform}. Try --service-driver forever.`,
    )
  }
  if (
    driver === "systemd" ||
    driver === "launchd" ||
    driver === "windows-task" ||
    driver === "forever"
  ) {
    return driver
  }
  fail(
    `Unknown service driver: ${driver}. Use auto, systemd, launchd, windows-task, or forever.`,
  )
}

async function installSystemdService(options) {
  requireLinuxSystemd()
  const runtime = resolveRuntimeOptions(options)
  const serviceBaseName = normalizeServiceBaseName(options.serviceName)
  const serviceName = `${serviceBaseName}.service`
  const unitPath = userSystemdUnitPath(serviceName)
  await mkdir(dirname(unitPath), { recursive: true, mode: 0o700 })
  await writeFile(unitPath, systemdUnitFile(runtime), { mode: 0o644 })
  await runSystemctl(["daemon-reload"])
  await runSystemctl(["enable", ...(options.noStart ? [] : ["--now"]), serviceName])

  const url = `http://${runtime.host === "0.0.0.0" ? "localhost" : runtime.host}:${runtime.port}`
  console.log(`Installed ${serviceName}.`)
  console.log(options.noStart ? "Service is enabled but not started." : `Service is running at ${url}.`)
  console.log(`Logs: systemctl --user status ${serviceName}`)
  console.log(`Uninstall: xedoc service uninstall --service-name ${serviceBaseName}`)
}

async function uninstallSystemdService(options) {
  requireLinuxSystemd()
  const serviceBaseName = normalizeServiceBaseName(options.serviceName)
  const serviceName = `${serviceBaseName}.service`
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

async function installLaunchdService(options) {
  requireDarwinLaunchd()
  const runtime = resolveRuntimeOptions(options)
  const label = normalizeServiceBaseName(options.serviceName)
  const plistPath = launchdPlistPath(label)
  await mkdir(dirname(plistPath), { recursive: true, mode: 0o700 })
  await mkdir(serviceLogDirectory(runtime), { recursive: true, mode: 0o700 })
  await writeFile(plistPath, launchdPlistFile(runtime, label), { mode: 0o644 })
  const domain = launchdDomain()
  if (!options.noStart) {
    await runLaunchctl(["bootout", domain, plistPath]).catch(() => undefined)
    await runLaunchctl(["bootstrap", domain, plistPath])
    await runLaunchctl(["enable", `${domain}/${label}`]).catch(() => undefined)
    await runLaunchctl(["kickstart", "-k", `${domain}/${label}`])
  }
  const url = `http://${runtime.host === "0.0.0.0" ? "localhost" : runtime.host}:${runtime.port}`
  console.log(`Installed ${label}.`)
  console.log(options.noStart ? "LaunchAgent is installed and will start at next login." : `Service is running at ${url}.`)
  console.log(`Logs: tail -f ${join(serviceLogDirectory(runtime), `${label}.out.log`)}`)
  console.log(`Uninstall: xedoc service uninstall --service-name ${label}`)
}

async function uninstallLaunchdService(options) {
  requireDarwinLaunchd()
  const label = normalizeServiceBaseName(options.serviceName)
  const plistPath = launchdPlistPath(label)
  await runLaunchctl(["bootout", launchdDomain(), plistPath]).catch((error) => {
    console.warn(
      `Could not stop ${label}: ${error instanceof Error ? error.message : error}`,
    )
  })
  await rm(plistPath, { force: true })
  console.log(`Uninstalled ${label}.`)
}

async function installWindowsTaskService(options) {
  requireWindowsTaskScheduler()
  const runtime = resolveRuntimeOptions(options)
  const taskName = normalizeServiceBaseName(options.serviceName)
  const commandPath = await writeWindowsServiceCommand(runtime, taskName)
  await runSchtasks([
    "/Create",
    "/TN",
    taskName,
    "/SC",
    "ONLOGON",
    "/TR",
    `cmd.exe /d /c ${windowsBatchQuote(commandPath)}`,
    "/F",
  ])
  if (!options.noStart) {
    await runSchtasks(["/Run", "/TN", taskName])
  }
  const url = `http://${runtime.host === "0.0.0.0" ? "localhost" : runtime.host}:${runtime.port}`
  console.log(`Installed ${taskName}.`)
  console.log(options.noStart ? "Task is installed but not started." : `Task is running at ${url}.`)
  console.log(`Status: schtasks /Query /TN ${taskName}`)
  console.log(`Uninstall: xedoc service uninstall --service-name ${taskName}`)
}

async function uninstallWindowsTaskService(options) {
  requireWindowsTaskScheduler()
  const runtime = resolveRuntimeOptions(options)
  const taskName = normalizeServiceBaseName(options.serviceName)
  await runSchtasks(["/End", "/TN", taskName]).catch(() => undefined)
  await runSchtasks(["/Delete", "/TN", taskName, "/F"]).catch((error) => {
    console.warn(
      `Could not delete ${taskName}: ${error instanceof Error ? error.message : error}`,
    )
  })
  await rm(windowsServiceCommandPath(runtime, taskName), { force: true })
  console.log(`Uninstalled ${taskName}.`)
}

async function installForeverService(options) {
  if (options.noStart) {
    fail("--no-start is not supported with --service-driver forever.")
  }
  const runtime = resolveRuntimeOptions(options)
  const serviceName = normalizeServiceBaseName(options.serviceName)
  const logDirectory = serviceLogDirectory(runtime)
  await mkdir(logDirectory, { recursive: true, mode: 0o700 })
  await runForever(["stop", serviceName], options).catch(() => undefined)
  await runForever([
    "start",
    "--uid",
    serviceName,
    "--append",
    "--workingDir",
    packageRoot,
    "-l",
    join(logDirectory, `${serviceName}.forever.log`),
    "-o",
    join(logDirectory, `${serviceName}.out.log`),
    "-e",
    join(logDirectory, `${serviceName}.err.log`),
    "-c",
    process.execPath,
    join(packageRoot, "bin", "xedoc.mjs"),
    ...runtimeServiceArgs(runtime),
  ], options)
  const url = `http://${runtime.host === "0.0.0.0" ? "localhost" : runtime.host}:${runtime.port}`
  console.log(`Started ${serviceName} with forever at ${url}.`)
  console.log("Note: forever keeps the process alive, but does not install OS boot integration.")
  console.log(`Logs: forever logs ${serviceName}`)
  console.log(`Uninstall: xedoc service uninstall --service-driver forever --service-name ${serviceName}`)
}

async function uninstallForeverService(options) {
  const serviceName = normalizeServiceBaseName(options.serviceName)
  await runForever(["stop", serviceName], options).catch((error) => {
    console.warn(
      `Could not stop ${serviceName}: ${error instanceof Error ? error.message : error}`,
    )
  })
  console.log(`Stopped ${serviceName} in forever.`)
}

function requireLinuxSystemd() {
  if (process.platform !== "linux") {
    fail("The systemd service driver only supports Linux.")
  }
}

function requireDarwinLaunchd() {
  if (process.platform !== "darwin") {
    fail("The launchd service driver only supports macOS.")
  }
  if (typeof process.getuid !== "function") {
    fail("Could not determine the current macOS user id.")
  }
}

function requireWindowsTaskScheduler() {
  if (process.platform !== "win32") {
    fail("The windows-task service driver only supports Windows.")
  }
}

function normalizeServiceBaseName(value) {
  const name = value?.trim() || "xedoc"
  const normalized = name.endsWith(".service") ? name.slice(0, -".service".length) : name
  if (!/^[A-Za-z0-9_.@-]+$/u.test(name)) {
    fail("Service name may only contain letters, numbers, dots, underscores, @, and hyphens.")
  }
  if (!normalized) {
    fail("Service name must not be empty.")
  }
  return normalized
}

function userSystemdUnitPath(serviceName) {
  return join(homedir(), ".config", "systemd", "user", serviceName)
}

function launchdPlistPath(label) {
  return join(homedir(), "Library", "LaunchAgents", `${label}.plist`)
}

function launchdDomain() {
  return `gui/${process.getuid()}`
}

function serviceLogDirectory(runtime) {
  return join(runtime.appHome, "logs")
}

function launchdPlistFile(runtime, label) {
  const execArgs = [
    process.execPath,
    join(packageRoot, "bin", "xedoc.mjs"),
    ...runtimeServiceArgs(runtime),
  ]
  const logDirectory = serviceLogDirectory(runtime)
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(label)}</string>
  <key>ProgramArguments</key>
  <array>
${execArgs.map((arg) => `    <string>${xmlEscape(arg)}</string>`).join("\n")}
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(packageRoot)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(join(logDirectory, `${label}.out.log`))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(join(logDirectory, `${label}.err.log`))}</string>
</dict>
</plist>
`
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
    "--history-home",
    runtime.historyHome,
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
  if (runtime.debug) {
    args.push("--debug")
  }
  return args
}

function systemdQuoteExecArg(value) {
  return `"${String(value)
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("%", "%%")}"`
}

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
}

async function writeWindowsServiceCommand(runtime, taskName) {
  const commandPath = windowsServiceCommandPath(runtime, taskName)
  await mkdir(dirname(commandPath), { recursive: true, mode: 0o700 })
  const command = [
    "@echo off",
    `cd /d ${windowsBatchQuote(packageRoot)}`,
    [
      windowsBatchQuote(process.execPath),
      windowsBatchQuote(join(packageRoot, "bin", "xedoc.mjs")),
      ...runtimeServiceArgs(runtime).map(windowsBatchQuote),
    ].join(" "),
    "",
  ].join("\r\n")
  await writeFile(commandPath, command, { mode: 0o700 })
  return commandPath
}

function windowsServiceCommandPath(runtime, taskName) {
  return join(runtime.appHome, "service", `${taskName}.cmd`)
}

function windowsBatchQuote(value) {
  return `"${String(value)
    .replaceAll("%", "%%")
    .replaceAll("^", "^^")
    .replaceAll('"', '""')}"`
}

async function runSystemctl(args) {
  await run("systemctl", ["--user", ...args], {
    cwd: packageRoot,
    env: process.env,
    stdio: "inherit",
  })
}

async function runLaunchctl(args) {
  await run("launchctl", args, {
    cwd: packageRoot,
    env: process.env,
    stdio: "inherit",
  })
}

async function runSchtasks(args) {
  await run("schtasks.exe", args, {
    cwd: packageRoot,
    env: process.env,
    stdio: "inherit",
  })
}

async function runForever(args, options) {
  await run(options.foreverCommand ?? process.env.FOREVER_COMMAND ?? "forever", args, {
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
  await run(process.execPath, [
    join(packageRoot, "server/index.mjs"),
    ...(isDebugEnabled(env.XEDOC_DEBUG) ? ["--debug"] : []),
  ], {
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

function isDebugEnabled(value) {
  return /^(1|true|yes|on)$/iu.test(String(value ?? "").trim())
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
  --workspace-root <path>       File browser start directory. Defaults to your home directory.
  --accounts-home <path>        Codex account state directory. Defaults to ~/.xedoc/accounts.
  --history-home <path>         xedoc canonical chat history directory. Defaults to <home>/history.
  --shared-chat-home <path>     External Codex history sync directory. Defaults to ~/.codex.
  --skip-setup                  Do not create the SQLite database schema.
  --skip-prisma-generate        Do not regenerate Prisma Client.
  --debug                       Print Codex runtime debug logs for run failures.
  --codex-command <command>     Codex command used for new accounts.
  --codex-args <args>           Codex command arguments used for new accounts.
  --home <path>                 App data directory. Defaults to ~/.xedoc.
  --service-driver <driver>     auto, systemd, launchd, windows-task, or forever. Defaults to auto.
  --service-name <name>         Service name. Defaults to xedoc.
  --forever-command <command>   forever executable for --service-driver forever. Defaults to forever.
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

Service commands:
  install                       Install the background service and start it unless --no-start is set.
  uninstall                     Stop and remove the background service.

Options:
  --service-driver <driver>     auto, systemd, launchd, windows-task, or forever. Defaults to auto.
  --service-name <name>         Service name. Defaults to xedoc.
  --forever-command <command>   forever executable for --service-driver forever. Defaults to forever.
  --no-start                    Enable service without starting it during install.
  --port <port>                 Web server port. Defaults to 6354.
  --host <host>                 Web server host. Defaults to 127.0.0.1.
  --workspace-root <path>       File browser start directory. Defaults to your home directory.
  --accounts-home <path>        Codex account state directory. Defaults to ~/.xedoc/accounts.
  --history-home <path>         xedoc canonical chat history directory. Defaults to <home>/history.
  --shared-chat-home <path>     External Codex history sync directory. Defaults to ~/.codex.
  --home <path>                 App data directory. Defaults to ~/.xedoc.
  --skip-setup                  Do not create the SQLite database schema.
  --skip-prisma-generate        Do not regenerate Prisma Client.
  --debug                       Print Codex runtime debug logs for run failures.
`)
}
