# Copilot CLI Teams Bridge

Bridge one GitHub Copilot CLI session into **Microsoft Teams personal chat** using:

- a Copilot CLI extension (`extension.mjs`)
- a small Bot Framework relay (`relay/server.mjs`)
- a sideloadable Teams app package (`teams-app/`)

This README is written for a **technical setup owner** who wants to get the experience running locally, validate the end-to-end flow, and then harden it.

## Current recommendation

After reviewing the existing Teams branch and `tamirdresher/cli-tunnel`, the recommended first path is:

1. keep the **Bot Framework relay** for Teams traffic
2. use a **public HTTPS tunnel** for local validation
3. treat `cli-tunnel` as **tunnel/auth inspiration**, not as the first relay replacement

Why:

- Teams still needs a Bot Framework-compatible webhook at `/api/messages`
- the relay already stores Teams conversation references and supports proactive replies back into Teams
- `cli-tunnel` is built around browser/PTTY remoting, not Teams bot traffic
- the fastest validation path is to expose the existing relay through **Dev Tunnels** or another public HTTPS tunnel, then harden from there

## What is in this repo

| Path | Purpose |
|---|---|
| `extension.mjs` | Copilot CLI extension that adds `/teams setup`, `/teams connect`, `/teams status`, and `/teams disconnect` |
| `relay/server.mjs` | Local or hosted Teams relay backed by Bot Framework |
| `teams-app/manifest.json` | Teams app manifest wired to App ID `fec8c5b4-5a84-49ac-822c-238dd5147e86` |
| `teams-app/copilot-cli-teams-bridge.zip` | Ready-to-sideload Teams app package |
| `.env.example` | Relay environment template for local validation |
| `skills/teams-install/SKILL.md` | Copilot CLI install skill for the extension |

## What you already have

- **App ID:** `fec8c5b4-5a84-49ac-822c-238dd5147e86`
- **Tenant sideloading:** available

## What you still need before validation works

App ID alone is **not** enough. You still need:

1. a **client secret** for App ID `fec8c5b4-5a84-49ac-822c-238dd5147e86`
2. a valid **bot registration / Azure Bot configuration** behind that App ID
3. a **public HTTPS URL** that Teams can reach
4. the bot registration messaging endpoint set to:
   ```
   https://YOUR-PUBLIC-HOST/api/messages
   ```

## Technical quick start

### 1. Install the Copilot CLI extension

#### Plugin install

1. In Copilot CLI, run:
   ```
   /plugin install iamjohanson/copilot-cli-teams-bridge
   ```
2. Restart Copilot CLI.
3. Run:
   ```
   /copilot-cli-teams-bridge:teams-install
   ```
4. Restart Copilot CLI again.

#### Manual install

1. Clone this repo.
2. Copy `extension.mjs` into your Copilot extensions directory:
   ```bash
   mkdir -p ~/.copilot/extensions/copilot-cli-teams-bridge
   cp extension.mjs ~/.copilot/extensions/copilot-cli-teams-bridge/
   ```
3. Restart Copilot CLI.

### 2. Install the relay dependencies

```bash
npm install
```

### 3. Create your local relay config

Copy `.env.example` to `.env` and fill in the missing values:

```bash
cp .env.example .env
```

Required values:

| Variable | Value |
|---|---|
| `MicrosoftAppId` | `fec8c5b4-5a84-49ac-822c-238dd5147e86` |
| `MicrosoftAppPassword` | The client secret for that App ID |
| `BRIDGE_SHARED_SECRET` | A long random secret used between the CLI extension and the relay |
| `PUBLIC_BASE_URL` | Your public HTTPS URL or tunnel URL, no trailing slash |

### 4. Start the relay

```bash
npm run relay:start
```

Then open the relay home page locally:

```text
http://127.0.0.1:3978/
```

The page shows:

- relay readiness
- the Teams bot endpoint
- the bridge health endpoint
- the exact JSON block to paste into `/teams setup`

### 5. Expose the relay over HTTPS

For local validation, use **Microsoft Dev Tunnels** or another public HTTPS tunnel.

Recommended options:

- Microsoft Dev Tunnels
- ngrok
- Cloudflare Tunnel

Important:

- Teams cannot call `localhost`
- the public URL must forward back to your local relay
- `PUBLIC_BASE_URL` must match that public URL

## `cli-tunnel` evaluation

The `cli-tunnel` repo is useful for:

- its **Dev Tunnel-first** approach
- account-gated access patterns
- its stronger auth and session-hardening ideas

It is **not** the right first substitute for the Teams relay because this repo still needs:

- Bot Framework inbound activity handling
- Teams conversation reference storage
- proactive `sendActivity` / update / delete support

Practical recommendation:

- use the same **Dev Tunnel mindset** for local validation
- keep the existing Teams relay for message flow
- consider borrowing `cli-tunnel` auth ideas during hardening, after the core experience is working

## Teams app package

This repo now includes a starter Teams app package in `teams-app/`:

- `manifest.json`
- `color.png`
- `outline.png`
- `copilot-cli-teams-bridge.zip`

The manifest is prewired to App ID:

```text
fec8c5b4-5a84-49ac-822c-238dd5147e86
```

Current scope:

- **personal** chat only
- no channels
- no group chats
- no file handling

## Configure the Teams bot

In Azure Bot / Developer Portal / your existing bot registration:

1. use App ID `fec8c5b4-5a84-49ac-822c-238dd5147e86`
2. add or confirm the client secret
3. set the messaging endpoint to:
   ```
   https://YOUR-PUBLIC-HOST/api/messages
   ```
4. keep the app scoped to **personal** for the first validation

## Sideload the Teams app

1. In Teams, upload the package:
   - `teams-app/copilot-cli-teams-bridge.zip`
2. Install it for yourself.
3. Open the app in **personal chat**.
4. Send one message such as `hello`.

That first message allows the relay to store your conversation reference for proactive replies.

## Connect Copilot CLI to the relay

1. In Copilot CLI, run:
   ```
   /teams setup myteamsbot
   ```
2. Paste the JSON shown on the relay home page. It should look like:
   ```json
   {
     "relayUrl": "https://YOUR-PUBLIC-HOST",
     "sharedSecret": "YOUR-BRIDGE-SHARED-SECRET"
   }
   ```
3. Run:
   ```
   /teams connect myteamsbot
   ```
4. Go back to Teams and send another message.
5. Copy the pairing code shown in Copilot CLI back into Teams.

At that point, Teams should become a remote chat surface for the connected Copilot CLI session.

## Validation checklist

Use this checklist before debugging deeper issues:

### Relay

- `.env` is present and values are correct
- `npm run relay:start` succeeds
- `http://127.0.0.1:3978/` loads
- the relay page says **Ready for Teams traffic**
- `PUBLIC_BASE_URL` is the real public HTTPS URL

### Bot registration

- App ID is `fec8c5b4-5a84-49ac-822c-238dd5147e86`
- a client secret exists
- the messaging endpoint is `https://YOUR-PUBLIC-HOST/api/messages`

### Teams app

- `teams-app/copilot-cli-teams-bridge.zip` uploads successfully
- the app installs in **personal** scope
- you can open the app and send a message

### Copilot CLI

- the extension is installed
- `/teams setup <name>` accepts the relay JSON
- `/teams connect <name>` succeeds
- the pairing code round-trip works
- replies flow back into Teams

## Troubleshooting

- **Teams app installs but nothing reaches the relay**  
  Recheck the bot registration messaging endpoint and make sure the public URL is reachable from outside your machine.

- **Relay home page loads but says not configured**  
  Your `MicrosoftAppId`, `MicrosoftAppPassword`, or `BRIDGE_SHARED_SECRET` is missing or empty.

- **`/teams setup` fails**  
  Make sure `relayUrl` is the public relay base URL, not `/api/messages`, and that `sharedSecret` matches `BRIDGE_SHARED_SECRET`.

- **You can message the bot but pairing never finishes**  
  Confirm the first Teams message actually reached the relay and that the relay stored a conversation reference before you ran `/teams connect`.

- **App ID works in the manifest but messages still fail**  
  That usually means the App ID exists, but the client secret or bot registration path is incomplete.

## Security and hardening backlog

The current design is enough to validate the experience, but it should be hardened before broader use.

Recommended next steps:

1. replace or strengthen the raw shared-secret bridge auth
2. evaluate Dev Tunnel account-gated access versus a generic public tunnel
3. move secrets into a safer local and hosted configuration model
4. add rate limiting and clearer audit logging around relay endpoints
5. add tests for relay behavior, auth handling, and Teams packaging assumptions
6. document a production hosting path separately from local validation

## Repo status note

This branch now carries the Teams implementation files from `origin/copilot/update-telegram-to-teams` so the codebase matches the intended Teams architecture.
