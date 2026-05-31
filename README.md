<div align="center">

# xedoc

**A local web workspace for running Codex across your projects, accounts, tasks, and file changes.**

[![npm](https://img.shields.io/npm/v/xedoc-cli?color=0b7285)](https://www.npmjs.com/package/xedoc-cli)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-339933)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-UNLICENSED-lightgrey)](./package.json)
[![Codex](https://img.shields.io/badge/powered%20by-Codex-111111)](https://www.npmjs.com/package/@openai/codex)

</div>

---

xedoc gives Codex a dedicated local control center in your browser. It keeps
Codex running on your machine while adding account management, project-aware
chats, live run tracking, workflow tasks, compact file-change status, and a
cleaner interface for day-to-day development work.

It is designed for people who use Codex often and want a reliable workspace
instead of juggling terminal sessions, account state, project folders, and
long-running runs manually.

## Contents

- [Why xedoc](#why-xedoc)
- [Features](#features)
- [Quick Start](#quick-start)
- [First Run](#first-run)
- [How It Fits Your Workflow](#how-it-fits-your-workflow)
- [Running in the Background](#running-in-the-background)
- [Configuration](#configuration)
- [Local Data](#local-data)
- [Troubleshooting](#troubleshooting)
- [Development](#development)

## Why xedoc

Codex is strongest when it can work directly in your local projects. xedoc adds
the workspace layer around that local runtime:

| Need | What xedoc provides |
| --- | --- |
| Work across multiple projects | Chats stay tied to working directories. |
| Use multiple Codex accounts | Account state is isolated and selectable per chat. |
| Track long-running work | Live messages, tool activity, task progress, and queued messages. |
| Review code edits clearly | Compact active-change status plus detailed timeline diffs. |
| Keep implementation organized | Plan mode and workflow tasks stay near the chat. |
| Avoid silent account failures | Invalidated accounts are surfaced and marked for re-authentication. |

## Features

### Browser Workspace, Local Runtime

Use Codex through a browser UI while Codex continues to run locally with access
to your local files and tools.

### Multi-Account Management

Add and authenticate Codex accounts, switch accounts per chat, set the active
local Codex account, and re-authenticate accounts when tokens expire or are
invalidated.

### Project-Aware Chats

Each chat can remember its working directory, account, model, reasoning effort,
service tier, collaboration mode, and permission mode.

### Live Run Tracking

Follow assistant output, tool activity, approval prompts, terminal activity,
queued messages, and run status without losing the thread.

### Compact File-Change Status

While Codex is editing files, xedoc shows a compact change summary above the
input. The full file-change details and diffs remain available in the timeline.

### Plan Mode and Tasks

Use Plan mode when you want Codex to break work into steps before implementation.
Active tasks can be collapsed above the input, and the workflow view helps keep
project tasks organized.

### Local Terminal Dock

Open a terminal in the selected working directory when you need to inspect,
verify, or run project commands without leaving xedoc.

## Quick Start

Run xedoc:

```bash
npx xedoc-cli
```

Open the printed local URL:

```text
http://127.0.0.1:6354
```

On first visit, xedoc asks you to set a server password. This protects the local
web UI from other browser sessions on the same machine.

## First Run

1. Open xedoc in your browser.
2. Add a Codex account from account management.
3. Authenticate with browser login or device login.
4. Choose a working directory for your chat.
5. Send your first message to Codex.

xedoc stores app data locally. Your code remains on your machine, and Codex runs
with the same local access as your user account.

## How It Fits Your Workflow

### Start a Project Chat

Create or open a chat, choose the project directory, select an account, and send
your request. xedoc keeps the chat attached to that directory for future runs.

### Guide Implementation

Use the composer to send follow-up instructions. If Codex is already running,
queue the next message so it is delivered when the active run completes.

### Review Active Work

Use the compact panels above the input for current state:

- Plan tasks show the current implementation checklist and can collapse.
- File changes stay compact while work is active.
- Queued messages show what will be sent next.

Use the timeline for full detail: transcript, tool activity, approvals, file
change blocks, and diffs.

### Recover from Account Issues

If an account becomes invalidated, xedoc marks it clearly and records the last
error. Re-authenticate the account from account management before using it again.

## Running in the Background

For regular use, install xedoc globally and run it as a background service:

```bash
npm install -g xedoc-cli
xedoc service install
```

Then open the local URL whenever you want to work.

Remove the background service:

```bash
xedoc service uninstall
```

## Configuration

Common options:

| Option | Purpose |
| --- | --- |
| `--port <port>` | Change the local web server port. |
| `--host <host>` | Change the local web server host. |
| `--workspace-root <path>` | Change which directories xedoc can browse. |
| `--accounts-home <path>` | Change where account authentication state is stored. |
| `--shared-chat-home <path>` | Change where Codex chat history is stored. |
| `--debug` | Print Codex runtime diagnostics for stuck runs and account failures. |

Examples:

```bash
xedoc --port 6354
xedoc --workspace-root ~/Projects
xedoc --debug
```

## Local Data

xedoc keeps its data on your machine:

| Data | Default location |
| --- | --- |
| App database | `<workspace-root>/.xedoc/xedoc.db` |
| Account state | `~/.xedoc/accounts` |
| Shared Codex chat history | `~/.codex` |

Each Codex account gets a separate account home. Chat history is shared so your
threads stay visible across accounts and other local Codex tools.

## Troubleshooting

### The app asks me to sign in again

The Codex account token was probably invalidated. Open account management and
authenticate the account again.

### A chat looks stuck

Restart xedoc first. If the problem repeats, run with debug logging:

```bash
xedoc --debug
```

Debug logs include Codex request failures, runtime exits, invalidation signals,
and other run-level diagnostics.

### Change the file browser start directory

xedoc opens the file browser at your home directory by default. You can type an
absolute project path in the picker, or choose a different start directory:

```bash
xedoc --workspace-root ~/Projects
```

### The browser cannot connect

Confirm xedoc is running and open the printed local URL. If you changed the
port, use that port in the browser address.

## Development

For contributors working on xedoc itself:

```bash
pnpm install
pnpm prisma:generate
pnpm db:setup
pnpm dev
```

Run type checking before submitting changes:

```bash
pnpm typecheck
```

## Notes

xedoc is a local-first tool. It does not make your local project files public,
but Codex runs with the permissions of your local user account. Choose working
directories and permission modes with that in mind.
