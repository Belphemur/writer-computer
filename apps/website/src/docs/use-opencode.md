# Use OpenCode in Writer

Writer's agent pane can chat with [OpenCode](https://opencode.ai) as well as Claude Code. Each chat has one agent, picked when you start it.

<!-- Facts are from SPECs/opencode-backend-spec.md and apps/desktop/features/opencode/. -->

## Requirements

- `opencode` 2.4 or newer, installed. Writer looks on your `PATH`, your login shell's `PATH` and the usual install folders. If it isn't found, the card in the pane has **Choose binary…**.
- A provider you signed in to once in a terminal: run `opencode auth login`. Writer never reads your credentials. With no login, a send fails with "Connect a provider".

With OpenCode missing or switched off, Writer looks and works as before.

## Start a chat

With two agents usable, the pane's empty state lets you pick one for the new chat. Settings > Agent > **Default agent** sets the one a new chat starts on. A chat keeps its agent.

## Writer's own OpenCode config

Writer runs its own OpenCode server with its own config. Your global OpenCode config, plugins, agents and MCP servers do not apply, and neither does a `opencode.json` or `.opencode/` folder in the vault. Writer adds its own tools (the note tools) and roles (an explorer and a worker). Your logins still work.

## Models

Settings > Agent > OpenCode lists the models your providers offer, with prices. Filter with All, Enabled and Free, or search. Switch a model off and it leaves the chat's model picker. Reasoning effort, when a model has levels, is in the chat's model chip.

Three tier models set what sub-agents and automatic chat titles use. Blank means the chat's own model.

## Permission modes

- **Ask before edit**: every edit, shell command and web fetch asks first. Reading is free.
- **Auto-edit files**: edits in the chat's own session go through; shell commands still ask.
- **Plan only**: read-only. The agent can read, search, look things up on the web and ask you questions. It writes nothing and runs no shell.

**Auto** and **Don't ask** ask like Ask before edit.

"Always allow" on a card saves an OpenCode rule for the vault's project. The same list is in Settings > Agent > OpenCode, where you can remove a rule.

## Limits

- A sub-agent's edits always ask, even in Auto-edit files.
- Approving a shell command approves anything your account can do: the agent's shell can read the server's password. Read each command.
- Rejecting a request ends the turn.
- Your own `agent.allowed-tools` and `agent.disallowed-tools` apply to Claude only.
- Effort levels none and minimal can't be picked.
- A skills folder that links outside the vault is left out.
- OpenCode keeps its own copy: chats appear in your other OpenCode clients, and saved rules and shell output stay in its data folder. Deleting a chat in Writer deletes its OpenCode session; archiving keeps it.
