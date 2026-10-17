<div align="center">

# effort-live-control

**Set each Claude Code sub-agent's reasoning effort per spawn with a tag, and let an opted-in agent's effort follow its own trouble while it works.**

[![Claude Code plugin](https://img.shields.io/badge/Claude%20Code-plugin-D97757)](https://docs.claude.com/en/docs/claude-code/plugins)
[![Version](https://img.shields.io/badge/version-0.4.0--dev.1-blue)](./CHANGELOG.md)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![Tests](https://img.shields.io/badge/tests-597%20passing-brightgreen)](#development)
[![Built with Professor](https://img.shields.io/badge/built%20with-Professor-8A2BE2)](https://github.com/rezzminator/professor)

</div>

```text
Agent({
  subagent_type: "general-purpose",
  prompt: "[effort: low]\nList every file under src/ that imports lodash."
})
```

<sup>The sub-agent runs its model requests at `low`, whatever the session's `/effort` says. A tag also wins over a definition's own `effort:` (`parentTag: ignore` pins the definition's). Two requests made on a sub-agent's behalf are not pinned ([How it works](#-how-it-works)).</sup>

## 🤔 Why

Claude Code lets you set effort for the session (`/effort`) and per agent type (`effort:` in an agent's frontmatter). Neither lets the model choose effort for one dispatch, and neither moves while an agent works. The Agent tool takes a `model`, but not an `effort`. An orchestrator that sends a grep-and-list job and an architecture review to the same agent type pays the same thinking budget for both, and an orchestrator stuck on a test that keeps failing thinks no harder than one waiting on a result.

With this plugin, the model that writes the dispatch also picks the effort, and an agent you mark with `effortControl` steps its own effort up when it is in trouble and back down when the trouble is over.

## 🚀 Quick start

Function hooks are experimental; turn them on first:

```bash
export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1
```

Then install:

```text
/plugin marketplace add rezzminator/effort-live-control
/plugin install effort-live-control@effort-live-control
```

The Agent tool's description now tells the model about the tag, so no prompt change is needed on your side. Live control is off until an agent definition asks for it ([Live control](#-live-control)).

It requires function hooks enabled (`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`) and is tested on Claude Code 2.1.283. To remove it:

```bash
claude plugin uninstall effort-live-control@effort-live-control
```

## 🧠 How it works

| Hook | What it does |
| --- | --- |
| `tool.describe` | Appends the tag's usage to the Agent tool's description. |
| `agent.spawn` | Reads the tag, the prompt's first non-blank text. An unknown level refuses the spawn, and the model sees why. A valid tag is removed from the prompt, so the sub-agent never sees it. Then reads the spawned type's definition: the tag pins, even over an `effort:` level the definition sets (a `tag` row says so); under `parentTag: ignore` that level pins instead and a `tag-ignored` row says so. The pin is recorded against the new sub-agent's id. A definition with `effortControl` on starts steering the agent. |
| `turn.step` | Leaves the main chat's requests untouched. Before each of a sub-agent's model requests, sets the request's `effort` to its pin: the tagged level, else the definition's level, or for an untagged sub-agent the effort of its first request. A steered agent gets its current live level instead. |
| `tool.call` | Reads a steered agent's own test runs, reads and messages; answers the `effort_up`, `effort_down` and `effort_auto` tools; carries a level change into the agent's next tool result. |
| `turn.complete` | When a sub-agent finishes, clears its pin and drops its steering state. A finished child's last answer is read as a return by its steered parent. A run that ends while the agent still runs, or waits on its own background work (a child agent, a backgrounded shell, a monitor), keeps both. |
| `session.start` | Registers the three button tools. |

- The tag counts only as the prompt's first non-blank text, written on one line. `[effort: high]` later in the prompt is ordinary prose, and a markdown link `[effort: high](…)` is not a tag.
- Levels are case-insensitive: `low`, `medium`, `high`, `xhigh`, `max`.
- A tag beats the definition's `effort:`: measured over 147 orchestrator runs, the effort the parent tags predicts trouble (18% of runs tagged medium struggled, 53% high, 77% xhigh), so the tag is kept. A steered agent starts at the tag held within its floor and ceiling (`tag` row: `tag`, `effort`, `home`, and `clamped` when the range moved it). `parentTag: ignore`, as the option or per type as `effortControl.parentTag`, keeps the definition's `effort:` instead: the tag is stripped, ignored and logged. A malformed tag still refuses the spawn, whatever the definition says.
- Every sub-agent is pinned. A tagged one runs at its tag (or, under `parentTag: ignore`, its definition's effort). An untagged one runs at the effort its first request carries (its frontmatter `effort:`, else the session's), so changing `/effort` mid-run never reaches a sub-agent already working.
- A pin lasts until the sub-agent finishes. Then it is cleared, and a continuation (SendMessage) is pinned afresh at its own first request, at the effort current then.
- The sub-agent reads its prompt without the tag. A prompt that is only a tag is refused.
- Pins are held by Claude Code for the session and survive a plugin reload. A sub-agent resumed in a new session runs unpinned, at its own effort. Steering state lives in memory: a reload ends it, and the agent goes on at its pin.
- A model that takes no effort setting (such as Haiku) is sent none, whatever the tag says.
- Two requests made on a sub-agent's behalf are not pinned. Its compaction forks are loops no spawn names, so they keep the effort they carry. The agent panel's progress line for a background sub-agent comes from a separate short request Claude Code sends about every 30 seconds (`agent_summary`); it passes through no plugin hook, so it carries the effort the sub-agent's definition declares, never its tag's. The sub-agent's own requests are pinned.
- The main chat is never steered here: its requests go at the effort they carry, and the buttons refuse it. Its effort belongs to [auto-effort](https://github.com/rezzminator/auto-effort).

## 🎚️ Live control

An agent definition turns it on with `effortControl`. Bare, `effortControl: on` (also `true` or `yes`; `off`, `false`, `no`) uses the option defaults. Nested, one level, it sets the agent's own range:

```markdown
---
name: lead
description: Coordinates a build across builder and lander sub-agents.
effort: medium
effortControl:
  floor: medium
  ceiling: xhigh
  landing: lander, reviewer
  judge: on
---
You coordinate the build. Spawn builders, check their returns, run the tests, then hand off to the lander.
```

| Key | Meaning |
| --- | --- |
| `effortControl.floor`, `effortControl.ceiling` | The range of levels the agent is ever sent (default: the options). |
| `effortControl.landing` | Agent types, separated by spaces or commas: spawning one lowers the agent one step below its home level. |
| `effortControl.judge` | `on` or `off`: ask the judge at a tripwire, or raise one step mechanically (default: the option). |
| `effortControl.tripwires` | The armed tripwires for this agent, comma-separated (`fail1`, `fail2`, `red`, `redispatch`; empty arms none), e.g. `red, redispatch` for an agent that writes its tests first (default: the option). |
| `effortControl.struggleDecay` | Requests without a new tripwire after which this agent's raised level comes home; `0` turns it off (default: the option). |
| `effortControl.parentTag` | `honor` or `ignore`: whether a tag beats this type's `effort:` (default: the option). Read even when steering is off, and it alone never turns steering on, so `effortControl:` holding only `parentTag: ignore` pins a type at its own `effort:` without steering it. |
| `effortControl.enabled` | `on` or `off`; on by default when any nested key other than `parentTag` is present. |

An invalid value is logged (`effort-live-control: {path} effortControl.{key} for {type} is invalid (…); using …`) and the default used. An agent whose definition has no `effortControl`, or has it off, is not steered; only the tag rules above apply to it.

A steered agent starts at its **home** level: its tag, else its definition's `effort:`, else the effort of its first request (a numeric effort leaves the agent unsteered); the home is held within floor..ceiling, so `[effort: low]` on a floor-`medium` agent starts at `medium`. Under `parentTag: ignore` the definition's `effort:` comes first. Every request is sent at its current level, held within floor..ceiling, on a model listed in `models`; any other model passes through untouched.

| Moment | What happens |
| --- | --- |
| The agent's own test run fails (the 1st failing run, the 2nd in a row, then every even count: 4th, 6th, …) | A **tripwire**: the level rises one step, or is judged when the judge is on. A test run is a foreground Bash call whose commands match `testCommandPatterns`: the patterns match only the commands a call runs, never a heredoc body, a search, an echo or another read-only program (`readOnlyCommands`), so a brief written with `cat <<'EOF'` that mentions `pytest` is not a test run; it fails when its result is an error or matches `failurePatterns`. |
| A sub-agent returns a red line (`FAIL`, `FAILED`, `BLOCKED`, `PARTIAL`, `SPEC-DRIFT` first on a line of its final answer, or in a file the agent reads: a `Read`, or a shell call that only runs read-only programs such as `cat`, never a program's output) | A tripwire, and that unit is marked red. A final answer counts on its token alone, in its first 15 lines, whatever follows (`DONE probe-unit (handoff skipped: no write tool)`); the unit is the name right after the token when a boundary follows it (the line's end, `.:,;!?)]`, or a space and a symbol such as `(`, `—` or a quote), else the child's type. A result the agent reads counts only as its first non-blank line, and only in that strict form: `DONE and dusted` is prose there. |
| The agent sends a message to a red child, or spawns a type that has a red child | A tripwire (the red result is being sent back). |
| A tripwire (one armed in `tripwires`; a disarmed one is only counted) | A struggle opens at the level the agent had outside trouble. With the judge off (the default), the level rises one step, up to the ceiling (`mechanical`). With it on, the judge is asked, detached: no request waits for it; requests go at the old level until it answers. A call already in flight for this struggle makes this tripwire a no-op (`judge-busy`); a call left over from a struggle that is over does not hold it: the level rises one step mechanically (`mechanical` with `busy: true`). |
| The judge answers | A probability at or above `judgeRaiseAt` raises the level one step, within the range; below it the level holds. The judge never lowers. A late answer for a closed struggle is dropped (`judge-stale`). |
| The judge times out, fails or answers off-format (no leading number from 0 to 100) | The level rises one step (`judge-failed`). |
| A test run passes and no unit is red, or a green return (`DONE`, `PASS`, `FIXED`) clears the last red unit | The struggle is **resolved**: the level returns to what it was before. A green return that names no open red unit closes the only open red of its own agent type, if there is exactly one. |
| `struggleDecay` requests of the agent's own (default 20) pass with no new tripwire | The struggle is **resolved** by decay: the level returns to what it was before, the open red units are cleared and the failure streak resets to 0. A later tripwire opens a new struggle from the level then in force. `0` turns decay off. |
| The agent spawns a `landing` type | Its resting level becomes one step below home, floored. |
| The agent presses `effort_up` or `effort_down` | One step, within the range; outside a struggle it also moves the resting level. The level is then **held**: no tripwire, judge answer or failure, resolution, decay or landing moves it. A tripwire is still counted and opens or keeps its struggle (a `tripwire` row with `held: true`), but asks no judge; every `judge`, `judge-failed`, `resolved` and `landing` row written while the level is held carries `held: true`, whether or not its rule would have moved the level. A press at a bound holds too. |
| The agent presses `effort_auto` | The hold ends: the level and the resting level go back to home (the agent's launch level: its definition's effort or its tag, else its first request's), held within the range, and an open struggle now resolves to home. The automatic rules steer again. Already at home, the answer says so, and the hold still ends. |
| The agent finishes | An `end` row summarises its requests by level, struggles and judge calls. |

**The judge** is off by default: with `judge: false`, every tripwire raises the effort one step. That is the measured better default. On 258 recorded tripwires from 147 orchestrator runs, a Haiku judge could not tell trouble that continues from trouble that ends (AUC 0.35 to 0.56 within each tripwire kind), and raising one step at every tripwire beat every judge variant on the replay loss (3 for a missed needed raise, 1 for an unneeded one): 0.283 against 0.517 for the best judge. Turn it on with the `judge` option, or per agent with `effortControl.judge: on`. When on, it is one `haiku` call per tripwire (`judgeModel`, `judgeEffort`, `judgeTimeoutMs`), 4000 tokens at most, and it estimates the probability that the trouble continues, starting from the rate measured for that tripwire kind: at or above `judgeRaiseAt` the effort rises one step, below it holds, and the judge never lowers it. It reads a snapshot of at most 2,500 characters: the agent's type, model, level and range, the tripwire, the opening 600 characters of its brief, its last 12 events (`test FAIL: …`, `return builder FAIL: …`, `sendmessage → …`, `spawn …`), the tail of the failing output or the head of the red return, and the tail of the agent's last words. It answers one line, `probability - reason`. Nothing else leaves the machine for the judge, and the snapshot is logged only with `logPackets`.

**The buttons** are three tools every agent sees, `effort_up`, `effort_down` and `effort_auto`, with no parameters. A steered agent moves its own level one step (or hears that it is already at the bound of its range), and that level holds until it calls `effort_auto`, which hands its effort back to the automatic rules at its home level. The main chat is refused with the name of its own effort control: the one tool of the session whose name ends in `set_effort`, to call with a level or `auto`, else (none listed, several, a name outside letters, digits, `_` and `-` up to 64 characters, or a tool list that fails or does not answer within 2 s) the user's `/effort`. Any other caller is refused. `buttons: false` registers none.

**Announcements** (`announce`): after any change of a steered agent's level, the agent's next tool result carries one line, `effort-live-control: your reasoning effort is now high — a failing test run.`, so the agent knows. A newer change replaces an undelivered one; a button press is answered by its own result instead.

## ⚙️ Options

Set under the plugin's settings, or in the environment variable named in the table: `EFFORT_LIVE_CONTROL_` and the option in upper snake case. A variable wins over the plugin's setting, which wins over the default. A variable that is unset or blank counts as not set. Write a boolean as `1`, `0`, `true` or `false` (any case); a number as the option takes it; a list as a JSON array of strings, e.g. `EFFORT_LIVE_CONTROL_MODELS='["claude-opus-5-5"]'`, with `[]` the empty list; any other value as the option's own text. A bad value is reported once at the first hook, by option name or by variable name, and the default used; a bad variable does not fall back to the plugin's setting.

| Option | Environment variable | Default | What it does |
| --- | --- | --- | --- |
| `floor` | `EFFORT_LIVE_CONTROL_FLOOR` | `medium` | Lowest effort a steered agent is sent. `effortControl.floor` overrides it. |
| `ceiling` | `EFFORT_LIVE_CONTROL_CEILING` | `xhigh` | Highest effort a steered agent is sent. `effortControl.ceiling` overrides it. |
| `parentTag` | `EFFORT_LIVE_CONTROL_PARENT_TAG` | `honor` | `honor`: a tag on the Agent prompt wins over the `effort:` of the agent's definition, and a steered agent starts at the tag held within its floor and ceiling. `ignore`: the definition's `effort:` keeps and the tag is ignored. `effortControl.parentTag` overrides it. |
| `models` | `EFFORT_LIVE_CONTROL_MODELS` | `claude-opus-5-5`<br>`claude-fable-5-1`<br>`claude-sonnet-5-5` | Model id prefixes that are steered; `claude-opus-5-5` also matches `claude-opus-5-5[1m]`. Any other model passes untouched. |
| `judge` | `EFFORT_LIVE_CONTROL_JUDGE` | `false` | Ask the judge at a tripwire; off raises one step mechanically. `effortControl.judge` overrides it. |
| `judgeRaiseAt` | `EFFORT_LIVE_CONTROL_JUDGE_RAISE_AT` | `25` | With the judge on: a probability (0 to 100) at or above this raises the effort one step; below it the effort holds. |
| `tripwires` | `EFFORT_LIVE_CONTROL_TRIPWIRES` | `fail1,fail2,red,redispatch` | The armed tripwires, comma-separated: `fail1` (the first failing test run), `fail2` (the 2nd in a row, then every even count), `red` (a sub-agent returned red), `redispatch` (a red result sent back). A disarmed one is still counted and read by the judge but raises nothing; an empty option arms none (a blank variable counts as unset). `effortControl.tripwires` overrides it. |
| `struggleDecay` | `EFFORT_LIVE_CONTROL_STRUGGLE_DECAY` | `20` | Requests a steered agent's raised effort may go without a new tripwire before it comes home: the struggle ends, and the open red returns and the failure streak are cleared. A later tripwire opens a new one. `0` turns it off. `effortControl.struggleDecay` overrides it. |
| `judgeModel` | `EFFORT_LIVE_CONTROL_JUDGE_MODEL` | `haiku` | The judge call's model. |
| `judgeEffort` | `EFFORT_LIVE_CONTROL_JUDGE_EFFORT` | `xhigh` | The judge call's own effort. |
| `judgeTimeoutMs` | `EFFORT_LIVE_CONTROL_JUDGE_TIMEOUT_MS` | `45000` | Milliseconds before an unanswered judge call is dropped and the effort rises one step. |
| `buttons` | `EFFORT_LIVE_CONTROL_BUTTONS` | `true` | Register the `effort_up`, `effort_down` and `effort_auto` tools. |
| `announce` | `EFFORT_LIVE_CONTROL_ANNOUNCE` | `true` | Tell a steered agent, in its next tool result, when its effort changes. |
| `testCommandPatterns` | `EFFORT_LIVE_CONTROL_TEST_COMMAND_PATTERNS` | `\bgo\s+(-C\s+\S+\s+)?test\b`<br>`\b(npm\|pnpm\|yarn\|bun)\s+(run\s+)?test\b`<br>`\bvitest\b`<br>`\bjest\b`<br>`\bpytest\b`<br>`\bpython(\d(\.\d+)?)?\s+-m\s+unittest\b`<br>`\bnode\s+(--test\|--test-only)\b`<br>`\bcargo\s+(test\|nextest)\b`<br>`\bmake\b[^;&\|\n]*?\b(test\|check\|verify)\b`<br>`\bjust\b[^;&\|\n]*?\b(test\|check)\b`<br>`\b(mvn\|gradle\|gradlew)\b[^;&\|\n]*?\btest\b`<br>`\bdotnet\s+test\b`<br>`\bdeno\s+test\b`<br>`\bswift\s+test\b`<br>`\bmix\s+test\b`<br>`\b(rspec\|phpunit\|ctest\|tox\|nox)\b`<br>`\bscripts?/test[\w.-]*\.sh\b` | Regular expressions (case-sensitive); a foreground Bash call is a test run when a command it runs matches any (never a heredoc body, see `readOnlyCommands`). |
| `readOnlyCommands` | `EFFORT_LIVE_CONTROL_READ_ONLY_COMMANDS` | `cat`<br>`grep`<br>`egrep`<br>`fgrep`<br>`rg`<br>`ag`<br>`ack`<br>`echo`<br>`printf`<br>`sed`<br>`awk`<br>`head`<br>`tail`<br>`less`<br>`more`<br>`ls`<br>`find`<br>`fd`<br>`git`<br>`wc`<br>`which`<br>`type`<br>`man`<br>`file`<br>`stat`<br>`diff`<br>`jq`<br>`yq`<br>`sort`<br>`uniq`<br>`cut`<br>`tr`<br>`tee`<br>`test`<br>`[`<br>`[[`<br>`cd`<br>`pushd`<br>`popd`<br>`mkdir`<br>`rm`<br>`cp`<br>`mv`<br>`touch`<br>`chmod`<br>`ln`<br>`basename`<br>`dirname`<br>`realpath`<br>`readlink`<br>`date`<br>`sleep`<br>`true`<br>`false`<br>`export`<br>`read`<br>`wait`<br>`kill` | Program names whose commands never count as a test run, whatever they mention: a search, a print, a read, a file operation. A command is split at `;`, `&`, `\|` and newline, and only the segments whose program is not listed are matched against `testCommandPatterns`. `source` and `.` are not listed, because they execute. A foreground Bash call whose every command is listed is also a file read, the only shell call a return line is read from. |
| `failurePatterns` | `EFFORT_LIVE_CONTROL_FAILURE_PATTERNS` | `--- FAIL`<br>`FAIL(ED)?`<br>`(?<!\d)[1-9]\d* (failed\|failing)`<br>`AssertionError`<br>`panic:`<br>`Traceback` | Regular expressions (case-sensitive); a test run whose result is an error or matches any fails. |
| `redWords` | `EFFORT_LIVE_CONTROL_RED_WORDS` | `FAIL`<br>`FAILED`<br>`BLOCKED`<br>`PARTIAL`<br>`SPEC-DRIFT` | Words that open a failed return line. |
| `greenWords` | `EFFORT_LIVE_CONTROL_GREEN_WORDS` | `DONE`<br>`PASS`<br>`FIXED` | Words that open a return line that clears an earlier red one. |
| `agentDirs` | `EFFORT_LIVE_CONTROL_AGENT_DIRS` | *(none)* | Extra directories searched for agent definitions, after the project, config and home `.claude/agents`. |
| `logFile` | `EFFORT_LIVE_CONTROL_LOG_FILE` | `~/.local/state/effort-live-control/decisions.jsonl` | The decision log, one file per session (session id before the extension); a leading `~` is your home directory; an empty option turns it off (a blank variable counts as unset). |
| `logPackets` | `EFFORT_LIVE_CONTROL_LOG_PACKETS` | `false` | Put the judge's snapshot and answer in its log rows. |

## 📜 Decision log

`logFile` holds one JSONL file per session, the newest 5,000 rows. Every row has `ts`, `event`, `agent` (an id, or `main`) and `type`. Rows: `step` for every steered request (`model`, `requested`, `sent`, `struggle`), `tag` (`tag`, `effort`; `home` and `clamped` for a steered agent), `tag-ignored`, `judge` (`tripwire`, `p`, `from`, `to`, `reason`, `ms`, `usage`), `judge-failed`, `judge-stale`, `judge-busy`, `mechanical` (`tripwire`, `from`, `to`; `busy` when it replaced a stale judge call), `resolved` (`from`, `to`, `requests`, `why`: `resolved` or `decay`), `landing`, `button` (`direction`, `from`, `to`), `auto` (`from`, `to`, `held`: whether a press held the level), `tripwire` (`tripwire`, `level`, `held`: a tripwire under a held level), `button-refused` (`direction`: `up`, `down` or `auto`), `model-gated`, `not-steered`, `end`, `plugin-log-failed` (`error`: a level-log append failed, once per failing streak), and option, tool-registration and resolution errors. No prompt, brief, reply or tool-result text is written, except the judge's `packet` and `answer` when `logPackets` is on.

## Logs

Errors, warnings and effort changes are also appended to `errors.jsonl`, `warnings.jsonl` and `info.jsonl` under `$PLUGIN_LOG_DIR/effort-live-control/`. Without `PLUGIN_LOG_DIR`, they use `$HOME/.local/state/effort-live-control/logs/`. Rows contain timestamps, event names, stable code locations and optional session ids; no prompt, transcript or tool-input bodies are added to these files, even with `logPackets` enabled.

Error-level diagnostics appear on screen and in the plugin log. Warning- and info-level diagnostics stay in the plugin log only. If no log directory resolves or a write fails, every unwritten warning and info message falls back to the screen; the logger's own failure notice remains visible, once per failing streak. Recoverable model fallbacks remain warnings; invalid settings and failures that disable pinning, steering, judgment, definition lookup, decision logging or tool registration are errors. Effort-change announcements in tool-result context, button replies and spawn refusals are product output, not diagnostics, and are unchanged.

Rows are capped at 4096 bytes. A level file over 20 MiB moves to `.1` and emits a `log-capped` warning. Directories and files are created privately. A failed append gives one screen notice and one `plugin-log-failed` decision row per failing streak, re-armed after a successful write, without changing the plugin's result. Appending needs the CLI's `$.process.run` and `/bin/sh`; when unavailable, the screen notice names the failure.

## ❓ FAQ

**Does it cost anything?** One host-state read per sub-agent request. A sub-agent's first request waits only while its own spawn is still returning; a loop no spawn names (the engine's compaction or memory forks) waits at most once, and never when no spawn is in flight. Live control adds nothing by default; with the judge on, one Haiku call per tripwire, never awaited.

**Does it survive compaction?** The pin does: it is kept per sub-agent id, not read from the transcript. A steered agent's state is in the plugin's memory and lasts until the agent finishes or the plugin reloads.

**Does changing effort break the prompt cache?** A level change is a change in the request's effort, which Claude Code may price as a cache miss for that agent's next request. A raise happens at a tripwire, not at random.

## 🛠️ Development

```bash
npm install
npm test               # vitest: the tag, definitions, signals, the controller, the judge and the hooks against a stand-in engine
npm run typecheck      # src and the hooks module against the plugin API types
npm run validate:plugin
```

A live run loads the checkout with `claude --plugin-dir plugins/effort-live-control`, with `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`.

| Module | Role |
| --- | --- |
| `src/effort.ts` | The tag parser, the deny texts, the description line, the per-request pin decision |
| `src/ladder.ts` | The five levels as a ladder: `step`, `clamp`, `isLevel` |
| `src/frontmatter.ts`, `src/agents.ts` | The definition reader: an agent type's `effort` and `effortControl` |
| `src/settings.ts` | The options, validated, with their defaults |
| `src/signals.ts` | Test runs, their outcome, file reads, and return lines |
| `src/control.ts` | The per-agent controller: levels, struggles, tripwires, buttons, announcements |
| `src/judge.ts` | The judge's prompt, the snapshot and the answer parser |
| `src/text.ts` | The texts the model reads from the buttons and announcements |
| `src/log.ts` | The decision log's file path and row cap |
| `src/plugin-log.ts` | The append-only level files, row cap and serialized writer |
| `hooks/effort-live-control.ts` | The adapter: the hooks, host state and the log, and the only file that touches `$` |
| `contract.d.ts` | The host-state contract: one pin per agent id |

## 🎓 Built with Professor

effort-live-control is built and maintained with [Professor](https://github.com/rezzminator/professor), a fleet controller and discipline layer for Claude Code, Codex and OpenCode: chats that message each other, agents held to the project's rules, and gated releases. This plugin came out of it: Professor's orchestrators choose an effort for every dispatch, and this plugin makes that choice apply.

## License

MIT

<sub>Keywords: Claude Code sub-agent effort · per-agent reasoning effort · subagent thinking budget · Agent tool effort parameter · output_config effort · live effort control · Claude Code plugin · function hooks · Claude Mods · multi-agent orchestration token cost</sub>
