import { describe, expect, it } from 'vitest';
import { parseTripwires } from '../plugins/effort-live-control/src/judge.ts';
import { compile, DEFAULTS, resolveSettings, SETTING_KEYS } from '../plugins/effort-live-control/src/settings.ts';

describe('resolveSettings', () => {
  it('uses the defaults for no options, with no errors', () => {
    expect(resolveSettings({})).toEqual({ settings: DEFAULTS, errors: [] });
  });

  it('holds the spec defaults', () => {
    expect(DEFAULTS).toMatchObject({
      floor: 'medium',
      ceiling: 'xhigh',
      models: ['claude-opus-5-5', 'claude-fable-5-1', 'claude-sonnet-5-5'],
      judge: false,
      judgeRaiseAt: 25,
      judgeModel: 'haiku',
      judgeEffort: 'xhigh',
      judgeTimeoutMs: 45000,
      buttons: true,
      announce: true,
      redWords: ['FAIL', 'FAILED', 'BLOCKED', 'PARTIAL', 'SPEC-DRIFT'],
      greenWords: ['DONE', 'PASS', 'FIXED'],
      agentDirs: [],
      logFile: '~/.local/state/effort-live-control/decisions.jsonl',
      logPackets: false,
      tripwires: 'fail1,fail2,red,redispatch',
      parentTag: 'honor',
      struggleDecay: 20,
    });
    expect(DEFAULTS.testCommandPatterns).toHaveLength(17);
    expect(DEFAULTS.failurePatterns).toHaveLength(6);
    expect(SETTING_KEYS).toHaveLength(21);
  });

  it('reads valid values of every kind', () => {
    const raw = { floor: 'low', ceiling: 'max', models: ['claude-x'], judge: true, judgeRaiseAt: 50, judgeModel: 'sonnet', judgeEffort: 'high', judgeTimeoutMs: 9000, buttons: false, announce: false, redWords: ['NO'], greenWords: ['YES'], agentDirs: ['/x'], logFile: '', logPackets: true, tripwires: 'fail2, red' };
    expect(resolveSettings(raw)).toEqual({ settings: { ...DEFAULTS, ...raw }, errors: [] });
  });

  it('reads booleans and numbers given as text', () => {
    const { settings, errors } = resolveSettings({ judge: 'true', judgeTimeoutMs: '1200', judgeRaiseAt: '40' });
    expect(errors).toEqual([]);
    expect(settings).toMatchObject({ judge: true, judgeTimeoutMs: 1200, judgeRaiseAt: 40 });
  });

  it('reports a bad value by key and value and uses the default', () => {
    const { settings, errors } = resolveSettings({ floor: 'sideways', judgeTimeoutMs: 0, buttons: 'maybe', judgeEffort: 'ultra' });
    expect(settings).toMatchObject({ floor: 'medium', judgeTimeoutMs: 45000, buttons: true, judgeEffort: 'xhigh' });
    expect(errors).toHaveLength(4);
    expect(errors[0]).toBe('effort-live-control: option "floor" is "sideways", not a level (low, medium, high, xhigh, max); using the default "medium"');
  });

  it('judgeRaiseAt takes a number from 0 to 100 and reports anything else', () => {
    expect(resolveSettings({ judgeRaiseAt: 0 }).settings.judgeRaiseAt).toBe(0);
    expect(resolveSettings({ judgeRaiseAt: 100 }).settings.judgeRaiseAt).toBe(100);
    for (const raw of [101, -1, 12.5, 'high', '']) {
      const { settings, errors } = resolveSettings({ judgeRaiseAt: raw });
      expect(settings.judgeRaiseAt, String(raw)).toBe(25);
      expect(errors, String(raw)).toHaveLength(1);
      expect(errors[0]).toContain('option "judgeRaiseAt"');
    }
  });

  it('reports a pattern that is not a regular expression', () => {
    const { settings, errors } = resolveSettings({ testCommandPatterns: ['(unclosed'] });
    expect(settings.testCommandPatterns).toEqual(DEFAULTS.testCommandPatterns);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('option "testCommandPatterns"');
    expect(errors[0]).toContain('is not a regular expression');
  });

  it('reports a word that cannot be a return token', () => {
    const { settings, errors } = resolveSettings({ redWords: ['OK now'] });
    expect(settings.redWords).toEqual(DEFAULTS.redWords);
    expect(errors[0]).toContain('option "redWords"');
  });

  it('reports a floor above the ceiling and uses both defaults', () => {
    const { settings, errors } = resolveSettings({ floor: 'max', ceiling: 'low' });
    expect(settings).toMatchObject({ floor: 'medium', ceiling: 'xhigh' });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('option "floor"');
  });

  it('reads a list given as text, one entry per line, and an empty text as the default', () => {
    expect(resolveSettings({ models: 'a\n b \n\nc' }).settings.models).toEqual(['a', 'b', 'c']);
    expect(resolveSettings({ models: '' }).settings.models).toEqual(DEFAULTS.models);
  });

  it('R-16: an empty logFile text turns the log off', () => {
    expect(resolveSettings({ logFile: '' }).settings.logFile).toBe('');
  });
});

describe('tripwires option', () => {
  it('tripwires: the default arms all four', () => {
    expect(DEFAULTS.tripwires).toBe('fail1,fail2,red,redispatch');
    expect(parseTripwires(DEFAULTS.tripwires)).toEqual({ ok: true, value: ['fail1', 'fail2', 'red', 'redispatch'] });
    expect(resolveSettings({}).errors).toEqual([]);
  });

  it('tripwires: whitespace around names is ignored, case is not significant and a repeat counts once', () => {
    expect(parseTripwires(' red ,  fail2\t, RED')).toEqual({ ok: true, value: ['red', 'fail2'] });
    expect(resolveSettings({ tripwires: ' fail2 , red ' })).toEqual({ settings: { ...DEFAULTS, tripwires: ' fail2 , red ' }, errors: [] });
  });

  it('tripwires: an empty list arms none', () => {
    expect(parseTripwires('')).toEqual({ ok: true, value: [] });
    expect(parseTripwires('  ')).toEqual({ ok: true, value: [] });
    expect(resolveSettings({ tripwires: '' })).toEqual({ settings: { ...DEFAULTS, tripwires: '' }, errors: [] });
  });

  it('tripwires: an unknown name is reported and the default applies', () => {
    const { settings, errors } = resolveSettings({ tripwires: 'fail1,boom' });
    expect(settings.tripwires).toBe('fail1,fail2,red,redispatch');
    expect(errors).toEqual(['effort-live-control: option "tripwires" is "fail1,boom", "boom" is not a tripwire (fail1, fail2, red, redispatch); using the default "fail1,fail2,red,redispatch"']);
    expect(resolveSettings({ tripwires: 7 }).errors).toHaveLength(1);
  });
});

describe('parentTag option', () => {
  it('parentTag: honor is the default, and honor and ignore are read', () => {
    expect(DEFAULTS.parentTag).toBe('honor');
    expect(resolveSettings({ parentTag: 'ignore' })).toEqual({ settings: { ...DEFAULTS, parentTag: 'ignore' }, errors: [] });
    expect(resolveSettings({ parentTag: 'honor' })).toEqual({ settings: DEFAULTS, errors: [] });
  });

  it('parentTag: an unknown value is reported by key and value and honor applies', () => {
    for (const raw of ['sometimes', 'Honor', '', true, 7]) {
      const { settings, errors } = resolveSettings({ parentTag: raw });
      expect(settings.parentTag, String(raw)).toBe('honor');
      expect(errors, String(raw)).toEqual([`effort-live-control: option "parentTag" is ${JSON.stringify(raw)}, not honor or ignore; using the default "honor"`]);
    }
  });
});

describe('struggleDecay option', () => {
  it('decay: 20 is the default, and a whole number from 0 up is read, as a number or as text', () => {
    expect(resolveSettings({}).settings.struggleDecay).toBe(20);
    expect(resolveSettings({ struggleDecay: 0 })).toEqual({ settings: { ...DEFAULTS, struggleDecay: 0 }, errors: [] });
    expect(resolveSettings({ struggleDecay: 7 }).settings.struggleDecay).toBe(7);
    expect(resolveSettings({ struggleDecay: '12' }).settings.struggleDecay).toBe(12);
  });

  it('decay: a bad value is reported by key and value and the default applies', () => {
    for (const raw of [-1, 1.5, 'soon', '', null, true]) {
      const { settings, errors } = resolveSettings({ struggleDecay: raw });
      expect(settings.struggleDecay, String(raw)).toBe(20);
      expect(errors, String(raw)).toHaveLength(1);
      expect(errors[0], String(raw)).toContain(`option "struggleDecay" is ${JSON.stringify(raw)}`);
      expect(errors[0], String(raw)).toContain('using the default 20');
    }
  });
});

describe('readOnlyCommands', () => {
  it('readOnlyCommands: the default names the programs that only read or print, and not the ones that execute', () => {
    expect(DEFAULTS.readOnlyCommands).toEqual(expect.arrayContaining(['cat', 'grep', 'echo', 'git', 'sed', '[', '[[', 'cd', 'sleep', 'kill']));
    expect(DEFAULTS.readOnlyCommands).not.toContain('source');
    expect(DEFAULTS.readOnlyCommands).not.toContain('.');
    expect(DEFAULTS.readOnlyCommands).toHaveLength(new Set(DEFAULTS.readOnlyCommands).size);
  });

  it('readOnlyCommands: a custom list replaces the default', () => {
    expect(resolveSettings({ readOnlyCommands: ['grep', 'cat'] })).toEqual({ settings: { ...DEFAULTS, readOnlyCommands: ['grep', 'cat'] }, errors: [] });
    expect(resolveSettings({ readOnlyCommands: 'grep\ncat' }).settings.readOnlyCommands).toEqual(['grep', 'cat']);
  });

  it.each([['two words', ['cat', 'two words']], ['', ['cat', '']], ['tab\there', ['tab\there']]])('readOnlyCommands: a bad item is reported and the default applies (%j)', (_label, raw) => {
    const { settings, errors } = resolveSettings({ readOnlyCommands: raw });
    expect(settings.readOnlyCommands).toEqual(DEFAULTS.readOnlyCommands);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('option "readOnlyCommands"');
    expect(errors[0]).toContain(JSON.stringify(raw));
  });
});

describe('compile', () => {
  it('turns the patterns into regular expressions', () => {
    const compiled = compile(DEFAULTS);
    expect(compiled.testCommand).toHaveLength(17);
    expect(compiled.failure).toHaveLength(6);
    expect(compiled.testCommand.every((re) => re instanceof RegExp)).toBe(true);
    expect(compiled.readOnly).toEqual(new Set(DEFAULTS.readOnlyCommands));
  });
});

// Every option is also read from EFFORT_LIVE_CONTROL_{OPTION}: the variable wins over the plugin option, a bad one
// is reported by its name and the default applies, a blank one is no variable.
type EnvRow = { key: keyof typeof DEFAULTS; name: string; env: string; expected: unknown; option: unknown; bad?: string };
const ENV_ROWS: EnvRow[] = [
  { key: 'floor', name: 'EFFORT_LIVE_CONTROL_FLOOR', env: 'high', expected: 'high', option: 'low', bad: 'sideways' },
  { key: 'ceiling', name: 'EFFORT_LIVE_CONTROL_CEILING', env: 'high', expected: 'high', option: 'max', bad: 'sideways' },
  { key: 'parentTag', name: 'EFFORT_LIVE_CONTROL_PARENT_TAG', env: 'ignore', expected: 'ignore', option: 'honor', bad: 'maybe' },
  { key: 'models', name: 'EFFORT_LIVE_CONTROL_MODELS', env: '["claude-x"]', expected: ['claude-x'], option: ['claude-y'], bad: 'claude-x' },
  { key: 'judge', name: 'EFFORT_LIVE_CONTROL_JUDGE', env: ' TRUE ', expected: true, option: false, bad: 'maybe' },
  { key: 'judgeRaiseAt', name: 'EFFORT_LIVE_CONTROL_JUDGE_RAISE_AT', env: '40', expected: 40, option: 50, bad: '101' },
  { key: 'tripwires', name: 'EFFORT_LIVE_CONTROL_TRIPWIRES', env: 'red', expected: 'red', option: 'fail1', bad: 'bogus' },
  { key: 'struggleDecay', name: 'EFFORT_LIVE_CONTROL_STRUGGLE_DECAY', env: '0', expected: 0, option: 5, bad: '-1' },
  { key: 'judgeModel', name: 'EFFORT_LIVE_CONTROL_JUDGE_MODEL', env: 'sonnet', expected: 'sonnet', option: 'opus', bad: 'two words' },
  { key: 'judgeEffort', name: 'EFFORT_LIVE_CONTROL_JUDGE_EFFORT', env: 'high', expected: 'high', option: 'low', bad: 'ultra' },
  { key: 'judgeTimeoutMs', name: 'EFFORT_LIVE_CONTROL_JUDGE_TIMEOUT_MS', env: '9000', expected: 9000, option: 8000, bad: '0' },
  { key: 'buttons', name: 'EFFORT_LIVE_CONTROL_BUTTONS', env: '0', expected: false, option: true, bad: 'yes' },
  { key: 'announce', name: 'EFFORT_LIVE_CONTROL_ANNOUNCE', env: 'False', expected: false, option: true, bad: 'no' },
  { key: 'testCommandPatterns', name: 'EFFORT_LIVE_CONTROL_TEST_COMMAND_PATTERNS', env: '["^make$"]', expected: ['^make$'], option: ['^ci$'], bad: '["(unclosed"]' },
  { key: 'readOnlyCommands', name: 'EFFORT_LIVE_CONTROL_READ_ONLY_COMMANDS', env: '["ls"]', expected: ['ls'], option: ['cat'], bad: '["two words"]' },
  { key: 'failurePatterns', name: 'EFFORT_LIVE_CONTROL_FAILURE_PATTERNS', env: '["boom"]', expected: ['boom'], option: ['bang'], bad: '["(unclosed"]' },
  { key: 'redWords', name: 'EFFORT_LIVE_CONTROL_RED_WORDS', env: '["NO"]', expected: ['NO'], option: ['NOPE'], bad: '["OK now"]' },
  { key: 'greenWords', name: 'EFFORT_LIVE_CONTROL_GREEN_WORDS', env: '["YES"]', expected: ['YES'], option: ['OK'], bad: '[1]' },
  { key: 'agentDirs', name: 'EFFORT_LIVE_CONTROL_AGENT_DIRS', env: '["/x"]', expected: ['/x'], option: ['/y'], bad: '{"dir":"/x"}' },
  { key: 'logFile', name: 'EFFORT_LIVE_CONTROL_LOG_FILE', env: '/logs/env.jsonl', expected: '/logs/env.jsonl', option: '/logs/option.jsonl' },
  { key: 'logPackets', name: 'EFFORT_LIVE_CONTROL_LOG_PACKETS', env: '1', expected: true, option: false, bad: 'yes' },
];

describe('resolveSettings: environment variables', () => {
  it('covers every option', () => {
    expect(ENV_ROWS.map((row) => row.key).sort()).toEqual([...SETTING_KEYS].sort());
  });

  it.each(ENV_ROWS)('$name overrides the $key option', ({ key, env, expected, option }) => {
    const { settings, errors } = resolveSettings({ [key]: option }, { [key]: env });
    expect(errors).toEqual([]);
    expect(settings[key]).toEqual(expected);
  });

  it.each(ENV_ROWS.filter((row) => row.bad !== undefined))('$name with a bad value is reported by name and the default applies over a valid $key option', ({ key, name, option, bad }) => {
    const { settings, errors } = resolveSettings({ [key]: option }, { [key]: bad });
    expect(settings[key]).toEqual(DEFAULTS[key]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(`environment variable ${name} is ${JSON.stringify(bad)}`);
    expect(errors[0]).toContain(`using the default ${JSON.stringify(DEFAULTS[key])}`);
  });

  it.each(ENV_ROWS)('$key: an unset or blank $name leaves the option, then the default', ({ key, option }) => {
    for (const env of [{}, { [key]: undefined }, { [key]: '' }, { [key]: ' \t ' }]) {
      const withOption = resolveSettings({ [key]: option }, env);
      expect(withOption.errors).toEqual([]);
      expect(withOption.settings[key]).toEqual(option);
      expect(resolveSettings({}, env)).toEqual({ settings: DEFAULTS, errors: [] });
    }
  });

  it('words a bad value like a bad option, naming the variable', () => {
    const { errors } = resolveSettings({}, { floor: 'sideways' });
    expect(errors).toEqual(['effort-live-control: environment variable EFFORT_LIVE_CONTROL_FLOOR is "sideways", not a level (low, medium, high, xhigh, max); using the default "medium"']);
  });

  it('reads an empty JSON array as the empty list, over a list option', () => {
    expect(resolveSettings({ models: ['claude-y'], agentDirs: ['/y'] }, { models: '[]', agentDirs: '[]' })).toEqual({ settings: { ...DEFAULTS, models: [], agentDirs: [] }, errors: [] });
  });

  it('reads the boolean words 1, 0, true and false in any case and nothing else', () => {
    for (const [text, value] of [['1', true], ['TRUE', true], [' true\n', true], ['0', false], ['False', false]] as const) expect(resolveSettings({}, { announce: text }).settings.announce, text).toBe(value);
    for (const text of ['yes', 'on', '2', 'tru']) expect(resolveSettings({}, { announce: text }).errors, text).toHaveLength(1);
  });

  it('checks the floor against the ceiling across the layers', () => {
    const { settings, errors } = resolveSettings({ ceiling: 'low' }, { floor: 'max' });
    expect(settings).toMatchObject({ floor: 'medium', ceiling: 'xhigh' });
    expect(errors[0]).toContain('environment variable EFFORT_LIVE_CONTROL_FLOOR ("max") is above option "ceiling" ("low")');
    expect(resolveSettings({ floor: 'high' }, { ceiling: 'low' }).errors[0]).toContain('option "floor" ("high") is above environment variable EFFORT_LIVE_CONTROL_CEILING ("low")');
    expect(resolveSettings({ floor: 'high', ceiling: 'low' }).errors[0]).toContain('option "floor" ("high") is above option "ceiling" ("low")');
  });

  it('names where a list variable stopped being JSON', () => {
    expect(resolveSettings({}, { models: '["a",]' }).errors[0]).toMatch(/EFFORT_LIVE_CONTROL_MODELS is .*not a JSON array of strings \(.+\)/);
  });
});
