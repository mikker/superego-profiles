# run

One long-running dev command per folder (a server, a watcher), from the folder's `.superego/run.json`, run as a
process of Superego's bundled **Processes** extension: the folder's process named `run`, shared by the threads working
there. Processes runs it, shows it (the chip in the thread's header, the Processes pane), keeps it through Superego's
restarts and stops it with the folder's last thread. run only keeps the definition in step with the config, and adds
the keys and the agent's hint. It needs Processes on.

- **⌃R** (`run.restart`): start the folder's dev command, or restart it if it runs.
- `run.stop`, and `run.logs`: its output, in the Processes pane beside the thread.
- **The agent** uses Processes' `process_logs`, `process_restart`, … on the process `run`; a short prompt section says
  which process is the dev command and asks it not to start the server itself.
- It's `keep`: started again after the computer restarts, if it was running. It's `notify: 'failure'`: if it fails, the
  thread last active in the folder is woken.

## Config

```json
{ "command": ["just", "run"], "ready": "STATUS:READY", "grace": 5, "env": { "PORT": "3000" } }
```

| Key | |
|---|---|
| `command` | an argv array (quoted for you) or a shell string. Required |
| `ready` | text that marks it ready once it appears in the output. Without it, it counts as running as soon as it starts |
| `grace` | seconds between SIGTERM and SIGKILL when stopping. Default 5 |
| `env` | extra environment variables |

run looks for the file in the thread's folder, then in each folder above it, stopping at the repository root (the
first folder with `.git`). The command runs in the folder that holds `.superego/`, in your login shell. With no file,
the setting `run.command` (Settings → Run) is the default. With neither, ⌃R says how to add a config. A change to the
file is picked up as it's saved; a broken one is said in the thread working there, and ⌃R keeps the command it had.

## Files

`daemon.ts` (the definition, the actions, the prompt section), `config.ts` (reading `run.json`), `shared.ts`. Tests:
`run.test.ts`, against a stand-in for Processes. Run them with `superego extension test run --user`.
