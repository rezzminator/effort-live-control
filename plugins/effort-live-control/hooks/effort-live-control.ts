import type { EngineInterface, ModelCompleteRequest, ModelCompleteResult, On, PluginOptions, Register } from 'claude-code';
import { Definitions, type ControlConfig, type Definition } from '../src/agents.ts';
import { Controller, type Action } from '../src/control.ts';
import { describe, denyText, EMPTY_TEXT, isStillRunning, parseTag, stepEffort, stripTag, type Effort, type Pin } from '../src/effort.ts';
import { JUDGE_SYSTEM, parseTripwires, TRIPWIRES } from '../src/judge.ts';
import { isLevel } from '../src/ladder.ts';
import { appendRows, sessionLogPath } from '../src/log.ts';
import { diagnosticVisible, levelRow, pluginLogDir, PluginLogQueue, type Level } from '../src/plugin-log.ts';
import { compile, envName, resolveSettings, SETTING_KEYS, type Compiled, type OptionEnv, type Settings } from '../src/settings.ts';
import { isRead, isTestRun, testOutcome } from '../src/signals.ts';
import { startOf } from '../src/start.ts';
import { BUTTON_AUTO, BUTTON_DOWN, BUTTON_UP, MAIN_REFUSED, mainEffortToolOf, REFUSED, type Direction } from '../src/text.ts';

// Thin adapter: every decision lives in src/. A failure is logged with its context and
// the spawn, request or tool call goes through at the effort it already had.

/** The spawning tool's name, past and present. */
const AGENT_TOOLS = new Set(['Agent', 'Task']);

/** How long a request of a loop the plugin has not seen waits for spawns in flight. */
const SPAWN_WAIT_MS = 5000;

const LOG_CAP = 5000;
const JUDGE_MAX_TOKENS = 4000;

/** The main chat's id in the decision log: it is never steered here. */
const MAIN = 'main';
/** How long the main chat's button waits for the session's tool list before its refusal names /effort. */
const TOOL_LIST_WAIT_MS = 2000;

type Fields = Record<string, unknown>;
/** What a button tool does: one step either way, or back to the automatic rules. */
type Button = Direction | 'auto';

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Pins live in host state, so a plugin reload keeps them; one value per agent id.
async function readPin(rt: Runtime, $: EngineInterface, agentId: string): Promise<Pin | undefined> {
  try {
    const { value } = await $.state.get({ plugin: 'effort-live-control', key: 'pin', id: agentId });
    return value ?? undefined;
  } catch (error) {
    notice(rt, $, 'error', 'pin-unreadable', `effort-live-control: reading sub-agent ${agentId}'s pin failed: ${message(error)}; its request goes at the effort it carries`, 'readPin');
    throw error;
  }
}

async function writePin($: EngineInterface, agentId: string, pin: Pin): Promise<void> {
  await $.state.set({ plugin: 'effort-live-control', key: 'pin', id: agentId }, pin);
}

type Spawns = {
  /** Spawns whose next() has not returned yet. */
  inFlight: number;
  /** Resolved and replaced each time a spawn settles. */
  settled: Promise<void>;
  wake: () => void;
  /** Loops that waited once and were never attributed to a spawn: never wait again. */
  strangers: Set<string>;
};

function newSpawns(): Spawns {
  const spawns = { inFlight: 0, strangers: new Set<string>() } as Spawns;
  spawns.settled = new Promise((resolve) => (spawns.wake = resolve));
  return spawns;
}

function settle(spawns: Spawns): void {
  spawns.inFlight -= 1;
  const wake = spawns.wake;
  spawns.settled = new Promise((resolve) => (spawns.wake = resolve));
  wake();
}

// A sub-agent's first request can start before agent.spawn returns its id. An
// unknown id waits until its own pin appears or no spawn is in flight, never past
// SPAWN_WAIT_MS, and at most once for its lifetime. The turn's abort ends the
// wait at once, and however the wait ends its timer is cancelled.
async function awaitPin(rt: Runtime, $: EngineInterface, spawns: Spawns, agentId: string, signal: AbortSignal): Promise<Pin | undefined> {
  let pin = await readPin(rt, $, agentId);
  if (pin !== undefined || spawns.strangers.has(agentId)) return pin;
  const waiting = new AbortController();
  const stop = () => waiting.abort();
  signal.addEventListener('abort', stop);
  if (signal.aborted) stop();
  const deadline = $.clock.sleep(SPAWN_WAIT_MS, { signal: waiting.signal }).then(
    () => 'over' as const,
    (error: unknown) => {
      if (!waiting.signal.aborted) notice(rt, $, 'error', 'spawn-wait-failed', `effort-live-control: sub-agent ${agentId}'s wait for its spawn failed: ${message(error)}; it goes on without waiting`, 'awaitPin');
      return 'over' as const;
    },
  );
  try {
    while (pin === undefined && spawns.inFlight > 0) {
      if ((await Promise.race([spawns.settled.then(() => 'settled' as const), deadline])) === 'over') break;
      pin = await readPin(rt, $, agentId);
    }
  } finally {
    signal.removeEventListener('abort', stop);
    waiting.abort();
  }
  if (pin === undefined) spawns.strangers.add(agentId);
  return pin;
}

/** A steered agent whose home waits for its first request. */
type Awaiting = { type: string; control: ControlConfig; brief: string };

type Runtime = {
  /** The plugin options as the host gave them; the environment variables are layered over them once, by `settleOptions`. */
  rawOptions: Readonly<Record<string, unknown>>;
  optionsSettled?: Promise<void>;
  pluginSetup?: Promise<string | undefined>;
  pluginDir?: string;
  pluginSession?: Promise<string | undefined>;
  pluginQueue?: PluginLogQueue;
  pluginWriting: Promise<void>;
  pluginFlushing: Promise<void>;
  modelFallback?: string;
  modelUnavailable?: boolean;
  config: Settings;
  compiled: Compiled;
  optionErrors: string[];
  started?: Promise<void>;
  defs?: Definitions;
  /** The decision log's path pattern with `~` expanded; empty: no log. */
  logFile: string;
  logPath?: Promise<string | undefined>;
  pending: string[];
  writing: Promise<void>;
  steered: Map<string, Controller>;
  awaiting: Map<string, Awaiting>;
  /** Each child agent's id → its steered parent's id. */
  childOf: Map<string, string>;
  /** The full tool names `$.tool.register` returned. */
  buttons: Map<string, Button>;
};

// The fallback must not log itself or turn a failed log write into failed work.
function logFallback($: EngineInterface, line: string): void {
  try { $.ui.log(line); } catch { /* The screen door itself is unavailable; no other sink exists. */ }
}

function setupPlugin(rt: Runtime, $: EngineInterface): Promise<string | undefined> {
  rt.pluginSetup ??= (async () => {
    let home: string | undefined;
    let configured: string | undefined;
    let homeError: { cause: unknown } | undefined;
    let dirError: { cause: unknown } | undefined;
    try { home = await $.env.get('HOME'); } catch (error) { homeError = { cause: error }; }
    try { configured = await $.env.get('PLUGIN_LOG_DIR'); } catch (error) { dirError = { cause: error }; }
    rt.pluginDir = pluginLogDir(configured, home, 'effort-live-control');
    rt.pluginQueue = new PluginLogQueue(rt.pluginDir, 'effort-live-control');
    if (homeError !== undefined) notice(rt, $, 'error', 'home-missing', `effort-live-control: reading HOME failed: ${message(homeError.cause)}; skipping ~/.claude/agents and ~ in logFile`, 'start');
    if (dirError !== undefined) notice(rt, $, 'warning', 'plugin-log-dir-unreadable', `effort-live-control: reading PLUGIN_LOG_DIR failed: ${message(dirError.cause)}; using the HOME fallback when available`, 'start');
    return home;
  })();
  return rt.pluginSetup;
}

async function flushPlugin(rt: Runtime, $: EngineInterface): Promise<void> {
  const out = await rt.pluginQueue!.flush(async (argv, init) => {
    try { return await $.process.run(argv, init); }
    catch (error) { throw new Error(`$.process.run failed: ${message(error)}`); }
  });
  for (const line of out.fallback ?? []) logFallback($, line);
  if (out.error !== undefined) {
    logFallback($, `effort-live-control: ${out.error}`);
    record(rt, $, 'main', 'plugin', { event: 'plugin-log-failed', error: out.error });
  }
}

// Only the metadata preparation is queued here; subprocesses have their own
// serial chain, so ordinary hooks never wait for the write.
function plog(rt: Runtime, $: EngineInterface, level: Level, event: string, msg: string, where: string, detail?: Fields): void {
  rt.pluginWriting = rt.pluginWriting.then(async () => {
    await setupPlugin(rt, $);
    rt.pluginSession ??= $.session.id().catch((error) => {
      notice(rt, $, 'warning', 'session-id-unreadable', `effort-live-control: reading the session id for plugin logs failed: ${message(error)}; rows omit the session`, 'plog');
      return undefined;
    });
    const session = await rt.pluginSession;
    const now = await $.clock.now();
    rt.pluginQueue!.add(levelRow({ plugin: 'effort-live-control', level, event, msg, where, session, detail }, now));
  }).catch((error) => {
    if (!diagnosticVisible(level, true)) logFallback($, msg);
    logFallback($, `effort-live-control: plugin log ${rt.pluginDir ?? 'off'}: preparing ${event} failed: ${message(error)}`);
  });
  rt.pluginFlushing = rt.pluginWriting.then(() => flushPlugin(rt, $)).catch((error) => logFallback($, `effort-live-control: plugin log ${rt.pluginDir ?? 'off'}: flushing failed: ${message(error)}`));
  if (diagnosticVisible(level, true)) $.ui.log(msg);
}

function notice(rt: Runtime, $: EngineInterface, level: Level, event: string, text: string, component: string): void {
  plog(rt, $, level, event, text, `hooks/effort-live-control.ts#${component}`);
}

// Rows queue in memory; each flush reads the session's file and appends them,
// so a resumed session keeps its earlier rows and no other chat shares the file.
function record(rt: Runtime, $: EngineInterface, agent: string, type: string, row: Fields): void {
  const file = rt.logFile;
  if (!file) return;
  const { event, ...rest } = row;
  rt.pending.push(JSON.stringify({ ts: new Date().toISOString(), event, agent, type, ...rest }));
  rt.logPath ??= $.session.id().then(
    (id) => sessionLogPath(file, id),
    (error) => {
      notice(rt, $, 'error', 'session-id-unreadable', `effort-live-control: reading the session id failed: ${message(error)}; the decision log is off for this session`, 'record');
      return undefined;
    },
  );
  rt.writing = rt.writing
    .then(async () => {
      const path = await rt.logPath;
      const rows = rt.pending.splice(0);
      if (!path || rows.length === 0) return;
      const existing = (await $.fs.exists(path)) ? await $.fs.read(path) : '';
      await $.fs.write(path, appendRows(existing, rows, LOG_CAP));
    })
    .catch((error) => notice(rt, $, 'error', 'decision-log-write-failed', `effort-live-control: writing the decision log for ${file} failed: ${message(error)}`, 'record'));
}

// The option was validated when the settings resolved, so a list that fails here is a bug: arm all four rather than none.
function tripwiresOf(text: string) {
  const found = parseTripwires(text);
  return found.ok ? found.value : [...TRIPWIRES];
}

/** One environment variable read: its text (undefined when unset), or the error the read raised. */
type EnvRead = { ok: true; value: string | undefined } | { ok: false; error: unknown };

const attempt = (read: Promise<string | undefined>): Promise<EnvRead> => read.then((value): EnvRead => ({ ok: true, value }), (error): EnvRead => ({ ok: false, error }));

// Each name is spelled out: Claude Code reads the names a module uses off its source and refuses a computed one.
async function readOptionEnv($: EngineInterface): Promise<Record<keyof Settings, EnvRead>> {
  return {
    floor: await attempt($.env.get('EFFORT_LIVE_CONTROL_FLOOR')),
    ceiling: await attempt($.env.get('EFFORT_LIVE_CONTROL_CEILING')),
    parentTag: await attempt($.env.get('EFFORT_LIVE_CONTROL_PARENT_TAG')),
    models: await attempt($.env.get('EFFORT_LIVE_CONTROL_MODELS')),
    judge: await attempt($.env.get('EFFORT_LIVE_CONTROL_JUDGE')),
    judgeRaiseAt: await attempt($.env.get('EFFORT_LIVE_CONTROL_JUDGE_RAISE_AT')),
    tripwires: await attempt($.env.get('EFFORT_LIVE_CONTROL_TRIPWIRES')),
    struggleDecay: await attempt($.env.get('EFFORT_LIVE_CONTROL_STRUGGLE_DECAY')),
    judgeModel: await attempt($.env.get('EFFORT_LIVE_CONTROL_JUDGE_MODEL')),
    judgeEffort: await attempt($.env.get('EFFORT_LIVE_CONTROL_JUDGE_EFFORT')),
    judgeTimeoutMs: await attempt($.env.get('EFFORT_LIVE_CONTROL_JUDGE_TIMEOUT_MS')),
    buttons: await attempt($.env.get('EFFORT_LIVE_CONTROL_BUTTONS')),
    announce: await attempt($.env.get('EFFORT_LIVE_CONTROL_ANNOUNCE')),
    testCommandPatterns: await attempt($.env.get('EFFORT_LIVE_CONTROL_TEST_COMMAND_PATTERNS')),
    readOnlyCommands: await attempt($.env.get('EFFORT_LIVE_CONTROL_READ_ONLY_COMMANDS')),
    failurePatterns: await attempt($.env.get('EFFORT_LIVE_CONTROL_FAILURE_PATTERNS')),
    redWords: await attempt($.env.get('EFFORT_LIVE_CONTROL_RED_WORDS')),
    greenWords: await attempt($.env.get('EFFORT_LIVE_CONTROL_GREEN_WORDS')),
    agentDirs: await attempt($.env.get('EFFORT_LIVE_CONTROL_AGENT_DIRS')),
    logFile: await attempt($.env.get('EFFORT_LIVE_CONTROL_LOG_FILE')),
    logPackets: await attempt($.env.get('EFFORT_LIVE_CONTROL_LOG_PACKETS')),
  };
}

// The environment variables are layered over the plugin options once, before anything reads a setting.
function settleOptions(rt: Runtime, $: EngineInterface): Promise<void> {
  rt.optionsSettled ??= (async () => {
    const read = await readOptionEnv($);
    const env: Partial<Record<keyof Settings, string>> = {};
    const readErrors: string[] = [];
    for (const key of SETTING_KEYS) {
      const one = read[key];
      if (!one.ok) readErrors.push(`effort-live-control: reading ${envName(key)} failed: ${message(one.error)}; using the option or its default`);
      else if (one.value !== undefined) env[key] = one.value;
    }
    const { settings, errors } = resolveSettings(rt.rawOptions, env satisfies OptionEnv);
    rt.config = settings;
    rt.compiled = compile(settings);
    rt.optionErrors = [...errors, ...readErrors];
  })().catch((error) => notice(rt, $, 'error', 'environment-unreadable', `effort-live-control: reading the environment variables failed: ${message(error)}; using the plugin options`, 'settleOptions'));
  return rt.optionsSettled;
}

// First hook call: read where definitions live, report option errors, build the resolver.
function start(rt: Runtime, $: EngineInterface): Promise<void> {
  rt.started ??= (async () => {
    await settleOptions(rt, $);
    const home = await setupPlugin(rt, $);
    let cwd = '.';
    let configDir: string | undefined;
    try {
      cwd = await $.session.cwd();
    } catch (error) {
      notice(rt, $, 'error', 'cwd-unreadable', `effort-live-control: reading the session cwd failed: ${message(error)}; using relative paths`, 'start');
    }
    try {
      configDir = await $.env.get('CLAUDE_CONFIG_DIR');
    } catch (error) {
      notice(rt, $, 'error', 'config-dir-missing', `effort-live-control: reading CLAUDE_CONFIG_DIR failed: ${message(error)}; skipping its agents directory`, 'start');
    }
    const file = rt.config.logFile;
    if (file.startsWith('~') && !home) notice(rt, $, 'error', 'log-file-needs-home', `effort-live-control: logFile ${file} needs HOME, which is unset; the decision log is off`, 'start');
    else rt.logFile = file.startsWith('~') ? `${home}${file.slice(1)}` : file;
    for (const line of rt.optionErrors) {
      notice(rt, $, 'error', 'option-error', line, 'start');
      record(rt, $, 'main', 'option-error', { event: 'option-error', line });
    }
    const dirs = [`${cwd}/.claude/agents`, ...(configDir ? [`${configDir}/agents`] : []), ...(home ? [`${home}/.claude/agents`] : []), ...rt.config.agentDirs];
    rt.defs = new Definitions(
      dirs,
      { floor: rt.config.floor, ceiling: rt.config.ceiling, judge: rt.config.judge, tripwires: tripwiresOf(rt.config.tripwires), parentTag: rt.config.parentTag, struggleDecay: rt.config.struggleDecay },
      {
        exists: (path) => $.fs.exists(path),
        read: (path) => $.fs.read(path),
        listMarkdown: async (dir) => (await $.fs.list(dir)).filter((entry) => entry.kind === 'file' && entry.name.endsWith('.md')).map((entry) => entry.name),
      },
      (line) => notice(rt, $, 'error', 'definition-unreadable', line, 'definitionOf'),
    );
  })().catch((error) => notice(rt, $, 'error', 'start-failed', `effort-live-control: starting failed: ${message(error)}; sub-agents run unsteered at the effort they carry`, 'start'));
  return rt.started;
}

const NO_DEFINITION = (rt: Runtime): Definition => ({ path: undefined, effort: undefined, control: undefined, parentTag: rt.config.parentTag, errors: [] });

async function definitionOf(rt: Runtime, $: EngineInterface, type: string | undefined): Promise<Definition> {
  if (!type || !rt.defs) return NO_DEFINITION(rt);
  try {
    return await rt.defs.resolve(type);
  } catch (error) {
    notice(rt, $, 'error', 'definition-unreadable', `effort-live-control: reading the definition of ${type} failed: ${message(error)}; treating it as having none`, 'definitionOf');
    return NO_DEFINITION(rt);
  }
}

// The steered controller of an agent id; the main chat (no id) is never steered here.
function controllerOf(rt: Runtime, agentId: string | undefined): Controller | undefined {
  return agentId === undefined ? undefined : rt.steered.get(agentId);
}

function newController(rt: Runtime, id: string, type: string, control: ControlConfig, home: Effort, brief: string): Controller {
  const controller = new Controller({
    id,
    type,
    home,
    floor: control.floor,
    ceiling: control.ceiling,
    judge: control.judge,
    judgeRaiseAt: rt.config.judgeRaiseAt,
    tripwires: new Set(control.tripwires),
    landing: control.landing,
    models: rt.config.models,
    words: { red: rt.config.redWords, green: rt.config.greenWords },
    announce: rt.config.announce,
    struggleDecay: control.struggleDecay,
    brief,
  });
  rt.steered.set(id, controller);
  return controller;
}

// Carries out what a controller decided: log rows, and judge calls started detached.
function perform(rt: Runtime, $: EngineInterface, controller: Controller, actions: readonly Action[]): void {
  for (const action of actions) {
    if (action.kind === 'log') {
      const { event, ...rest } = action.row;
      if (event === 'judge-failed' && rest.reason !== 'model-unavailable') plog(rt, $, 'error', 'judge-failed', `effort-live-control: judge failed for ${controller.id}: ${String(rest.reason)}; effort ${String(rest.from)} -> ${String(rest.to)}`, 'src/control.ts#failed', { agent: controller.id, error: String(rest.reason) });
      if (rest.from !== undefined && rest.to !== undefined && rest.from !== rest.to) plog(rt, $, 'info', 'effort-steered', `effort-live-control: ${controller.id}'s effort changed from ${String(rest.from)} to ${String(rest.to)}`, 'hooks/effort-live-control.ts#perform', { agent: controller.id, from: rest.from, to: rest.to });
      record(rt, $, controller.id, controller.type, { event, ...rest, ...(rt.config.logPackets ? action.detail : {}) });
    } else {
      runJudge(rt, $, controller, action);
    }
  }
}

function oauthDenied(reply: ModelCompleteResult): boolean {
  return !reply.isAnswered && reply.reason === 'api-error' && reply.status === 403 && reply.error === 'oauth_org_not_allowed';
}

// Only the default model may switch: explicit model choices remain authoritative.
async function completeModel(rt: Runtime, $: EngineInterface, request: ModelCompleteRequest): Promise<ModelCompleteResult | undefined> {
  if (request.model !== 'haiku') return $.model.complete(request);
  if (rt.modelUnavailable) return undefined;
  const sentModel = rt.modelFallback ?? request.model;
  let reply = await $.model.complete({ ...request, model: sentModel });
  if (oauthDenied(reply) && sentModel === request.model) {
    const current = rt.modelFallback ?? await $.session.model();
    if (rt.modelFallback === undefined) {
      rt.modelFallback = current;
      plog(rt, $, 'warning', 'model-fallback', `effort-live-control: default haiku refused (api-error 403 oauth_org_not_allowed); using current main model ${current} for the default judge`, 'hooks/effort-live-control.ts#completeModel', { model: current });
    }
    if (rt.modelFallback !== request.model) reply = await $.model.complete({ ...request, model: rt.modelFallback });
  }
  if (oauthDenied(reply)) {
    if (!rt.modelUnavailable) {
      rt.modelUnavailable = true;
      notice(rt, $, 'error', 'model-unavailable', 'effort-live-control: model judgment unavailable for this session (api-error 403 oauth_org_not_allowed); judges use deterministic failure handling', 'completeModel');
    }
    return undefined;
  }
  return reply;
}

// One judge call, never awaited by a hook: no request waits for it. Whatever it
// comes back with is read by the controller, which raises one step when it gives no level.
function runJudge(rt: Runtime, $: EngineInterface, controller: Controller, action: Extract<Action, { kind: 'judge' }>): void {
  const started = Date.now();
  completeModel(rt, $, { model: rt.config.judgeModel, effort: rt.config.judgeEffort, system: JUDGE_SYSTEM, prompt: action.packet, maxTokens: JUDGE_MAX_TOKENS, timeoutMs: rt.config.judgeTimeoutMs })
    .then(
      (reply) => {
        if (rt.steered.get(controller.id) !== controller) return;
        const ms = Date.now() - started;
        const out = reply === undefined
          ? controller.onJudgeFailure(action.epoch, 'model-unavailable')
          : reply.isAnswered
            ? controller.onJudgeAnswer(action.epoch, reply.text, ms, reply.usage)
            : controller.onJudgeFailure(action.epoch, reply.reason === 'api-error' ? `api-error ${reply.status ?? 'no status'} ${reply.error}` : reply.reason, reply.usage);
        perform(rt, $, controller, out.actions);
      },
      (error: unknown) => {
        if (rt.steered.get(controller.id) !== controller) return;
        perform(rt, $, controller, controller.onJudgeFailure(action.epoch, `threw: ${message(error)}`).actions);
      },
    )
    .catch((error: unknown) => notice(rt, $, 'error', 'judge-threw', `effort-live-control: reading the judge's answer for ${controller.id} failed: ${message(error)}; its effort stays where it is`, 'runJudge'));
}

// What a spawn starts at: the tag against the definition's own effort, by `parentTag`.
// A steered agent's home waits for its first request when neither names a level.
function startOfSpawn(definition: Definition, tagged: Effort | undefined) {
  return startOf({ tagged, own: definition.effort, parentTag: definition.parentTag, range: definition.control });
}

// A spawn returned an id: log what the tag did, tell a steered parent, and start steering the child.
function afterSpawn(rt: Runtime, $: EngineInterface, agentId: string, type: string, parentId: string | undefined, name: string | undefined, definition: Definition, tagged: Effort | undefined, brief: string): void {
  try {
    const opening = startOfSpawn(definition, tagged);
    if (opening.row) record(rt, $, agentId, type, opening.row);
    const parent = controllerOf(rt, parentId);
    if (parent) {
      rt.childOf.set(agentId, parent.id);
      perform(rt, $, parent, parent.onSpawn({ childId: agentId, type, name }).actions);
    }
    if (definition.control) {
      if (opening.level !== undefined) newController(rt, agentId, type, definition.control, opening.level, brief);
      else rt.awaiting.set(agentId, { type, control: definition.control, brief });
    }
  } catch (error) {
    notice(rt, $, 'error', 'steer-subagent-failed', `effort-live-control: steering sub-agent ${agentId} failed: ${message(error)}; it runs unsteered at its pin`, 'afterSpawn');
  }
}

// The first request of an agent whose home is its effort: steer it when that is a level.
function adoptFirst(rt: Runtime, $: EngineInterface, agentId: string, requested: unknown): Controller | undefined {
  const waiting = rt.awaiting.get(agentId);
  if (!waiting) return undefined;
  rt.awaiting.delete(agentId);
  if (!isLevel(requested)) {
    record(rt, $, agentId, waiting.type, { event: 'not-steered', requested: requested ?? null });
    notice(rt, $, 'error', 'not-a-level', `effort-live-control: sub-agent ${agentId} (${waiting.type}) starts at ${String(requested)}, not a level; it is not steered`, 'adoptFirst');
    return undefined;
  }
  return newController(rt, agentId, waiting.type, waiting.control, requested, waiting.brief);
}

// What a steered agent's own tool call tells the controller.
function observe(rt: Runtime, $: EngineInterface, controller: Controller, e: Fields & { tool: string }, result: { text?: string; isError?: boolean }): void {
  const text = result.text ?? '';
  if (e.tool === 'SendMessage') {
    perform(rt, $, controller, controller.onSendMessage(String(e.to)).actions);
    return;
  }
  const command = isTestRun(e.tool, e, rt.compiled.testCommand, rt.compiled.readOnly);
  if (command !== undefined) {
    const failed = testOutcome(result.isError, text, rt.compiled.failure) === 'fail';
    perform(rt, $, controller, controller.onTestRun({ command, failed, text }).actions);
    return;
  }
  if (isRead(e.tool, e, rt.compiled.readOnly)) perform(rt, $, controller, controller.onRead(text).actions);
}

// The session's own tool that sets the main chat's effort, by its listed name (mainEffortToolOf); undefined when none
// is listed, or when the list fails or does not answer within TOOL_LIST_WAIT_MS, so a button call is never held. The
// call's abort ends the wait at once, with no timeout logged, and however the wait ends its timer is cancelled.
async function mainEffortTool(rt: Runtime, $: EngineInterface, signal: AbortSignal): Promise<string | undefined> {
  const waiting = new AbortController();
  const stop = () => waiting.abort();
  signal.addEventListener('abort', stop);
  if (signal.aborted) stop();
  try {
    const deadline = $.clock.sleep(TOOL_LIST_WAIT_MS, { signal: waiting.signal }).then(
      () => 'over' as const,
      (error: unknown) => {
        if (!waiting.signal.aborted) notice(rt, $, 'warning', 'tool-list-wait-failed', `effort-live-control: the wait for the session's tool list failed: ${message(error)}; the main chat's refusal names /effort`, 'mainEffortTool');
        return 'failed' as const;
      },
    );
    const listed = await Promise.race([$.tool.list(), deadline]);
    if (listed === 'failed') return undefined;
    if (listed === 'over') {
      notice(rt, $, 'warning', 'tool-list-timeout', `effort-live-control: the session's tool list did not answer within ${TOOL_LIST_WAIT_MS} ms; the main chat's refusal names /effort`, 'mainEffortTool');
      return undefined;
    }
    return mainEffortToolOf(listed.map((tool) => tool.name));
  } catch (error) {
    notice(rt, $, 'warning', 'tool-list-failed', `effort-live-control: listing the session's tools failed: ${message(error)}; the main chat's refusal names /effort`, 'mainEffortTool');
    return undefined;
  } finally {
    signal.removeEventListener('abort', stop);
    waiting.abort();
  }
}

async function answerButton(rt: Runtime, $: EngineInterface, agentId: string | undefined, button: Button, signal: AbortSignal): Promise<{ result: string }> {
  const controller = controllerOf(rt, agentId);
  if (!controller) {
    record(rt, $, agentId ?? MAIN, 'unsteered', { event: 'button-refused', direction: button });
    return { result: agentId === undefined ? MAIN_REFUSED(await mainEffortTool(rt, $, signal)) : REFUSED };
  }
  const out = button === 'auto' ? controller.onAuto() : controller.onButton(button);
  perform(rt, $, controller, out.actions);
  return { result: out.text };
}

async function registerButtons(rt: Runtime, $: EngineInterface): Promise<void> {
  await settleOptions(rt, $);
  if (!rt.config.buttons) return;
  const specs: Array<{ name: string; description: string; button: Button }> = [
    { name: 'effort_up', description: BUTTON_UP, button: 'up' },
    { name: 'effort_down', description: BUTTON_DOWN, button: 'down' },
    { name: 'effort_auto', description: BUTTON_AUTO, button: 'auto' },
  ];
  for (const spec of specs) {
    try {
      const { tool } = await $.tool.register({ name: spec.name, description: spec.description, inputSchema: { type: 'object', properties: {} } });
      rt.buttons.set(tool, spec.button);
      record(rt, $, 'main', 'plugin', { event: 'tool-registered', tool });
    } catch (error) {
      notice(rt, $, 'error', 'tool-register-failed', `effort-live-control: registering the ${spec.name} tool failed: ${message(error)}; agents have no ${spec.name} button`, 'registerButtons');
      record(rt, $, 'main', 'plugin', { event: 'tool-register-failed', tool: spec.name, error: message(error) });
    }
  }
}

// A finished agent: its end row, and a child's final answer to its steered parent.
function finish(rt: Runtime, $: EngineInterface, agentId: string, answer: string): void {
  try {
    const parentId = rt.childOf.get(agentId);
    const parent = parentId === undefined ? undefined : rt.steered.get(parentId);
    if (parent) perform(rt, $, parent, parent.onChildReturn(agentId, answer).actions);
    const own = rt.steered.get(agentId);
    if (own) {
      record(rt, $, own.id, own.type, own.end());
      rt.steered.delete(agentId);
      for (const [child, owner] of rt.childOf) if (owner === agentId) rt.childOf.delete(child);
    }
    rt.awaiting.delete(agentId);
  } catch (error) {
    notice(rt, $, 'error', 'close-steering-failed', `effort-live-control: closing sub-agent ${agentId}'s steering failed: ${message(error)}; its pin is cleared as usual`, 'finish');
  }
}

export const register: Register = (on: On, options: PluginOptions) => {
  const spawns = newSpawns();
  const rawOptions = options as Record<string, unknown>;
  const { settings, errors } = resolveSettings(rawOptions);
  const rt: Runtime = {
    rawOptions,
    pluginWriting: Promise.resolve(),
    pluginFlushing: Promise.resolve(),
    config: settings,
    compiled: compile(settings),
    optionErrors: errors,
    logFile: '',
    pending: [],
    writing: Promise.resolve(),
    steered: new Map(),
    awaiting: new Map(),
    childOf: new Map(),
    buttons: new Map(),
  };

  on('session.start', async ($, e, next) => {
    const result = await next(e);
    await start(rt, $);
    await registerButtons(rt, $);
    return result;
  });

  on('session.end', async ($, e, next) => {
    await rt.pluginWriting;
    await rt.pluginFlushing;
    // The last flush may queue a decision row (a failed append's plugin-log-failed): it is on disk before the session ends.
    // A write failure's notice has queued its level row before a throwing screen rejected the chain; the session still ends.
    await rt.writing.catch((error) => logFallback($, `effort-live-control: finishing the decision log failed: ${message(error)}`));
    return next(e);
  });

  on('tool.describe', async ($, e, next) => {
    const result = await next(e);
    if (!AGENT_TOOLS.has(e.tool)) return result;
    await settleOptions(rt, $);
    return { ...result, description: describe(result.description, rt.config.parentTag) };
  });

  on('agent.spawn', async ($, e, next) => {
    const tag = parseTag(e.prompt);
    if (tag.kind === 'bad') return { deny: denyText(tag.raw) };
    if (tag.kind === 'empty') return { deny: EMPTY_TEXT };
    await start(rt, $);
    const definition = await definitionOf(rt, $, e.subagentType);
    const tagged = tag.kind === 'ok' ? tag.effort : undefined;
    const prompt = tag.kind === 'ok' ? stripTag(e.prompt) : e.prompt;
    spawns.inFlight += 1;
    try {
      const result = await next(tag.kind === 'ok' ? { ...e, prompt } : e);
      if (result.agentId !== undefined) {
        afterSpawn(rt, $, result.agentId, e.subagentType ?? 'unknown', e.parentAgentId, e.name, definition, tagged, prompt);
        try {
          await writePin($, result.agentId, { level: startOfSpawn(definition, tagged).level ?? null });
        } catch (error) {
          notice(rt, $, 'error', 'pin-write-failed', `effort-live-control: recording sub-agent ${result.agentId}'s pin failed: ${message(error)}; it runs at the session's effort, unpinned`, 'agent.spawn');
        }
      }
      return result;
    } finally {
      settle(spawns);
    }
  });

  on('turn.step', async function* ($, e, next) {
    const agentId = e.agentId;
    // The main chat is never steered here: its request goes at the effort it carries.
    if (agentId === undefined) return yield* next(e);
    let send = e.effort;
    let controller: Controller | undefined;
    try {
      await start(rt, $);
      const pin = await awaitPin(rt, $, spawns, agentId, next.signal);
      controller = rt.steered.get(agentId) ?? adoptFirst(rt, $, agentId, e.effort);
      if (controller) {
        const out = controller.onRequest(e.model, e.effort);
        perform(rt, $, controller, out.actions);
        send = out.send ?? e.effort;
      } else {
        const step = stepEffort(pin, e.effort);
        send = step.send;
        if (step.pin !== undefined) await writePin($, agentId, { level: step.pin });
      }
    } catch (error) {
      notice(rt, $, 'error', 'resolve-effort-failed', `effort-live-control: resolving sub-agent ${agentId}'s effort failed: ${message(error)}; this request goes at ${String(e.effort)}`, 'turn.step');
    }
    const result = yield* next(send === undefined || send === e.effort ? e : { ...e, effort: send });
    try {
      controller?.onAnswer(result.answer);
    } catch (error) {
      notice(rt, $, 'error', 'subagent-reply-unreadable', `effort-live-control: reading sub-agent ${agentId}'s reply failed: ${message(error)}; its last words are not kept`, 'turn.step');
    }
    return result;
  });

  // Answers the three buttons itself; for a steered agent, reads what its own calls say about trouble
  // and carries a level change it is owed in the result's context.
  on('tool.call', async ($, e, next) => {
    const button = rt.buttons.get(e.tool);
    if (button !== undefined) {
      try {
        return await answerButton(rt, $, e.agentId, button, next.signal);
      } catch (error) {
        notice(rt, $, 'error', 'answer-tool-failed', `effort-live-control: answering ${e.tool} failed: ${message(error)}; nothing changed`, 'answerButton');
        return { result: `Nothing changed: ${message(error)}` };
      }
    }
    const controller = controllerOf(rt, e.agentId);
    if (!controller) return next(e);
    const result = await next(e);
    if (result.deny !== undefined) return result;
    try {
      observe(rt, $, controller, e as unknown as Fields & { tool: string }, result);
      const line = controller.takeAnnouncement();
      if (line !== undefined) return { ...result, context: [...(result.context ?? []), line] };
    } catch (error) {
      notice(rt, $, 'error', 'tool-result-unreadable', `effort-live-control: reading ${e.agentId}'s ${e.tool} result failed: ${message(error)}; its effort stays where it is`, 'tool.call');
    }
    return result;
  });

  // A finished sub-agent drops its pin, so a continuation is pinned afresh at its
  // first request. A run that ends while the agent still runs, or waits on its own
  // background work, is the same job resuming later: its pin stays.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e);
    if (e.agentId === undefined) return result;
    try {
      const status = (await $.agent.list()).find((agent) => agent.id === e.agentId)?.status;
      if (isStillRunning(status)) return result;
      finish(rt, $, e.agentId, e.answer);
      if ((await readPin(rt, $, e.agentId)) !== undefined) await writePin($, e.agentId, { level: null });
    } catch (error) {
      notice(rt, $, 'error', 'pin-clear-failed', `effort-live-control: clearing sub-agent ${e.agentId}'s pin failed: ${message(error)}; its next run keeps the old pin`, 'turn.complete');
    }
    return result;
  });
};
