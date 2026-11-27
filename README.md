# superego-profiles

Mikkel's [Superego](https://github.com/mikker/superego) profiles.

| Profile | What it is |
| --- | --- |
| `default` | The everyday agent, with the `tickets` pane for its tk tickets, and the Sentry and Paraframe MCP servers. |
| `chief-of-staff` | Leads a project's threads through managed worker lanes, with an action-first triage board (and tickets). |
| `chief-of-staff-worker` | Worker lane started by `chief-of-staff`: `default` without `thread-tools`, so lanes coordinate through the lead. |
| `obsidian` | Works in an Obsidian vault, with note and graph panes, and a Vault space (rail) listing the vault set in Settings → Obsidian vault. Global: threads not started in a vault start in that one. |
| `email` | Your Fastmail: a mail pane (Snailblaze's triage and rendering) and tools for the agent to read, triage and write email. Set the token in Settings → Email. |

## Install

```sh
superego profile install git:github.com/mikker/superego-profiles
```

Each `profiles/<name>/` is a user profile. `superego profile types --user` links its `node_modules` to this
machine's Superego types.
