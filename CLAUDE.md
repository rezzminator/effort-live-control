# effort-live-control

A Claude Code function-hooks plugin: a tag at the start of an Agent prompt sets
that sub-agent's reasoning effort, and an agent whose frontmatter opts in has its
effort raised at each tripwire and brought home once the trouble resolves.
`README.md` is the behavioural spec.

## Layout

- `plugins/effort-live-control/`: everything that installs, and nothing else — the directory scans only this folder, so dev files never go in it.
- `plugins/effort-live-control/hooks/effort-live-control.ts`: the adapter, the only file that touches `$`.
- `plugins/effort-live-control/src/`: every decision, pure and unit-tested; `tests/` holds one vitest file per concern.
- `types/claude-code.d.ts`: the plugin API (from `/plugin-types`), the truth for every hook's shape; grep it before using an event.
- `plugins/effort-live-control/.claude-plugin/`: `plugin.json` (the manifest) and `icon.svg`; the root `.claude-plugin/marketplace.json` makes the repo its own marketplace, with a `git-subdir` source pinned to `main`.

## Commands

`npm test`, `npm run typecheck` and `npm run validate:plugin` all pass before a commit. `make release-check` runs every check the release workflow runs on a `develop → main` pull request, the same make targets (`check`, `release`) under Node 22.

A live check loads the checkout with `--plugin-dir plugins/effort-live-control` and `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`, with any installed copy disabled for that run.

## Rules

- A new behaviour lands in `plugins/effort-live-control/src/` as a pure function with a test watched failing first; the adapter only wires it.
- Every option is also a variable `EFFORT_LIVE_CONTROL_{OPTION}`, upper snake, listed in the README options table: variable > plugin option > default; booleans `1|0|true|false`, any case, lists a JSON array of strings, blank is unset; a bad variable is reported by its name and the default applies.
- `readOptionEnv` spells each name as a string literal, since Claude Code refuses computed names; a new option adds its literal there, its row with the variable column in both READMEs, and a table row in `tests/settings.test.ts`.
- An error never holds a spawn or a request: log it with context and let it through at the effort it already had.
- A malformed tag refuses the spawn with a message naming the valid levels; it is never silently dropped.
- A version bump moves `plugins/effort-live-control/.claude-plugin/plugin.json`, `marketplace.json`, `package.json`, `package-lock.json` and the README badge together; installed copies update only on a new version.
- Public repo: no machine-absolute paths, personal data or private project names in a tracked file.
- `$` is passed only to functions declared at the top level of the hooks file and always spelled `$.noun.event(...)`: Claude Code checks this statically and otherwise loads the module with zero hooks. `npm run validate:plugin` catches it.

## Branches and releases

- `develop` is the default branch: every change lands there, by a commit or a pull request, and no CI runs on a push. `.github/workflows/release.yml` runs on the `develop → main` pull request only. `develop` is protected by the ruleset `develop keeps its history`: never force-push or delete it.
- `main` is release-only (ruleset `main is release-only`). It moves only by merging the `develop → main` pull request, with a merge commit and never a squash, so both branches share one history, and only after `check` and `release` pass: never a direct push, never an admin override. The marketplace installs the plugin from `main` (`git-subdir`, `ref: main`), so users only ever get a released version.
- A release, in order:
  1. On `develop`: bump the version in all four places, and move `## [Unreleased]` in `CHANGELOG.md` to `## [X.Y.Z] — date`. Every merge into `main` publishes, so a pre-release suffix (`-dev.N`, `-alpha`) becomes the real release version here.
  2. `make release-check` passes, after `git fetch origin main`.
  3. Open the `develop → main` pull request. Its `check` and `release` checks run the same make targets; `release` requires the version to have moved past `main`'s and the CHANGELOG section to yield notes.
  4. Merge once both are green. The merge is the release: `release.yml`'s `publish` job tags the merge commit `effort-live-control--vX.Y.Z` and publishes the GitHub release from the CHANGELOG section. No tag is pushed by hand.
- Semantic versioning: a fix is a patch; a new option or behaviour is a minor; a renamed or removed option is a major, and its CHANGELOG entry says how to migrate.
- Publishing: README and marketing changes on `develop` are pushed as soon as they are committed. Code is pushed, and a release is cut, only when the owner asks.
- Git writes go through this repo's gitter, `.claude/agents/gitter.md`.
