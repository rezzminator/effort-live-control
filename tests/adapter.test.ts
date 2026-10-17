import { afterEach, describe as suite, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Controller } from '../plugins/effort-live-control/src/control.ts';
import { register } from '../plugins/effort-live-control/hooks/effort-live-control.ts';
import { MAIN_REFUSED } from '../plugins/effort-live-control/src/text.ts';

// A stand-in engine: host state that outlives a re-register, a clock the test
// fires, and the hooks the module registers, driven the way the engine drives them.
type Hook = (...args: any[]) => any;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

type Opts = {
  /** Files the stand-in file system holds: absolute path → text. */
  files?: Record<string, string>;
  /** A write lands only after a timer turn, as a real disk write does: what is not awaited is not on disk. */
  slowWrite?: boolean;
  /** The screen door throws, as an engine without a UI may. */
  uiThrows?: boolean;
  options?: Record<string, unknown>;
  env?: Record<string, string | undefined>;
  run?: (argv: readonly string[], init?: { timeoutMs?: number }) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  noProcess?: boolean;
  /** Paths whose read throws. */
  broken?: string[];
  /** Answers every model call at once (the judge's); without it a call waits in `judgeCalls`. */
  reply?: (request: any) => unknown;
  /** What `$.tool.list()` answers; none listed by default. */
  toolList?: () => Promise<Array<{ name: string; description: string; mcp: boolean }>>;
};

function engine(state = new Map<string, unknown>(), opts: Opts = {}) {
  const files = new Map<string, string>(Object.entries(opts.files ?? {}));
  const mtimes = new Map<string, number>();
  const env: Record<string, string | undefined> = { HOME: '/fixture-home/t', ...(opts.env ?? {}) };
  const judgeCalls: Array<{ request: any; resolve: (value: any) => void; reject: (error: unknown) => void }> = [];
  const registered: any[] = [];
  const statuses = new Map<string, string>();
  const hooks = new Map<string, Hook>();
  const timers: Array<() => void> = [];
  const logs: string[] = [];
  const $ = {
    state: {
      get: async (ref: { id: string }) => ({ value: state.get(ref.id), version: 0 }),
      set: async (ref: { id: string }, value: unknown) => (state.set(ref.id, value), { isSet: true, version: 1 }),
    },
    // A sleep the test fires; its signal aborting rejects it and drops its timer.
    clock: {
      now: async () => 1791991231123,
      sleep: (_ms: number, options?: { signal?: AbortSignal }) =>
        new Promise<void>((resolve, reject) => {
          const signal = options?.signal;
          if (signal?.aborted) return reject(signal.reason);
          const fire = () => (signal?.removeEventListener('abort', cancel), resolve());
          const cancel = () => (timers.splice(timers.indexOf(fire) >>> 0, 1), reject(signal!.reason));
          timers.push(fire);
          signal?.addEventListener('abort', cancel, { once: true });
        }),
    },
    ui: { log: (line: string) => { if (opts.uiThrows) throw new Error('no screen'); logs.push(line); } },
    ...(opts.noProcess ? {} : { process: { run: opts.run ?? (async () => ({ exitCode: 0, stdout: '', stderr: '' })) } }),
    agent: { list: async () => [...statuses].map(([id, status]) => ({ id, status, type: 'general-purpose', description: '' })) },
    fs: {
      exists: async (path: string) => files.has(path) || [...files.keys()].some((file) => file.startsWith(path.replace(/\/$/, '') + '/')),
      read: async (path: string) => {
        if (opts.broken?.includes(path)) throw new Error('EACCES');
        const text = files.get(path);
        if (text === undefined) throw new Error('ENOENT');
        return text;
      },
      write: async (path: string, text: string) => {
        if (opts.slowWrite) await new Promise((resolve) => setTimeout(resolve, 5));
        files.set(path, text); mtimes.set(path, (mtimes.get(path) ?? 0) + 1);
      },
      stat: async (path: string) => {
        if (!files.has(path)) throw new Error(`ENOENT: no such file or directory, stat '${path}'`);
        return { kind: 'file', size: 0, mtimeMs: mtimes.get(path) ?? 0, isLink: false };
      },
      list: async (dir: string) => [...files.keys()].filter((file) => file.startsWith(dir + '/')).map((file) => ({ name: file.slice(dir.length + 1), kind: 'file', size: 0, isLink: false })),
    },
    env: { get: async (name: string) => env[name] },
    session: { cwd: async () => '/proj', id: async () => 'sess1', model: async () => 'claude-opus-5-5' },
    tool: {
      register: async (spec: any) => (registered.push(spec), { tool: `mcp__effort-live-control__${spec.name}` }),
      list: opts.toolList ?? (async () => []),
    },
    model: {
      complete: (request: any) => (opts.reply ? Promise.resolve(opts.reply(request)) : new Promise<any>((resolve, reject) => judgeCalls.push({ request, resolve, reject }))),
    },
  };
  (register as Hook)((name: string, fn: Hook) => hooks.set(name, fn), opts.options ?? {});

  async function step(agentId: string | undefined, effort: string | number | undefined, signal = new AbortController().signal, model = 'm', answer = ''): Promise<string | undefined> {
    let sent: string | undefined;
    const next = Object.assign(
      async function* (e: any) {
        sent = e.effort;
        return { answer, toolUses: [] };
      },
      { signal },
    );
    const gen = hooks.get('turn.step')!($, { turnId: 't', index: 0, model, messageCount: 1, agentId, effort }, next);
    for (let r = await gen.next(); !r.done; r = await gen.next());
    return sent;
  }

  function spawn(prompt: string, extra: Record<string, unknown> = {}) {
    const started = deferred<{ model: string; agentId?: string }>();
    let seen: any;
    const result = hooks.get('agent.spawn')!($, { prompt, ...extra }, (e: any) => ((seen = e), started.promise));
    return { result, start: (agentId: string) => started.resolve({ model: 'm', agentId }), prompt: () => seen?.prompt };
  }

  /** A spawn that has started: resolves once the hook returned. */
  async function spawned(prompt: string, agentId: string, extra: Record<string, unknown> = {}) {
    const s = spawn(prompt, extra);
    s.start(agentId);
    await s.result;
    return s;
  }

  /** One request of the main chat in turn `turnId`. Resolves to the effort it was sent at. */
  async function mainStep(effort: string | number | undefined, turnId = 't1', model = 'claude-opus-5-5'): Promise<string | undefined> {
    let sent: string | undefined;
    const next = Object.assign(
      async function* (e: any) {
        sent = e.effort;
        return { answer: '', toolUses: [] };
      },
      { signal: new AbortController().signal },
    );
    const gen = hooks.get('turn.step')!($, { turnId, index: 0, model, messageCount: 1, effort }, next);
    for (let r = await gen.next(); !r.done; r = await gen.next());
    return sent;
  }

  /** The file's mtime moves, as an edit does. */
  const touch = async (path: string) => void mtimes.set(path, (mtimes.get(path) ?? 0) + 1);

  const complete = (agentId: string, answer = '') => hooks.get('turn.complete')!($, { agentId, answer }, async () => ({ text: '' }));

  /** One tool call of an agent; `result` is what the tool answers when next is called. */
  async function tool(agentId: string | undefined, name: string, input: Record<string, unknown>, result: Record<string, unknown> = { result: {}, text: '' }, signal = new AbortController().signal) {
    let called = false;
    const out = await hooks.get('tool.call')!($, { tool: name, tool_use_id: 'u', agentId, ...input }, Object.assign(async () => ((called = true), result), { signal }));
    return { out, called };
  }

  const sessionStart = () => hooks.get('session.start')!($, {}, async () => ({}));
  const describeTool = (name: string, description: string) => hooks.get('tool.describe')!($, { tool: name }, async () => ({ description }));
  const fireTimers = () => timers.splice(0).forEach((fire) => fire());
  const tick = () => new Promise((r) => setTimeout(r, 0));
  /** The decision-log rows written so far (waits for the queued appends). */
  const rows = async () => {
    await tick();
    await tick();
    const text = files.get('/fixture-home/t/.local/state/effort-live-control/decisions.sess1.jsonl') ?? '';
    return text.split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as Record<string, any>);
  };
  const sessionEnd = async (next = async () => ({})) => { if (hooks.has('session.end')) await hooks.get('session.end')!($, {}, next); };
  return { $, state, statuses, touch, step, mainStep, spawn, spawned, complete, tool, sessionStart, sessionEnd, describeTool, fireTimers, tick, logs, timers, files, judgeCalls, registered, rows };
}

suite('agent.spawn', () => {
  it('refuses an unknown level and a tag with no task', async () => {
    const x = engine();
    expect(await x.spawn('[effort: turbo] go').result).toHaveProperty('deny');
    expect(await x.spawn('[effort: low]').result).toHaveProperty('deny');
  });

  it('hands the sub-agent its prompt without the tag', async () => {
    const x = engine();
    const s = x.spawn('[effort: low]\nMap X.');
    s.start('a1');
    await s.result;
    expect(s.prompt()).toBe('Map X.');
  });
});

suite('pins', () => {
  it('sends a tagged sub-agent its tag on every request, whatever /effort says', async () => {
    const x = engine();
    const s = x.spawn('[effort: max]\nMap X.');
    s.start('a1');
    await s.result;
    expect(await x.step('a1', 'medium')).toBe('max');
    expect(await x.step('a1', 'low')).toBe('max');
  });

  it('pins an untagged sub-agent to its first request, so a later /effort change never reaches it', async () => {
    const x = engine();
    const s = x.spawn('Map X.');
    s.start('a1');
    await s.result;
    expect(await x.step('a1', 'high')).toBe('high');
    expect(await x.step('a1', 'low')).toBe('high');
  });

  it('keeps pins across a plugin reload', async () => {
    const first = engine();
    const s = first.spawn('[effort: low]\nMap X.');
    s.start('a1');
    await s.result;
    const reloaded = engine(first.state);
    expect(await reloaded.step('a1', 'high')).toBe('low');
  });

  it('clears a pin when its sub-agent finishes, so a continuation pins afresh', async () => {
    const x = engine();
    const s = x.spawn('Map X.');
    s.start('a1');
    await s.result;
    expect(await x.step('a1', 'high')).toBe('high');
    x.statuses.set('a1', 'completed');
    await x.complete('a1');
    expect(await x.step('a1', 'low')).toBe('low');
    expect(await x.step('a1', 'max')).toBe('low');
  });

  it('keeps the pin when a run ends while the sub-agent still runs, waiting on its own task', async () => {
    const x = engine();
    const s = x.spawn('[effort: max]\nMap X.');
    s.start('a1');
    await s.result;
    x.statuses.set('a1', 'running');
    await x.complete('a1');
    expect(await x.step('a1', 'low')).toBe('max');
  });

  it('keeps the pin when a run ends while its own background child still runs, so the wake stays tagged', async () => {
    // The engine reports such an agent as `waiting`: its run is over, and its child's notification resumes it.
    const x = engine();
    const s = x.spawn('[effort: max]\nMap X.');
    s.start('a1');
    await s.result;
    x.statuses.set('a1', 'waiting');
    await x.complete('a1');
    expect(await x.step('a1', 'low')).toBe('max');
  });

  it('never pins the main chat', async () => {
    const x = engine();
    expect(await x.step(undefined, 'high')).toBe('high');
    expect(await x.step(undefined, 'low')).toBe('low');
  });
});

suite('waiting for a spawn to return', () => {
  it('ends the wait when its own spawn is recorded, not when every spawn settles', async () => {
    const x = engine();
    x.spawn('Slow unrelated task.'); // never started: stays in flight
    const mine = x.spawn('[effort: low]\nMap X.');
    const sent = x.step('a1', 'high'); // its first request races ahead of the spawn's return
    await x.tick();
    mine.start('a1');
    expect(await sent).toBe('low');
    expect(x.logs).toEqual([]);
  });

  it('lets a loop no spawn names wait once, then pass straight through', async () => {
    const x = engine();
    x.spawn('Slow unrelated task.'); // in flight throughout
    const first = x.step('fork-1', 'high');
    await x.tick();
    x.fireTimers();
    expect(await first).toBe('high');
    expect(await x.step('fork-1', 'high')).toBe('high'); // no timer fired: it did not wait
    expect(x.timers).toHaveLength(0);
  });

  it('cancels its timer when the spawn settles first', async () => {
    const x = engine();
    const mine = x.spawn('[effort: low]\nMap X.');
    const sent = x.step('a1', 'high');
    await x.tick();
    expect(x.timers).toHaveLength(1);
    mine.start('a1');
    expect(await sent).toBe('low');
    expect(x.timers).toHaveLength(0);
  });

  it('ends the wait at once when the turn is interrupted', async () => {
    const x = engine();
    x.spawn('Slow unrelated task.'); // in flight throughout, never started
    const turn = new AbortController();
    const sent = x.step('a1', 'high', turn.signal);
    await x.tick();
    turn.abort();
    const stillWaiting = new Promise((r) => setTimeout(() => r('still waiting'), 50));
    expect(await Promise.race([sent, stillWaiting])).toBe('high');
    expect(x.timers).toHaveLength(0);
    expect(x.logs).toEqual([]);
  });
});

// ---- effort-live-control: definitions, steering, the judge, buttons, the log ----

const OPUS = 'claude-opus-5-5';
const USAGE = { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const agentFile = (name: string, frontmatter: string) => ({ [`/proj/.claude/agents/${name}.md`]: `---\nname: ${name}\n${frontmatter}\n---\nBody` });
const LEAD = agentFile('lead', 'effort: medium\neffortControl:\n  landing: lander');

/** An engine with a steered `lead` agent L1 already spawned. */
async function withLead(files: Record<string, string> = LEAD, options: Record<string, unknown> = {}) {
  const x = engine(new Map(), { files, options: { judge: true, ...options } });
  await x.spawned('Build X.', 'L1', { subagentType: 'lead' });
  const run = (command: string, text: string, extra: Record<string, unknown> = {}) => x.tool('L1', 'Bash', { command, ...extra }, { result: {}, text, isError: false });
  const failTwice = async () => {
    await run('npm test', 'FAIL a');
    await run('npm test', 'FAIL a');
  };
  const answer = async (text: string) => {
    x.judgeCalls[0]!.resolve({ isAnswered: true, text, usage: USAGE });
    await x.tick();
  };
  return { x, run, failTwice, answer };
}

suite('definition effort over the tag', () => {
  const files = agentFile('builder', 'effort: High');

  it("R-1: under parentTag ignore a definition effort wins over the tag: the tag is stripped, ignored, and the pin is the definition's level", async () => {
    const x = engine(new Map(), { files, options: { parentTag: 'ignore' } });
    const s = await x.spawned('[effort: low]\nMap X.', 'a1', { subagentType: 'builder' });
    expect(s.prompt()).toBe('Map X.');
    expect(await x.step('a1', 'medium')).toBe('high');
    expect(await x.step('a1', 'low')).toBe('high');
    expect(await x.rows()).toContainEqual(expect.objectContaining({ event: 'tag-ignored', agent: 'a1', type: 'builder', tag: 'low', effort: 'high' }));
  });

  it('R-1: the same tag is honoured on a type without a definition effort (positive control)', async () => {
    const x = engine(new Map(), { files: { ...files, ...agentFile('plain', 'description: no effort here') } });
    const s = await x.spawned('[effort: low]\nMap X.', 'a1', { subagentType: 'plain' });
    expect(s.prompt()).toBe('Map X.');
    expect(await x.step('a1', 'medium')).toBe('low');
    const g = await x.spawned('[effort: max]\nMap X.', 'a2', { subagentType: 'general-purpose' });
    expect(g.prompt()).toBe('Map X.');
    expect(await x.step('a2', 'medium')).toBe('max');
    expect((await x.rows()).filter((row) => row.event === 'tag-ignored')).toEqual([]);
  });

  it('R-2: a malformed tag still refuses the spawn, whatever the definition says', async () => {
    const x = engine(new Map(), { files });
    const bad = await x.spawn('[effort: turbo] go', { subagentType: 'builder' }).result;
    expect(bad).toHaveProperty('deny');
    expect(bad.deny).toContain('"turbo"');
    expect(await x.spawn('[effort: low]', { subagentType: 'builder' }).result).toHaveProperty('deny');
  });

  it('R-2: without a definition effort an untagged sub-agent pins at its first request, as before', async () => {
    const x = engine(new Map(), { files: agentFile('plain', 'description: none') });
    await x.spawned('Map X.', 'a1', { subagentType: 'plain' });
    expect(await x.step('a1', 'high')).toBe('high');
    expect(await x.step('a1', 'low')).toBe('high');
  });

  it('R-2: a definition effort given as a number is no level, so the tag pins', async () => {
    const x = engine(new Map(), { files: agentFile('numeric', 'effort: 5') });
    await x.spawned('[effort: low]\nMap X.', 'a1', { subagentType: 'numeric' });
    expect(await x.step('a1', 'high')).toBe('low');
  });

  it('R-2: a definition that cannot be read is no definition: the spawn goes through and the tag pins', async () => {
    const x = engine(new Map(), { files, broken: ['/proj/.claude/agents/builder.md'] });
    await x.spawned('[effort: low]\nMap X.', 'a1', { subagentType: 'builder' });
    expect(await x.step('a1', 'high')).toBe('low');
    expect(x.logs.join('\n')).toContain('effort-live-control: reading /proj/.claude/agents/builder.md failed: EACCES; treating builder as having no definition');
  });

  it('finds a definition in the home directory and in CLAUDE_CONFIG_DIR', async () => {
    const x = engine(new Map(), { files: { '/fixture-home/t/.claude/agents/h.md': '---\nname: h\neffort: max\n---\n', '/cfg/agents/c.md': '---\nname: c\neffort: low\n---\n' }, env: { CLAUDE_CONFIG_DIR: '/cfg' } });
    await x.spawned('Go.', 'a1', { subagentType: 'h' });
    await x.spawned('Go.', 'a2', { subagentType: 'c' });
    expect(await x.step('a1', 'high')).toBe('max');
    expect(await x.step('a2', 'high')).toBe('low');
  });

  it('finds a definition in an agentDirs directory', async () => {
    const x = engine(new Map(), { files: { '/extra/e.md': '---\nname: e\neffort: max\n---\n' }, options: { agentDirs: ['/extra'] } });
    await x.spawned('Go.', 'a1', { subagentType: 'e' });
    expect(await x.step('a1', 'high')).toBe('max');
  });
});

suite('parentTag', () => {
  const steered = agentFile('lead', 'effort: high\neffortControl: on');
  const own = agentFile('builder', 'effort: high');
  const tagRows = async (x: ReturnType<typeof engine>) => (await x.rows()).filter((row) => row.event === 'tag' || row.event === 'tag-ignored');

  it("parentTag: a tag on a type with its own effort sets a steered agent's home", async () => {
    const x = engine(new Map(), { files: steered });
    const s = await x.spawned('[effort: medium]\nBuild X.', 'L1', { subagentType: 'lead' });
    expect(s.prompt()).toBe('Build X.');
    expect(await x.step('L1', 'low', undefined, OPUS)).toBe('medium');
    expect(await x.step('L1', 'high', undefined, OPUS)).toBe('medium');
    const rows = await tagRows(x);
    expect(rows).toEqual([expect.objectContaining({ event: 'tag', agent: 'L1', type: 'lead', tag: 'medium', effort: 'high', home: 'medium' })]);
    expect(rows[0]).not.toHaveProperty('clamped');
  });

  it('parentTag: the home is clamped into floor and ceiling', async () => {
    const x = engine(new Map(), { files: steered });
    await x.spawned('[effort: low]\nBuild X.', 'L1', { subagentType: 'lead' });
    await x.spawned('[effort: max]\nBuild X.', 'L2', { subagentType: 'lead' });
    expect(await x.step('L1', 'high', undefined, OPUS)).toBe('medium');
    expect(await x.step('L2', 'high', undefined, OPUS)).toBe('xhigh');
    expect(await tagRows(x)).toEqual([
      expect.objectContaining({ event: 'tag', agent: 'L1', tag: 'low', effort: 'high', home: 'medium', clamped: true }),
      expect.objectContaining({ event: 'tag', agent: 'L2', tag: 'max', effort: 'high', home: 'xhigh', clamped: true }),
    ]);
  });

  it("parentTag: the home is clamped into the agent's own range, and into the range of a type without effort", async () => {
    const x = engine(new Map(), { files: { ...agentFile('narrow', 'effort: high\neffortControl:\n  floor: high\n  ceiling: high'), ...agentFile('plain', 'effortControl: on') } });
    await x.spawned('[effort: low]\nGo.', 'N1', { subagentType: 'narrow' });
    await x.spawned('[effort: low]\nGo.', 'P1', { subagentType: 'plain' });
    expect(await x.step('N1', 'max', undefined, OPUS)).toBe('high');
    expect(await x.step('P1', 'max', undefined, OPUS)).toBe('medium');
    expect(await tagRows(x)).toEqual([
      expect.objectContaining({ agent: 'N1', tag: 'low', effort: 'high', home: 'high', clamped: true }),
      expect.objectContaining({ agent: 'P1', tag: 'low', effort: null, home: 'medium', clamped: true }),
    ]);
  });

  it('parentTag: a tag on an unsteered type with its own effort pins its requests', async () => {
    for (const files of [own, agentFile('builder', 'effort: high\neffortControl: off')]) {
      const x = engine(new Map(), { files });
      const s = await x.spawned('[effort: low]\nMap X.', 'a1', { subagentType: 'builder' });
      expect(s.prompt()).toBe('Map X.');
      expect(await x.step('a1', 'medium')).toBe('low');
      expect(await x.step('a1', 'max')).toBe('low');
      const rows = await tagRows(x);
      expect(rows).toEqual([expect.objectContaining({ event: 'tag', agent: 'a1', type: 'builder', tag: 'low', effort: 'high' })]);
      expect(rows[0]).not.toHaveProperty('home');
    }
  });

  it("parentTag: ignore keeps the definition's effort and logs tag-ignored, as the option", async () => {
    for (const files of [own, steered]) {
      const x = engine(new Map(), { files, options: { parentTag: 'ignore' } });
      const type = files === own ? 'builder' : 'lead';
      await x.spawned('[effort: low]\nGo.', 'a1', { subagentType: type });
      expect(await x.step('a1', 'medium', undefined, OPUS)).toBe('high');
      expect(await x.step('a1', 'low', undefined, OPUS)).toBe('high');
      expect(await tagRows(x)).toEqual([expect.objectContaining({ event: 'tag-ignored', agent: 'a1', type, tag: 'low', effort: 'high' })]);
    }
  });

  it("parentTag: ignore keeps the definition's effort and logs tag-ignored, as frontmatter, even with effortControl off", async () => {
    const files = { ...agentFile('pinned', 'effort: high\neffortControl:\n  enabled: off\n  parentTag: ignore'), ...agentFile('lead', 'effort: high\neffortControl:\n  parentTag: ignore\n  floor: medium') };
    const x = engine(new Map(), { files });
    await x.spawned('[effort: low]\nGo.', 'a1', { subagentType: 'pinned' });
    await x.spawned('[effort: low]\nGo.', 'a2', { subagentType: 'lead' });
    expect(await x.step('a1', 'medium')).toBe('high');
    expect(await x.step('a2', 'medium', undefined, OPUS)).toBe('high');
    expect(await tagRows(x)).toEqual([
      expect.objectContaining({ event: 'tag-ignored', agent: 'a1', type: 'pinned', tag: 'low', effort: 'high' }),
      expect.objectContaining({ event: 'tag-ignored', agent: 'a2', type: 'lead', tag: 'low', effort: 'high' }),
    ]);
  });

  it('parentTag: frontmatter honor overrides the option ignore', async () => {
    const x = engine(new Map(), { files: agentFile('builder', 'effort: high\neffortControl:\n  enabled: off\n  parentTag: honor'), options: { parentTag: 'ignore' } });
    await x.spawned('[effort: low]\nGo.', 'a1', { subagentType: 'builder' });
    expect(await x.step('a1', 'medium')).toBe('low');
    expect(await tagRows(x)).toEqual([expect.objectContaining({ event: 'tag', agent: 'a1', tag: 'low', effort: 'high' })]);
  });

  it("parentTag: an untagged spawn keeps the definition's effort", async () => {
    for (const parentTag of ['honor', 'ignore']) {
      const x = engine(new Map(), { files: { ...own, ...steered }, options: { parentTag } });
      await x.spawned('Go.', 'a1', { subagentType: 'builder' });
      await x.spawned('Go.', 'L1', { subagentType: 'lead' });
      expect(await x.step('a1', 'low')).toBe('high');
      expect(await x.step('L1', 'low', undefined, OPUS)).toBe('high');
      expect(await tagRows(x)).toEqual([]);
    }
  });

  it('parentTag: a tag on a type without effort is unchanged, and a malformed tag still refuses the spawn', async () => {
    const x = engine(new Map(), { files: agentFile('plain', 'description: none') });
    await x.spawned('[effort: low]\nGo.', 'a1', { subagentType: 'plain' });
    expect(await x.step('a1', 'high')).toBe('low');
    expect(await tagRows(x)).toEqual([]);
    for (const files of [own, steered]) {
      const y = engine(new Map(), { files });
      expect(await y.spawn('[effort: turbo] go', { subagentType: files === own ? 'builder' : 'lead' }).result).toHaveProperty('deny');
    }
  });

  it('parentTag: an unknown value is reported and honor applies', async () => {
    const x = engine(new Map(), { files: { ...own, ...agentFile('odd', 'effort: high\neffortControl:\n  enabled: off\n  parentTag: sometimes') }, options: { parentTag: 'maybe' } });
    await x.sessionStart();
    await x.spawned('[effort: low]\nGo.', 'a1', { subagentType: 'builder' });
    await x.spawned('[effort: low]\nGo.', 'a2', { subagentType: 'odd' });
    expect(x.logs).toContain('effort-live-control: option "parentTag" is "maybe", not honor or ignore; using the default "honor"');
    expect(x.logs).toContain('effort-live-control: /proj/.claude/agents/odd.md effortControl.parentTag for odd is invalid (not honor or ignore); using honor');
    expect(await x.step('a1', 'high')).toBe('low');
    expect(await x.step('a2', 'high')).toBe('low');
  });

  it('parentTag: end to end, a tagged steered spawn with effort high and tag medium sends medium, and a tripwire raises it to high', async () => {
    const x = engine(new Map(), { files: steered });
    await x.spawned('[effort: medium]\nBuild X.', 'L1', { subagentType: 'lead' });
    expect(await x.step('L1', 'xhigh', undefined, OPUS)).toBe('medium');
    await x.tool('L1', 'Bash', { command: 'npm test' }, { result: {}, text: 'FAIL a', isError: false });
    expect(await x.step('L1', 'xhigh', undefined, OPUS)).toBe('high');
    expect(await x.rows()).toContainEqual(expect.objectContaining({ event: 'mechanical', agent: 'L1', tripwire: 'fail1', from: 'medium', to: 'high' }));
  });
});

suite('describe line', () => {
  it('tells the model the tag wins over a definition effort, and under parentTag ignore that the definition keeps it', async () => {
    const x = engine();
    const { description } = await x.describeTool('Agent', 'Launch a new agent.');
    expect(description).toContain('Effort: start the prompt with [effort: low|medium|high|xhigh|max] to run the sub-agent at that effort; without it, the sub-agent keeps the effort it starts with. The tag also wins over an effort the agent definition sets.');
    const ignoring = engine(new Map(), { options: { parentTag: 'ignore' } });
    expect((await ignoring.describeTool('Agent', 'Launch a new agent.')).description).toContain('An agent whose definition sets its own effort keeps it, and the tag is ignored.');
  });
});

suite('steering', () => {
  it("R-3: an agent whose definition turns effortControl on is steered: its requests go at its home level, clamped into the range", async () => {
    const { x } = await withLead();
    expect(await x.step('L1', 'low', undefined, OPUS)).toBe('medium');
    const low = engine(new Map(), { files: agentFile('lead', 'effort: low\neffortControl: on') });
    await low.spawned('Go.', 'L2', { subagentType: 'lead' });
    expect(await low.step('L2', 'low', undefined, OPUS)).toBe('medium');
    const top = engine(new Map(), { files: agentFile('lead', 'effort: max\neffortControl: on') });
    await top.spawned('Go.', 'L3', { subagentType: 'lead' });
    expect(await top.step('L3', 'low', undefined, OPUS)).toBe('xhigh');
  });

  it('R-3: without effortControl, or with it off, the agent is not steered and its buttons are refused', async () => {
    for (const frontmatter of ['effort: high', 'effort: high\neffortControl: off']) {
      const x = engine(new Map(), { files: agentFile('plain', frontmatter) });
      await x.sessionStart();
      await x.spawned('Go.', 'P1', { subagentType: 'plain' });
      await x.tool('P1', 'Bash', { command: 'npm test' }, { result: {}, text: 'FAIL a', isError: false });
      await x.tool('P1', 'Bash', { command: 'npm test' }, { result: {}, text: 'FAIL a', isError: false });
      expect(x.judgeCalls).toHaveLength(0);
      expect(await x.step('P1', 'low', undefined, OPUS)).toBe('high');
      const { out, called } = await x.tool('P1', 'mcp__effort-live-control__effort_up', {});
      expect(called).toBe(false);
      expect(out.result).toContain('Not available here');
    }
  });

  it('R-3: an invalid effortControl value is logged with its key and the default used', async () => {
    const x = engine(new Map(), { files: agentFile('lead', 'effort: medium\neffortControl:\n  floor: sideways') });
    await x.spawned('Go.', 'L1', { subagentType: 'lead' });
    expect(x.logs).toContain('effort-live-control: /proj/.claude/agents/lead.md effortControl.floor for lead is invalid (not a level: low, medium, high, xhigh, max); using medium');
    expect(await x.step('L1', 'low', undefined, OPUS)).toBe('medium');
  });

  it("R-4: with no definition effort the home is the tag's level", async () => {
    const x = engine(new Map(), { files: agentFile('lead', 'effortControl: on') });
    await x.spawned('[effort: high]\nGo.', 'L1', { subagentType: 'lead' });
    expect(await x.step('L1', 'low', undefined, OPUS)).toBe('high');
  });

  it("R-4: with neither, the home is the first request's effort, later /effort changes never reaching it", async () => {
    const x = engine(new Map(), { files: agentFile('lead', 'effortControl: on') });
    await x.spawned('Go.', 'L1', { subagentType: 'lead' });
    expect(await x.step('L1', 'high', undefined, OPUS)).toBe('high');
    expect(await x.step('L1', 'low', undefined, OPUS)).toBe('high');
  });

  it('R-4: an agent whose effort is a number, or has none, is not steered; logged once', async () => {
    const x = engine(new Map(), { files: agentFile('lead', 'effortControl: on') });
    await x.spawned('Go.', 'L1', { subagentType: 'lead' });
    expect(await x.step('L1', 7, undefined, OPUS)).toBe(7);
    expect(await x.step('L1', 3, undefined, OPUS)).toBe(7);
    const rows = (await x.rows()).filter((row) => row.event === 'not-steered');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ agent: 'L1', type: 'lead' });
  });

  it('R-4: an unallowed model passes the request through untouched, logged once', async () => {
    const { x } = await withLead();
    expect(await x.step('L1', 'low', undefined, 'claude-haiku-5-5')).toBe('low');
    expect(await x.step('L1', 'low', undefined, 'claude-haiku-5-5')).toBe('low');
    expect((await x.rows()).filter((row) => row.event === 'model-gated')).toHaveLength(1);
  });

  it('R-4: the models option sets which models are steered', async () => {
    const { x } = await withLead(LEAD, { models: ['claude-haiku-5-5'] });
    expect(await x.step('L1', 'low', undefined, 'claude-haiku-5-5')).toBe('medium');
    expect(await x.step('L1', 'low', undefined, OPUS)).toBe('low');
  });

  it("R-4: the reply's text is kept as the agent's last words for the judge", async () => {
    const { x, failTwice } = await withLead();
    await x.step('L1', 'low', undefined, OPUS, 'I am guessing the cache is stale');
    await failTwice();
    expect(x.judgeCalls[0]!.request.prompt).toContain("agent's last words (tail): I am guessing the cache is stale");
  });
});

suite('own test runs and the judge', () => {
  it('R-5: the first failing test run raises one step', async () => {
    const { x, run } = await withLead(LEAD, { judge: false });
    expect(await x.step('L1', 'low', undefined, OPUS)).toBe('medium');
    await run('npm test', 'FAIL a');
    expect(x.judgeCalls).toHaveLength(0);
    expect(await x.step('L1', 'low', undefined, OPUS)).toBe('high');
    expect(await x.rows()).toContainEqual(expect.objectContaining({ event: 'mechanical', agent: 'L1', tripwire: 'fail1', from: 'medium', to: 'high' }));
  });

  it('R-5: the second failing run raises again up to the ceiling', async () => {
    const { x, run } = await withLead(LEAD, { judge: false });
    await run('npm test', 'FAIL a');
    await run('npm test', 'FAIL a');
    expect(await x.step('L1', 'low', undefined, OPUS)).toBe('xhigh');
    await run('npm test', 'FAIL a');
    await run('npm test', 'FAIL a');
    expect(await x.step('L1', 'low', undefined, OPUS)).toBe('xhigh');
  });

  it('R-5: a pass between failures restarts the count at the first', async () => {
    const { x, run } = await withLead(LEAD, { judge: false });
    await run('npm test', 'FAIL a');
    await run('npm test', '12 passed');
    expect(await x.step('L1', 'low', undefined, OPUS)).toBe('medium');
    await run('npm test', 'FAIL a');
    expect(await x.step('L1', 'low', undefined, OPUS)).toBe('high');
  });

  it('R-5: the judge is off by default: a tripwire starts no call', async () => {
    const x = engine(new Map(), { files: LEAD });
    await x.spawned('Build X.', 'L1', { subagentType: 'lead' });
    await x.tool('L1', 'Bash', { command: 'npm test' }, { result: {}, text: 'FAIL a', isError: false });
    expect(x.judgeCalls).toHaveLength(0);
    expect(await x.step('L1', 'low', undefined, OPUS)).toBe('high');
  });

  it('R-5: with the judge on, the first failing test run starts one detached judge call with the spec request, the 2nd another', async () => {
    const { x, run, answer } = await withLead();
    await run('npm test', 'FAIL a');
    expect(x.judgeCalls).toHaveLength(1);
    expect(x.judgeCalls[0]!.request).toMatchObject({ model: 'haiku', effort: 'xhigh', maxTokens: 4000, timeoutMs: 45000 });
    expect(x.judgeCalls[0]!.request.system).toContain('You estimate whether an AI coding agent is in real trouble');
    expect(x.judgeCalls[0]!.request.prompt).toContain('tripwire: a failing test run\n');
    await answer('10 - plain');
    await run('npm test', 'FAIL a');
    expect(x.judgeCalls).toHaveLength(2);
    expect(x.judgeCalls[1]!.request.prompt).toContain('tripwire: 2nd failing test run in a row');
  });

  it('R-8: judgeRaiseAt reaches the controller: p at the line raises, below it holds', async () => {
    const hold = await withLead(LEAD, { judgeRaiseAt: 60 });
    await hold.run('npm test', 'FAIL a');
    await hold.answer('59 - a plain fix');
    expect(await hold.x.step('L1', 'low', undefined, OPUS)).toBe('medium');
    const raise = await withLead(LEAD, { judgeRaiseAt: 60 });
    await raise.run('npm test', 'FAIL a');
    await raise.answer('60 - unsure');
    expect(await raise.x.step('L1', 'low', undefined, OPUS)).toBe('high');
  });

  it('R-5: the judge options (model, effort, timeout) reach the call', async () => {
    const { x, failTwice } = await withLead(LEAD, { judgeModel: 'sonnet', judgeEffort: 'low', judgeTimeoutMs: 9000 });
    await failTwice();
    expect(x.judgeCalls[0]!.request).toMatchObject({ model: 'sonnet', effort: 'low', timeoutMs: 9000 });
  });

  it('R-5: a pass resets the count; a backgrounded run, a non-test command and a deny count nothing', async () => {
    const { x, run } = await withLead(LEAD, { judge: false });
    await run('npm test', 'FAIL a');
    await run('npm test', '12 passed');
    await run('npm test', 'FAIL a');
    await run('npm test', 'FAIL a', { run_in_background: true });
    await run('cat notes.txt', 'FAIL in the text');
    await x.tool('L1', 'Bash', { command: 'npm test' }, { deny: 'no' });
    // only the one counted failure since the pass: one step, not two
    expect(await x.step('L1', 'low', undefined, OPUS)).toBe('high');
  });

  it('R-5: the test and failure patterns are options', async () => {
    const { x, run } = await withLead(LEAD, { testCommandPatterns: ['\\bmycheck\\b'], failurePatterns: ['BOOM'] });
    await run('npm test', 'BOOM');
    await run('npm test', 'BOOM');
    expect(x.judgeCalls).toHaveLength(0);
    await run('./mycheck', 'BOOM');
    await run('./mycheck', 'BOOM');
    expect(x.judgeCalls).toHaveLength(1);
  });

  it('R-5: a result that is an error fails the run', async () => {
    const { x } = await withLead();
    for (let i = 0; i < 2; i++) await x.tool('L1', 'Bash', { command: 'go test ./...' }, { result: {}, text: 'exit 1', isError: true });
    expect(x.judgeCalls).toHaveLength(1);
  });

  it('R-8: a request issued while the judge is pending goes at the old level; the next one after the answer at the new level', async () => {
    const { x, failTwice, answer } = await withLead();
    await failTwice();
    expect(await x.step('L1', 'low', undefined, OPUS)).toBe('medium');
    await answer('85 - same test fails after the fix, cause unknown');
    expect(await x.step('L1', 'low', undefined, OPUS)).toBe('high');
  });

  it('R-8: the tool call returns without waiting for the judge', async () => {
    const { x, run } = await withLead();
    await run('npm test', 'FAIL a');
    const settled = await Promise.race([run('npm test', 'FAIL a').then(() => 'returned'), new Promise((r) => setTimeout(() => r('hung'), 200))]);
    expect(settled).toBe('returned');
    expect(x.judgeCalls).toHaveLength(1);
  });

  it('R-8: a second tripwire while the call is in flight starts no second call (judge-busy)', async () => {
    const { x, run, failTwice } = await withLead();
    await failTwice();
    await run('npm test', 'FAIL a');
    await run('npm test', 'FAIL a');
    expect(x.judgeCalls).toHaveLength(1);
    expect((await x.rows()).some((row) => row.event === 'judge-busy')).toBe(true);
  });

  it('R-8: with judge off the tripwire raises one step at once', async () => {
    const { x, failTwice } = await withLead(LEAD, { judge: false });
    await failTwice();
    expect(x.judgeCalls).toHaveLength(0);
    expect(await x.step('L1', 'low', undefined, OPUS)).toBe('xhigh');
  });

  it('R-8: effortControl.judge in the frontmatter overrides the option', async () => {
    const files = agentFile('lead', 'effort: medium\neffortControl:\n  judge: off');
    const { x, failTwice } = await withLead(files);
    await failTwice();
    expect(x.judgeCalls).toHaveLength(0);
    expect(await x.step('L1', 'low', undefined, OPUS)).toBe('xhigh');
  });

  it('R-8: effortControl.judge: on in the frontmatter turns the judge on for that agent while the option is off', async () => {
    const files = agentFile('lead', 'effort: medium\neffortControl:\n  judge: on');
    const x = engine(new Map(), { files });
    await x.spawned('Build X.', 'L1', { subagentType: 'lead' });
    await x.tool('L1', 'Bash', { command: 'npm test' }, { result: {}, text: 'FAIL a', isError: false });
    expect(x.judgeCalls).toHaveLength(1);
  });

  it('R-8: the judge row carries the tripwire, p, the levels, the reason, the time and the usage', async () => {
    const { x, failTwice, answer } = await withLead();
    await failTwice();
    await answer('70 - cause unknown');
    const judge = (await x.rows()).find((row) => row.event === 'judge')!;
    expect(judge).toMatchObject({ agent: 'L1', type: 'lead', tripwire: 'fail1', p: 70, from: 'medium', to: 'high', reason: 'cause unknown', usage: USAGE });
    expect(typeof judge.ms).toBe('number');
  });

  it('R-9: a call that is not answered (timed out) raises one step and logs judge-failed with the reason', async () => {
    const { x, failTwice } = await withLead();
    await failTwice();
    x.judgeCalls[0]!.resolve({ isAnswered: false, reason: 'aborted', usage: USAGE });
    await x.tick();
    expect(await x.step('L1', 'low', undefined, OPUS)).toBe('high');
    expect(await x.rows()).toContainEqual(expect.objectContaining({ event: 'judge-failed', reason: 'aborted', from: 'medium', to: 'high' }));
  });

  it('R-9: an answer without a leading number is unparsed and raises one step', async () => {
    const { x, failTwice, answer } = await withLead();
    await failTwice();
    await answer('Probably 60, I would say.');
    expect(await x.step('L1', 'low', undefined, OPUS)).toBe('high');
    expect(await x.rows()).toContainEqual(expect.objectContaining({ event: 'judge-failed', reason: 'unparseable answer' }));
  });

  it('R-9: a call that throws raises one step and logs the error', async () => {
    const { x, failTwice } = await withLead();
    await failTwice();
    x.judgeCalls[0]!.reject(new Error('socket closed'));
    await x.tick();
    expect(await x.step('L1', 'low', undefined, OPUS)).toBe('high');
    expect((await x.rows()).find((row) => row.event === 'judge-failed')!.reason).toContain('socket closed');
  });

  it('R-10: a passing run after the trouble restores the pre-struggle level and logs resolved', async () => {
    const { x, run, failTwice, answer } = await withLead();
    await failTwice();
    await answer('90 - stuck');
    expect(await x.step('L1', 'low', undefined, OPUS)).toBe('high');
    await run('npm test', '12 passed');
    expect(await x.step('L1', 'low', undefined, OPUS)).toBe('medium');
    expect(await x.rows()).toContainEqual(expect.objectContaining({ event: 'resolved', from: 'high', to: 'medium', requests: 1 }));
  });
});

suite('test runs', () => {
  it('test runs: a heredoc that mentions the test command does not end a failing streak', async () => {
    const { x, run } = await withLead(LEAD, { judge: false });
    await run('npm test', 'FAIL a');
    expect(await x.step('L1', 'low', undefined, OPUS)).toBe('high');
    await run("cat > brief.md <<'EOF'\nRun python3 -m unittest -v and report.\nEOF", 'wrote brief.md');
    expect(await x.step('L1', 'low', undefined, OPUS)).toBe('high');
    expect((await x.rows()).filter((row) => row.event === 'resolved')).toEqual([]);
    await run('python3 -m unittest -v 2>&1 | tail -3', 'Ran 4 tests\nOK');
    expect(await x.step('L1', 'low', undefined, OPUS)).toBe('medium');
    expect((await x.rows()).filter((row) => row.event === 'resolved')).toMatchObject([{ from: 'high', to: 'medium' }]);
  });

  it('readOnlyCommands: the option reaches the adapter, so an emptied list counts a grep as a test run', async () => {
    const { x, run } = await withLead(LEAD, { judge: false, readOnlyCommands: [] });
    await run('grep -rn pytest .', 'FAIL a');
    expect(await x.step('L1', 'low', undefined, OPUS)).toBe('high');
  });
});

suite('tripwires', () => {
  it('tripwires: the option disarms a kind for every steered agent', async () => {
    const { x, run } = await withLead(LEAD, { judge: false, tripwires: 'fail2,red,redispatch' });
    await run('npm test', 'FAIL a');
    expect(await x.step('L1', 'low', undefined, OPUS)).toBe('medium');
    await run('npm test', 'FAIL a');
    expect(await x.step('L1', 'low', undefined, OPUS)).toBe('high');
    expect((await x.rows()).filter((row) => row.event === 'mechanical')).toMatchObject([{ tripwire: 'fail2' }]);
  });

  it('tripwires: frontmatter overrides the option for that agent', async () => {
    const files = { ...agentFile('lead', 'effort: medium\neffortControl:\n  tripwires: red'), ...agentFile('plain', 'effort: medium\neffortControl: on') };
    const x = engine(new Map(), { files, options: { judge: false } });
    await x.spawned('Build X.', 'L1', { subagentType: 'lead' });
    await x.spawned('Build Y.', 'P1', { subagentType: 'plain' });
    const run = (id: string) => x.tool(id, 'Bash', { command: 'npm test' }, { result: {}, text: 'FAIL a', isError: false });
    await run('L1');
    await run('L1');
    await run('P1');
    expect(await x.step('L1', 'low', undefined, OPUS)).toBe('medium');
    expect(await x.step('P1', 'low', undefined, OPUS)).toBe('high');
    expect((await x.rows()).filter((row) => row.event === 'mechanical')).toMatchObject([{ agent: 'P1', tripwire: 'fail1' }]);
  });

  it('tripwires: an unknown name in the frontmatter is logged naming the agent type and the default applies', async () => {
    const files = agentFile('lead', 'effort: medium\neffortControl:\n  tripwires: fail1, boom');
    const { x, run } = await withLead(files, { judge: false });
    await run('npm test', 'FAIL a');
    expect(x.logs).toContain('effort-live-control: /proj/.claude/agents/lead.md effortControl.tripwires for lead is invalid ("boom" is not a tripwire (fail1, fail2, red, redispatch)); using fail1,fail2,red,redispatch');
    expect(await x.step('L1', 'low', undefined, OPUS)).toBe('high');
  });

  it('tripwires: an unknown name in the option is reported once at start and the default applies', async () => {
    const { x, run } = await withLead(LEAD, { judge: false, tripwires: 'boom' });
    await run('npm test', 'FAIL a');
    expect(x.logs.filter((line) => line.includes('option "tripwires"'))).toHaveLength(1);
    expect(await x.step('L1', 'low', undefined, OPUS)).toBe('high');
  });

  it('tripwires: an empty list arms none', async () => {
    const { x, failTwice } = await withLead(LEAD, { judge: true, tripwires: '' });
    await failTwice();
    expect(x.judgeCalls).toHaveLength(0);
    expect(await x.step('L1', 'low', undefined, OPUS)).toBe('medium');
    expect((await x.rows()).filter((row) => ['mechanical', 'judge', 'judge-busy'].includes(String(row.event)))).toEqual([]);
  });
});

suite('children', () => {
  const child = async (x: ReturnType<typeof engine>, id = 'C1', type = 'builder', extra: Record<string, unknown> = {}) => {
    await x.spawned('Build part.', id, { subagentType: type, parentAgentId: 'L1', ...extra });
    x.statuses.set(id, 'completed');
  };

  it('R-6: a red return on the child\'s own turn.complete fires the judge', async () => {
    const { x } = await withLead();
    await child(x);
    await x.complete('C1', 'FAIL parser: 3 tests red');
    expect(x.judgeCalls).toHaveLength(1);
    expect(x.judgeCalls[0]!.request.prompt).toContain('tripwire: a sub-task returned red');
    expect(x.judgeCalls[0]!.request.prompt).toContain('return (head): FAIL parser: 3 tests red');
  });

  it('R-6: a turn.complete whose child is still running or waiting is not a return', async () => {
    const { x } = await withLead();
    await child(x);
    for (const status of ['running', 'waiting']) {
      x.statuses.set('C1', status);
      await x.complete('C1', 'FAIL parser');
    }
    expect(x.judgeCalls).toHaveLength(0);
  });

  it('R-6: a return read by the steered agent (Read, a cat) counts, and a line already seen does not count twice', async () => {
    const { x } = await withLead();
    await child(x);
    await x.complete('C1', 'BLOCKED builder: no network');
    expect(x.judgeCalls).toHaveLength(1);
    await x.tool('L1', 'Read', { file_path: '/tmp/ret.md' }, { result: {}, text: '     1→BLOCKED builder: no network\n' });
    expect((await x.rows()).filter((row) => row.event === 'judge-busy')).toHaveLength(0);
  });

  it('R-6: a Read of a return file the agent had not seen is a return', async () => {
    const { x } = await withLead();
    await x.tool('L1', 'Read', { file_path: '/tmp/ret.md' }, { result: {}, text: '     1→FAIL unit-a: boom\n' });
    expect(x.judgeCalls).toHaveLength(1);
    await x.tool('L1', 'Bash', { command: 'cat /tmp/ret2.md' }, { result: {}, text: 'PARTIAL unit-b', isError: false });
    expect((await x.rows()).filter((row) => row.event === 'judge-busy')).toHaveLength(1);
  });

  it('R-6: a green return from the same unit clears the red and the level goes back', async () => {
    const { x } = await withLead(LEAD, { judge: false });
    await child(x);
    await x.complete('C1', 'FAIL builder');
    expect(await x.step('L1', 'low', undefined, OPUS)).toBe('high');
    await x.tool('L1', 'SendMessage', { to: 'C1', message: 'fix it' });
    await x.complete('C1', 'DONE builder');
    expect(await x.step('L1', 'low', undefined, OPUS)).toBe('medium');
  });

  it('return: a final answer with a parenthesis after its unit resolves the struggle', async () => {
    const { x } = await withLead(LEAD, { judge: false });
    await child(x);
    await x.complete('C1', 'FAIL probe-unit: boom');
    expect(await x.step('L1', 'low', undefined, OPUS)).toBe('high');
    await x.tool('L1', 'SendMessage', { to: 'C1', message: 'fix it' });
    await x.complete('C1', 'DONE probe-unit (handoff skipped: I have no file-write tool, only Read)');
    expect(await x.step('L1', 'low', undefined, OPUS)).toBe('medium');
  });

  it('R-7: a SendMessage to a red child fires the redispatch tripwire', async () => {
    const { x } = await withLead();
    await child(x, 'C1', 'builder', { name: 'b1' });
    await x.complete('C1', 'FAIL builder');
    x.judgeCalls[0]!.resolve({ isAnswered: true, text: '10 - plain', usage: USAGE });
    await x.tick();
    await x.tool('L1', 'SendMessage', { to: 'b1', message: 'fix it' });
    expect(x.judgeCalls).toHaveLength(2);
    expect(x.judgeCalls[1]!.request.prompt).toContain('tripwire: a red result sent back to a sub-task');
  });

  it('R-7: spawning another agent of a red child\'s type fires it', async () => {
    const { x } = await withLead();
    await child(x);
    await x.complete('C1', 'FAIL builder');
    x.judgeCalls[0]!.resolve({ isAnswered: true, text: '10 - plain', usage: USAGE });
    await x.tick();
    await x.spawned('Build part again.', 'C2', { subagentType: 'builder', parentAgentId: 'L1' });
    expect(x.judgeCalls).toHaveLength(2);
    expect(x.judgeCalls[1]!.request.prompt).toContain('- spawn builder');
  });

  it('R-11: spawning a landing type puts the agent one step below its home level', async () => {
    const files = { ...agentFile('lead', 'effort: high\neffortControl:\n  landing: lander') };
    const { x } = await withLead(files);
    expect(await x.step('L1', 'low', undefined, OPUS)).toBe('high');
    await x.spawned('Land it.', 'C9', { subagentType: 'lander', parentAgentId: 'L1' });
    expect(await x.step('L1', 'low', undefined, OPUS)).toBe('medium');
    expect(await x.rows()).toContainEqual(expect.objectContaining({ event: 'landing', from: 'high', to: 'medium' }));
  });

  it('a child spawned by an unsteered agent is nobody\'s return', async () => {
    const { x } = await withLead();
    await x.spawned('Build part.', 'C1', { subagentType: 'builder', parentAgentId: 'someone-else' });
    x.statuses.set('C1', 'completed');
    await x.complete('C1', 'FAIL builder');
    expect(x.judgeCalls).toHaveLength(0);
  });
});

suite('read channel', () => {
  // A steered agent that has spawned a child named unit-a reads each result below; a red return raises it one step.
  it.each([
    ['Bash', { command: './scripts/check.sh src/a.go' }, 'FAIL fmt PASS typecheck', false],
    ['Bash', { command: './scripts/check.sh src/a.go' }, 'FAIL fmt: 2 files unformatted', false],
    ['Bash', { command: './scripts/check.sh' }, 'FAIL fmt, PASS typecheck', false],
    ['Bash', { command: './scripts/check.sh src/a.go' }, 'FAIL fmt\nPASS typecheck\nFAIL lint-new\nlog: /tmp/check.log rc=1', false],
    ['Bash', { command: 'make lint 2>&1 | tail -3' }, 'FAIL lint-new', false],
    ['Bash', { command: 'cat flight/returns/unit-a-r1.md' }, 'FAIL unit-a: two rows red', true],
    ['Bash', { command: 'head -5 flight/returns/gate-r1.md' }, 'FAIL flight: gate red', true],
    ['Read', { file_path: 'flight/returns/unit-a-r1.md' }, '     1\tFAIL unit-a: two rows red', true],
    ['Bash', { command: 'cat a.md && ./run.sh' }, 'FAIL unit-a: x', false],
  ] as const)('read channel: %s %j with result %j is red: %s', async (tool, input, text, red) => {
    const { x } = await withLead(LEAD, { judge: false });
    await x.spawned('Build part.', 'C1', { subagentType: 'builder', name: 'unit-a', parentAgentId: 'L1' });
    expect(await x.step('L1', 'low', undefined, OPUS)).toBe('medium');
    await x.tool('L1', tool, input, { result: {}, text, isError: false });
    expect(await x.step('L1', 'low', undefined, OPUS)).toBe(red ? 'high' : 'medium');
    expect((await x.rows()).filter((row) => row.event === 'mechanical' && row.tripwire === 'red')).toHaveLength(red ? 1 : 0);
  });

  it('read channel: a check script\'s status line never marks a unit red, however often it prints it', async () => {
    const { x, run } = await withLead(LEAD, { judge: false });
    for (let i = 0; i < 5; i++) await run('./scripts/check.sh', 'FAIL fmt: 2 files unformatted');
    expect(await x.step('L1', 'low', undefined, OPUS)).toBe('medium');
  });

  it('read channel: a backgrounded read is not read', async () => {
    const { x, run } = await withLead(LEAD, { judge: false });
    await run('cat flight/returns/unit-a-r1.md', 'FAIL unit-a: two rows red', { run_in_background: true });
    expect(await x.step('L1', 'low', undefined, OPUS)).toBe('medium');
  });

  it('read channel: the programs that read are the readOnlyCommands option', async () => {
    const { x, run } = await withLead(LEAD, { judge: false, readOnlyCommands: ['less'] });
    await run('cat flight/returns/unit-a-r1.md', 'FAIL unit-a: two rows red');
    expect(await x.step('L1', 'low', undefined, OPUS)).toBe('medium');
    await run('less flight/returns/unit-b-r1.md', 'FAIL unit-b: red');
    expect(await x.step('L1', 'low', undefined, OPUS)).toBe('high');
  });
});

suite('struggle decay', () => {
  const resolvedRows = async (x: ReturnType<typeof engine>) => (await x.rows()).filter((row) => row.event === 'resolved');

  it('decay: the option brings a raised level home after that many requests, and the row says why', async () => {
    const { x, run } = await withLead(LEAD, { judge: false, struggleDecay: 3 });
    await run('npm test', 'FAIL a');
    for (let i = 0; i < 3; i++) expect(await x.step('L1', 'low', undefined, OPUS)).toBe('high');
    expect(await x.step('L1', 'low', undefined, OPUS)).toBe('medium');
    expect(await resolvedRows(x)).toEqual([expect.objectContaining({ agent: 'L1', from: 'high', to: 'medium', requests: 3, why: 'decay' })]);
  });

  it('decay: the default is 20 requests', async () => {
    const { x, run } = await withLead(LEAD, { judge: false });
    await run('npm test', 'FAIL a');
    for (let i = 0; i < 20; i++) expect(await x.step('L1', 'low', undefined, OPUS)).toBe('high');
    expect(await x.step('L1', 'low', undefined, OPUS)).toBe('medium');
  });

  it('decay: frontmatter overrides the option', async () => {
    const shorter = await withLead(agentFile('lead', 'effort: medium\neffortControl:\n  struggleDecay: 2'), { judge: false, struggleDecay: 50 });
    await shorter.run('npm test', 'FAIL a');
    for (let i = 0; i < 2; i++) expect(await shorter.x.step('L1', 'low', undefined, OPUS)).toBe('high');
    expect(await shorter.x.step('L1', 'low', undefined, OPUS)).toBe('medium');
    const off = await withLead(agentFile('lead', 'effort: medium\neffortControl:\n  struggleDecay: 0'), { judge: false, struggleDecay: 2 });
    await off.run('npm test', 'FAIL a');
    for (let i = 0; i < 10; i++) expect(await off.x.step('L1', 'low', undefined, OPUS)).toBe('high');
    expect(await resolvedRows(off.x)).toEqual([]);
  });

  it('decay: a bad value is reported and the default applies', async () => {
    const option = await withLead(LEAD, { judge: false, struggleDecay: -4 });
    await option.x.step('L1', 'low', undefined, OPUS);
    expect(option.x.logs).toContain('effort-live-control: option "struggleDecay" is -4, not a whole number of at least 0; using the default 20');
    await option.run('npm test', 'FAIL a');
    for (let i = 0; i < 20; i++) await option.x.step('L1', 'low', undefined, OPUS);
    expect(await option.x.step('L1', 'low', undefined, OPUS)).toBe('medium');
    const frontmatter = await withLead(agentFile('lead', 'effort: medium\neffortControl:\n  struggleDecay: soon'), { judge: false, struggleDecay: 2 });
    expect(frontmatter.x.logs.filter((line) => line.includes('effortControl.struggleDecay'))).toEqual([expect.stringContaining('"soon" is not a whole number of at least 0); using 2')]);
    await frontmatter.run('npm test', 'FAIL a');
    for (let i = 0; i < 2; i++) expect(await frontmatter.x.step('L1', 'low', undefined, OPUS)).toBe('high');
    expect(await frontmatter.x.step('L1', 'low', undefined, OPUS)).toBe('medium');
  });

  it('decay: an ordinary resolution says why: resolved', async () => {
    const { x, run } = await withLead(LEAD, { judge: false });
    await run('npm test', 'FAIL a');
    await x.step('L1', 'low', undefined, OPUS);
    await run('npm test', '12 passed');
    expect(await resolvedRows(x)).toEqual([expect.objectContaining({ from: 'high', to: 'medium', requests: 1, why: 'resolved' })]);
  });
});

suite('buttons', () => {
  const UP = 'mcp__effort-live-control__effort_up';
  const DOWN = 'mcp__effort-live-control__effort_down';
  const AUTO = 'mcp__effort-live-control__effort_auto';

  it('R-12: session.start registers effort_up, effort_down and effort_auto with no parameters and the spec descriptions', async () => {
    const x = engine();
    await x.sessionStart();
    expect(x.registered.map((spec) => spec.name)).toEqual(['effort_up', 'effort_down', 'effort_auto']);
    for (const spec of x.registered) expect(spec).toMatchObject({ inputSchema: { type: 'object', properties: {} } });
    expect(x.registered[0].description.startsWith('Raise your own reasoning effort one step for your next replies.')).toBe(true);
    expect(x.registered[1].description.startsWith('Lower your own reasoning effort one step for your next replies.')).toBe(true);
    expect(x.registered[2].description.startsWith('Hand your reasoning effort back to the automatic rules')).toBe(true);
  });

  it('R-12: buttons off registers nothing', async () => {
    const x = engine(new Map(), { options: { buttons: false } });
    await x.sessionStart();
    expect(x.registered).toEqual([]);
  });

  it('R-12: a steered caller\'s press moves its level one step, is answered without next, and logs button', async () => {
    const { x } = await withLead();
    await x.sessionStart();
    const up = await x.tool('L1', UP, {});
    expect(up.called).toBe(false);
    expect(up.out.result).toBe('Effort raised to high for your next replies (your range medium..xhigh); it holds until you call effort_auto.');
    expect(await x.step('L1', 'low', undefined, OPUS)).toBe('high');
    const down = await x.tool('L1', DOWN, {});
    expect(down.out.result).toBe('Effort lowered to medium for your next replies (your range medium..xhigh); it holds until you call effort_auto.');
    const again = await x.tool('L1', DOWN, {});
    expect(again.out.result).toBe('Your effort is already medium, the floor of your range; it holds there until you call effort_auto.');
    expect(await x.rows()).toContainEqual(expect.objectContaining({ event: 'button', agent: 'L1', direction: 'up', from: 'medium', to: 'high' }));
  });

  it('R-12: an unsteered main chat and an unsteered agent are refused, each by its own text, and the refusal is logged', async () => {
    const x = engine();
    await x.sessionStart();
    const main = await x.tool(undefined, UP, {});
    expect(main.called).toBe(false);
    expect(main.out.result).toBe('Not available here: these effort buttons do not steer the main chat, and no tool here sets its effort; the user sets it with /effort. Nothing changed.');
    const stranger = await x.tool('stranger', DOWN, {});
    expect(stranger.out.result).toBe("Not available here: this agent's effort is not live-controlled (its definition does not turn on effortControl). Nothing changed.");
    expect((await x.tool('stranger', AUTO, {})).out.result).toContain('not live-controlled');
    const refused = (await x.rows()).filter((row) => row.event === 'button-refused');
    expect(refused.map((row) => [row.agent, row.direction])).toEqual([['main', 'up'], ['stranger', 'down'], ['stranger', 'auto']]);
  });

  it("main chat: unsteered, every button names the main chat's own listed set_effort tool, with a level or auto", async () => {
    const toolList = async () => [
      { name: 'Bash', description: 'Runs a command.', mcp: false },
      { name: 'mcp__other__reset_effort_cache', description: 'Not it.', mcp: true },
      { name: 'mcp__steerer__set_effort', description: 'Sets the effort.', mcp: true },
    ];
    const x = engine(new Map(), { toolList });
    await x.sessionStart();
    await x.mainStep('high');
    for (const name of [UP, DOWN, AUTO]) {
      const { out, called } = await x.tool(undefined, name, {});
      expect(called).toBe(false);
      expect(out.result).toBe('Not available here: these effort buttons do not steer the main chat. Your effort has its own control, mcp__steerer__set_effort: call it with a level, or auto. Nothing changed.');
    }
  });

  // The plugin log rows a stand-in append command received: a warning the log holds stays off the screen.
  const captureLog = () => {
    const rows: any[] = [];
    const run: NonNullable<Opts['run']> = async (argv) => {
      if (argv[3] === 'plugin-log') for (let i = 7; i < argv.length; i += 2) rows.push(JSON.parse(argv[i]!));
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    return { run, warnings: () => rows.filter((row) => row.level === 'warning').map((row) => row.msg) };
  };

  it('main chat: a tool list that fails is reported with its cause, and the refusal names /effort', async () => {
    const log = captureLog();
    const x = engine(new Map(), { run: log.run, toolList: async () => { throw new Error('list denied'); } });
    await x.sessionStart();
    const { out } = await x.tool(undefined, UP, {});
    expect(out.result).toContain('the user sets it with /effort');
    await vi.waitFor(() => expect(log.warnings()).toContain("effort-live-control: listing the session's tools failed: list denied; the main chat's refusal names /effort"));
    expect(x.logs.some((line) => line.includes("listing the session's tools failed: list denied; the main chat's refusal names /effort"))).toBe(false);
  });

  it('main chat: a tool list that does not answer is waited for within a bound, then the refusal names /effort', async () => {
    const log = captureLog();
    const x = engine(new Map(), { run: log.run, toolList: () => new Promise(() => {}) });
    await x.sessionStart();
    const pending = x.tool(undefined, UP, {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    x.fireTimers();
    const { out } = await pending;
    expect(out.result).toContain('the user sets it with /effort');
    await vi.waitFor(() => expect(log.warnings()).toContain("effort-live-control: the session's tool list did not answer within 2000 ms; the main chat's refusal names /effort"));
    expect(x.logs.some((line) => line.includes("the session's tool list did not answer within 2000 ms; the main chat's refusal names /effort"))).toBe(false);
  });

  it('main chat: a wait for the tool list that throws at once still gets the /effort refusal', async () => {
    const log = captureLog();
    const x = engine(new Map(), { run: log.run, toolList: () => new Promise(() => {}) });
    x.$.clock.sleep = () => {
      throw new Error('no clock');
    };
    await x.sessionStart();
    const { out } = await x.tool(undefined, UP, {});
    expect(out.result).toBe(MAIN_REFUSED(undefined));
    await vi.waitFor(() => expect(log.warnings()).toContain("effort-live-control: listing the session's tools failed: no clock; the main chat's refusal names /effort"));
    expect(x.logs.some((line) => line.includes("listing the session's tools failed: no clock; the main chat's refusal names /effort"))).toBe(false);
  });

  it('main chat: a press the engine abandons stops its wait for the tool list and logs no timeout', async () => {
    const x = engine(new Map(), { toolList: () => new Promise(() => {}) });
    await x.sessionStart();
    const abandoned = new AbortController();
    const pending = x.tool(undefined, UP, {}, undefined, abandoned.signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(x.timers).toHaveLength(1);
    abandoned.abort();
    x.fireTimers();
    const { out } = await pending;
    expect(out.result).toBe(MAIN_REFUSED(undefined));
    expect(x.logs.filter((line) => line.includes('tool list'))).toEqual([]);
  });

  it('effort_auto: a steered agent goes back to its launch level, and its tripwires steer it again', async () => {
    const { x, failTwice } = await withLead(LEAD, { judge: false });
    await x.sessionStart();
    await x.tool('L1', UP, {});
    await failTwice();
    expect(await x.step('L1', 'low', undefined, OPUS)).toBe('high');
    const auto = await x.tool('L1', AUTO, {});
    expect(auto.called).toBe(false);
    expect(auto.out.result).toBe('Effort back to medium, your home level, for your next replies (your range medium..xhigh); the automatic rules steer it again.');
    expect(await x.step('L1', 'low', undefined, OPUS)).toBe('medium');
    await failTwice();
    expect(await x.step('L1', 'low', undefined, OPUS)).not.toBe('medium');
    expect(await x.rows()).toContainEqual(expect.objectContaining({ event: 'auto', agent: 'L1', from: 'high', to: 'medium', held: true }));
  });

  it('R-15: a registration that fails is logged and the plugin goes on', async () => {
    const x = engine();
    (x as any).registered.push = undefined;
    await expect(x.sessionStart()).resolves.toBeDefined();
    expect(x.logs.filter((line) => line.startsWith('effort-live-control: registering the effort_')).map((line) => line.slice(0, 55))).toEqual([
      'effort-live-control: registering the effort_up tool fai',
      'effort-live-control: registering the effort_down tool f',
      'effort-live-control: registering the effort_auto tool f',
    ]);
  });
});

suite('announcing a change', () => {
  it('the next tool result of the agent carries one line in context, appended to existing context, then it is cleared', async () => {
    const { x, failTwice, answer } = await withLead();
    await failTwice();
    await answer('80 - same failure after the fix');
    const first = await x.tool('L1', 'Bash', { command: 'ls' }, { result: {}, text: 'a b', context: ['earlier'] });
    expect(first.out.context).toEqual(['earlier', 'effort-live-control: your reasoning effort is now high — judge: same failure after the fix.']);
    const second = await x.tool('L1', 'Bash', { command: 'ls' }, { result: {}, text: 'a b' });
    expect(second.out.context).toBeUndefined();
  });

  it('a mechanical raise is told in the same tool result that caused it', async () => {
    const { x, run } = await withLead(LEAD, { judge: false });
    const first = await run('npm test', 'FAIL a');
    expect(first.out.context).toEqual(['effort-live-control: your reasoning effort is now high — a failing test run.']);
    const second = await run('npm test', 'FAIL a');
    expect(second.out.context).toEqual(['effort-live-control: your reasoning effort is now xhigh — 2nd failing test run in a row.']);
  });

  it('a deny carries nothing and the line waits for the next result', async () => {
    const { x, run } = await withLead(LEAD, { judge: false });
    await run('npm test', 'FAIL a');
    await run('npm test', 'FAIL a');
    const denied = await x.tool('L1', 'Write', {}, { deny: 'no' });
    expect(denied.out).toEqual({ deny: 'no' });
  });

  it('announce off tells nothing', async () => {
    const { run } = await withLead(LEAD, { judge: false, announce: false });
    await run('npm test', 'FAIL a');
    const second = await run('npm test', 'FAIL a');
    expect(second.out.context).toBeUndefined();
  });
});

suite('the end of a steered agent', () => {
  it('logs end with its requests by level and drops its state; the pin clears as before', async () => {
    const { x } = await withLead();
    await x.step('L1', 'low', undefined, OPUS);
    await x.step('L1', 'low', undefined, OPUS);
    x.statuses.set('L1', 'completed');
    await x.complete('L1', 'DONE');
    expect(await x.rows()).toContainEqual(expect.objectContaining({ event: 'end', agent: 'L1', type: 'lead', requests: { medium: 2 }, struggles: 0, judgeCalls: 0 }));
    expect(await x.step('L1', 'high', undefined, OPUS)).toBe('high');
  });

  it('keeps its state while the agent still runs or waits', async () => {
    const { x } = await withLead();
    x.statuses.set('L1', 'waiting');
    await x.complete('L1', 'waiting on a child');
    expect(await x.step('L1', 'low', undefined, OPUS)).toBe('medium');
    expect((await x.rows()).some((row) => row.event === 'end')).toBe(false);
  });
});

suite('the decision log', () => {
  it('R-16: writes a step row per steered request, with ts, agent and type, and no prompt or brief text', async () => {
    const { x } = await withLead();
    await x.step('L1', 'low', undefined, OPUS, 'private reasoning words');
    const rows = await x.rows();
    const step = rows.find((row) => row.event === 'step')!;
    expect(step).toMatchObject({ agent: 'L1', type: 'lead', model: OPUS, requested: 'low', sent: 'medium', struggle: false });
    expect(typeof step.ts).toBe('string');
    expect(JSON.stringify(rows)).not.toContain('Build X.');
    expect(JSON.stringify(rows)).not.toContain('private reasoning words');
  });

  it('R-16: judge rows carry no packet unless logPackets is on; with it, the packet and the answer', async () => {
    for (const logPackets of [false, true]) {
      const { x, failTwice, answer } = await withLead(LEAD, { logPackets });
      await failTwice();
      await answer('70 - cause unknown');
      const judge = (await x.rows()).find((row) => row.event === 'judge')!;
      if (logPackets) {
        expect(judge.packet).toContain('tripwire: a failing test run');
        expect(judge.answer).toBe('70 - cause unknown');
      } else {
        expect(judge).not.toHaveProperty('packet');
        expect(judge).not.toHaveProperty('answer');
      }
    }
  });

  it('R-16: an empty logFile turns the log off; a path with ~ is expanded from HOME', async () => {
    const off = engine(new Map(), { files: LEAD, options: { logFile: '' } });
    await off.spawned('Go.', 'L1', { subagentType: 'lead' });
    await off.step('L1', 'low', undefined, OPUS);
    await off.tick();
    expect([...off.files.keys()].filter((path) => path.endsWith('.jsonl'))).toEqual([]);
    const custom = engine(new Map(), { files: LEAD, options: { logFile: '~/logs/elc.jsonl' } });
    await custom.spawned('Go.', 'L1', { subagentType: 'lead' });
    await custom.step('L1', 'low', undefined, OPUS);
    await custom.tick();
    await custom.tick();
    expect(custom.files.has('/fixture-home/t/logs/elc.sess1.jsonl')).toBe(true);
  });

  it('option errors are reported once at the first hook, and the defaults apply', async () => {
    const x = engine(new Map(), { options: { floor: 'sideways' } });
    await x.spawned('Map X.', 'a1');
    await x.spawned('Map Y.', 'a2');
    expect(x.logs.filter((line) => line.includes('option "floor"'))).toEqual(['effort-live-control: option "floor" is "sideways", not a level (low, medium, high, xhigh, max); using the default "medium"']);
  });
});

// ---- the main chat: never steered here; the judge's model route ----

const say = (text: string) => ({ isAnswered: true, text, usage: USAGE });
const REFUSAL_403 = { isAnswered: false, reason: 'api-error', status: 403, error: 'oauth_org_not_allowed', usage: USAGE };

/** An engine with a steered `lead` agent L1 whose model calls (the judge's) are answered at once by `script.next`, each call recorded. */
async function withJudge(options: Record<string, unknown> = {}, extra: Opts = {}) {
  const calls: any[] = [];
  const script = { next: (): unknown => say('90 - stuck') };
  const x = engine(new Map(), { files: LEAD, ...extra, options: { judge: true, ...options }, reply: (request) => (calls.push(request), script.next()) });
  await x.spawned('Build X.', 'L1', { subagentType: 'lead' });
  const fail = async () => {
    await x.tool('L1', 'Bash', { command: 'npm test' }, { result: {}, text: 'FAIL a', isError: false });
    await x.tick();
    await x.tick();
  };
  return { x, calls, script, fail };
}

suite('main chat: never steered here', () => {
  it('main chat: every request goes at the effort it carries, through its own failing test runs and red sub-agent returns', async () => {
    const x = engine(new Map(), { files: LEAD });
    await x.sessionStart();
    for (const level of ['low', 'medium', 'high', 'xhigh', 'max', undefined]) expect(await x.mainStep(level, 't1', OPUS)).toBe(level);
    const { out, called } = await x.tool(undefined, 'Bash', { command: 'npm test' }, { result: {}, text: 'FAIL a', isError: false });
    expect(called).toBe(true);
    expect((out as any).context).toBeUndefined();
    expect(await x.mainStep('medium', 't1', OPUS)).toBe('medium');
    await x.spawned('Build X.', 'c1', { subagentType: 'general-purpose' });
    x.statuses.set('c1', 'completed');
    await x.complete('c1', 'BLOCKED builder: no access');
    expect(await x.mainStep('medium', 't2', OPUS)).toBe('medium');
    expect(x.judgeCalls).toEqual([]);
    expect((await x.rows()).filter((row) => row.agent === 'main' && row.type !== 'plugin')).toEqual([]);
  });

  it('main chat: sub-agents keep being steered with the main chat untouched (positive control)', async () => {
    const x = engine(new Map(), { files: LEAD, options: { judge: false } });
    await x.spawned('[effort: low]\nMap X.', 'a1');
    expect(await x.step('a1', 'high')).toBe('low');
    await x.spawned('Build X.', 'L1', { subagentType: 'lead' });
    expect(await x.mainStep('medium', 't1', OPUS)).toBe('medium');
    await x.tool('L1', 'Bash', { command: 'npm test' }, { result: {}, text: 'FAIL a', isError: false });
    expect(await x.step('L1', 'low', undefined, OPUS)).toBe('high');
    expect(await x.mainStep('medium', 't1', OPUS)).toBe('medium');
  });
});

suite("the judge's model route", () => {
  it.each([
    { name: 'default denial recovers on the current model', options: {}, status: 403, error: 'oauth_org_not_allowed', denied: false, models: ['haiku', OPUS, OPUS], answered: true, disabled: false },
    { name: 'both routes denied degrades once', options: {}, status: 403, error: 'oauth_org_not_allowed', denied: true, models: ['haiku', OPUS], answered: false, disabled: true },
    { name: 'explicit nondefault model is preserved', options: { judgeModel: 'sonnet' }, status: 403, error: 'oauth_org_not_allowed', denied: true, models: ['sonnet', 'sonnet'], answered: false, disabled: false },
    { name: 'transient failure does not change route', options: {}, status: 529, error: 'overloaded', denied: false, models: ['haiku', 'haiku'], answered: false, disabled: false },
    { name: 'other 403 does not change route', options: {}, status: 403, error: 'permission_denied', denied: false, models: ['haiku', 'haiku'], answered: false, disabled: false },
    { name: 'same error at 401 does not change route', options: {}, status: 401, error: 'oauth_org_not_allowed', denied: false, models: ['haiku', 'haiku'], answered: false, disabled: false },
  ])('judge model route: $name', async ({ options, status, error, denied, models, answered, disabled }) => {
    const { x, calls, script, fail } = await withJudge(options);
    script.next = () => calls.at(-1).model === OPUS && !denied
      ? say('90 - stuck')
      : { isAnswered: false, reason: 'api-error', status, error, usage: USAGE };
    await fail();
    await fail();
    expect(calls.map((call) => call.model)).toEqual(models);
    const judged = (await x.rows()).filter((row) => row.event === 'judge' || row.event === 'judge-failed');
    expect(judged).toHaveLength(2);
    expect(judged.at(-1)).toEqual(expect.objectContaining(answered ? { event: 'judge', p: 90 } : { event: 'judge-failed' }));
    expect(x.logs.filter((line) => line.includes('model judgment unavailable for this session'))).toHaveLength(disabled ? 1 : 0);
  });

  it('concurrent judge calls share the default fallback, switching once', async () => {
    const pending = [deferred<unknown>(), deferred<unknown>()];
    const files = { ...LEAD, ...agentFile('lead2', 'effort: medium\neffortControl: on') };
    const { x, calls, script } = await withJudge({}, { files });
    await x.spawned('Build Y.', 'L2', { subagentType: 'lead2' });
    script.next = () => calls.at(-1).model === 'haiku' ? pending[calls.length - 1]!.promise : say('90 - stuck');
    await x.tool('L1', 'Bash', { command: 'npm test' }, { result: {}, text: 'FAIL a', isError: false });
    await x.tool('L2', 'Bash', { command: 'npm test' }, { result: {}, text: 'FAIL a', isError: false });
    expect(calls.map((call) => call.model)).toEqual(['haiku', 'haiku']);
    pending[0]!.resolve(REFUSAL_403);
    await x.tick();
    pending[1]!.resolve(REFUSAL_403);
    await x.tick();
    await x.tick();
    expect(calls.map((call) => call.model)).toEqual(['haiku', 'haiku', OPUS, OPUS]);
    expect(await x.step('L1', 'low', undefined, OPUS)).toBe('high');
    expect(await x.step('L2', 'low', undefined, OPUS)).toBe('high');
  });
});

suite('plugin log adapter', () => {
  const exec = promisify(execFile);
  const dirs: string[] = [];
  const fresh = async () => { const dir = await mkdtemp(join(tmpdir(), 'effort-plugin-log-')); dirs.push(dir); return dir; };
  afterEach(async () => { vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
  const realRun: NonNullable<Opts['run']> = async (argv, init) => {
    try { const result = await exec('/bin/sh', argv.slice(1), { timeout: init?.timeoutMs }); return { exitCode: 0, ...result }; }
    catch (error: any) { return { exitCode: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? String(error) }; }
  };
  const readRows = async (dir: string, file: string) => {
    let text: string;
    try { text = await readFile(join(dir, file), 'utf8'); }
    catch (error: any) { if (error.code === 'ENOENT') return []; throw error; }
    return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  };

  it('screen policy: a recoverable warning stays off screen with an active log', async () => {
    const dir = await fresh();
    const x = engine(new Map(), { env: { PLUGIN_LOG_DIR: dir }, run: realRun, options: { logFile: '' }, toolList: async () => { throw new Error('list denied'); } });
    await x.sessionStart(); await x.tool(undefined, 'mcp__effort-live-control__effort_up', {}); await x.sessionEnd();
    expect(await readRows(join(dir, 'effort-live-control'), 'warnings.jsonl')).toContainEqual(expect.objectContaining({ event: 'tool-list-failed' }));
    expect(x.logs).toEqual([]);
  });

  it.each(['no destination', 'failed write'])('screen policy: a warning reaches the screen with %s', async (mode) => {
    const { x, calls, script, fail } = await withJudge({ logFile: '' }, {
      env: mode === 'no destination' ? { HOME: undefined, PLUGIN_LOG_DIR: undefined } : { PLUGIN_LOG_DIR: await fresh() },
      run: async () => ({ exitCode: 1, stdout: '', stderr: 'append denied' }),
    });
    script.next = () => calls.at(-1).model === 'haiku' ? REFUSAL_403 : say('90 - stuck');
    await fail(); await x.sessionEnd();
    expect(x.logs).toContainEqual(expect.stringContaining('default haiku refused'));
    expect(x.logs.filter((line) => line.includes('plugin log'))).toHaveLength(1);
    expect(await x.step('L1', 'low', undefined, OPUS)).toBe('high');
  });

  it('screen policy: a tool registration error always shows and is logged as an error', async () => {
    const dir = await fresh();
    const x = engine(undefined, { env: { PLUGIN_LOG_DIR: dir }, run: realRun, options: { logFile: '' } });
    x.$.tool.register = async () => { throw new Error('registration denied'); };
    await x.sessionStart(); await x.sessionEnd();
    expect(x.logs.filter((line) => line.includes('registration denied'))).toHaveLength(3);
    expect(await readRows(join(dir, 'effort-live-control'), 'errors.jsonl')).toEqual([
      expect.objectContaining({ event: 'tool-register-failed', level: 'error', msg: expect.stringContaining('effort_up') }),
      expect.objectContaining({ event: 'tool-register-failed', level: 'error', msg: expect.stringContaining('effort_down') }),
      expect.objectContaining({ event: 'tool-register-failed', level: 'error', msg: expect.stringContaining('effort_auto') }),
    ]);
  });

  it.each(['PLUGIN_LOG_DIR', 'fallback'])('writes forced error and warning through %s without changing answers', async (source) => {
    const dir = await fresh();
    const x = engine(undefined, { env: { HOME: dir, PLUGIN_LOG_DIR: source === 'PLUGIN_LOG_DIR' ? join(dir, 'levels') : undefined }, run: realRun, options: { logFile: '' }, files: LEAD, toolList: async () => { throw new Error('list denied'); } });
    await x.sessionStart(); await x.sessionStart();
    await x.spawned('Build X.', 'L1', { subagentType: 'lead' });
    expect(await x.mainStep('medium')).toBe('medium');
    expect((await x.tool(undefined, 'mcp__effort-live-control__effort_up', {})).out.result).toContain('the user sets it with /effort');
    vi.spyOn(Controller.prototype, 'onButton').mockImplementation(() => { throw new Error('unknown level'); });
    const result = await x.tool('L1', 'mcp__effort-live-control__effort_up', {});
    expect(result.out.result).toBe('Nothing changed: unknown level');
    expect(result.called).toBe(false);
    await x.sessionEnd();
    const target = source === 'PLUGIN_LOG_DIR' ? join(dir, 'levels/effort-live-control') : join(dir, '.local/state/effort-live-control/logs');
    expect(await readRows(target, 'errors.jsonl')).toEqual([expect.objectContaining({ ts: '2026-10-14T15:20:31.123Z', plugin: 'effort-live-control', level: 'error', event: 'answer-tool-failed', where: 'hooks/effort-live-control.ts#answerButton', session: 'sess1' })]);
    expect(await readRows(target, 'warnings.jsonl')).toContainEqual(expect.objectContaining({ level: 'warning', event: 'tool-list-failed', where: 'hooks/effort-live-control.ts#mainEffortTool' }));
    expect(x.logs).toContain('effort-live-control: answering mcp__effort-live-control__effort_up failed: unknown level; nothing changed');
  });

  it.each([
    { level: 'error', file: 'errors.jsonl', event: 'answer-tool-failed', component: 'answerButton', cause: 'unknown level' },
    { level: 'error', file: 'errors.jsonl', event: 'pin-unreadable', component: 'readPin', cause: 'pin store offline' },
  ])('queues $event before a throwing screen call', async ({ level, file, event, component, cause }) => {
    const dir = await fresh();
    const x = engine(undefined, { env: { PLUGIN_LOG_DIR: dir }, run: realRun, options: { logFile: '' }, files: LEAD });
    await x.sessionStart(); await x.spawned('Build X.', 'L1', { subagentType: 'lead' });
    x.$.ui.log = () => { throw new Error('screen offline'); };
    if (event === 'answer-tool-failed') vi.spyOn(Controller.prototype, 'onButton').mockImplementation(() => { throw new Error(cause); });
    else x.$.state.get = async () => { throw new Error(cause); };
    await expect(event === 'answer-tool-failed' ? x.tool('L1', 'mcp__effort-live-control__effort_up', {}) : x.step('unknown', 'medium')).rejects.toThrow('screen offline');
    await x.sessionEnd();
    expect(await readRows(join(dir, 'effort-live-control'), file)).toContainEqual(expect.objectContaining({
      plugin: 'effort-live-control', level, event, where: `hooks/effort-live-control.ts#${component}`, session: 'sess1', msg: expect.stringContaining(cause),
    }));
  });

  it('reports one process rejection per failing streak, then rearms after a successful real write', async () => {
    const dir = await fresh();
    let broken = true;
    const x = engine(undefined, { env: { PLUGIN_LOG_DIR: dir }, options: { logFile: '' }, files: LEAD, run: async (argv, init) => { if (broken) throw new Error('spawn denied'); return realRun(argv, init); } });
    await x.sessionStart(); await x.sessionEnd();
    vi.spyOn(Controller.prototype, 'onButton').mockImplementation(() => { throw new Error('unknown level'); });
    await x.spawned('Build X.', 'L1', { subagentType: 'lead' });
    await x.tool('L1', 'mcp__effort-live-control__effort_up', {}); await x.sessionEnd();
    const notices = () => x.logs.filter((line) => line.includes('plugin log'));
    expect(notices()).toHaveLength(1); expect(notices()[0]).toContain(join(dir, 'effort-live-control')); expect(notices()[0]).toContain('spawn denied');
    broken = false;
    await x.tool('L1', 'mcp__effort-live-control__effort_up', {}); await x.sessionEnd();
    expect(await readRows(join(dir, 'effort-live-control'), 'errors.jsonl')).toHaveLength(1);
    broken = true;
    await x.tool('L1', 'mcp__effort-live-control__effort_up', {}); await x.sessionEnd();
    expect(notices()).toHaveLength(2);
  });

  it('a failing plugin-log write also reaches the decision log, once per failing streak', async () => {
    // The invalid floor's option-error is an error: the requested setting cannot apply.
    const x = engine(undefined, { slowWrite: true, env: { PLUGIN_LOG_DIR: '/fixture-logs' }, options: { floor: 'invalid', logFile: '/fixture-home/t/elc.jsonl' }, run: async () => ({ exitCode: 1, stdout: '', stderr: 'chmod: --: No such file or directory' }) });
    await x.sessionStart(); await x.sessionEnd();
    // No tick after session.end: the row the final flush queues is on disk when the session ends.
    const text = x.files.get('/fixture-home/t/elc.sess1.jsonl') ?? '';
    const failed = text.split('\n').filter(Boolean).map((line) => JSON.parse(line)).filter((row) => row.event === 'plugin-log-failed');
    expect(failed).toHaveLength(1);
    expect(failed[0].error).toContain('chmod: --: No such file or directory');
    expect(x.logs.filter((line) => line.includes('plugin log'))).toHaveLength(1);
  });

  it('session.end still ends when the decision-log write fails and the screen door throws', async () => {
    const path = '/fixture-home/t/elc.sess1.jsonl';
    const x = engine(undefined, { uiThrows: true, broken: [path], files: { [path]: '' }, env: { PLUGIN_LOG_DIR: '/fixture-logs' }, options: { logFile: '/fixture-home/t/elc.jsonl' } });
    await x.sessionStart();
    let ended = false;
    await x.sessionEnd(async () => { ended = true; return {}; });
    expect(ended).toBe(true);
  });

  it.each(['no-process', 'no-home'])('keeps work unchanged and gives visible logger fallback for %s', async (mode) => {
    const dir = await fresh();
    const x = engine(undefined, { env: mode === 'no-home' ? { HOME: undefined, PLUGIN_LOG_DIR: undefined } : { PLUGIN_LOG_DIR: dir }, noProcess: mode === 'no-process', options: { floor: 'invalid', logFile: '' } });
    await x.sessionStart(); expect(await x.mainStep('medium')).toBe('medium'); await x.sessionEnd();
    const notice = x.logs.filter((line) => line.includes('plugin log'));
    expect(notice).toHaveLength(1);
    expect(notice[0]).toContain(mode === 'no-home' ? 'plugin log off: no PLUGIN_LOG_DIR and no HOME' : join(dir, 'effort-live-control'));
    if (mode === 'no-process') expect(notice[0]).toContain('process');
  });

  it.each(['HOME', 'PLUGIN_LOG_DIR'])('does not render a rejected %s read as ordinary absence', async (name) => {
    const dir = await fresh();
    const env: Record<string, string | undefined> = { HOME: dir, PLUGIN_LOG_DIR: join(dir, 'levels') };
    const x = engine(undefined, { env, run: realRun, options: { logFile: '' } });
    x.$.env.get = async (key) => { if (key === name) throw undefined; return env[key]; };
    await x.sessionStart(); await x.sessionEnd();
    const target = name === 'HOME' ? join(dir, 'levels/effort-live-control') : join(dir, '.local/state/effort-live-control/logs');
    expect(await readRows(target, name === 'HOME' ? 'errors.jsonl' : 'warnings.jsonl')).toContainEqual(expect.objectContaining({ event: name === 'HOME' ? 'home-missing' : 'plugin-log-dir-unreadable', msg: expect.stringContaining('failed: undefined') }));
  });

  it('logs unreadable pins, judge fallback and actual effort changes without decision packets', async () => {
    const dir = await fresh();
    const x = engine(undefined, { env: { PLUGIN_LOG_DIR: dir }, run: realRun, options: { judge: true, logFile: '', logPackets: true }, files: LEAD });
    await x.sessionStart();
    await x.spawned('Build X.', 'L1', { subagentType: 'lead' });
    expect(await x.step('L1', 'medium', undefined, OPUS)).toBe('medium');
    await x.tool('L1', 'Bash', { command: 'npm test', tool_input: { command: 'npm test' } }, { text: 'private test body', isError: true });
    expect(x.judgeCalls).toHaveLength(1);
    x.judgeCalls[0]!.resolve({ isAnswered: false, reason: 'aborted' });
    await x.tick();
    expect(await x.step('L1', 'medium', undefined, OPUS)).toBe('high');
    x.$.state.get = async () => { throw new Error('pin store offline'); };
    expect(await x.step('unknown', 'medium')).toBe('medium');
    await x.sessionEnd();
    const target = join(dir, 'effort-live-control');
    expect(await readRows(target, 'errors.jsonl')).toContainEqual(expect.objectContaining({ event: 'pin-unreadable', level: 'error' }));
    expect(await readRows(target, 'errors.jsonl')).toContainEqual(expect.objectContaining({ event: 'judge-failed', level: 'error', where: 'src/control.ts#failed' }));
    expect(await readRows(target, 'info.jsonl')).toContainEqual(expect.objectContaining({ event: 'effort-steered', detail: { agent: 'L1', from: 'medium', to: 'high' } }));
    const text = JSON.stringify(await readRows(target, 'errors.jsonl'));
    expect(text).not.toContain('private test body');
  });
});

suite('environment variables', () => {
  // Every option has its own EFFORT_LIVE_CONTROL_{OPTION} variable; a bad value names it in the first hook's report.
  const BAD: Array<[name: string, bad: string]> = [
    ['EFFORT_LIVE_CONTROL_FLOOR', 'sideways'],
    ['EFFORT_LIVE_CONTROL_CEILING', 'sideways'],
    ['EFFORT_LIVE_CONTROL_PARENT_TAG', 'maybe'],
    ['EFFORT_LIVE_CONTROL_MODELS', 'not json'],
    ['EFFORT_LIVE_CONTROL_JUDGE', 'maybe'],
    ['EFFORT_LIVE_CONTROL_JUDGE_RAISE_AT', '101'],
    ['EFFORT_LIVE_CONTROL_TRIPWIRES', 'bogus'],
    ['EFFORT_LIVE_CONTROL_STRUGGLE_DECAY', '-1'],
    ['EFFORT_LIVE_CONTROL_JUDGE_MODEL', 'two words'],
    ['EFFORT_LIVE_CONTROL_JUDGE_EFFORT', 'ultra'],
    ['EFFORT_LIVE_CONTROL_JUDGE_TIMEOUT_MS', '0'],
    ['EFFORT_LIVE_CONTROL_BUTTONS', 'yes'],
    ['EFFORT_LIVE_CONTROL_ANNOUNCE', 'yes'],
    ['EFFORT_LIVE_CONTROL_TEST_COMMAND_PATTERNS', '["(unclosed"]'],
    ['EFFORT_LIVE_CONTROL_READ_ONLY_COMMANDS', '["two words"]'],
    ['EFFORT_LIVE_CONTROL_FAILURE_PATTERNS', '["(unclosed"]'],
    ['EFFORT_LIVE_CONTROL_RED_WORDS', '["OK now"]'],
    ['EFFORT_LIVE_CONTROL_GREEN_WORDS', '[1]'],
    ['EFFORT_LIVE_CONTROL_AGENT_DIRS', '{"dir":"/x"}'],
    ['EFFORT_LIVE_CONTROL_LOG_PACKETS', 'yes'],
  ];

  it.each(BAD)('%s is read, and a bad value is reported by name with the default used', async (name, bad) => {
    const x = engine(new Map(), { env: { [name]: bad } });
    await x.sessionStart();
    expect(x.logs.filter((line) => line.includes(`environment variable ${name} is ${JSON.stringify(bad)}`))).toHaveLength(1);
    expect(x.logs.filter((line) => line.includes('option "'))).toEqual([]);
  });

  it('EFFORT_LIVE_CONTROL_LOG_FILE overrides the logFile option', async () => {
    const x = engine(new Map(), { env: { EFFORT_LIVE_CONTROL_LOG_FILE: '~/logs/env.jsonl' }, options: { logFile: '' } });
    await x.sessionStart();
    await x.tick();
    await x.tick();
    expect(x.files.has('/fixture-home/t/logs/env.sess1.jsonl')).toBe(true);
  });

  it('EFFORT_LIVE_CONTROL_BUTTONS decides whether the three tools register, over the buttons option', async () => {
    const off = engine(new Map(), { env: { EFFORT_LIVE_CONTROL_BUTTONS: '0' }, options: { buttons: true } });
    await off.sessionStart();
    expect(off.registered).toEqual([]);
    const on = engine(new Map(), { env: { EFFORT_LIVE_CONTROL_BUTTONS: ' ' }, options: { buttons: true } });
    await on.sessionStart();
    expect(on.registered.map((spec) => spec.name)).toEqual(['effort_up', 'effort_down', 'effort_auto']);
    const unset = engine(new Map(), { options: { buttons: false } });
    await unset.sessionStart();
    expect(unset.registered).toEqual([]);
  });

  it('EFFORT_LIVE_CONTROL_PARENT_TAG shapes the Agent tool description before any session start', async () => {
    const honor = await engine(new Map(), { env: { EFFORT_LIVE_CONTROL_PARENT_TAG: 'honor' }, options: { parentTag: 'ignore' } }).describeTool('Agent', 'Spawns.');
    const ignore = await engine(new Map(), { env: { EFFORT_LIVE_CONTROL_PARENT_TAG: 'ignore' } }).describeTool('Agent', 'Spawns.');
    expect(honor.description).not.toBe(ignore.description);
    expect((await engine(new Map(), { options: { parentTag: 'ignore' } }).describeTool('Agent', 'Spawns.')).description).toBe(ignore.description);
  });

  it('a variable that cannot be read is reported by name and the option decides', async () => {
    const x = engine(new Map(), { options: { buttons: false } });
    const read = x.$.env.get;
    x.$.env.get = async (name: string) => {
      if (name === 'EFFORT_LIVE_CONTROL_BUTTONS') throw new Error('env denied');
      return read(name);
    };
    await x.sessionStart();
    expect(x.registered).toEqual([]);
    expect(x.logs.join('\n')).toContain('effort-live-control: reading EFFORT_LIVE_CONTROL_BUTTONS failed: env denied; using the option or its default');
  });
});
