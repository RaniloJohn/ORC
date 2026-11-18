# orc

A closed-loop orchestrator. A lead Claude model (Opus by default; Fable or any other Claude
model works) plans the work, writes the instructions and reviews the result. Gemini, through
the Antigravity CLI (`agy`), does the implementation. The loop itself is plain code, so the
attempt limit and the routing never depend on a model remembering them.

```
request -> PLAN (lead; it may ask you questions first) -> for each task:
    WORK ORDER (lead)
    EXECUTE (agy) -> VERIFY (your commands) -> REVIEW (lead)      up to 3 attempts
        pass -> commit, next task
        fail -> the lead rewrites the executor's instructions for the next attempt,
                asking you first when the fix depends on what you want
    after 3 fails -> ESCALATE: the lead does the task itself -> VERIFY -> REVIEW
        still failing -> stop and hand over to you
```

## Two modes

- **Closed loop** (default, for hard work): the loop above. Opus reviews every task and sends it
  back until it passes. Workers are told to read only the files they change and the files the
  work order names, once, and not to review the project themselves: Opus does the reviewing.
- **Open-ended**: Opus plans and writes each task's instructions, and that is all. One Hydrogen
  session (the chosen Hydrogen level, High by default) does every task in the same
  conversation, so it remembers the project between tasks. It can start its own sub-agents
  (agy's `invoke_subagent` and `swarm`), but only with Opus's approval: it stops before
  editing and asks with the split it wants, Opus approves, changes or rejects it in one short
  call, and Hydrogen then runs exactly what was approved (or does the task alone). A task that
  needs no sub-agents costs no extra call. Nothing is reviewed: each task is committed as soon as files change, your checks
  still run and any failures are listed, and you review the result yourself.

Pick it with **Mode** on the new-run form or in a run's settings, or `--mode open` in the terminal
(`mode` in `orc.config.json`).

## Questions and the plan check

The lead is told not to guess. Unless the request is a small change, it asks about every
decision with real consequences that the request leaves open (scope, stack, look, data, what
to do with existing code), offering likely options so you can answer quickly. It gets at most
two rounds of questions, and asking never uses up an attempt.

Before any work starts, orc shows you the plan and what the lead decided on its own. Approve it,
or say what to change and the lead revises it and shows it again. Turn this off with the
"Let me check the plan" box on the new-run form, or `--no-plan-check` in the terminal.

When no one is at the keyboard (output piped, a scheduled run, or `--no-questions`), the lead
decides for itself, lists what it assumed under the plan, and starts without the check.

## Requirements

- Node 22.18 or newer (runs the TypeScript sources directly; nothing to install or build)
- `claude` (Claude Code) signed in, and `agy` (Antigravity CLI) signed in
- `git` installed. You never have to run it: a project folder with no git gets set up
  automatically, your current files are recorded before each run, and passed work is put
  straight into the folder. In a git repository you already manage, orc leaves the result
  on a branch unless you pass `--merge`

Both models run on your subscriptions through their own CLIs. No API keys are used.

## Use: the GUI

Double-click `orc-ui.cmd` (or run `orc ui`). A page opens in your browser at
`http://127.0.0.1:47517/` (or the next free port; the window shows the address). Keep the small window that started it open while you work.

- **Project folder:** type a path or use Browse. An empty folder is fine.
- **New run:** describe what you want, pick the lead model, optionally add check commands.
- **While it runs:** the page shows what each model is doing right now, the plan, the
  instructions given to the executor, the files it changed, and each review.
- **Questions:** when the lead needs an answer, a form appears at the top of the run.
- **Stop / Continue:** Stop pauses the run; Continue picks it up where it stopped.
- **Switch the lead model and thinking level:** the run's header has Lead model and Thinking
  level menus. On a paused run the choice is used when you continue; on a run in progress it
  applies from the lead's next step. From the terminal: `orc resume --lead-model opus --lead-effort high`.
- **Message the lead:** while a run is going or paused, type into "Message the lead". It
  reaches the lead at its next step and shapes the instructions Argon gets next.
- **Pictures and files:** both the request box and "Message the lead" take attachments: use
  "Attach pictures or files", drag files onto the box, or paste a screenshot. They are saved
  with the run (up to 20 MB each, 50 MB in total). The lead opens them and names the ones
  Argon needs in its instructions; Argon can read them too. From the terminal:
  `orc run "..." --attach design.png --attach notes.pdf`.
- **Let Argon run commands:** off by default. Without it Argon can only write files (agy
  refuses every command in this mode). Turn it on when the work needs installs, builds or
  tests; Argon then runs commands on this computer without asking.
- **Empty attempts don't count:** if Argon finishes without changing any files, that run is
  not counted as an attempt and is not reviewed. After 3 empty runs in a row the run pauses.
- **Usage:** tokens per model for the run, and how much of your Claude limits is used.

The page uses no model tokens. It displays the log orc writes and passes your answers back.
It is served to this computer only.

## Use: the terminal

From this folder, or with this folder on your PATH:

```
orc run "Add JWT auth to the API" --repo D:\Projects\MyApp --verify "npm test"
orc resume --repo D:\Projects\MyApp
orc status --repo D:\Projects\MyApp
orc log 20261115-213000 --repo D:\Projects\MyApp
```

While a run is going it never touches your files. It works in its own copy under
`.orchestrator/worktrees/<run-id>` on a branch named `orc/<run-id>`, and commits a checkpoint
after every attempt. When a run passes, the result is brought into your folder (automatically
in folders orc set up, or with `--merge` in your own repositories). When it does not pass,
your folder is left as it was.

## Pausing and continuing

A run saves each step as it finishes and commits each piece of finished work. If it stops
partway (a usage limit on either account, an error, a closed window, or Ctrl+C) it ends as
`paused` and your folder is left untouched. Continue it from the same folder with:

```
orc resume
```

It picks the most recent paused run (or give a run id), throws away only the half-done edits
of the step that was interrupted, and carries on from there. Finished tasks are not redone,
the attempt count carries over, and a stop during review resumes at the review without
running the executor again. A run that stopped before its plan was finished plans again.

When the pause was a Claude usage limit, orc prints roughly when the 5-hour limit resets.

## Settings

Flags on `orc run`, or the same keys in `orc.config.json` in the target repository:

| Flag | Config key | Default | Meaning |
|---|---|---|---|
| `--lead-model` | `leadModel` | `opus` | Claude model for every lead role |
| `--architect-model`, `--reviewer-model`, `--escalation-model` | `leadModels` | none | Per-role override |
| `--executor-model` | `executorModel` | `gemini-pro-orchestrator-g1-pro` | agy model |
| `--max-attempts` | `maxAttempts` | `3` | Executor attempts before the lead takes over |
| `--verify` | `verifyCommands` | none | Checks run after every attempt |
| `--trust-lead-commands` | `allowArchitectCommands` | off | Also run check commands the lead proposes |
| `--executor-full-access` | `executorSkipPermissions` | off | Executor may run any tool unprompted |
| `--no-questions` | (flag only) | off | The lead never asks; it lists assumptions instead |

Example `orc.config.json`:

```json
{
  "leadModels": { "architect": "claude-fable-5-2", "reviewer": "opus" },
  "verifyCommands": ["npm test", "npm run lint"]
}
```

## Rules the code enforces

- The architect can only read files. The reviewer has no tools at all: the app hands it the
  diff, the changed files and the check results, so a review is one request. Only the
  escalation step lets the lead edit files.
- The reviewer is a separate conversation from the architect, started fresh for each task.
- Lead sessions run stripped: no connectors, no skills, and a short system prompt of their own
  (`src/lead-system-prompt.txt`). This keeps each request small.
- A failed verification command is always a fail, even if the reviewer says pass.
- A model reply that is not valid JSON in the expected shape is re-asked once, then the run stops.

## Where things are

| Path | What |
|---|---|
| `src/machine.ts` | The loop |
| `src/prompts.ts` | Every prompt sent to either model |
| `src/agents/claude.ts`, `src/agents/agy.ts` | The two CLI adapters |
| `src/git.ts`, `src/verify.ts` | Worktree handling and check commands |
| `src/runner.ts` | Starting and resuming runs; shared by the terminal and the GUI |
| `src/ui/server.ts`, `src/ui/page.html` | The local GUI |
| `<repo>/.orchestrator/runs/<run-id>/` | `events.jsonl`, `state.json`, work orders, diffs, verdicts |

## Tests

```
npm test
```

The tests drive the loop with scripted fake models, so they use no quota.

## Not built yet

Waiting out a limit and continuing automatically, token budgets, and early exit when an
attempt changes nothing.
