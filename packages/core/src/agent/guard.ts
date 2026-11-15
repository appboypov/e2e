/**
 * The guard of an `@e2e-dev/core` agent: which actions the agent may not take on
 * its own. Checked by the action dispatcher immediately before each dispatch,
 * replayed actions included, against the node the action lands on and the
 * screen's location, so a recording can never carry the agent past it. The
 * dispatcher reads both off a look taken after the action before it, so a
 * turn that batches actions is checked against the screen each one left. A
 * screen that changes by itself between that look and the dispatch is past
 * what a guard can see.
 *
 * `deny` refuses the action with `POLICY_DENIED`, which the model reads and
 * plans around. `stop` ends the `act` call before the action, as a pass whose
 * result has `status: 'stopped'`, so the program takes over: the place for a
 * payment, an order, a deletion.
 */

import { parseKey, type ParsedKey } from '../engine/contract.ts';
import { TestError } from '../internal/errors.ts';
import { canonicalDigest } from '../internal/ids.ts';
import { compareText, toTextPattern, type TextPattern } from '../internal/text.ts';
import type { ActionName, Guard, GuardDecision, GuardedActionName, GuardNode, GuardRule, ProposedAction } from '../types.ts';
import { PROJECT_TOOL_EVENT_PREFIX } from './action-names.ts';
import { AgentError } from './error.ts';
import type { AgentObservation, RedactedNode } from './observation.ts';

/** A guard's answer for one action, and whether its `check` function gave it rather than a rule. */
export interface GuardVerdict {
  readonly decision: GuardDecision;
  readonly byCheck: boolean;
}

/** A guard's rules compiled once, with what an action and its node are checked against. */
export interface CompiledGuard {
  /** False for a guard with no rule and no `check`: it allows everything and reads nothing. */
  readonly guarding: boolean;
  decide(action: ProposedAction, identified: boolean, raw: { readonly node?: RedactedNode }): Promise<GuardVerdict>;
  /** Whether `check` still stops before `action`, a stop it decided when the step was recorded. */
  stillStops(action: ProposedAction): Promise<boolean>;
}

interface CompiledRule {
  readonly role?: string;
  readonly name?: TextPattern;
  readonly text?: TextPattern;
  readonly testId?: TextPattern;
  readonly url?: TextPattern;
  readonly destination?: TextPattern;
  readonly key?: ParsedKey;
  readonly actions?: ReadonlySet<string>;
}

const RULE_KEYS: ReadonlySet<string> = new Set(['role', 'name', 'text', 'testId', 'url', 'destination', 'key', 'actions']);
const GUARD_KEYS: ReadonlySet<string> = new Set(['stop', 'deny', 'check', 'unidentified']);

/** Validates and compiles a guard; a malformed one is `INVALID_ARGUMENT`. */
export function compileGuard(guard: Guard, label = 'guard'): CompiledGuard {
  if (typeof guard !== 'object' || guard === null) throw new TestError('INVALID_ARGUMENT', `${label} must be an object`);
  for (const key of Object.keys(guard)) {
    if (!GUARD_KEYS.has(key)) throw new TestError('INVALID_ARGUMENT', `${label} has an unknown key "${key}"; expected stop, deny, check, or unidentified`);
  }
  const stop = compileRules(guard.stop, `${label}.stop`);
  const deny = compileRules(guard.deny, `${label}.deny`);
  const check = guard.check;
  if (check !== undefined && typeof check !== 'function') throw new TestError('INVALID_ARGUMENT', `${label}.check must be a function`);
  if (guard.unidentified !== undefined && guard.unidentified !== 'deny' && guard.unidentified !== 'allow') {
    throw new TestError('INVALID_ARGUMENT', `${label}.unidentified must be "deny" or "allow"`);
  }
  const guarding = stop.length > 0 || deny.length > 0 || check !== undefined;
  const unidentified = guard.unidentified ?? 'deny';
  const ask = async (action: ProposedAction): Promise<GuardDecision> => {
    const decision = await check!(Object.freeze({ ...action }));
    if (decision !== 'allow' && decision !== 'deny' && decision !== 'stop') {
      throw new TestError('INVALID_ARGUMENT', `${label}.check must return "allow", "deny", or "stop"; got ${JSON.stringify(decision)}`);
    }
    return decision;
  };
  const ruled = (decision: GuardDecision): GuardVerdict => ({ decision, byCheck: false });
  return {
    guarding,
    async decide(action, identified, raw) {
      if (!guarding) return ruled('allow');
      if (!identified && unidentified === 'deny') return ruled('deny');
      if (stop.some((rule) => matches(rule, action, raw.node))) return ruled('stop');
      if (deny.some((rule) => matches(rule, action, raw.node))) return ruled('deny');
      if (check === undefined) return ruled('allow');
      return { decision: await ask(action), byCheck: true };
    },
    stillStops: async (action) => check !== undefined && (await ask(action)) === 'stop',
  };
}

function compileRules(rules: readonly GuardRule[] | undefined, label: string): readonly CompiledRule[] {
  if (rules === undefined) return [];
  if (!Array.isArray(rules)) throw new TestError('INVALID_ARGUMENT', `${label} must be an array of rules`);
  return rules.map((rule, index) => compileRule(rule, `${label}[${index}]`));
}

function compileRule(rule: GuardRule, label: string): CompiledRule {
  if (typeof rule !== 'object' || rule === null) throw new TestError('INVALID_ARGUMENT', `${label} must be an object`);
  for (const key of Object.keys(rule)) {
    if (!RULE_KEYS.has(key)) throw new TestError('INVALID_ARGUMENT', `${label} has an unknown key "${key}"; expected role, name, text, testId, url, destination, key, or actions`);
  }
  if (rule.role !== undefined && typeof rule.role !== 'string') throw new TestError('INVALID_ARGUMENT', `${label}.role must be a role name`);
  const key = rule.key === undefined ? undefined : typeof rule.key === 'string' ? parseKey(rule.key) : undefined;
  if (rule.key !== undefined && key === undefined) {
    throw new TestError('INVALID_ARGUMENT', `${label}.key ${JSON.stringify(rule.key)} is not a key: write it as press does, such as "Enter" or "Control+s"`);
  }
  if (rule.actions !== undefined && !Array.isArray(rule.actions)) throw new TestError('INVALID_ARGUMENT', `${label}.actions must be an array of action names`);
  for (const action of rule.actions ?? []) {
    if (typeof action !== 'string' || !isGuardedActionName(action)) {
      throw new TestError('INVALID_ARGUMENT', `${label}.actions names ${JSON.stringify(action)}, which is no action: use a name such as "tap", "type", "navigate", or "tool:<name>"`);
    }
  }
  return {
    ...(rule.role === undefined ? {} : { role: rule.role }),
    ...(rule.name === undefined ? {} : { name: toTextPattern(rule.name) }),
    ...(rule.text === undefined ? {} : { text: toTextPattern(rule.text) }),
    ...(rule.testId === undefined ? {} : { testId: toTextPattern(rule.testId) }),
    ...(rule.url === undefined ? {} : { url: toTextPattern(rule.url) }),
    ...(rule.destination === undefined ? {} : { destination: toTextPattern(rule.destination) }),
    ...(key === undefined ? {} : { key }),
    ...(rule.actions === undefined ? {} : { actions: new Set(rule.actions) }),
  };
}

const textMatches = (actual: string | undefined, pattern: TextPattern | undefined): boolean =>
  pattern === undefined || (actual !== undefined && compareText(actual, pattern, { mode: 'equals', normalize: true }));

/**
 * Whether an action's key is the rule's. A rule that names no modifier
 * matches the key under any of them, so `Enter` covers `Shift+Enter`, which
 * submits a form as well; a rule that names modifiers matches exactly those.
 */
function keyMatches(rule: ParsedKey, pressed: string | undefined): boolean {
  const key = pressed === undefined ? undefined : parseKey(pressed);
  if (key === undefined) return false;
  const same = rule.key.kind === 'named'
    ? key.key.kind === 'named' && key.key.name === rule.key.name
    : key.key.kind === 'char' && key.key.char.toLowerCase() === rule.key.char.toLowerCase();
  if (!same || rule.modifiers.length === 0) return same;
  return rule.modifiers.length === key.modifiers.length && rule.modifiers.every((modifier) => key.modifiers.includes(modifier));
}

/** Whether every field the rule sets matches the action. A node field never matches an action with no node. */
function matches(rule: CompiledRule, action: ProposedAction, node: RedactedNode | undefined): boolean {
  if (rule.actions !== undefined && !rule.actions.has(action.kind)) return false;
  if (rule.key !== undefined && !keyMatches(rule.key, action.key)) return false;
  if (!textMatches(action.url, rule.url)) return false;
  if (!textMatches(action.destination, rule.destination)) return false;
  if (rule.role === undefined && rule.name === undefined && rule.text === undefined && rule.testId === undefined) return true;
  if (node === undefined) return false;
  if (rule.role !== undefined && node.role !== rule.role) return false;
  return textMatches(node.name, rule.name) && textMatches(node.text, rule.text) && textMatches(node.testId, rule.testId);
}

/**
 * What a guard's rules are, as the replay cache keys a recording by: a flow
 * recorded under one set of rules (one that stopped, say) never replays under
 * another. A `check` function counts by its presence; its logic cannot be read.
 */
export function guardIdentity(guard: Guard): string {
  const rule = (value: GuardRule): unknown =>
    Object.fromEntries(Object.entries(value).map(([key, field]) => [key, field instanceof RegExp ? { source: field.source, flags: field.flags } : field]));
  return canonicalDigest({
    stop: (guard.stop ?? []).map(rule),
    deny: (guard.deny ?? []).map(rule),
    check: guard.check !== undefined,
    unidentified: guard.unidentified ?? 'deny',
  });
}

/** Every action name a guard reads, kept equal to `ActionName` by the compiler. */
const ACTION_NAMES: ReadonlySet<string> = new Set(Object.keys({
  tap: true, doubleTap: true, longPress: true, secondaryTap: true, hover: true, scrollTo: true,
  type: true, typeSecret: true, press: true, select: true, check: true, upload: true, drag: true,
  scroll: true, scrollUntil: true, navigate: true, back: true, resize: true, switchTab: true, closeTab: true,
  tapAt: true, hoverAt: true, dragAt: true, typeText: true, pressKey: true, dismissKeyboard: true,
} satisfies Record<ActionName, true>));

/** Whether a stored string names an action a guard reads: a grammar action, or `tool:<name>`. */
export function isGuardedActionName(value: string): value is GuardedActionName {
  return ACTION_NAMES.has(value) || (value.startsWith(PROJECT_TOOL_EVENT_PREFIX) && value.length > PROJECT_TOOL_EVENT_PREFIX.length);
}

/** The node as a guard and a stopped result describe it. */
export function guardNode(node: RedactedNode): GuardNode {
  return { role: node.role ?? 'generic', name: node.name ?? '', ...(node.testId === undefined ? {} : { testId: node.testId }) };
}

/**
 * Thrown by the dispatcher when a `stop` rule matches: it hard-stops the
 * step, which `dispatchAgentStep` turns into a pass with `status: 'stopped'`.
 */
export class GuardStop extends AgentError {
  constructor(
    readonly action: ProposedAction,
    /** The screen the step stopped on, settled while the step could still read it. */
    readonly screen: AgentObservation | undefined,
    /** True when the guard's `check` decided the stop, which a replay asks again; a rule's stop is in the recording's key. */
    readonly byCheck = false,
  ) {
    super('POLICY_DENIED', `the guard stopped the agent before ${describeProposed(action)}`);
    this.name = 'GuardStop';
  }
}

/** One line naming a proposed action, for messages and the stopped step's summary. */
export function describeProposed(action: ProposedAction): string {
  const node = action.node === undefined ? '' : ` ${action.node.role} ${JSON.stringify(action.node.name)}`;
  const key = action.key === undefined ? '' : ` ${action.key}`;
  return `${action.kind}${node}${key}`;
}
