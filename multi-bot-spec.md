# Spec: Multi-Connection Registry for the Teams Bridge

## Goal

Support multiple saved Microsoft Teams relay connections, each mapped to one Copilot CLI session at a time.

## Design summary

- `extension.mjs` keeps the existing local queueing, pairing, lock-file, and Copilot session logic
- the Microsoft Teams-specific work moves into `relay/server.mjs`
- the extension now talks to the relay instead of talking directly to Telegram

## Why a relay exists

Telegram allows direct client polling. Microsoft Teams does not. Teams bots require a public HTTPS messaging endpoint, so the local Copilot extension now polls a relay service that receives Teams webhook traffic and exposes a small authenticated API back to the extension.

## Saved connection model

`bots.json` remains the shared local registry file, but each entry now stores relay credentials instead of a Telegram token.

Example:

```json
{
  "work": {
    "relayUrl": "https://copilot-teams-bridge.azurewebsites.net",
    "sharedSecret": "replace-me",
    "username": "Contoso Copilot",
    "addedAt": "2026-03-31T00:00:00.000Z"
  }
}
```

## Pairing model

`access.json` still holds pairing state, but the stored identifiers now represent paired Teams personal chats instead of Telegram user IDs.

## Commands

- `/teams setup <name>`
- `/teams connect <name>`
- `/teams connect`
- `/teams disconnect`
- `/teams status`
- `/teams remove <name>`

## v1 scope

This repository currently targets the smallest reliable Teams experience:

- personal chat
- text messages
- pairing code flow
- proactive replies from Copilot CLI back into Teams

Attachments and channel/group chat scenarios are intentionally deferred.
