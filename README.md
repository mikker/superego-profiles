# superego-profiles

Mikkel's [Superego](https://github.com/mikker/superego) profiles.

| Profile | What it is |
| --- | --- |
| `default` | The everyday agent, with the `run` pane for a folder's dev command and the Sentry and Paraframe MCP servers. |
| `chief-of-staff` | Leads a project's threads, with a board of what each is doing. |
| `obsidian` | Works in an Obsidian vault, with note, vault and graph panes. |

## Install

```sh
superego profile install git:github.com/mikker/superego-profiles
```

Each `profiles/<name>/` is a user profile. `superego profile types --user` links its `node_modules` to this
machine's Superego types.
