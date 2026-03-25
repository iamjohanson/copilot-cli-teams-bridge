---
name: telegram-install
description: Install the Copilot CLI Telegram Bridge extension. Copies extension.mjs into the Copilot extensions directory.
---

# Telegram Bridge Installation Skill

Install the Telegram Bridge extension so the user gets a `/telegram` slash command for remote interaction via a Telegram bot.

## Agent behavior

- Be fast. Combine commands with `&&` where possible. Do not add unnecessary pauses or confirmations between steps.
- Copilot CLI blocks `$(...)` inside commands. You must run Step 1 first, read its output, then plug the literal paths into later steps.
- Skip steps that are already done (extension already installed). Only do what's needed.

## Step 1 -- Discover current state

```bash
H="${COPILOT_HOME:-$HOME/.copilot}" && echo "HOME=$H" && find "$H/installed-plugins" "$H/state/installed-plugins" -path "*/copilot-cli-telegram-bridge/extension.mjs" 2>/dev/null && echo "---EXT---" && ls "$H/extensions/copilot-cli-telegram-bridge/extension.mjs" 2>/dev/null
```

Read the output. Extract:
- COPILOT_HOME: the value printed after `HOME=`
- PLUGIN_SRC: the directory containing the found `extension.mjs` (strip the `/extension.mjs` suffix). May be empty if plugin not installed.
- ALREADY_INSTALLED: true if the `ls` after `---EXT---` found the extension in the extensions directory

**If ALREADY_INSTALLED is true**, skip to Step 3 (already set up).

**If no PLUGIN_SRC is found** (no extension.mjs in installed-plugins), stop and tell the user:
> The plugin is not installed yet. Run this first, then restart Copilot CLI and invoke this skill again:
> ```
> copilot plugin install examon/copilot-cli-telegram-bridge
> ```

## Step 2 -- Install extension (skip if ALREADY_INSTALLED)

Run this single command (replace COPILOT_HOME and PLUGIN_SRC with literal paths from Step 1):

```bash
EXT="COPILOT_HOME/extensions/copilot-cli-telegram-bridge" && mkdir -p "$EXT" && cp "PLUGIN_SRC/extension.mjs" "$EXT/extension.mjs" && chmod 644 "$EXT/extension.mjs" && ls -la "$EXT/extension.mjs" && echo "OK: extension installed"
```

If the command fails, report the error and stop.

## Step 3 -- Done

Tailor the message based on what happened:

**If extension was already installed** (skipped Step 2):
> Telegram Bridge is already installed. Nothing to do.
>
> - `/telegram setup <name>` -- register a bot
> - `/telegram connect <name>` -- start the bridge
> - `/telegram help` -- see all commands

**If installation was performed**:
> Telegram Bridge extension installed. Restart Copilot CLI to load it.
>
> After restart:
> - `/telegram setup <name>` -- register a bot
> - `/telegram connect <name>` -- start the bridge
> - `/telegram help` -- see all commands
