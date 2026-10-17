// Every text the model reads from this plugin, apart from the tag's deny texts and the
// Agent tool's description line (effort.ts) and the judge's prompt (judge.ts).

export const BUTTON_UP =
  'Raise your own reasoning effort one step for your next replies. Use it when you are stuck: a check still fails after your fix, results do not fit your understanding of the code, a sub-task came back red for a reason you did not foresee — or right before a design decision that is hard to undo. Not for routine steps; it makes every later reply slower and costlier. The level then holds, whatever happens, until you call effort_auto.';

export const BUTTON_DOWN =
  'Lower your own reasoning effort one step for your next replies. Use it when what is left is routine: spawning and waiting, relaying results, bookkeeping, or a fix whose every line you already know. The level then holds, whatever happens, until you call effort_auto.';

export const BUTTON_AUTO =
  'Hand your reasoning effort back to the automatic rules: it returns to your home level, and failing checks or red sub-tasks raise it again. Use it once the reason you called effort_up or effort_down is behind you.';

export const REFUSED = "Not available here: this agent's effort is not live-controlled (its definition does not turn on effortControl). Nothing changed.";

/**
 * The main chat's refusal where this plugin does not steer it: `tool` is the session's own tool that sets the main
 * chat's effort (a listed `set_effort`), undefined when none is listed.
 */
export const MAIN_REFUSED = (tool: string | undefined): string =>
  tool === undefined
    ? 'Not available here: these effort buttons do not steer the main chat, and no tool here sets its effort; the user sets it with /effort. Nothing changed.'
    : `Not available here: these effort buttons do not steer the main chat. Your effort has its own control, ${tool}: call it with a level, or auto. Nothing changed.`;

/**
 * The tool MAIN_REFUSED names: the one listed tool whose name ends in `set_effort`; undefined when none is listed, or
 * when more than one is, since naming one of them could point the main chat at a control that is not its own, or when
 * its name is not a tool name.
 */
export function mainEffortToolOf(names: readonly string[]): string | undefined {
  const matches = names.filter((name) => /(^|__)set_effort$/.test(name));
  // The name goes into the main chat's tool result verbatim: only one a tool registers under (letters, digits, `_`
  // and `-`, at most 64) is named.
  return matches.length === 1 && /^[A-Za-z0-9_-]{1,64}$/.test(matches[0]!) ? matches[0] : undefined;
}

export type Direction = 'up' | 'down';

/** What a button press that moved the level answers. */
export function buttonText(direction: Direction, level: string, floor: string, ceiling: string): string {
  return `Effort ${direction === 'up' ? 'raised' : 'lowered'} to ${level} for your next replies (your range ${floor}..${ceiling}); it holds until you call effort_auto.`;
}

/** What a press adds while the agent's last request went to a model this plugin does not steer. */
export function unsteeredNote(model: string): string {
  return ` Your current model, ${model}, is not steered here: the level applies once a steered model answers.`;
}

/** What a button press at the end of the range answers. */
export function boundText(direction: Direction, level: string): string {
  return `Your effort is already ${level}, the ${direction === 'up' ? 'ceiling' : 'floor'} of your range; it holds there until you call effort_auto.`;
}

/** What effort_auto answers: the home level it went back to (`from` the level it left). */
export function autoText(home: string, from: string, floor: string, ceiling: string): string {
  if (home === from) return `Your effort is already ${home}, your home level; the automatic rules steer it again.`;
  return `Effort back to ${home}, your home level, for your next replies (your range ${floor}..${ceiling}); the automatic rules steer it again.`;
}

/** The line a steered agent reads after its next tool result once its level changed. */
export function announceLine(level: string, why: string): string {
  return `effort-live-control: your reasoning effort is now ${level} — ${why}.`;
}

export const WHY_FAIL1 = 'a failing test run';
export const WHY_FAIL2 = '2nd failing test run in a row';
export const WHY_JUDGE_FAILED = 'judge unavailable, raised one step';
export const WHY_LANDING = 'landing, one step below your home level';

export const whyChild = (childType: string, token: string): string => `${childType} returned ${token}`;
export const whyRedispatch = (type: string): string => `${type} sent back a red result`;
export const whyJudge = (reason: string): string => `judge: ${reason === '' ? 'no reason given' : reason}`;
export const whyResolved = (level: string): string => `the trouble is resolved, back to ${level}`;
export const whyDecayed = (level: string, requests: number): string => `no new trouble for ${requests} requests, back to ${level}`;
