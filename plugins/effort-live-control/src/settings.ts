// Every knob is a plugin option, and each is also read from the environment variable EFFORT_LIVE_CONTROL_{OPTION}.
// Precedence: the variable, then the plugin option, then the default. Defaults agree in three places: here,
// plugin.json's userConfig and the README table.
// A bad value is reported by key (or variable name) and value, and the default applies.

import { isEffort, isParentTag, LEVELS, type Effort, type ParentTag } from './effort.ts';
import { parseTripwires } from './judge.ts';
import { rank } from './ladder.ts';

export type Settings = {
  floor: Effort;
  ceiling: Effort;
  /** `honor`: a tag wins over an effort the agent's definition sets; `ignore`: the definition keeps it. */
  parentTag: ParentTag;
  models: string[];
  judge: boolean;
  judgeRaiseAt: number;
  /** A comma list of the armed tripwire kinds: fail1, fail2, red, redispatch. Empty arms none. */
  tripwires: string;
  /** The requests a steered agent's open struggle may go without a new tripwire before its level comes home; 0: never. */
  struggleDecay: number;
  judgeModel: string;
  judgeEffort: Effort;
  judgeTimeoutMs: number;
  buttons: boolean;
  announce: boolean;
  testCommandPatterns: string[];
  /** Programs whose arguments are never a test run: a search, a print, a read. A Bash call that runs only these is a file read. */
  readOnlyCommands: string[];
  failurePatterns: string[];
  redWords: string[];
  greenWords: string[];
  agentDirs: string[];
  logFile: string;
  logPackets: boolean;
};

export const DEFAULTS: Settings = {
  floor: 'medium',
  ceiling: 'xhigh',
  parentTag: 'honor',
  models: ['claude-opus-5-5', 'claude-fable-5-1', 'claude-sonnet-5-5'],
  judge: false,
  judgeRaiseAt: 25,
  tripwires: 'fail1,fail2,red,redispatch',
  struggleDecay: 20,
  judgeModel: 'haiku',
  judgeEffort: 'xhigh',
  judgeTimeoutMs: 45000,
  buttons: true,
  announce: true,
  testCommandPatterns: [
    '\\bgo\\s+(-C\\s+\\S+\\s+)?test\\b',
    '\\b(npm|pnpm|yarn|bun)\\s+(run\\s+)?test\\b',
    '\\bvitest\\b',
    '\\bjest\\b',
    '\\bpytest\\b',
    '\\bpython(\\d(\\.\\d+)?)?\\s+-m\\s+unittest\\b',
    '\\bnode\\s+(--test|--test-only)\\b',
    '\\bcargo\\s+(test|nextest)\\b',
    '\\bmake\\b[^;&|\\n]*?\\b(test|check|verify)\\b',
    '\\bjust\\b[^;&|\\n]*?\\b(test|check)\\b',
    '\\b(mvn|gradle|gradlew)\\b[^;&|\\n]*?\\btest\\b',
    '\\bdotnet\\s+test\\b',
    '\\bdeno\\s+test\\b',
    '\\bswift\\s+test\\b',
    '\\bmix\\s+test\\b',
    '\\b(rspec|phpunit|ctest|tox|nox)\\b',
    '\\bscripts?/test[\\w.-]*\\.sh\\b',
  ],
  readOnlyCommands: `cat grep egrep fgrep rg ag ack echo printf sed awk head tail less more ls find fd git wc which type man file stat diff jq yq sort uniq cut tr tee test [ [[ cd pushd popd mkdir rm cp mv touch chmod ln basename dirname realpath readlink date sleep true false export read wait kill`.split(' '),
  failurePatterns: ['--- FAIL', 'FAIL(ED)?', '(?<!\\d)[1-9]\\d* (failed|failing)', 'AssertionError', 'panic:', 'Traceback'],
  redWords: ['FAIL', 'FAILED', 'BLOCKED', 'PARTIAL', 'SPEC-DRIFT'],
  greenWords: ['DONE', 'PASS', 'FIXED'],
  agentDirs: [],
  logFile: '~/.local/state/effort-live-control/decisions.jsonl',
  logPackets: false,
};

export const SETTING_KEYS = Object.keys(DEFAULTS) as Array<keyof Settings>;

/** The environment variable that sets an option: `EFFORT_LIVE_CONTROL_` and the option name in upper snake case. */
export const envName = (key: keyof Settings): string => `EFFORT_LIVE_CONTROL_${key.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase()}`;

/** The variables' text by option; an unset variable has no entry or `undefined`. */
export type OptionEnv = Readonly<Partial<Record<keyof Settings, string | undefined>>>;

type Parsed<T> = { ok: true; value: T } | { ok: false; why: string };
const good = <T>(value: T): Parsed<T> => ({ ok: true, value });
const bad = (why: string): Parsed<never> => ({ ok: false, why });

const quote = (value: unknown): string => (typeof value === 'string' ? JSON.stringify(value) : String(JSON.stringify(value)));
const clip = (text: string, max: number): string => (text.length > max ? text.slice(0, max - 1) + '…' : text);

const parseLevel = (raw: unknown): Parsed<Effort> => (typeof raw === 'string' && isEffort(raw) ? good(raw) : bad(`not a level (${LEVELS.join(', ')})`));

function parseBool(raw: unknown): Parsed<boolean> {
  if (typeof raw === 'boolean') return good(raw);
  if (raw === 'true') return good(true);
  if (raw === 'false') return good(false);
  return bad('not true or false');
}

function toNumber(raw: unknown): number {
  if (typeof raw === 'number') return raw;
  return typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : Number.NaN;
}

const parseInt1 = (raw: unknown): Parsed<number> => {
  const n = toNumber(raw);
  return Number.isInteger(n) && n >= 1 ? good(n) : bad('not a whole number of at least 1');
};

/** A whole number of 0 or more; shared by the `struggleDecay` option and the `effortControl.struggleDecay` key. */
export const parseDecay = (raw: unknown): Parsed<number> => {
  const n = toNumber(raw);
  return Number.isInteger(n) && n >= 0 ? good(n) : bad('not a whole number of at least 0');
};

const parsePercent = (raw: unknown): Parsed<number> => {
  const n = toNumber(raw);
  return Number.isInteger(n) && n >= 0 && n <= 100 ? good(n) : bad('not a whole number from 0 to 100');
};

const parseParentTag = (raw: unknown): Parsed<ParentTag> => (isParentTag(raw) ? good(raw) : bad('not honor or ignore'));

const parseText = (raw: unknown): Parsed<string> => (typeof raw === 'string' ? good(raw) : bad('not text'));

function parseTripwireList(raw: unknown): Parsed<string> {
  if (typeof raw !== 'string') return bad('not text');
  const found = parseTripwires(raw);
  return found.ok ? good(raw) : bad(found.why);
}

const parseModel = (raw: unknown): Parsed<string> =>
  typeof raw === 'string' && /^\S+$/.test(raw) ? good(raw) : bad('not a model alias or id (text without spaces)');

/** A list option: an array of strings, or text with one entry per line. Empty text means the default. */
function listOf(check: (item: string) => string | undefined): (raw: unknown) => Parsed<string[] | 'default'> {
  return (raw) => {
    let items: string[];
    if (Array.isArray(raw)) items = raw.map(String);
    else if (typeof raw === 'string') items = raw.split('\n').map((line) => line.trim()).filter((line) => line !== '');
    else return bad('not a list');
    if (typeof raw === 'string' && items.length === 0) return good('default');
    for (const item of items) {
      const problem = check(item);
      if (problem !== undefined) return bad(problem);
    }
    return good(items);
  };
}

const regexItem = (item: string): string | undefined => {
  try {
    new RegExp(item);
    return undefined;
  } catch (error) {
    return `${quote(item)} is not a regular expression (${clip(error instanceof Error ? error.message : String(error), 80)})`;
  }
};

const wordItem = (item: string): string | undefined => (/^[A-Za-z][A-Za-z0-9_-]*$/.test(item) ? undefined : `${quote(item)} is not a word of letters, digits, _ and -`);
const modelItem = (item: string): string | undefined => (/^\S+$/.test(item) ? undefined : `${quote(item)} is not a model id prefix (text without spaces)`);
const readOnlyItem = (item: string): string | undefined => (/^\S+$/.test(item) ? undefined : `${quote(item)} is not a program name (text without spaces)`);
const dirItem = (item: string): string | undefined => (item.trim() !== '' ? undefined : 'an empty directory');

const PARSERS: { [K in keyof Settings]: (raw: unknown) => Parsed<Settings[K] | 'default'> } = {
  floor: parseLevel,
  ceiling: parseLevel,
  parentTag: parseParentTag,
  models: listOf(modelItem),
  judge: parseBool,
  judgeRaiseAt: parsePercent,
  tripwires: parseTripwireList,
  struggleDecay: parseDecay,
  judgeModel: parseModel,
  judgeEffort: parseLevel,
  judgeTimeoutMs: parseInt1,
  buttons: parseBool,
  announce: parseBool,
  testCommandPatterns: listOf(regexItem),
  readOnlyCommands: listOf(readOnlyItem),
  failurePatterns: listOf(regexItem),
  redWords: listOf(wordItem),
  greenWords: listOf(wordItem),
  agentDirs: listOf(dirItem),
  logFile: parseText,
  logPackets: parseBool,
};

/** An environment variable's text as the option's value: a JSON array of strings for a list, `1|0|true|false` for a boolean, the option's own grammar otherwise. */
function parseEnv(key: keyof Settings, text: string): Parsed<unknown> {
  const parser = PARSERS[key] as (raw: unknown) => Parsed<unknown>;
  const kind = DEFAULTS[key];
  if (typeof kind === 'boolean') {
    const word = text.trim().toLowerCase();
    if (word === '1' || word === 'true') return good(true);
    if (word === '0' || word === 'false') return good(false);
    return bad('not 1, 0, true or false');
  }
  if (Array.isArray(kind)) {
    let list: unknown;
    try {
      list = JSON.parse(text);
    } catch (error) {
      return bad(`not a JSON array of strings (${clip(error instanceof Error ? error.message : String(error), 80)})`);
    }
    return Array.isArray(list) && list.every((item) => typeof item === 'string') ? parser(list) : bad('not a JSON array of strings');
  }
  return parser(text);
}

function errorLine(key: string, raw: unknown, why: string): string {
  return `effort-live-control: option "${key}" is ${quote(raw)}, ${why}; using the default ${JSON.stringify(DEFAULTS[key as keyof Settings])}`;
}

function envErrorLine(key: keyof Settings, text: string, why: string): string {
  return `effort-live-control: environment variable ${envName(key)} is ${quote(text)}, ${why}; using the default ${JSON.stringify(DEFAULTS[key])}`;
}

/**
 * Every option read, validated and defaulted; `errors` holds one line per rejected value. A set, non-blank variable wins
 * over the plugin option; a bad one is reported and the default applies, the plugin option not consulted.
 */
export function resolveSettings(raw: Readonly<Record<string, unknown>>, env: OptionEnv = {}): { settings: Settings; errors: string[] } {
  const settings: Record<string, unknown> = { ...DEFAULTS };
  const errors: string[] = [];
  const fromEnv = new Set<keyof Settings>();
  for (const key of SETTING_KEYS) {
    const text = env[key];
    if (text !== undefined && text.trim() !== '') {
      const parsed = parseEnv(key, text);
      if (parsed.ok) {
        settings[key] = parsed.value;
        fromEnv.add(key);
      } else errors.push(envErrorLine(key, text, parsed.why));
      continue;
    }
    const value = raw[key];
    if (value === undefined) continue;
    const parsed = (PARSERS[key] as (raw: unknown) => Parsed<unknown>)(value);
    if (!parsed.ok) errors.push(errorLine(key, value, parsed.why));
    else if (parsed.value !== 'default') settings[key] = parsed.value;
  }
  const out = settings as Settings;
  if (rank(out.floor) > rank(out.ceiling)) {
    const side = (key: 'floor' | 'ceiling') => (fromEnv.has(key) ? `environment variable ${envName(key)}` : `option "${key}"`);
    errors.push(`effort-live-control: ${side('floor')} (${JSON.stringify(out.floor)}) is above ${side('ceiling')} (${JSON.stringify(out.ceiling)}); using the defaults ${JSON.stringify(DEFAULTS.floor)} and ${JSON.stringify(DEFAULTS.ceiling)}`);
    out.floor = DEFAULTS.floor;
    out.ceiling = DEFAULTS.ceiling;
  }
  return { settings: out, errors };
}

export type Compiled = { failure: RegExp[]; testCommand: RegExp[]; readOnly: ReadonlySet<string> };

/** The pattern lists as regular expressions, which match case-sensitively. */
export function compile(settings: Settings): Compiled {
  return {
    failure: settings.failurePatterns.map((source) => new RegExp(source)),
    testCommand: settings.testCommandPatterns.map((source) => new RegExp(source)),
    readOnly: new Set(settings.readOnlyCommands),
  };
}
