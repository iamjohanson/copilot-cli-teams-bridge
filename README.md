# Copilot CLI Teams Bridge

A GitHub Copilot CLI extension plus small relay service that lets you chat with one Copilot CLI session from Microsoft Teams personal chat.

## What changed from the Telegram version

Microsoft Teams bots cannot be polled directly like Telegram bots. This repo now uses:

- a local Copilot CLI extension that handles pairing, queueing, and session forwarding
- a small Teams relay service that receives Teams webhook traffic and exposes a simple authenticated bridge API back to the extension

## Current scope

This version is intentionally focused on the smallest reliable Teams experience:

- Microsoft Teams **personal chat** support
- text messages both ways
- pairing code confirmation
- typing indicator and tool-status updates
- multi-connection support inside Copilot CLI

Not included in v1:

- channel conversations
- group chats
- inbound file uploads
- outbound image/file delivery

## Repository layout

- `extension.mjs` - Copilot CLI extension with the `/teams` command
- `relay/server.mjs` - Teams relay service you host on a public HTTPS URL
- `skills/teams-install/SKILL.md` - install skill for the extension

## Prerequisites

- [GitHub Copilot CLI](https://github.com/github/copilot-cli) installed and working
- Extensions enabled in Copilot CLI
- A Microsoft 365 account that can upload or install a custom Teams app
- A Microsoft app registration and bot registration for Teams, even for local development or sideloading
- Node.js 18+

## Install the Copilot CLI extension

### Plugin install

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

### Manual install

1. Clone this repo.
2. Copy `extension.mjs` into your Copilot extensions directory:
   ```bash
   mkdir -p ~/.copilot/extensions/copilot-cli-teams-bridge
   cp extension.mjs ~/.copilot/extensions/copilot-cli-teams-bridge/
   ```
3. Restart Copilot CLI.

## Run the Teams relay service

1. Install dependencies:
   ```bash
   npm install
   ```
2. Set these environment variables anywhere you host the relay, including your local machine:

   - `MicrosoftAppId`
   - `MicrosoftAppPassword`
   - `BRIDGE_SHARED_SECRET`
   - `PUBLIC_BASE_URL`
   - optional: `TEAMS_BOT_NAME`

3. Start the relay:
   ```bash
   npm run relay:start
   ```
4. Open the relay home page in your browser. It shows:
    - whether the relay is fully configured
    - the Teams messaging endpoint you should use
    - the exact JSON format Copilot CLI expects during `/teams setup`

## Local-first development and Teams sideloading

You can absolutely run the relay on your own machine and sideload the Teams app while using the Copilot CLI extension locally. That is the lowest-friction development path for this repo.

What still does **not** go away:

- Teams still requires a **Microsoft App ID / bot registration**
- Teams still needs a **public HTTPS URL**
- sideloading the app does **not** remove those two requirements

The practical local workflow is:

1. Install this Copilot CLI extension locally.
2. Run the relay locally with `npm run relay:start`.
3. Expose the relay through a public HTTPS dev tunnel such as:
   - Visual Studio Dev Tunnels
   - ngrok
   - Cloudflare Tunnel
4. Set `PUBLIC_BASE_URL` to that tunnel URL.
5. In the Teams Developer Portal, create or update a personal bot app that uses your Microsoft App ID and points its messaging endpoint to:
   ```
   https://YOUR-TUNNEL-HOST/api/messages
   ```
6. Sideload that Teams app for yourself.
7. Send the Teams app one message so the relay stores your personal chat reference.
8. In Copilot CLI, run `/teams setup myteamsbot` and paste the tunnel URL plus the shared secret.

In other words: the Copilot CLI extension already covers the local Copilot side. The extra Teams-specific piece is just the bot registration plus a public HTTPS tunnel back to your local relay.

## Non-technical setup guide

These steps assume someone has already deployed the relay service from this repo for you.

### Part 1: Prepare the Teams app

1. Open the **Microsoft Teams Developer Portal**.
2. Create a **new app**.
3. In the **Bots** section, add a bot that uses your Azure Bot / Microsoft App ID.
4. Set the messaging endpoint to:
   ```
   https://YOUR-RELAY-HOST/api/messages
   ```
    Replace `YOUR-RELAY-HOST` with the same public URL you set in the relay's `PUBLIC_BASE_URL`.
    If you are hosting locally, this should be your dev tunnel URL, not `localhost`.
5. Turn on the **Personal** scope.
6. Save the app and install it for yourself in Teams.
7. Open the app in Teams and send it any short message like `hello`.

### Part 2: Connect Copilot CLI

1. In Copilot CLI, run:
   ```
   /teams setup myteamsbot
   ```
2. Paste a JSON block like this:
   ```json
   {
     "relayUrl": "https://YOUR-RELAY-HOST",
     "sharedSecret": "YOUR-BRIDGE-SHARED-SECRET"
   }
   ```
3. When Copilot CLI confirms the bridge was saved, run:
   ```
   /teams connect myteamsbot
   ```
4. Go back to Teams and send the bot any message.
5. The bot asks you to check Copilot CLI for a pairing code.
6. Copy the pairing code from Copilot CLI and send it back in Teams.
7. You are done. Messages now flow both ways.

### What the non-technical user should expect

- The first Teams message starts pairing.
- After pairing, Teams becomes a remote chat window for the connected Copilot CLI session.
- If you disconnect the CLI session, Teams receives a short disconnect message.

## Commands

| Command | Description |
|---|---|
| `/teams setup <name>` | Register a Teams relay connection with a local alias |
| `/teams connect <name>` | Connect this session to the named Teams bridge |
| `/teams connect` | List registered bridges |
| `/teams disconnect` | Disconnect from the current Teams bridge |
| `/teams status` | Show registered bridges and paired chat count |
| `/teams remove <name>` | Remove a saved Teams bridge |

## Multiple connections

You can register more than one Teams bridge with `/teams setup <name>`.

Each Copilot CLI session can connect to one saved bridge at a time, and the existing lock-file behavior still prevents two local sessions from using the same saved bridge at once.

## Troubleshooting

- **The Teams app does not answer** - make sure the Teams bot messaging endpoint is `https://YOUR-RELAY-HOST/api/messages`
- **`/teams setup` fails** - confirm the relay URL is public HTTPS, the shared secret matches `BRIDGE_SHARED_SECRET`, and the URL is your tunnel/public host rather than `localhost`
- **`/teams connect` fails** - open the relay home page and confirm it shows as configured
- **Pairing code expired** - send a new message in Teams to request a fresh code

## Security

The Copilot extension stores relay connection details, including the shared secret, in `bots.json` with restricted file permissions.

- Do not commit `bots.json`
- Do not share the relay secret broadly
- If the secret is exposed, generate a new `BRIDGE_SHARED_SECRET` and re-run `/teams setup`

The relay service stores Teams conversation references in `relay/.data/bridge-store.json` so it can proactively send replies back into Teams personal chat.
