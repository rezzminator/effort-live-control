import { describe, expect, it } from 'vitest';
import { Controller, type Action, type Outcome, type Setup } from '../plugins/effort-live-control/src/control.ts';
import { TRIPWIRES, type Tripwire } from '../plugins/effort-live-control/src/judge.ts';
import { DEFAULTS } from '../plugins/effort-live-control/src/settings.ts';

const USAGE = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

function make(over: Partial<Setup> = {}): Controller {
  return new Controller({
    id: 'a1',
    type: 'lead',
    home: 'medium',
    floor: 'medium',
    ceiling: 'xhigh',
    judge: true,
    judgeRaiseAt: 25,
    tripwires: new Set(TRIPWIRES),
    landing: [],
    models: DEFAULTS.models,
    words: { red: DEFAULTS.redWords, green: DEFAULTS.greenWords },
    announce: true,
    struggleDecay: DEFAULTS.struggleDecay,
    brief: 'Coordinate the build of X.',
    ...over,
  });
}

const rows = (o: Outcome, event?: string) => o.actions.flatMap((a) => (a.kind === 'log' && (event === undefined || a.row.event === event) ? [a.row] : []));
const judges = (o: Outcome) => o.actions.filter((a): a is Extract<Action, { kind: 'judge' }> => a.kind === 'judge');
const FAIL = { command: 'npm test', failed: true, text: 'expected 3 got 4' };
const PASS = { command: 'npm test', failed: false, text: 'ok' };

/** Drives a judge-on controller through a first failing run (answered "hold") to its 2nd, and returns the 2nd's judge action. */
function fail2(c: Controller): Extract<Action, { kind: 'judge' }> {
  c.onTestRun(FAIL);
  c.onJudgeAnswer(1, '10 - hold', 1, USAGE);
  return judges(c.onTestRun(FAIL))[0]!;
}

describe('onRequest', () => {
  it('R-4: sends the level, home clamped into the range', () => {
    expect(make({ home: 'high' }).onRequest('claude-opus-5-5', 'low').send).toBe('high');
    expect(make({ home: 'low' }).onRequest('claude-opus-5-5', 'low').send).toBe('medium');
    expect(make({ home: 'max' }).onRequest('claude-opus-5-5', 'low').send).toBe('xhigh');
  });

  it('R-4: an allowed model matches as a prefix of the request model, bracket suffix included', () => {
    expect(make().onRequest('claude-opus-5-5[1m]', undefined).send).toBe('medium');
    expect(make().onRequest('claude-sonnet-5-5-20260101', undefined).send).toBe('medium');
  });

  it('R-4: an unallowed model passes through untouched, logged once per agent', () => {
    const c = make({ home: 'high' });
    const first = c.onRequest('claude-haiku-5-5', 'low');
    expect(first.send).toBeUndefined();
    expect(rows(first, 'model-gated')).toEqual([{ event: 'model-gated', model: 'claude-haiku-5-5' }]);
    expect(rows(c.onRequest('claude-haiku-5-5', 'low'), 'model-gated')).toEqual([]);
    expect(rows(c.onRequest('claude-haiku-5-5', 'low'), 'step')).toEqual([]);
  });

  it('R-4: writes a step row per steered request', () => {
    const c = make({ home: 'high' });
    expect(rows(c.onRequest('claude-opus-5-5', 'low'), 'step')).toEqual([{ event: 'step', model: 'claude-opus-5-5', requested: 'low', sent: 'high', struggle: false }]);
  });

  it('R-4: the tail of a non-empty answer is the agent\'s last words, whitespace collapsed to 400 chars', () => {
    const c = make();
    c.onRequest('claude-opus-5-5', undefined);
    c.onAnswer('first   words');
    c.onAnswer('');
    c.onAnswer(`${'x'.repeat(500)}\n\nend   here`);
    const p = fail2(c).packet;
    expect(p).toContain("agent's last words (tail): ");
    expect(p).toContain('x end here');
    expect(p).not.toContain('first words');
  });
});

describe('own test runs', () => {
  it('R-5: the first failing test run raises one step (judge off) and logs the fail1 tripwire', () => {
    const c = make({ judge: false });
    const out = c.onTestRun(FAIL);
    expect(c.level).toBe('high');
    expect(rows(out, 'mechanical')).toEqual([{ event: 'mechanical', tripwire: 'fail1', from: 'medium', to: 'high' }]);
    expect(c.takeAnnouncement()).toBe('effort-live-control: your reasoning effort is now high — a failing test run.');
  });

  it('R-5: the second failing run raises again up to the ceiling', () => {
    const c = make({ judge: false, ceiling: 'xhigh' });
    c.onTestRun(FAIL);
    const second = c.onTestRun(FAIL);
    expect(rows(second, 'mechanical')).toEqual([{ event: 'mechanical', tripwire: 'fail2', from: 'high', to: 'xhigh' }]);
    expect(c.level).toBe('xhigh');
    c.onTestRun(FAIL);
    const fourth = c.onTestRun(FAIL);
    expect(rows(fourth, 'mechanical')).toEqual([{ event: 'mechanical', tripwire: 'fail2', from: 'xhigh', to: 'xhigh' }]);
    expect(c.level).toBe('xhigh');
  });

  it('R-5: a pass between failures restarts the count at the first', () => {
    const c = make({ judge: false });
    c.onTestRun(FAIL);
    c.onTestRun(PASS);
    expect(c.level).toBe('medium');
    const out = c.onTestRun(FAIL);
    expect(rows(out, 'mechanical')).toEqual([{ event: 'mechanical', tripwire: 'fail1', from: 'medium', to: 'high' }]);
    expect(c.ownFails).toBe(1);
  });

  it('R-5: with the judge on, the first failing run asks the judge as fail1 and the 2nd as fail2', () => {
    const c = make();
    const first = judges(c.onTestRun(FAIL));
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ tripwire: 'fail1', epoch: 1 });
    expect(first[0]!.packet).toContain('tripwire: a failing test run\n');
    expect(judges(c.onTestRun(FAIL))).toHaveLength(0);
    expect(fail2(make())).toMatchObject({ tripwire: 'fail2', epoch: 1 });
  });

  it('R-5: fires at the 1st, 2nd, 4th and 6th failure, not at the 3rd or 5th', () => {
    const c = make({ judge: false });
    const fired = [1, 2, 3, 4, 5, 6].map(() => rows(c.onTestRun(FAIL), 'mechanical').map((row) => row.tripwire));
    expect(fired).toEqual([['fail1'], ['fail2'], [], ['fail2'], [], ['fail2']]);
  });

  it('R-5: the packet carries the tripwire, the events and the failing output tail', () => {
    const p = fail2(make()).packet;
    expect(p).toContain('agent: lead · model ');
    expect(p).toContain('tripwire: 2nd failing test run in a row');
    expect(p).toContain('brief (opening): Coordinate the build of X.');
    expect(p).toContain('- test FAIL: npm test\n- test FAIL: npm test');
    expect(p).toContain('last output of the failing run (tail): expected 3 got 4');
  });

  it('R-5: the event token holds the command to 70 chars', () => {
    const c = make();
    c.onTestRun({ command: `npm test -- ${'a'.repeat(100)}`, failed: false, text: '' });
    const p = fail2(c).packet;
    expect(p).toContain(`- test PASS: npm test -- ${'a'.repeat(58)}\n`);
    expect(p).not.toContain('a'.repeat(59));
  });
});

describe('child returns', () => {
  const spawned = (c: Controller, id = 'c1', type = 'builder', name?: string) => c.onSpawn({ childId: id, type, name });

  it('R-6: a red return on the child\'s own turn.complete adds its unit and fires the red tripwire', () => {
    const c = make();
    spawned(c);
    const out = c.onChildReturn('c1', 'FAIL parser: 3 tests red\nmore detail');
    expect(c.reds.has('parser')).toBe(true);
    expect(judges(out)[0]).toMatchObject({ tripwire: 'red' });
    expect(judges(out)[0]!.packet).toContain('- return builder FAIL: FAIL parser: 3 tests red');
    expect(judges(out)[0]!.packet).toContain('return (head): FAIL parser: 3 tests red more detail');
  });

  it('R-6: a return naming no unit takes the child\'s type as its unit', () => {
    const c = make();
    spawned(c, 'c1', 'lander');
    c.onChildReturn('c1', 'BLOCKED');
    expect([...c.reds]).toEqual(['lander']);
  });

  it('R-6: a green return removes its unit from the reds', () => {
    const c = make({ judge: false });
    spawned(c);
    c.onChildReturn('c1', 'FAIL parser');
    c.onSendMessage('c1');
    c.onChildReturn('c1', 'DONE parser');
    expect(c.reds.size).toBe(0);
  });

  it('R-6: a return line already seen since the last spawn or SendMessage is ignored', () => {
    const c = make({ judge: false });
    spawned(c);
    expect(rows(c.onChildReturn('c1', 'FAIL parser'), 'mechanical')).toHaveLength(1);
    expect(rows(c.onRead('1→FAIL parser'), 'mechanical')).toHaveLength(0);
    c.onSendMessage('c1');
    expect(rows(c.onRead('1→FAIL parser'), 'mechanical')).toHaveLength(1);
  });

  it('R-6: a Read result counts through its first line, with the name as unit and no known child as "?"', () => {
    const c = make();
    expect(judges(c.onRead('     1→FAIL unit-9: reason\n'))[0]).toMatchObject({ tripwire: 'red' });
    expect(c.reds.has('unit-9')).toBe(true);
    const d = make();
    d.onRead('BLOCKED');
    expect(d.reds.has('?')).toBe(true);
  });

  it('R-6: a Read of a return whose name is a known child\'s name reads as that child\'s type', () => {
    const c = make();
    spawned(c, 'c1', 'builder', 'b1');
    const out = c.onRead('FAIL b1');
    expect(judges(out)[0]!.packet).toContain('- return builder FAIL: FAIL b1');
  });

  it("return: a green return of the same type closes that type's only open red", () => {
    const c = make({ judge: false });
    spawned(c, 'c1', 'builder');
    c.onChildReturn('c1', 'FAIL unit-a: x');
    expect(c.struggleOpen).toBe(true);
    spawned(c, 'c2', 'builder');
    const out = c.onChildReturn('c2', 'DONE (no handoff)');
    expect(c.reds.size).toBe(0);
    expect(c.struggleOpen).toBe(false);
    expect(rows(out, 'resolved')).toHaveLength(1);
  });

  it('return: with two open reds of one type an unnamed green closes neither', () => {
    const c = make({ judge: false });
    spawned(c, 'c1', 'builder');
    c.onChildReturn('c1', 'FAIL unit-a: x');
    spawned(c, 'c2', 'builder');
    c.onChildReturn('c2', 'FAIL unit-b: y');
    spawned(c, 'c3', 'builder');
    c.onChildReturn('c3', 'DONE (no handoff)');
    expect([...c.reds].sort()).toEqual(['unit-a', 'unit-b']);
    expect(c.struggleOpen).toBe(true);
  });

  it('R-6: text that is not a return line changes nothing', () => {
    const c = make();
    spawned(c);
    const out = c.onChildReturn('c1', 'All good, finished.');
    expect(out.actions).toEqual([]);
    expect(c.reds.size).toBe(0);
  });

  it('R-6: the return token keeps the line to 100 chars', () => {
    const c = make();
    spawned(c);
    const p = judges(c.onChildReturn('c1', `FAIL x: ${'y'.repeat(200)}`))[0]!.packet;
    const event = p.split('\n').find((line) => line.startsWith('- return'));
    expect(event).toBe(`- return builder FAIL: FAIL x: ${'y'.repeat(92)}`);
  });
});

describe('re-dispatch', () => {
  function withRed(): Controller {
    const c = make();
    c.onSpawn({ childId: 'c1', type: 'builder', name: 'b1' });
    c.onChildReturn('c1', 'FAIL parser');
    return c;
  }

  it('R-7: a SendMessage to a red child by id fires the redispatch tripwire', () => {
    const c = withRed();
    c.onJudgeFailure(1, 'timeout');
    const out = c.onSendMessage('c1');
    expect(c.struggleOpen).toBe(true);
    expect(rows(out, 'judge-busy').length + judges(out).length).toBe(1);
  });

  it('R-7: a SendMessage to a red child by name fires it, with a packet reading "sent back to a sub-task"', () => {
    const c = withRed();
    c.onJudgeFailure(1, 'timeout');
    const out = c.onSendMessage('b1');
    expect(judges(out)[0]).toMatchObject({ tripwire: 'redispatch' });
    expect(judges(out)[0]!.packet).toContain('tripwire: a red result sent back to a sub-task');
    expect(judges(out)[0]!.packet).toContain('- sendmessage → builder');
    expect(judges(out)[0]!.packet).toContain('return (head): FAIL parser');
  });

  it('R-7: a SendMessage to a child that is not red fires nothing', () => {
    const c = make();
    c.onSpawn({ childId: 'c1', type: 'builder' });
    expect(judges(c.onSendMessage('c1'))).toHaveLength(0);
    expect(judges(c.onSendMessage('someone-else'))).toHaveLength(0);
  });

  it('R-7: spawning an agent of the type of a red child fires it', () => {
    const c = withRed();
    c.onJudgeFailure(1, 'timeout');
    const out = c.onSpawn({ childId: 'c2', type: 'builder' });
    expect(judges(out)[0]).toMatchObject({ tripwire: 'redispatch' });
    expect(judges(out)[0]!.packet).toContain('- spawn builder');
  });

  it('R-7: spawning another type fires nothing', () => {
    const c = withRed();
    c.onJudgeFailure(1, 'timeout');
    expect(judges(c.onSpawn({ childId: 'c2', type: 'reviewer' }))).toHaveLength(0);
  });
});

describe('a tripwire', () => {
  it('R-8: opens a struggle at the base level and starts one judge call', () => {
    const c = make({ home: 'high' });
    const j = fail2(c);
    expect(c.struggleOpen).toBe(true);
    expect(j).toMatchObject({ kind: 'judge', epoch: 1, tripwire: 'fail2' });
  });

  it('R-8: a request issued while the judge is pending goes at the old level, the next one after the answer at the new level', () => {
    const c = make();
    fail2(c);
    expect(c.onRequest('claude-opus-5-5', undefined).send).toBe('medium');
    c.onJudgeAnswer(1, '85 - same test fails after the fix', 800, USAGE);
    expect(c.onRequest('claude-opus-5-5', undefined).send).toBe('high');
  });

  it('R-8: with the judge on, p at or above judgeRaiseAt raises one step', () => {
    const at = make();
    fail2(at);
    at.onJudgeAnswer(1, '25 - exactly at the line', 5, USAGE);
    expect(at.level).toBe('high');
    const above = make({ ceiling: 'max', home: 'xhigh' });
    fail2(above);
    above.onJudgeAnswer(1, '100 - certain', 5, USAGE);
    expect(above.level).toBe('max');
    const custom = make({ judgeRaiseAt: 60 });
    fail2(custom);
    custom.onJudgeAnswer(1, '60 - at the custom line', 5, USAGE);
    expect(custom.level).toBe('high');
  });

  it('R-8: with the judge on, p below judgeRaiseAt holds the current level', () => {
    const c = make();
    fail2(c);
    const out = c.onJudgeAnswer(1, '24 - plain fix', 5, USAGE);
    expect(c.level).toBe('medium');
    expect(c.takeAnnouncement()).toBeUndefined();
    expect(rows(out, 'judge')).toEqual([{ event: 'judge', tripwire: 'fail2', p: 24, from: 'medium', to: 'medium', reason: 'plain fix', ms: 5, usage: USAGE }]);
    const custom = make({ judgeRaiseAt: 60 });
    fail2(custom);
    custom.onJudgeAnswer(1, '59 - below the custom line', 5, USAGE);
    expect(custom.level).toBe('medium');
  });

  it('R-8: the judge never lowers', () => {
    const c = make({ home: 'high' });
    fail2(c);
    c.onJudgeAnswer(1, '0 - nothing wrong', 5, USAGE);
    expect(c.level).toBe('high');
    c.onTestRun(FAIL);
    const j = judges(c.onTestRun(FAIL))[0]!;
    expect(j.tripwire).toBe('fail2');
    const top = make({ home: 'xhigh' });
    fail2(top);
    top.onJudgeAnswer(1, '99 - at the ceiling', 5, USAGE);
    expect(top.level).toBe('xhigh');
  });

  it('R-8: an answer logs the judge row with its tripwire, p, levels, reason, time and usage', () => {
    const c = make();
    fail2(c);
    const out = c.onJudgeAnswer(1, '70 - cause unknown', 812, USAGE);
    expect(c.level).toBe('high');
    expect(rows(out, 'judge')).toEqual([{ event: 'judge', tripwire: 'fail2', p: 70, from: 'medium', to: 'high', reason: 'cause unknown', ms: 812, usage: USAGE }]);
  });

  it('R-8: a second tripwire while a call is in flight logs judge-busy and starts no other call', () => {
    const c = make();
    fail2(c);
    c.onTestRun(FAIL);
    const out = c.onTestRun(FAIL);
    expect(judges(out)).toHaveLength(0);
    expect(rows(out, 'judge-busy')).toHaveLength(1);
  });

  it('R-8: an answer after the struggle closed is stale and changes nothing', () => {
    const c = make();
    fail2(c);
    c.onTestRun(PASS);
    const out = c.onJudgeAnswer(1, '90 - x', 100, USAGE);
    expect(rows(out, 'judge-stale')).toHaveLength(1);
    expect(c.level).toBe('medium');
  });

  it('R-8: an answer for an earlier struggle\'s epoch is stale', () => {
    const c = make();
    fail2(c);
    c.onTestRun(PASS);
    c.onTestRun(FAIL); // the new struggle's tripwires raise on their own while the old call is out
    c.onTestRun(FAIL);
    expect(c.level).toBe('xhigh');
    const out = c.onJudgeAnswer(1, '90 - x', 100, USAGE);
    expect(rows(out, 'judge-stale')).toHaveLength(1);
    expect(c.level).toBe('xhigh');
  });

  it('R-8: with the judge off, a tripwire raises one step mechanically, clamped to the ceiling', () => {
    const c = make({ judge: false, ceiling: 'high' });
    const first = c.onTestRun(FAIL);
    expect(judges(first)).toHaveLength(0);
    expect(rows(first, 'mechanical')).toEqual([{ event: 'mechanical', tripwire: 'fail1', from: 'medium', to: 'high' }]);
    expect(c.level).toBe('high');
    const second = c.onTestRun(FAIL);
    expect(rows(second, 'mechanical')).toEqual([{ event: 'mechanical', tripwire: 'fail2', from: 'high', to: 'high' }]);
    c.onTestRun(FAIL);
    c.onTestRun(FAIL);
    expect(c.level).toBe('high');
  });
});

describe('a judge that gives no level', () => {
  it('R-9: a call that timed out or went unanswered raises one step and logs judge-failed with the reason', () => {
    const c = make();
    fail2(c);
    const out = c.onJudgeFailure(1, 'aborted');
    expect(c.level).toBe('high');
    expect(rows(out, 'judge-failed')).toEqual([{ event: 'judge-failed', tripwire: 'fail2', reason: 'aborted', from: 'medium', to: 'high' }]);
  });

  it('R-9: an answer without a leading number is unparsed and raises one step', () => {
    const c = make();
    fail2(c);
    const out = c.onJudgeAnswer(1, 'I think maybe high', 700, USAGE);
    expect(c.level).toBe('high');
    expect(rows(out, 'judge-failed')[0]).toMatchObject({ reason: 'unparseable answer' });
  });

  it('R-9: a number above 100 does not parse', () => {
    const c = make();
    fail2(c);
    c.onJudgeAnswer(1, '150 - panic', 700, USAGE);
    expect(c.level).toBe('high');
  });

  it('R-9: a failure for a closed struggle logs but raises nothing', () => {
    const c = make();
    fail2(c);
    c.onTestRun(PASS);
    const out = c.onJudgeFailure(1, 'aborted');
    expect(c.level).toBe('medium');
    expect(rows(out, 'judge-failed')).toHaveLength(1);
  });

  it('R-9: after a failure the next tripwire may start a new call', () => {
    const c = make();
    fail2(c);
    c.onJudgeFailure(1, 'aborted');
    c.onTestRun(FAIL);
    expect(judges(c.onTestRun(FAIL))).toHaveLength(1);
  });
});

describe('resolution', () => {
  it('R-10: a passing test run with no red unit restores the pre-struggle level and logs resolved', () => {
    const c = make({ home: 'high' });
    fail2(c);
    c.onJudgeAnswer(1, '90 - stuck', 100, USAGE);
    c.onRequest('claude-opus-5-5', undefined);
    c.onRequest('claude-opus-5-5', undefined);
    const out = c.onTestRun(PASS);
    expect(c.level).toBe('high');
    expect(c.struggleOpen).toBe(false);
    expect(rows(out, 'resolved')).toEqual([{ event: 'resolved', from: 'xhigh', to: 'high', requests: 2, why: 'resolved' }]);
  });

  it('R-10: a pass does not resolve while a red unit is open; the green return then does', () => {
    const c = make({ judge: false });
    c.onSpawn({ childId: 'c1', type: 'builder' });
    c.onChildReturn('c1', 'FAIL parser');
    expect(c.level).toBe('high');
    c.onTestRun(PASS);
    expect(c.struggleOpen).toBe(true);
    c.onSendMessage('c1');
    c.onChildReturn('c1', 'DONE parser');
    expect(c.struggleOpen).toBe(false);
    expect(c.level).toBe('medium');
  });

  it('R-10: a green return does not resolve while own test runs still fail', () => {
    const c = make({ judge: false });
    c.onSpawn({ childId: 'c1', type: 'builder' });
    c.onChildReturn('c1', 'FAIL parser');
    c.onTestRun(FAIL);
    c.onSendMessage('c1');
    c.onChildReturn('c1', 'DONE parser');
    expect(c.struggleOpen).toBe(true);
    c.onTestRun(PASS);
    expect(c.struggleOpen).toBe(false);
  });

  it('R-10: a judge answer after resolution is stale', () => {
    const c = make();
    fail2(c);
    c.onTestRun(PASS);
    expect(c.struggleOpen).toBe(false);
    c.onJudgeAnswer(1, '90 - x', 1, USAGE);
    expect(c.level).toBe('medium');
  });
});

describe('landing', () => {
  it('R-11: spawning a landing type drops base one step below home, floored', () => {
    const c = make({ home: 'high', landing: ['lander'] });
    const out = c.onSpawn({ childId: 'c1', type: 'lander' });
    expect(c.level).toBe('medium');
    expect(c.base).toBe('medium');
    expect(rows(out, 'landing')).toEqual([{ event: 'landing', from: 'high', to: 'medium' }]);
    const low = make({ home: 'medium', landing: ['lander'] });
    low.onSpawn({ childId: 'c1', type: 'lander' });
    expect(low.level).toBe('medium');
  });

  it('R-11: another type does not land', () => {
    const c = make({ home: 'high', landing: ['lander'] });
    c.onSpawn({ childId: 'c1', type: 'builder' });
    expect(c.level).toBe('high');
  });

  it('R-11: during a struggle landing moves the level it resolves to, not the current one', () => {
    const c = make({ home: 'high', landing: ['lander'] });
    fail2(c);
    c.onJudgeAnswer(1, '90 - stuck', 1, USAGE);
    c.onSpawn({ childId: 'c1', type: 'lander' });
    expect(c.level).toBe('xhigh');
    c.onTestRun(PASS);
    expect(c.level).toBe('medium');
  });

  it('R-11: a lander\'s red return is an ordinary red return', () => {
    const c = make({ home: 'high', landing: ['lander'] });
    c.onSpawn({ childId: 'c1', type: 'lander' });
    expect(judges(c.onChildReturn('c1', 'BLOCKED ci')).map((j) => j.tripwire)).toEqual(['red']);
  });
});

describe('buttons', () => {
  it('R-12: up raises one step and, outside a struggle, moves the base with it', () => {
    const c = make();
    const out = c.onButton('up');
    expect(out.text).toBe('Effort raised to high for your next replies (your range medium..xhigh); it holds until you call effort_auto.');
    expect(c.level).toBe('high');
    expect(c.base).toBe('high');
    expect(c.held).toBe(true);
    expect(rows(out, 'button')).toEqual([{ event: 'button', direction: 'up', from: 'medium', to: 'high' }]);
  });

  it('R-12: down lowers one step', () => {
    const c = make({ home: 'high' });
    expect(c.onButton('down').text).toBe('Effort lowered to medium for your next replies (your range medium..xhigh); it holds until you call effort_auto.');
  });

  it('R-12: at a bound it answers the bound text, keeps the level and still holds it', () => {
    const c = make({ home: 'xhigh' });
    expect(c.onButton('up').text).toBe('Your effort is already xhigh, the ceiling of your range; it holds there until you call effort_auto.');
    const d = make({ judge: false });
    const out = d.onButton('down');
    expect(out.text).toBe('Your effort is already medium, the floor of your range; it holds there until you call effort_auto.');
    expect(rows(out, 'button')).toEqual([{ event: 'button', direction: 'down', from: 'medium', to: 'medium' }]);
    expect(d.held).toBe(true);
    d.onTestRun(FAIL);
    expect(d.level).toBe('medium');
  });

  it('R-12: during a struggle the base stays, and the pressed level outlives the resolution', () => {
    const c = make();
    fail2(c);
    c.onButton('up');
    expect(c.level).toBe('high');
    expect(c.base).toBe('medium');
    c.onTestRun(PASS);
    expect(c.struggleOpen).toBe(false);
    expect(c.level).toBe('high');
  });
});

describe('a press while the model is not steered', () => {
  it('each button says the level waits for a steered model, and that model then gets it', () => {
    const c = make({ judge: false, models: ['claude-opus'] });
    expect(c.onRequest('claude-haiku-5-5', 'low').send).toBeUndefined();
    const note = ' Your current model, claude-haiku-5-5, is not steered here: the level applies once a steered model answers.';
    expect(c.onButton('up').text).toBe(`Effort raised to high for your next replies (your range medium..xhigh); it holds until you call effort_auto.${note}`);
    expect(c.onAuto().text).toBe(`Effort back to medium, your home level, for your next replies (your range medium..xhigh); the automatic rules steer it again.${note}`);
    expect(c.onButton('down').text).toBe(`Your effort is already medium, the floor of your range; it holds there until you call effort_auto.${note}`);
    c.onButton('up');
    expect(c.onRequest('claude-opus-5-5', 'low').send).toBe('high');
    expect(c.onButton('up').text).toBe('Effort raised to xhigh for your next replies (your range medium..xhigh); it holds until you call effort_auto.');
  });
});

describe('the hold: no automatic rule moves a pressed level', () => {
  const MODEL = 'claude-opus-5-5';

  it('hold: a tripwire counts its struggle and logs a held row, but raises nothing (judge off)', () => {
    const c = make({ home: 'high', judge: false });
    c.onButton('down');
    const out = c.onTestRun(FAIL);
    expect(c.level).toBe('medium');
    expect(c.struggleOpen).toBe(true);
    expect(rows(out, 'mechanical')).toEqual([]);
    expect(rows(out, 'tripwire')).toEqual([{ event: 'tripwire', tripwire: 'fail1', level: 'medium', held: true }]);
    expect(c.end()).toMatchObject({ struggles: 1 });
  });

  it('hold: a tripwire asks no judge (judge on)', () => {
    const c = make({ home: 'high' });
    c.onButton('up');
    const out = c.onTestRun(FAIL);
    expect(judges(out)).toEqual([]);
    expect(rows(out, 'tripwire')).toEqual([{ event: 'tripwire', tripwire: 'fail1', level: 'xhigh', held: true }]);
    expect(c.end()).toMatchObject({ judgeCalls: 0 });
  });

  it('hold: a judge answer that arrives after the press changes nothing', () => {
    const c = make();
    fail2(c);
    c.onButton('up');
    const out = c.onJudgeAnswer(1, '90 - stuck', 1, USAGE);
    expect(c.level).toBe('high');
    expect(rows(out, 'judge')).toEqual([expect.objectContaining({ tripwire: 'fail2', p: 90, from: 'high', to: 'high', held: true })]);
  });

  it('hold: a judge failure after the press changes nothing', () => {
    const c = make();
    fail2(c);
    c.onButton('up');
    const out = c.onJudgeFailure(1, 'aborted');
    expect(c.level).toBe('high');
    expect(rows(out, 'judge-failed')).toEqual([expect.objectContaining({ reason: 'aborted', from: 'high', to: 'high', held: true })]);
  });

  it('hold: decay ends the struggle but leaves the level', () => {
    const c = make({ judge: false, struggleDecay: 3 });
    c.onTestRun(FAIL);
    c.onButton('up');
    const out = [c.onRequest(MODEL, undefined), c.onRequest(MODEL, undefined), c.onRequest(MODEL, undefined)];
    expect(out.flatMap((o) => rows(o, 'resolved'))).toEqual([{ event: 'resolved', from: 'xhigh', to: 'xhigh', requests: 3, why: 'decay', held: true }]);
    expect(c.struggleOpen).toBe(false);
    expect(c.onRequest(MODEL, undefined).send).toBe('xhigh');
  });

  it('hold: resolution ends the struggle but leaves the level, and announces nothing', () => {
    const c = make({ judge: false });
    c.onTestRun(FAIL);
    c.takeAnnouncement();
    c.onButton('up');
    const out = c.onTestRun(PASS);
    expect(rows(out, 'resolved')).toEqual([{ event: 'resolved', from: 'xhigh', to: 'xhigh', requests: 0, why: 'resolved', held: true }]);
    expect(c.level).toBe('xhigh');
    expect(c.takeAnnouncement()).toBeUndefined();
  });

  it('hold: the landing step leaves the level', () => {
    const c = make({ home: 'high', landing: ['lander'] });
    c.onButton('up');
    const out = c.onSpawn({ childId: 'c1', type: 'lander' });
    expect(c.level).toBe('xhigh');
    expect(rows(out, 'landing')).toEqual([{ event: 'landing', from: 'xhigh', to: 'xhigh', held: true }]);
  });
});

describe('effort_auto', () => {
  it('effort_auto: back to the home level, the hold cleared, and the rules steer again', () => {
    const c = make({ home: 'high', judge: false });
    c.onButton('up');
    const out = c.onAuto();
    expect(out.text).toBe('Effort back to high, your home level, for your next replies (your range medium..xhigh); the automatic rules steer it again.');
    expect(rows(out, 'auto')).toEqual([{ event: 'auto', from: 'xhigh', to: 'high', held: true }]);
    expect(c.level).toBe('high');
    expect(c.base).toBe('high');
    expect(c.held).toBe(false);
    c.onTestRun(FAIL);
    expect(c.level).toBe('xhigh');
  });

  it('effort_auto: the home is held within the range', () => {
    const low = make({ home: 'low' });
    low.onButton('up');
    low.onAuto();
    expect(low.level).toBe('medium');
    const max = make({ home: 'max' });
    max.onButton('down');
    max.onAuto();
    expect(max.level).toBe('xhigh');
  });

  it('effort_auto: at home already it says so and still clears the hold', () => {
    const c = make({ home: 'high', judge: false });
    c.onButton('up');
    c.onButton('down');
    const out = c.onAuto();
    expect(out.text).toBe('Your effort is already high, your home level; the automatic rules steer it again.');
    expect(c.held).toBe(false);
    c.onTestRun(FAIL);
    expect(c.level).toBe('xhigh');
  });

  it("effort_auto: an open struggle stays open and resolves to the home level, not to its own pre level", () => {
    const c = make({ home: 'high', judge: false, landing: ['lander'] });
    c.onTestRun(FAIL);
    c.onSpawn({ childId: 'c1', type: 'lander' }); // the struggle would resolve one step below home
    c.onButton('down');
    c.onAuto();
    expect(c.level).toBe('high');
    expect(c.struggleOpen).toBe(true);
    c.onTestRun(FAIL);
    expect(c.level).toBe('xhigh');
    c.onTestRun(PASS);
    expect(c.level).toBe('high');
  });
});

describe('announcements', () => {
  it('queues one line per level change, handed over once', () => {
    const c = make({ judge: false });
    c.onTestRun(FAIL);
    expect(c.takeAnnouncement()).toBe('effort-live-control: your reasoning effort is now high — a failing test run.');
    c.onTestRun(FAIL);
    expect(c.takeAnnouncement()).toBe('effort-live-control: your reasoning effort is now xhigh — 2nd failing test run in a row.');
    expect(c.takeAnnouncement()).toBeUndefined();
  });

  it('names the child and its token for a red return, and the type for a re-dispatch', () => {
    const c = make({ judge: false });
    c.onSpawn({ childId: 'c1', type: 'lander' });
    c.onChildReturn('c1', 'BLOCKED');
    expect(c.takeAnnouncement()).toContain('— lander returned BLOCKED.');
    c.onSendMessage('c1');
    expect(c.takeAnnouncement()).toContain('— lander sent back a red result.');
  });

  it('a newer change replaces an undelivered line', () => {
    const c = make({ judge: false });
    c.onTestRun(FAIL);
    c.onTestRun(FAIL);
    c.onTestRun(PASS);
    expect(c.takeAnnouncement()).toBe('effort-live-control: your reasoning effort is now medium — the trouble is resolved, back to medium.');
  });

  it('a press drops an undelivered line: its own result is the last word on the level (a step, a bound, effort_auto)', () => {
    const presses: Array<[string, Partial<Setup>, (c: Controller) => unknown]> = [
      ['effort_up', {}, (c) => c.onButton('up')],
      ['effort_up at the ceiling', { ceiling: 'high' }, (c) => c.onButton('up')],
      ['effort_auto', {}, (c) => c.onAuto()],
    ];
    for (const [name, over, press] of presses) {
      const c = make({ judge: false, ...over });
      c.onTestRun(FAIL);
      expect(c.level, name).toBe('high');
      press(c);
      expect(c.takeAnnouncement(), name).toBeUndefined();
    }
  });

  it('carries the judge\'s reason', () => {
    const c = make();
    fail2(c);
    c.onJudgeAnswer(1, '85 - cause unknown', 1, USAGE);
    expect(c.takeAnnouncement()).toBe('effort-live-control: your reasoning effort is now high — judge: cause unknown.');
  });

  it('R-11: carries the landing line', () => {
    const c = make({ home: 'high', landing: ['lander'] });
    c.onSpawn({ childId: 'c1', type: 'lander' });
    expect(c.takeAnnouncement()).toBe('effort-live-control: your reasoning effort is now medium — landing, one step below your home level.');
  });

  it('says "judge unavailable" after a failed call', () => {
    const c = make();
    fail2(c);
    c.onJudgeFailure(1, 'aborted');
    expect(c.takeAnnouncement()).toBe('effort-live-control: your reasoning effort is now high — judge unavailable, raised one step.');
  });

  it('says nothing for a change that leaves the level where it was, for a button press, or with announce off', () => {
    const c = make();
    fail2(c);
    c.onJudgeAnswer(1, '10 - plain fix', 1, USAGE);
    expect(c.takeAnnouncement()).toBeUndefined();
    c.onButton('up');
    expect(c.takeAnnouncement()).toBeUndefined();
    const quiet = make({ judge: false, announce: false });
    quiet.onTestRun(FAIL);
    quiet.onTestRun(FAIL);
    expect(quiet.level).toBe('xhigh');
    expect(quiet.takeAnnouncement()).toBeUndefined();
  });
});

describe('end', () => {
  it('summarises requests by level, struggles and judge calls', () => {
    const c = make();
    c.onRequest('claude-opus-5-5', undefined);
    fail2(c);
    c.onJudgeAnswer(1, '80 - x', 1, USAGE);
    c.onRequest('claude-opus-5-5', undefined);
    c.onRequest('claude-opus-5-5', undefined);
    expect(c.end()).toEqual({ event: 'end', requests: { medium: 1, high: 2 }, struggles: 1, judgeCalls: 2, judgeTokens: { input: 20, output: 10 } });
  });
});

describe('tripwires', () => {
  const redChild = (c: Controller) => {
    c.onSpawn({ childId: 'c1', type: 'builder', name: 'b1' });
    return c.onChildReturn('c1', 'FAIL parser');
  };

  it('tripwires: the default arms all four', () => {
    const first = make({ judge: false });
    expect(rows(first.onTestRun(FAIL), 'mechanical')).toMatchObject([{ tripwire: 'fail1' }]);
    expect(rows(first.onTestRun(FAIL), 'mechanical')).toMatchObject([{ tripwire: 'fail2' }]);
    const red = make({ judge: false });
    expect(rows(redChild(red), 'mechanical')).toMatchObject([{ tripwire: 'red' }]);
    expect(rows(red.onSpawn({ childId: 'c2', type: 'builder' }), 'mechanical')).toMatchObject([{ tripwire: 'redispatch' }]);
  });

  it('tripwires: with fail1 off the first failing run holds and the second raises', () => {
    const c = make({ judge: false, tripwires: new Set(['fail2', 'red', 'redispatch']) });
    const first = c.onTestRun(FAIL);
    expect(first.actions).toEqual([]);
    expect(c.struggleOpen).toBe(false);
    expect(c.level).toBe('medium');
    expect(c.ownFails).toBe(1);
    const second = c.onTestRun(FAIL);
    expect(rows(second, 'mechanical')).toEqual([{ event: 'mechanical', tripwire: 'fail2', from: 'medium', to: 'high' }]);
    expect(c.level).toBe('high');
  });

  it('tripwires: a disarmed tripwire still enters the event ring the judge reads', () => {
    const c = make({ tripwires: new Set(['fail2']) });
    expect(judges(c.onTestRun(FAIL))).toHaveLength(0);
    const call = judges(c.onTestRun(FAIL))[0]!;
    expect(call.tripwire).toBe('fail2');
    expect(call.packet.match(/- test FAIL: npm test/g)).toHaveLength(2);
  });

  it('tripwires: with red off a red return holds and a redispatch of it still raises', () => {
    const c = make({ judge: false, tripwires: new Set(['fail1', 'fail2', 'redispatch']) });
    const out = redChild(c);
    expect(out.actions).toEqual([]);
    expect(c.struggleOpen).toBe(false);
    expect(c.level).toBe('medium');
    expect([...c.reds]).toEqual(['parser']);
    expect(rows(c.onSpawn({ childId: 'c2', type: 'builder' }), 'mechanical')).toEqual([{ event: 'mechanical', tripwire: 'redispatch', from: 'medium', to: 'high' }]);
    expect(c.level).toBe('high');
  });

  it('tripwires: an empty list arms none', () => {
    const c = make({ tripwires: new Set() });
    expect(c.onTestRun(FAIL).actions).toEqual([]);
    expect(c.onTestRun(FAIL).actions).toEqual([]);
    expect(c.onTestRun(FAIL).actions).toEqual([]);
    expect(c.ownFails).toBe(3);
    expect(redChild(c).actions).toEqual([]);
    expect(c.onSpawn({ childId: 'c2', type: 'builder' }).actions).toEqual([]);
    expect(c.onSendMessage('c1').actions).toEqual([]);
    expect(c.struggleOpen).toBe(false);
    expect(c.level).toBe('medium');
    expect(c.end()).toMatchObject({ struggles: 0, judgeCalls: 0 });
  });
});

describe('judge-busy', () => {
  it('judge-busy: a tripwire in a new struggle while the old struggle\'s call is in flight raises one step mechanically', () => {
    const c = make();
    expect(judges(c.onTestRun(FAIL))).toHaveLength(1); // epoch 1, in flight
    c.onTestRun(PASS); // struggle 1 resolves
    const out = c.onTestRun(FAIL); // struggle 2 opens while call 1 is still out
    expect(judges(out)).toHaveLength(0);
    expect(rows(out, 'judge-busy')).toEqual([]);
    expect(rows(out, 'mechanical')).toEqual([{ event: 'mechanical', tripwire: 'fail1', from: 'medium', to: 'high', busy: true }]);
    expect(c.level).toBe('high');
    const late = c.onJudgeAnswer(1, '90 - x', 100, USAGE);
    expect(rows(late, 'judge-stale')).toHaveLength(1);
    expect(c.level).toBe('high');
    // the slot is clear: the next tripwire of the open struggle asks the judge
    expect(judges(c.onTestRun(FAIL))).toHaveLength(1);
  });

  it('judge-busy: a tripwire in a new struggle clamps at the ceiling', () => {
    const c = make({ ceiling: 'medium' });
    c.onTestRun(FAIL);
    c.onTestRun(PASS);
    const out = c.onTestRun(FAIL);
    expect(rows(out, 'mechanical')).toEqual([{ event: 'mechanical', tripwire: 'fail1', from: 'medium', to: 'medium', busy: true }]);
  });

  it('judge-busy: a tripwire in the same struggle while its call is in flight stays judge-busy', () => {
    const c = make();
    expect(judges(c.onTestRun(FAIL))).toHaveLength(1);
    const out = c.onTestRun(FAIL);
    expect(judges(out)).toHaveLength(0);
    expect(rows(out, 'mechanical')).toEqual([]);
    expect(rows(out, 'judge-busy')).toEqual([{ event: 'judge-busy', tripwire: 'fail2' }]);
    expect(c.level).toBe('medium');
  });
});

describe('struggle decay', () => {
  const MODEL = 'claude-opus-5-5';
  const quiet = (c: Controller, n: number): Outcome[] => Array.from({ length: n }, () => c.onRequest(MODEL, undefined));

  it('decay: a struggle with no tripwire for struggleDecay requests resolves to its pre level', () => {
    const c = make({ judge: false, struggleDecay: 20 });
    c.onTestRun(FAIL);
    expect(c.level).toBe('high');
    const early = quiet(c, 19);
    expect(early.flatMap((o) => rows(o, 'resolved'))).toEqual([]);
    expect(c.level).toBe('high');
    expect(c.struggleOpen).toBe(true);
    const last = c.onRequest(MODEL, undefined);
    expect(rows(last, 'resolved')).toEqual([{ event: 'resolved', from: 'high', to: 'medium', requests: 20, why: 'decay' }]);
    expect(c.level).toBe('medium');
    expect(c.struggleOpen).toBe(false);
    expect(c.onRequest(MODEL, undefined).send).toBe('medium');
    expect(c.takeAnnouncement()).toContain('back to medium');
  });

  it('decay: a tripwire inside the window restarts the count', () => {
    const c = make({ judge: false, struggleDecay: 20 });
    c.onTestRun(FAIL);
    quiet(c, 15);
    c.onTestRun(FAIL); // the 2nd failing run in a row is a tripwire
    expect(c.level).toBe('xhigh');
    quiet(c, 19);
    expect(c.struggleOpen).toBe(true);
    const last = c.onRequest(MODEL, undefined);
    expect(rows(last, 'resolved')).toEqual([{ event: 'resolved', from: 'xhigh', to: 'medium', requests: 35, why: 'decay' }]);
    expect(c.level).toBe('medium');
  });

  it('decay: a disarmed tripwire does not restart the count', () => {
    const c = make({ judge: false, struggleDecay: 4, tripwires: new Set<Tripwire>(['fail1']) });
    c.onTestRun(FAIL);
    quiet(c, 2);
    c.onTestRun(FAIL);
    c.onTestRun(FAIL); // fail2, not armed
    quiet(c, 1);
    expect(c.struggleOpen).toBe(true);
    expect(rows(c.onRequest(MODEL, undefined), 'resolved')).toHaveLength(1);
  });

  it('decay: an open child red is cleared by decay, and a later passing test run then needs no green return', () => {
    const c = make({ judge: false, struggleDecay: 5 });
    c.onSpawn({ childId: 'c1', type: 'builder' });
    c.onChildReturn('c1', 'FAIL parser');
    expect(c.reds.size).toBe(1);
    quiet(c, 5);
    expect(c.struggleOpen).toBe(false);
    expect(c.reds.size).toBe(0);
    expect(c.level).toBe('medium');
    c.onTestRun(FAIL);
    expect(c.struggleOpen).toBe(true);
    expect(c.level).toBe('high');
    c.onTestRun(PASS);
    expect(c.struggleOpen).toBe(false);
    expect(c.level).toBe('medium');
  });

  it('decay: the failure streak resets, so the next failing run is a first failure again', () => {
    const c = make({ judge: false, struggleDecay: 3 });
    c.onTestRun(FAIL);
    c.onTestRun(FAIL);
    expect(c.ownFails).toBe(2);
    quiet(c, 3);
    expect(c.ownFails).toBe(0);
    expect(rows(c.onTestRun(FAIL), 'mechanical')).toEqual([{ event: 'mechanical', tripwire: 'fail1', from: 'medium', to: 'high' }]);
  });

  it('decay: a later tripwire opens a new struggle from the level in force', () => {
    const c = make({ judge: false, struggleDecay: 2, home: 'high' });
    c.onTestRun(FAIL);
    quiet(c, 2);
    expect(c.level).toBe('high');
    c.onTestRun(FAIL);
    expect(c.struggleOpen).toBe(true);
    expect(c.level).toBe('xhigh');
    quiet(c, 2);
    expect(c.level).toBe('high');
    expect(c.end()).toMatchObject({ struggles: 2 });
  });

  it('decay: 0 turns it off', () => {
    const c = make({ judge: false, struggleDecay: 0 });
    c.onTestRun(FAIL);
    const all = quiet(c, 200);
    expect(all.flatMap((o) => rows(o, 'resolved'))).toEqual([]);
    expect(c.struggleOpen).toBe(true);
    expect(c.level).toBe('high');
  });

  it('decay: a judge answer for a decayed struggle is dropped as stale', () => {
    const c = make({ struggleDecay: 2 });
    const [call] = judges(c.onTestRun(FAIL));
    quiet(c, 2);
    expect(c.struggleOpen).toBe(false);
    expect(rows(c.onJudgeAnswer(call!.epoch, '90 - stuck', 1, USAGE), 'judge-stale')).toHaveLength(1);
    expect(c.level).toBe('medium');
  });

  it('decay: a request on a gated model is not counted', () => {
    const c = make({ judge: false, struggleDecay: 2 });
    c.onTestRun(FAIL);
    for (let i = 0; i < 5; i++) c.onRequest('claude-haiku-5-5', undefined);
    expect(c.struggleOpen).toBe(true);
  });
});
