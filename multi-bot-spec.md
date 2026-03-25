# Spec: Multi-Bot Registry for Telegram Bridge Extension

## Goal

Support multiple Telegram bots, each paired 1:1 with a different Copilot CLI session, managed by a single shared extension. Replace the current single-bot `.env`-based config with a named bot registry (`bots.json`). Each Copilot CLI session connects to a specific bot by local alias.

## Current State

The extension is a single-file ESM module (~1500 lines) at `extension.mjs`. It uses module-level globals throughout:

- **`botToken`** -- single token loaded from `.env` (`TELEGRAM_BOT_TOKEN=...`)
- **`session`** -- single Copilot CLI session from `joinSession()`
- **`access`** -- loaded from `access.json` (`{ allowedUsers: [...], pending: {} }`)
- **`state`** -- loaded from `state.json` (`{ offset: N }`)
- **`lock.json`** -- PID/session lock preventing two sessions from polling one bot

Each Copilot CLI process runs its own extension instance, so a given process only ever handles one bot. The globals are fine for single-bot-per-process. The problem is there's no way to register or select among multiple bots.

**File layout today:**
```
extension-dir/
  extension.mjs
  .env              # TELEGRAM_BOT_TOKEN=...
  access.json       # { allowedUsers: [...], pending: {} }
  state.json        # { offset: N }
  lock.json         # { pid, sessionId, connectedAt }
```

## Decisions

### 1. Registry model: shared `bots.json`
A single `bots.json` file in the extension directory holds all registered bots. Each bot has a local alias (user-chosen, short, memorable) and its Telegram token/username.

**Rationale:** Simple, one file to manage. Atomic read-modify-write with the existing `saveJsonAtomic` pattern is sufficient for concurrency (two sessions running setup simultaneously is rare, and last-write-wins is acceptable).

### 2. Local alias as bot identifier
The bot name used in commands (`/telegram connect johnny5`) is a local alias you choose, not the Telegram `@username`. The `@username` is stored in the registry for display purposes.

**Rationale:** Short, memorable names are easier to type. Different machines could alias the same bot differently.

### 3. Per-bot state directories
Each bot gets a subdirectory under `bots/` for its `state.json` (poll offset) and `lock.json` (session lock). This keeps per-bot state isolated and avoids concurrent write conflicts between sessions connected to different bots.

### 4. Shared access control
`access.json` stays as a single top-level file. Pairing with any bot grants access to all bots (global pairing).

**Rationale:** Single operator, single user. Per-bot ACLs would add complexity with no benefit. The pairing code flow stays the same -- the `pending` field tracks in-progress pairings regardless of which bot initiated them.

### 5. Clean break from `.env`
The `.env` file is no longer used. Tokens live in `bots.json`. No migration -- existing users must re-register their bot with `/telegram setup <name>`.

**Rationale:** User preference. Avoids maintaining backwards-compat code paths.

### 6. Token security
`bots.json` is `chmod 600` after every write (same protection as `.env` had).

### 7. Bot removal deletes state
`/telegram remove <name>` removes the bot from the registry AND deletes its `bots/<name>/` state directory.

### 8. `/telegram connect` without a name always lists bots
Even if only one bot is registered, running `/telegram connect` (no name) shows the list of available bots with their status. The user must always specify a name.

**Rationale:** Consistent behavior, no magic auto-selection.

### 9. Full session IDs in status output
When showing which session holds a bot's lock, display the full session UUID, not a truncated version.

## Technical Design

### New file layout

```
extension-dir/
  extension.mjs
  bots.json         # { "johnny5": { token, username, addedAt }, ... }
  access.json       # { allowedUsers: [...], pending: {} }  (shared across all bots)
  bots/
    johnny5/
      state.json    # { offset: N }
      lock.json     # { pid, sessionId, connectedAt }
    jarvis/
      state.json
      lock.json
```

### `bots.json` schema

```json
{
  "johnny5": {
    "token": "1234567890:AAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "username": "Johnny5bestBot",
    "addedAt": "2026-03-26T17:00:00.000Z"
  },
  "jarvis": {
    "token": "9999999999:BBxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "username": "JarvisBotDev",
    "addedAt": "2026-03-26T18:00:00.000Z"
  }
}
```

### Constants & paths

Replace the single-file constants:

```javascript
const BOTS_REGISTRY_PATH = join(EXT_DIR, "bots.json");
const BOTS_DIR = join(EXT_DIR, "bots");
// Per-bot paths derived at connect time:
// join(BOTS_DIR, botName, "state.json")
// join(BOTS_DIR, botName, "lock.json")
```

Remove:
- `ENV_PATH` constant
- `STATE_PATH` constant (replaced by `botStatePath(name)`)
- `LOCK_PATH` constant (replaced by `botLockPath(name)`)
- `loadEnv()` function
- `.env` file handling

### Command surface

| Command | Description |
|---|---|
| `/telegram setup <name>` | Register a new bot. Prompts for BotFather token. Validates the token via `getMe()`. Saves to `bots.json`. Creates `bots/<name>/` directory. |
| `/telegram connect <name>` | Connect this session to the named bot. Acquires per-bot lock. Starts poll loop. |
| `/telegram connect` (no name) | Lists all registered bots with their availability status. |
| `/telegram disconnect` | Disconnect from the currently connected bot. Releases lock. |
| `/telegram status` | Shows all registered bots, which are available/in-use, paired user count. |
| `/telegram remove <name>` | Remove a bot from registry. Deletes `bots/<name>/` directory. Fails if bot is currently connected (by any session). |
| `/telegram` or `/telegram help` | Shows available subcommands. This is the default when no recognized subcommand is given (same as current behavior). |

### `handleTelegramCommand` router changes

The router currently extracts only the subcommand (`args.trim().split(/\s+/)[0]`). It now also extracts the bot name (second token) and passes it to handlers that need it:

```javascript
const parts = args.trim().split(/\s+/);
const subcommand = parts[0]?.toLowerCase() || "help";
const botName = parts[1] || "";
```

Updated dispatch:
- `setup` -> `handleSetup(botName)`
- `connect` -> `handleConnect(botName, sessionId)`
- `remove` -> `handleRemove(botName, sessionId)`
- `disconnect` -> `handleDisconnect(sessionId)` (no name needed -- disconnects from current bot)
- `status` -> `handleStatus(sessionId)` (shows all bots)
- `help` / default -> show available subcommands including `remove`

The command description in `registerSlashCommand` updates to include `remove`: `"Telegram bridge: setup, connect, disconnect, status, remove"`.

### `handleSetup(name)` changes

```
1. Re-read bots.json into registry (see "Registry freshness" below)
2. If name is empty -> error: "Usage: /telegram setup <name>"
3. If name doesn't match /^[a-z0-9_-]+$/ -> error: "Bot name must be lowercase letters, numbers, hyphens, or underscores."
4. If name already exists in registry -> error: "Bot '<name>' already registered. Remove it first."
5. Set pendingSetupName = name
6. Prompt user for token (same BotFather instructions as today)
7. When token is received (via onUserPromptSubmitted hook):
   a. Validate token with getMe() -- if invalid, error and abort
   b. Save to bots.json: registry[name] = { token, username, addedAt }
   c. chmod 600 bots.json
   d. Create bots/<name>/ directory
   e. Log: "Bot registered as '<name>' (@<username>)"
```

### `handleConnect(name, sessionId)` changes

```
1. Re-read bots.json into registry (see "Registry freshness" below)
2. If name is empty -> list all bots with status (call listBots(sessionId))
3. If name not in registry -> error: "No bot named '<name>'. Run /telegram setup <name> first."
4. If already connected (to any bot) -> error: "Already connected to '<currentBotName>'. Disconnect first."
5. Read lock from bots/<name>/lock.json
6. If lock is held by another session and not stale -> error: "Bot '<name>' is in use by session <fullId>. Disconnect that session first."
7. Set botToken = registry[name].token, call getMe() to populate botInfo
   - If getMe() returns 401: clear botToken and botInfo, error: "Bot token is invalid or revoked. Re-register with `/telegram remove <name>` then `/telegram setup <name>`." Abort. Don't write lock.
   - If getMe() fails with network error/timeout: clear botToken and botInfo, error: "Failed to reach Telegram API. Check your network and try again." Abort. Don't write lock.
8. Ensure bots/<name>/ directory exists (mkdirSync with recursive: true)
9. Write lock to bots/<name>/lock.json
10. Set currentBotName = name, currentSessionId = sessionId
11. Reload access from access.json (may have changed since startup, e.g. pairing via another bot)
12. Load state from bots/<name>/state.json
13. Call setupEventHandlers(session) -- idempotent (only registers once via `eventHandlersRegistered` guard). Must be called during connect so event handlers are registered on first connect; subsequent connects skip it. The handlers check the `connected` flag, so they are no-ops while disconnected.
14. shutdownRequested = false, connected = true, start poll loop

Note on step 8: The directory is normally created during `/telegram setup` (step 7d), but connect creates it defensively in case it was deleted or this is a fresh clone with only `bots.json` present.

Note on step 13: `setupEventHandlers(session)` is currently called at line 1037 in `handleConnect`. The spec includes it explicitly because the handler registration is easy to overlook -- without it, event forwarding (assistant messages, tool call bubbles, typing indicators) silently doesn't work.

Note on step 14: `shutdownRequested` must be reset before starting the poll loop. After a `/telegram disconnect` (which sets `shutdownRequested = true` to break the previous poll loop), a subsequent connect would fail silently without this reset -- the poll loop's `while (!shutdownRequested)` would exit immediately. The current code already does this (line 1033), but it's called out explicitly here because the disconnect-then-reconnect-to-different-bot flow is a primary use case in the multi-bot design.
```

### `listBots(sessionId)` -- new function

Re-reads `bots.json` into `registry` (see "Registry freshness" below), iterates all entries, checks each bot's `lock.json` for availability. Uses `isLockStale()` to distinguish live locks from stale ones -- a bot whose owning process has died shows as available, not "in use". Compares the lock's `sessionId` against the passed `sessionId` to distinguish "connected, this session" from "in use by another session" (since `listBots` can be called while connected -- step 2 of `handleConnect` runs before the "already connected" check):

```
Available bots:
  johnny5  @Johnny5bestBot  (connected, this session)
  jarvis   @JarvisBotDev    (available)
  hal      @HalBot9000      (in use by session a3f2c1d0-7b8e-4f12-9c3d-5e6f7a8b9c0d)

Use: /telegram connect <name>
```

When the registry is empty (0 bots):
```
No bots registered. Use /telegram setup <name> to add one.
```

Full session UUID is shown (not truncated).

### `handleDisconnect(sessionId)` changes

Mostly the same, but:
- NEW: Saves state to `bots/<currentBotName>/state.json` on disconnect (currently state is only saved in the poll loop and SIGTERM handler -- disconnect doesn't save it)
- Releases lock at `bots/<currentBotName>/lock.json` (not top-level)
- NEW: Stops typing and dismisses the tool-call bubble before clearing `botToken`. `stopTyping()` itself only cancels timers (no API calls), but its interval callbacks send typing indicators via `enqueue` -- if the timer fires after `botToken` is cleared, those calls would fail. `dismissBubble()` makes direct API calls (`deleteMessage`) that require a valid token. In the current code, these are implicitly handled by `session.idle` firing after the disconnect command completes (`flushResponseFinal` -> `stopTyping` + `dismissBubble`). But the new design clears `botToken` during disconnect, so by the time `session.idle` fires, the token is null and bubble deletion API calls fail silently -- leaving orphaned bubble messages in Telegram. Moving the cleanup into disconnect, before clearing the token, avoids this.
- NEW: Clears `pendingResponse` and `seenMessageIds` (via `clearPendingResponse()`). Without this, stale accumulated text from the previous bot's interaction would leak into the first response sent after connecting to a different bot. The disconnect-then-reconnect-to-different-bot flow is a primary multi-bot use case, so this matters. Note: in the current single-bot code, `flushText()` inside `flushResponseFinal()` returns early when `connected` is false (line 841) and never reaches `clearPendingResponse()` (line 854), so this is already a latent issue -- multi-bot just makes it observable.
- Clears `botToken`, `botInfo`, `currentBotName`, `currentSessionId`, and `state`. These are now set at connect time, so they must be cleared on disconnect to avoid stale state. Clearing `state` is important because the SIGTERM handler guards its save with `if (state && currentBotName)` -- if `currentBotName` is cleared but `state` is not, the SIGTERM handler would silently skip the save (and without the guard, `join(BOTS_DIR, null, "state.json")` would throw a TypeError). Clearing `currentSessionId` is equally important because the SIGTERM handler's lock release guard depends on `currentBotName` -- if `currentSessionId` were left set while `currentBotName` is null, a stale `currentSessionId` could not be used for lock cleanup anyway (the lock path requires the bot name).

Ordering matters: goodbye messages and bubble dismissal make API calls that require a valid `botToken`, and typing stop cancels timer callbacks that would make API calls -- all must complete before the token is cleared. The full sequence is: `shutdownRequested = true` -> abort poll -> save state -> send goodbye messages -> stop typing -> dismiss bubble -> `connected = false` -> release lock -> clear pending response -> clear `botToken`, `botInfo`, `currentBotName`, `currentSessionId`, `state`.

### `handleStatus(sessionId)` changes

Re-reads `bots.json` into `registry` (see "Registry freshness" below), then shows all registered bots, using `isLockStale()` to distinguish live locks from stale ones (same as `listBots()`):

When 0 bots are registered:
```
No bots registered. Use /telegram setup <name> to add one.
```

When bots exist:
```
Registered bots:
  johnny5  @Johnny5bestBot  (connected, this session)
  jarvis   @JarvisBotDev    (available)
  hal      @HalBot9000      (in use by session f7e8d6c5-a1b2-4c3d-8e5f-6a7b8c9d0e1f)

Paired users: 1
```

### `handleRemove(name, sessionId)` -- new function

```
1. Re-read bots.json into registry (see "Registry freshness" below)
2. If name is empty -> error: "Usage: /telegram remove <name>"
3. If name not in registry -> error: "No bot named '<name>'."
4. Check lock at bots/<name>/lock.json
   - If held by this session and not stale -> error: "Bot '<name>' is connected to this session. Disconnect first."
   - If held by another session and not stale -> error: "Bot '<name>' is in use by session <fullId>. Disconnect that session first."
   - If lock is stale or absent -> proceed (safe to remove)
5. Delete registry[name] from bots.json, chmod 600
6. Delete bots/<name>/ directory recursively
7. Log: "Bot '<name>' removed."
```

### State management changes

The module-level variables stay mostly the same, with additions:

```javascript
let registry = {};          // NEW: loaded from bots.json at startup
let currentBotName = null;  // NEW: which bot this process is connected to
let pendingSetupName = null; // NEW: replaces awaitingSetupToken -- non-null means awaiting token for this bot name
// botToken, botInfo, session, access, state, connected, etc. stay as-is
```

Remove:
- `awaitingSetupToken` -- superseded by `pendingSetupName` (null = not awaiting, non-null = awaiting token for that bot name)

State and lock paths become dynamic:
```javascript
function botDir(name) { return join(BOTS_DIR, name); }
function botStatePath(name) { return join(botDir(name), "state.json"); }
function botLockPath(name) { return join(botDir(name), "lock.json"); }
```

**Registry freshness:** Unlike `access` and `state` (which are per-connection and loaded at connect time), `registry` is shared across sessions writing to the same `bots.json`. Every command handler (`handleSetup`, `handleConnect`, `handleRemove`, `handleStatus`, and `listBots`) re-reads `bots.json` from disk into `registry` before operating (each handler's pseudocode includes this as step 1). Without this, a long-running session would never see bots registered or removed by other sessions, and guards like "already registered" or "no bot named" would be ineffective across sessions. The `onUserPromptSubmitted` token-save path also re-reads before writing (read-modify-write) to minimize the window for lost updates.

### `main()` changes

```
1. Load bots.json (or empty {} if missing)
2. Load access.json (same as today)
3. Don't load botToken or call getMe() at startup -- that happens at connect time
4. Don't load state at startup -- state is per-bot, loaded from bots/<name>/state.json at connect time. The `state` variable stays undefined until a bot is connected.
5. joinSession() with updated onSessionStart hook
6. Register slash command
7. Log dormant status showing registered bot count
```

### `onSessionStart` hook changes

Re-reads `bots.json` into `registry`, then iterates all entries checking each bot's `lock.json` and using `isLockStale()` to determine availability (same logic as `listBots`). Shows all registered bots and their availability:

```
[Telegram Bridge Extension]
Extension directory: <EXT_DIR>
Status: <N> bot(s) registered. Use /telegram connect <name> to start.
Registry: <BOTS_REGISTRY_PATH>
Registered bots:
  johnny5  @Johnny5bestBot  (available)
  jarvis   @JarvisBotDev    (in use by session a3f2c1d0-7b8e-4f12-9c3d-5e6f7a8b9c0d)
Access control: <ACCESS_PATH>
README: <EXT_DIR>/README.md
```

When 0 bots are registered, the status line changes and the "Registered bots:" block is omitted entirely:
```
Status: No bots registered. Use /telegram setup <name> to add one.
```

### `onUserPromptSubmitted` hook changes

The token detection now needs to know the pending bot name:

The token detection gate changes from `awaitingSetupToken` (boolean) to `pendingSetupName` (string|null):

```javascript
// pendingSetupName is set by handleSetup(), cleared when token is received
// replaces the old awaitingSetupToken boolean
```

When a token-shaped string is detected and `pendingSetupName` is set:

1. Capture the pending name and clear `pendingSetupName` (consume the flag)
2. Return `{ modifiedPrompt }` telling the LLM the token is being validated (so it waits rather than acting on the raw token string, e.g. `"[Telegram Bridge: validating bot token for '<name>'... Please wait.]"`)
3. Fire an async validation in the background (the hook itself stays synchronous):
   - Call `getMe()` directly with the candidate token (do NOT modify the module-level `botToken` -- it may be in use by an active connection's poll loop). Use a standalone fetch against `https://api.telegram.org/bot<token>/getMe` instead of going through `callTelegram()`.
   - On success: re-read `bots.json` from disk into `registry` (time has passed since `/telegram setup` -- another session may have modified the registry), then save `registry[name] = { token, username, addedAt }` to `bots.json`, `chmod 600`, create `bots/<name>/` directory, log success via `session.log()` (e.g. `"Bot registered as '<name>' (@<username>)"`)
   - On failure: log error via `session.log()` (e.g. `"Invalid token. Make sure you copied it correctly from BotFather."`)

This replaces the current approach where the hook instructs the LLM agent to save the token to `.env`. The extension now handles validation and persistence directly, removing the LLM from the save path.

### SIGTERM handler changes

Same behavior, but:
- Save state to `bots/<currentBotName>/state.json` (not top-level), guarded with `if (state && currentBotName)` -- after disconnect, both are null so the guard prevents a TypeError from `join(BOTS_DIR, null, ...)`
- Release lock at `bots/<currentBotName>/lock.json`, guarded with `if (currentBotName)` -- the current code guards with `if (currentSessionId)`, but the new lock path depends on `currentBotName`, so the guard must check it. After disconnect, `currentBotName` is null so the SIGTERM handler correctly skips lock removal (disconnect already released it).

### Poll loop changes

One path change: the poll loop currently saves state to the top-level `STATE_PATH`. This changes to `botStatePath(currentBotName)`. Otherwise no structural changes -- the loop already operates on the module-level `botToken` and `state`, which are set correctly at connect time for the specific bot.

`readLock`/`writeLock`/`removeLock` need to accept a bot name and use `botLockPath(name)` instead of the top-level `LOCK_PATH`.

The 409 conflict message changes from "Type /telegram connect to reclaim" to "Type /telegram connect \<name\> to reclaim" since the user must now specify which bot.

The 409 conflict handler also needs multi-bot state cleanup (mirrors disconnect):
1. Save state to `bots/<currentBotName>/state.json` before clearing
2. Stop typing and dismiss the tool-call bubble (`stopTyping()` cancels timer callbacks; `dismissBubble()` makes delete API calls -- both need `botToken` to still be valid)
3. Set `connected = false`
4. Remove lock at `bots/<currentBotName>/lock.json`
5. Clear `pendingResponse` and `seenMessageIds` (via `clearPendingResponse()`)
6. Clear `botToken`, `botInfo`, `currentBotName`, `currentSessionId`, and `state`

Step 2 must happen before step 6 because `dismissBubble()` makes API calls that require `botToken`, and `stopTyping()` cancels timer callbacks that would use it. `clearPendingResponse` (step 5) comes after `connected = false` (step 3) so event handlers cannot re-accumulate stale text in the gap. Same ordering rationale as `handleDisconnect`.

Without this cleanup, `currentBotName` and `botToken` would remain pointing at the lost bot. While a subsequent `/telegram connect <other_bot>` would overwrite them, the inconsistent intermediate state could confuse the status display and SIGTERM handler.

### `telegram-install` skill changes

The install skill currently:
1. Copies `extension.mjs` to the live location
2. Sets up `.env` with the token

Updated behavior:
1. Copies `extension.mjs` to the live location (same)
2. No longer creates `.env`
3. Tells the user to restart Copilot CLI and run `/telegram setup <name>` to register a bot

This keeps the skill thin and the setup flow in one place (the extension's `/telegram setup` command).

### README.md changes

The README currently references `.env`-based setup (step 4: "the agent will save it to `.env`") and `/telegram setup` without a name argument. Update to reflect the multi-bot workflow:
- Replace `.env` references with `bots.json`
- Add `<name>` argument to `/telegram setup` and `/telegram connect` examples
- Mention that multiple bots can be registered

## Edge Cases & Error Handling

| Scenario | Behavior |
|---|---|
| `/telegram setup` with no name | Error: "Usage: /telegram setup \<name\>" |
| `/telegram setup <name>` where name exists | Error: "Bot '\<name\>' already registered. Remove it first." |
| `/telegram setup <name>` with invalid token | Error: "Invalid token. Make sure you copied it correctly from BotFather." Clear pending state. |
| `/telegram connect` with no name | List all bots with availability status |
| `/telegram connect <name>` where name not found | Error: "No bot named '\<name\>'. Run /telegram setup \<name\> first." |
| `/telegram connect <name>` when already connected | Error: "Already connected to '\<currentBotName\>'. Disconnect first." |
| `/telegram connect <name>` where bot is locked by another session | Error: "Bot '\<name\>' is in use by session \<fullId\>. Disconnect that session first." |
| `/telegram connect <name>` where bot is locked but lock is stale | Claim lock, connect normally (same as current stale-lock behavior) |
| `/telegram connect <name>` where token was revoked since setup | getMe() returns 401. Error: "Bot token is invalid or revoked. Re-register with `/telegram remove <name>` then `/telegram setup <name>`." Lock is not acquired. |
| `/telegram connect <name>` where Telegram API is unreachable | getMe() fails with network error/timeout. Error: "Failed to reach Telegram API. Check your network and try again." Lock is not acquired. |
| `/telegram remove` with no name | Error: "Usage: /telegram remove \<name\>" |
| `/telegram remove <name>` while bot is connected by this session | Error: "Bot '\<name\>' is connected to this session. Disconnect first." |
| `/telegram remove <name>` while bot is connected by another session | Error: "Bot '\<name\>' is in use by session \<fullId\>. Disconnect that session first." |
| `/telegram remove <name>` where name not found | Error: "No bot named '\<name\>'." |
| `bots.json` doesn't exist | Treated as empty registry `{}`. Created on first `/telegram setup`. |
| `bots/<name>/` directory doesn't exist at connect time | Created automatically |
| Bot name contains invalid filesystem characters | Restrict names to `[a-z0-9_-]`, error otherwise |
| Two sessions run `/telegram setup` concurrently for different bot names | Race window exists on `bots.json` read-modify-write. If the reads don't overlap with writes, both entries survive. If they do overlap, last-write-wins and the first entry may be lost. Acceptable given the rarity of concurrent setup. |
| Two sessions run `/telegram setup` for the same bot name | Second one gets "already registered" error (race window exists but is tiny and acceptable) |
| `/telegram setup <name2>` while awaiting token for `<name1>` | `pendingSetupName` is overwritten to `name2`. The pending setup for `name1` is silently abandoned. When the user pastes a token, it is assigned to `name2`. Same behavior as the current `awaitingSetupToken` boolean (running setup again just restarts the flow). |
| Old `.env` file exists from pre-migration setup | Ignored. The extension no longer reads `.env`. Users see 0 bots registered and must re-register with `/telegram setup <name>`. The orphaned `.env` can be manually deleted. |

## Constraints & Invariants

1. **One bot per process.** A Copilot CLI session can connect to at most one bot at a time.
2. **One session per bot.** The lock file prevents two sessions from polling the same bot (Telegram 409 conflict).
3. **Global access control.** `access.json` is shared. Pairing with any bot grants access to all bots.
4. **No `.env` dependency.** Tokens live exclusively in `bots.json`.
5. **Bot names are `[a-z0-9_-]` only.** Used as directory names.
6. **`bots.json` is `chmod 600`.** Contains secrets.
7. **Atomic writes.** All JSON file writes use `saveJsonAtomic` (write to `.tmp`, rename). Exception: the SIGTERM handler uses `writeFileSync` directly for maximum reliability during shutdown.
8. **Rate limiting invariant preserved.** All outbound Telegram message calls (`sendMessage`, `editMessageText`, `deleteMessage`, `sendChatAction`) still go through the `enqueue()` wrapper. Each process has its own send queue for its one connected bot. Read-only calls like `getMe()` and `getUpdates()` use `callTelegram()` directly. The standalone fetch in `onUserPromptSubmitted` (for token validation with a candidate token that isn't the module-level `botToken`) bypasses `callTelegram()` entirely -- this is safe because it's a single `getMe()` call, not a burst.

## Testing Strategy

### Manual verification (via tmux)

1. **Clean start:** Remove `bots.json`, `.env`, and `bots/` directory. Start Copilot CLI. Verify the extension loads with "No bots registered" message and directs user to `/telegram setup <name>`.

2. **Setup flow:**
   - Run `/telegram setup testbot`
   - Paste a valid BotFather token
   - Verify `bots.json` is created with the entry
   - Verify `bots/testbot/` directory exists
   - Verify `bots.json` permissions are 600

3. **Connect/disconnect:**
   - Run `/telegram connect testbot`
   - Verify lock is created at `bots/testbot/lock.json`
   - Send a message from Telegram, verify it reaches the agent
   - Verify agent responses appear in Telegram
   - Run `/telegram disconnect`
   - Verify lock is removed

4. **Multi-bot:**
   - Register two bots (`bot1`, `bot2`)
   - Start two Copilot CLI sessions
   - Connect session 1 to `bot1`, session 2 to `bot2`
   - Verify each bot independently routes messages to its own session
   - Verify `/telegram status` in either session shows both bots correctly

5. **Disconnect-reconnect to different bot:**
   - Register two bots (`bot1`, `bot2`), connect to `bot1`
   - Send a message, verify response arrives
   - Run `/telegram disconnect`, then `/telegram connect bot2`
   - Send a message via `bot2`, verify response arrives
   - Verify no stale text from `bot1`'s interaction leaks into `bot2`'s first response
   - Verify `bots/bot1/lock.json` is released and `bots/bot2/lock.json` is held

6. **Edge cases:**
   - Try connecting to a bot already held by another session
   - Try removing a connected bot
   - Try `/telegram connect` with no name -- verify listing
   - Try `/telegram setup` with a name that already exists
   - Kill a session, verify stale lock detection in another session
   - Run `/telegram setup badbot`, paste an invalid token -- verify "Invalid token" error and no entry in `bots.json`

7. **409 conflict handling:**
   - Connect session 1 to `bot1`
   - Start session 2, manually write a lock for `bot1` pointing at session 2's PID (or start a second poll loop by other means)
   - Verify session 1 receives the 409, logs the release warning, and cleans up (`connected = false`, lock removed, bot token cleared, no orphaned typing indicator or bubble)

8. **Pairing:**
   - Pair a Telegram user via one bot
   - Verify the user can also message the other bot (global access)

## Open Questions

None. All design decisions resolved during interview.
