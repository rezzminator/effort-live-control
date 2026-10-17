# Changelog

Every release of effort-live-control (named agent-effort through 0.1.3). Versions follow [semantic versioning](https://semver.org); each release is the `main` commit tagged `effort-live-control--v<version>` (`agent-effort--v<version>` through 0.1.3), with a GitHub release carrying the section below.

## [Unreleased]

### Removed
- Main-chat steering, end to end: this plugin now steers sub-agents only. The main chat's requests always go at the effort they carry, and `effort_up`, `effort_down` and `effort_auto` refuse it, naming its own effort control (the session's `set_effort` tool, else `/effort`) — what `mainChat: off` did before. The prompt reader, its casebook (the bundled one included) and the main chat's tripwires are gone, with the `prompt.submit` and `turn.start` hooks and the `prompt`, `reader-timeout`, `reader-failed`, `reader-unparsed`, `reader-gated` and main-chat `step` log rows. Reason: the default `mainChat: reader` overwrote the level another main-chat steerer had set; the main chat belongs to [auto-effort](https://github.com/rezzminator/auto-effort).
- The options `mainChat`, `casebookFile`, `promptModel`, `promptEffort` and `promptTimeoutMs`, and their variables `EFFORT_LIVE_CONTROL_MAIN_CHAT`, `EFFORT_LIVE_CONTROL_CASEBOOK_FILE`, `EFFORT_LIVE_CONTROL_PROMPT_MODEL`, `EFFORT_LIVE_CONTROL_PROMPT_EFFORT` and `EFFORT_LIVE_CONTROL_PROMPT_TIMEOUT_MS`. Migration: delete `pluginConfigs["effort-live-control@…"].options.mainChat` (and `casebookFile`, `promptModel`, `promptEffort`, `promptTimeoutMs`) from `settings.json`, and unset those variables; use auto-effort to steer the main chat. A casebook file at `~/.local/state/effort-live-control/casebook.jsonl` is no longer read and can be deleted.

## [0.3.6-dev.2] — 2026-10-17

### Fixed
- Error diagnostics reach the screen and plugin log; warnings and routine effort-change diagnostics go only to the plugin log while it works. If no directory resolves or writes fail, every unwritten warning and info message falls back to the screen, including later failures in the same streak. The logger's own failure notice stays visible.
- Invalid settings and failures that prevent pinning, steering, judgment, definition lookup, decision logging or tool registration are errors rather than warnings. Recoverable casebook and model fallbacks remain warnings. Model-facing effort announcements, button replies and spawn refusals are unchanged.

## [0.3.6-dev.1] — 2026-10-17

### Added
- `effort_auto`, a third button beside `effort_up` and `effort_down` (registered under the same `buttons` option): it hands the caller's effort back to the automatic rules at its home level — its launch level (definition effort or tag, else its first request's), or the main chat's turn home — held within its range; an open struggle then resolves to that level.

### Changed
- A level set with `effort_up` or `effort_down` now holds: no tripwire, judge answer or failure, resolution, decay, landing step or new main-chat turn moves it until `effort_auto`. A tripwire under the hold is still counted (a `tripwire` row with `held: true`) but asks no judge. A press at a bound holds too and is logged as a `button` row.
- The main chat, where this plugin does not steer it, is refused with the name of its own effort control — the one session tool ending in `set_effort`, to call with a level or `auto`, else (none, several, a name that is not a tool name, or a tool list that fails or does not answer within 2 s) the user's `/effort` — instead of the sub-agent text about `effortControl`.
- A press answers for itself: a level-change line an automatic rule left undelivered is dropped, so the next tool result never names a level the agent no longer has. While the agent's last request went to a model outside `models`, each button's answer says the level applies once a steered model answers; while it carried no effort level, that the level applies once a request carries one.

## [0.3.5] — 2026-10-16

### Added
- Every option can be set by an environment variable, `EFFORT_LIVE_CONTROL_` and the option name in upper snake case (`EFFORT_LIVE_CONTROL_JUDGE_RAISE_AT` for `judgeRaiseAt`). Precedence: the variable, then the plugin's setting, then the default. A boolean is `1`, `0`, `true` or `false`; a list is a JSON array of strings; an unset or blank variable counts as not set. A bad value is reported by variable name at the first hook and the default is used (a bad variable does not fall back to the plugin's setting). The README options table gains the variable column.

## [0.3.4] — 2026-10-15

### Fixed
- The plugin level log now writes on macOS: its append script no longer passes `--` to `chmod`, which BSD `chmod` reads as a file name and fails on under `set -eu`, so every flush was dropped. A log directory that starts with a dash is handled as a `./` path instead. The regression tests run the script behind a BSD-style `chmod` shim, so the Linux suite catches it too.
- A failed plugin-log write also reaches the decision log (event `plugin-log-failed`, once per failing streak), not only the screen.

## [0.3.3] — 2026-10-15

### Fixed
- The default Haiku judge and prompt reader retry on the session's own model when the organization denies the default; an explicit non-default choice stays authoritative, and both routes denied degrades visibly once.

## [0.3.2] — 2026-10-15

### Fixed
- Queue diagnostic rows before screen notices so an unavailable screen cannot swallow the level log.

## [0.3.1] — 2026-10-15

### Fixed
- Plugin log writes support macOS, including hyphen-leading relative log roots.

## [0.3.0] — 2026-10-14

### Added
- Append-only error, warning and info JSONL files under `PLUGIN_LOG_DIR/effort-live-control`, falling back to `$HOME/.local/state/effort-live-control/logs`. The writer adds stable event locations, private creation modes, a 4096-byte row cap and rename-aside rotation over 20 MiB. Failed writes report once per failing streak without affecting effort control; existing notices and decision logs stay unchanged.
- Unreadable pins and unavailable judges are visible as warning rows. Applied effort changes are info rows, without prompt, transcript or tool-input bodies.

## [0.2.0] — 2026-10-12

### Added
- The `struggleDecay` option (a whole number from 0, default 20) and the per-agent `effortControl.struggleDecay`: a steered agent's raised level comes home once it has made that many requests without a new tripwire, clearing the red sub-agent returns still open and the failure streak, and a later tripwire opens a new struggle; `0` turns it off, and the main chat decays too. The `resolved` log row gains `why` (`decay`, or `resolved` for an ordinary resolution). Why, measured over 147 orchestrator runs (313 replayed struggles): 49% of all raised requests came after a struggle's last tripwire, and 15% of struggles never resolved, 31 of those 47 held open only by a red sub-agent return no green ever cleared; a decay of 20 cuts 14 of 313 struggles early (the next tripwire re-opens them) and none of the landers' struggles over 131 lander runs.
- The main chat is steered too, by the new `mainChat` option (`off`, `tripwires` or `reader`, default `reader`). With `reader`, one Haiku call per new prompt (`promptModel`, `promptEffort`, `promptTimeoutMs`) reads the message, the end of the previous reply and precedents from a casebook of past turns (`casebookFile`, JSONL) and sets the turn's level, held within `floor` and `ceiling`; a timeout, error or unparsable answer leaves the level at what `/effort` asks, and the log says why. Mid-turn the main chat has the tripwires of a steered agent (its own failing test runs, a sub-agent's red return), the `effort_up` and `effort_down` buttons work for it, and `tripwires` mode skips the reader. Why, measured on 272 labelled prompts of one user's work: picking the level from design or architecture words did worse than always-high (average loss 0.743 and 0.790 against 0.710, lower is better), the reader scored 0.513 with no casebook. Do not enable auto-effort at the same time. `mainChat: off` restores the old behaviour.
- The default `testCommandPatterns` count `python -m unittest` (also `python3`, `python3.14`) and `node --test` (also `--test-only`) as test runs.
- The `tripwires` option (default `fail1,fail2,red,redispatch`) and the per-agent `effortControl.tripwires`: a comma list of the armed tripwires, empty arms none; a disarmed one is still counted but opens no struggle and raises nothing. Why, measured over 147 orchestrator runs: the first-failure tripwire raises 18.3% of requests above home against 9.8% without it, and covers 92.3% of struggle requests against 78.0%, so an agent that writes its tests first may turn `fail1` off.
- The `judgeRaiseAt` option (0 to 100, default 25): with the judge on, a probability at or above it raises the effort one step; below it the effort holds. The judge never lowers.
- Live effort control. An agent definition with `effortControl` (bare `on`, or nested `floor`, `ceiling`, `landing`, `judge`, `enabled`) is steered: its requests go at a level that rises at a tripwire (its own test run failing, a sub-agent returning `FAIL`, `FAILED`, `BLOCKED`, `PARTIAL` or `SPEC-DRIFT`, a red result sent back to a sub-task) and returns to the level it had once a test run passes and no unit is red. With the judge on, one Haiku call per tripwire (never awaited, so no request waits) estimates the probability that the trouble continues; a call that times out, fails or answers off-format raises one step instead.
- The `effort_up` and `effort_down` tools: a steered agent moves its own effort one step within its range; any other caller is refused.
- The agent is told of each change in its next tool result (`announce`).
- A landing step: spawning a type listed in `effortControl.landing` lowers the agent one step below its home level.
- Twenty-six plugin options (`floor`, `ceiling`, `parentTag`, `models`, `judge`, `judgeRaiseAt`, `tripwires`, `struggleDecay`, `judgeModel`, `judgeEffort`, `judgeTimeoutMs`, `mainChat`, `casebookFile`, `promptModel`, `promptEffort`, `promptTimeoutMs`, `buttons`, `announce`, `testCommandPatterns`, `readOnlyCommands`, `failurePatterns`, `redWords`, `greenWords`, `agentDirs`, `logFile`, `logPackets`) and a per-session JSONL decision log, with no prompt or tool-result text unless `logPackets` is on.

### Fixed
- The hooks module passes Claude Code 2.1.283's strict validation: no local binding shares the name of the `start` function that receives `$`, which that validator read as a second declaration.
- The read channel reads only reads: a return line is taken from a `Read`, or from a foreground shell call whose every command is a `readOnlyCommands` program (`cat`, `head`, `sed -n`), never from the output of a program, and a call that runs nothing is not a read. Why, in one live flight: a lander ran a static-check script whose first output line was `FAIL fmt …`, the channel took it as a red return of a unit named `fmt`, no child of that name ever returns green, and the lander ran at its ceiling for its last 38 requests.
- A test run is what a command runs, never what it mentions. Patterns used to match the whole command string; they now match only the commands a call runs (heredoc bodies and comments dropped, the call split at `;`, `&`, `|` and newlines, the commands inside `$( )` and backticks counted, `command -v` lookups and `for`/`select`/`case` headers skipped, programs listed in the new `readOnlyCommands` option skipped). Why, measured over 9,703 recorded shell calls of 147 orchestrator runs: 254 calls that only mentioned a test command (162 heredoc bodies written to files, 53 file reads, 25 searches, 14 echoes) counted as test runs, 37 of them landed as a pass while a failure streak was open and each reset it, bringing the effort home mid-trouble, and 25 more started or extended a false streak; parsing only the segments a call runs cuts all 254 and adds none.
- A sub-agent's final answer such as `DONE probe-unit (handoff skipped: no write tool)` is a return line again (the token alone counts; the unit is read when a boundary follows it), and a green return naming no open red closes the only open red of its own agent type, so a struggle no longer stays open through the landing at a raised effort.
- A tripwire that arrives while a judge call for an already closed struggle is still in flight raises one step mechanically (`mechanical` row with `busy: true`) instead of being swallowed as `judge-busy`; the stale answer is still dropped.

### Changed
- The prompt reader uses a small invented casebook shipped with the plugin (36 made-up turns, 12 per level) while `casebookFile` is missing or unreadable (an unreadable file is still reported in the log and in the row); your own file replaces it and an existing empty file turns the casebook off. The `prompt` log row gains `casebookSource` (`file` or `bundled`). Why, measured on 272 labelled prompts of one user's work: loss 0.478 with the invented casebook against 0.513 with none (lower is better, two runs each; always-high 0.710).
- A valid `[effort: …]` tag wins over the `effort:` a type's definition sets, and a steered agent starts at the tag held within its floor and ceiling (a `tag` row records it, with `clamped` when the range moved it). Why, measured over 147 orchestrator runs: the effort the parent tagged predicts trouble (18% of runs tagged medium struggled, 53% high, 77% xhigh). To keep the old behaviour set the new `parentTag` option to `ignore`, or `effortControl.parentTag: ignore` in one agent's definition, which pins that type at its own `effort:` even with steering off. A malformed tag still refuses the spawn. The Agent tool's description follows the option.
- The first failing test run is a tripwire: it raises the effort one step (kind `fail1`, announced as `a failing test run`); the 2nd in a row and every even count after it still fire (kind `fail2`).
- The judge is off by default (`judge` is `false`), so every tripwire raises one step, up to the ceiling, and logs its kind. Why, measured: on 258 recorded tripwires from 147 orchestrator runs, a Haiku judge could not tell trouble that continues from trouble that ends (AUC 0.35 to 0.56 within each tripwire kind), and raising one step at every tripwire beat every judge variant on the replay loss (3 for a missed needed raise, 1 for an unneeded one): 0.283 against 0.517 for the best judge. `judge: true`, or `effortControl.judge: on` for one agent, turns it back on; its prompt now asks for a probability, not a level, and its `judge` log row carries `p`.
- Renamed from agent-effort to effort-live-control. Migration: uninstall `agent-effort@agent-effort`, install `effort-live-control@effort-live-control` (`/plugin marketplace add rezzminator/effort-live-control`). The host-state key changed from `agent-effort` to `effort-live-control`, so the pins of a running session are dropped: its sub-agents run unpinned until their next spawn or first request.

## [0.1.3] — 2026-10-12

### Fixed
- A tagged sub-agent whose run ends while its own background child, shell or monitor still runs keeps its pin, so the run that work's notification wakes stays at the tagged effort. The engine reports such an agent as `waiting`, which used to clear the pin.
- The README says the panel's `agent_summary` request carries the effort the sub-agent's definition declares; it said the session's.

## [0.1.2] — 2026-09-28

### Fixed
- Removing the tag keeps the next line's indentation: only the spaces after the tag on its own line and one line break are removed.
- A markdown link opening the prompt (`[effort: high](…)`) and brackets spanning a line break are no longer read as a tag.
- An interrupted turn ends a sub-agent request's wait for its spawn at once, and the wait's timer is cancelled however the wait ends.
- The release check exits 2 with a clear error when a manifest cannot be read, accepts prerelease versions in the badge and compares versions by semver, escapes the version in its patterns, and fails on an unchecked `cd`.
- The release workflow refuses a tag whose version differs from the plugin manifest at the tagged commit.
- CI pins its GitHub actions by commit SHA and the Claude Code CLI by version.

### Changed
- The READMEs say the tag is the prompt's first non-blank text on one line and that a markdown link is not one, name the requests that are not pinned (compaction forks, `agent_summary`), and add the requirement, the tested Claude Code version and how to uninstall.
- The gitter agent states that only a release reaches installed copies.

## [0.1.1] — 2026-09-27

### Added
- Every sub-agent is pinned: an untagged one runs at the effort of its first request, so a mid-run `/effort` change never reaches it. A pin clears when the sub-agent finishes; a run that ends while it still waits on its own background task keeps it.
- A prompt that is only an effort tag is refused.

### Known limits
- The agent panel's progress summary (`agent_summary`, a short request about every 30 seconds per background sub-agent) passes through no plugin hook and runs at the session's effort.

### Fixed
- A sub-agent's first request waits only for its own spawn, not every spawn in flight, and its log no longer misreports the effort sent.
- A loop no spawn names (compaction and memory forks) waits at most once instead of on every request during fan-out.
- Pins live in Claude Code's session state and survive a plugin reload.
- The release check fails when `main`'s manifest cannot be read, instead of passing against version 0.0.0, and checks `package-lock.json`'s version.

### Changed
- The Agent tool's description line is one sentence and names the pinning.

## [0.1.0] — 2026-09-27

### Added
- `[effort: low|medium|high|xhigh|max]` at the start of an Agent prompt sets that sub-agent's effort for every model request it makes.
- The tag is removed from the prompt before the sub-agent reads it.
- An unknown level refuses the spawn with a message naming the valid levels.
- The Agent tool's description teaches the tag.
