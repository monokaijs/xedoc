# xedoc

xedoc is a single React Router Framework Mode app, built with Vite, for managing Codex accounts, chats, chat execution, workspace browsing, and live assistant output.

## What It Does

- Stores shared Codex accounts and per-thread preferences in xedoc SQLite; chat history stays in the root Codex store.
- Starts browser or device-code Codex account authentication through the local `codex app-server` JSON-RPC flow.
- Isolates each Codex account with a separate `CODEX_HOME` while sharing Codex chat sessions through the system Codex chat store.
- Stores a working directory on each chat so different chats can target different local projects.
- Executes chat prompts against the selected Codex account and reads settled chat lists/transcripts from the root Codex store.
- Serves the ChatGPT-style web UI and `/api/*` resource routes from one same-origin app.
- Streams live chat updates through authenticated Socket.IO rooms on `/socket.io`.

## Setup

The easiest local install is the npm CLI:

```bash
npx xedoc-cli
```

By default the CLI creates a SQLite database under the workspace root at
`<workspace-root>/.xedoc/xedoc.db`, prepares the schema, and serves the app at
`http://127.0.0.1:6354`. Open the app in a browser and set the server password
on first visit.

Common CLI options:

- `--port <port>` changes the web server port.
- `--workspace-root <path>` changes the directory tree visible to the app.
- `--accounts-home <path>` changes where Codex account state is stored.
- `--shared-chat-home <path>` changes where shared Codex chat sessions are stored.
- `--skip-setup` skips SQLite schema setup.

For repository development:

```bash
pnpm install
cp .env.example .env
pnpm prisma:generate
pnpm db:setup
pnpm dev
```

On first visit, the web app asks you to set the server password and stores a
hashed password plus token signing secret in the SQLite database. Later browser
sessions exchange that password for a bearer token, then store the token in
local storage. Authenticated sessions share the same local accounts and chats.

The SQLite database path is derived from `CODEX_WORKSPACE_ROOT` and is always
stored at `<workspace-root>/.xedoc/xedoc.db`.

## Scripts

- `pnpm dev` starts the React Router dev server.
- `pnpm build` builds the app.
- `pnpm start` serves the production React Router build through `server/index.mjs` and attaches Socket.IO.
- `pnpm db:setup` creates or updates the local SQLite schema.
- `pnpm prisma:generate` regenerates Prisma Client.
- `pnpm run publish` publishes the package to npm with public access. npm runs `prepack`, which builds the production bundle first.
- `pnpm run publish:dry-run` checks the npm package contents without publishing.

## npm Releases

Package releases are published by GitHub Actions when a tag matching `v*` is
pushed. The workflow uses npm trusted publishing, so configure the package on
npmjs.com with this GitHub repository and the workflow file
`.github/workflows/npm-publish.yml` before pushing the first release tag.

## Codex Account Isolation

Each Codex account runs as its own local `codex app-server` process. The server sets `CODEX_HOME` per account so auth files, config, cache, and other non-chat account state stay under:

```text
~/.xedoc/accounts/<accountId>
```

Codex chat data and personalization are centralized separately. By default,
each account home gets symlinks for `sessions/`, `session_index.jsonl`, Codex
`state_*.sqlite` chat state files, and `AGENTS.md` pointing at the system Codex
chat store:

```text
~/.codex
```

Set `CODEX_SHARED_CHAT_HOME` to change the shared chat store. Existing
per-account chat storage and non-empty personalization files are copied or
merged into the shared store when safe, then kept as timestamped
`.pre-shared-*` backups before the symlinks are created.

For existing installations, saved account homes are prepared when the app lists
accounts after upgrade. This migrates old per-account chat storage into the
shared store without changing each account's `auth.json` or other
account-specific files.

Set `CODEX_ACCOUNTS_HOME` to change the base directory. This isolates Codex account state only; Codex still runs as the same host user and can access whatever that user can access.

Set `CODEX_WORKSPACE_ROOT` to the directory the web app can browse for chat
working directories. Local development defaults to the current user's home
directory, for example `/home/ubuntu`.

## API Entry Points

- `GET /health`
- `GET /api/auth/status`
- `POST /api/auth/exchange`
- `GET /api/auth/session`
- `GET /api/accounts`
- `POST /api/accounts`
- `GET /api/accounts/:accountId`
- `PATCH /api/accounts/:accountId`
- `DELETE /api/accounts/:accountId`
- `POST /api/accounts/import-local-active`
- `POST /api/accounts/:accountId/local-active`
- `POST /api/accounts/:accountId/authenticate` with optional `{ "mode": "browser" | "device" }`
- `POST /api/accounts/:accountId/authenticate/callback`
- `GET /api/chats`
- `POST /api/chats`
- `GET /api/chats/:chatId`
- `PATCH /api/chats/:chatId`
- `DELETE /api/chats/:chatId`
- `GET /api/chats/:chatId/messages`
- `POST /api/chats/:chatId/messages`
- `GET /api/workspaces/directories`
