---
name: teams-install
description: Install the Copilot CLI Teams Bridge extension. Copies extension.mjs into the Copilot extensions directory.
---

# Teams Bridge Installation Skill

Install the Teams Bridge extension so the user gets a `/teams` slash command for remote interaction via Microsoft Teams.

## Agent behavior

- Be fast. Combine commands with `&&` where possible. Do not add unnecessary pauses or confirmations between steps.
- Copilot CLI blocks `$(...)` inside commands. Run Step 1 first, read its output, then plug the literal paths into later steps.
- Skip steps that are already done. Only do what is needed.

## Step 1 -- Discover current state

```bash
H="${COPILOT_HOME:-$HOME/.copilot}" && echo "HOME=$H" && find "$H/installed-plugins" "$H/state/installed-plugins" -path "*/copilot-cli-teams-bridge/extension.mjs" 2>/dev/null && echo "---EXT---" && ls "$H/extensions/copilot-cli-teams-bridge/extension.mjs" 2>/dev/null
```

Read the output. Extract:
- `COPILOT_HOME`: the value printed after `HOME=`
- `PLUGIN_SRC`: the directory containing the found `extension.mjs`
- `ALREADY_INSTALLED`: true if the `ls` after `---EXT---` found the extension in the extensions directory

If `ALREADY_INSTALLED` is true, skip to Step 3.

If no `PLUGIN_SRC` is found, stop and tell the user:

> The plugin is not installed yet. Run this first, then restart Copilot CLI and invoke this skill again:
> ```
> copilot plugin install iamjohanson/copilot-cli-teams-bridge
> ```

## Step 2 -- Install extension

Run this single command, replacing `COPILOT_HOME` and `PLUGIN_SRC` with the literal paths from Step 1:

```bash
EXT="COPILOT_HOME/extensions/copilot-cli-teams-bridge" && mkdir -p "$EXT" && cp "PLUGIN_SRC/extension.mjs" "$EXT/extension.mjs" && chmod 644 "$EXT/extension.mjs" && ls -la "$EXT/extension.mjs" && echo "OK: extension installed"
```

If the command fails, report the error and stop.

## Step 3 -- Done

If the extension was already installed:

> Teams Bridge is already installed. Nothing else is required here.
>
> Next in Copilot CLI:
> - `/teams setup <name>`
> - `/teams connect <name>`
> - `/teams status`

If installation was performed:

> Teams Bridge extension installed. Restart Copilot CLI to load it.
>
> After restart:
> - `/teams setup <name>`
> - `/teams connect <name>`
> - `/teams status`
