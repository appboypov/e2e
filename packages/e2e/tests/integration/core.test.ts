/** `e2e/core` (`@e2e-dev/core`): hosts, sessions, saved state, secrets, timeouts, link bases, and the agent's cache and guard. */
import { mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StepExecutor, StepExecutorContext } from '@e2e-dev/core/lib/agent/executor';
import { createAgent } from '@e2e-dev/core/agent';
import { launch, SessionState, type Host, type Session } from '@e2e-dev/core';
import { createFakeEngine, FAKE_APP } from '../helpers/fake-engine.ts';
import type { ScriptedNode } from '../helpers/scripted-scene.ts';

const PROJECTS = path.join(import.meta.dirname, '..', 'tmp-projects');

/** A shop: a product page whose button leads to a cart with a coupon and a payment button. */
function shop(): ScriptedNode[] {
  const paid: ScriptedNode = { id: 'paid', role: 'status', name: 'Paid', states: { hidden: true } };
  const cart: ScriptedNode = {
    id: 'cart', role: 'region', name: 'Cart', states: { hidden: true },
    children: [
      { id: 'coupon', role: 'checkbox', name: 'Apply coupon SAVE10', states: { checked: false } },
      { id: 'pay', role: 'button', name: 'Pay now', on: () => { paid.states = { hidden: false }; } },
      { id: 'delete', role: 'button', name: 'Delete account' },
    ],
  };
  return [
    { id: 'add', role: 'button', name: 'Add to cart', on: () => { cart.states = { hidden: false }; } },
    { id: 'price', role: 'paragraph', name: '', text: '39,000', testId: 'sale-price' },
    cart,
    paid,
  ];
}

/** The id of the first line naming `role "name"` in an executor observation. */
function idOf(text: string, role: string, name: string): string {
  const line = text.split('\n').find((candidate) => candidate.includes(` ${role} "${name}"`));
  const id = line?.match(/#(\S+)/)?.[1];
  if (id === undefined) throw new Error(`no ${role} "${name}" in:\n${text}`);
  return id;
}

/** A scripted brain: adds to cart, checks the coupon, and goes for the payment button; or deletes the account. */
function scripted(): StepExecutor & { calls: number; refusals: string[] } {
  const brain = {
    name: 'scripted',
    version: '1',
    calls: 0,
    refusals: [] as string[],
    async runStep(context: StepExecutorContext) {
      brain.calls += 1;
      const tap = async (role: string, name: string): Promise<void> => {
        const { text } = await context.observe();
        try {
          await context.actions.tap({ id: idOf(text, role, name) });
        } catch (cause) {
          brain.refusals.push((cause as { code?: string }).code ?? 'unknown');
        }
      };
      if (context.step.kind === 'assert') {
        const { text } = await context.observe();
        await context.actions.scrollTo({ id: idOf(text, 'button', 'Pay now') });
        return { status: 'failed' as const, summary: 'the total is wrong' };
      }
      if (context.step.instruction.startsWith('confirm')) {
        try {
          await context.actions.navigate('/checkout/confirm');
        } catch (cause) {
          brain.refusals.push((cause as { code?: string }).code ?? 'unknown');
        }
        try {
          await context.budgets.runTool({ name: 'alert', mutates: true }, async () => 'accepted');
        } catch (cause) {
          brain.refusals.push((cause as { code?: string }).code ?? 'unknown');
        }
        return { status: 'passed' as const, summary: 'tried to confirm' };
      }
      if (context.step.instruction.startsWith('delete')) {
        await tap('button', 'Delete account');
        return { status: 'passed' as const, summary: 'tried to delete the account' };
      }
      await tap('button', 'Add to cart');
      const { text } = await context.observe();
      await context.actions.check({ id: idOf(text, 'checkbox', 'Apply coupon SAVE10') }, true);
      await tap('button', 'Pay now');
      return { status: 'passed' as const, summary: 'paid' };
    },
  };
  return brain;
}

describe('e2e/core', { timeout: 60_000 }, () => {
  let dir = '';
  let hosts: Host[] = [];

  beforeEach(() => {
    mkdirSync(PROJECTS, { recursive: true });
    dir = mkdtempSync(path.join(PROJECTS, 'core-'));
    hosts = [];
  });

  afterEach(async () => {
    for (const opened of hosts) await opened.close().catch(() => undefined);
  });

  async function host(engine: Parameters<typeof launch>[0], options: Parameters<typeof launch>[1] = {}) {
    const opened = await launch(engine, { cwd: dir, env: {}, handleSignals: false, ...options });
    hosts.push(opened);
    return opened;
  }

  it('opens sessions one at a time on one engine instance, each with screen, app, and platform', async () => {
    const fake = createFakeEngine({ scene: shop, fixtures: true });
    const opened = await host(fake.engine, { app: FAKE_APP });
    expect(opened.platform).toBe('fake');
    const first = await opened.newSession();
    await first.app.open('/');
    expect(await first.screen.getByTestId('sale-price').textContent()).toBe('39,000');
    expect(Object.keys(first).toSorted()).toEqual(['app', 'close', 'gadget', 'platform', 'saveState', 'screen', 'setDefaultTimeout']);
    expect('agent' in first).toBe(false);
    await expect(opened.newSession()).rejects.toMatchObject({ code: 'WORKER_PROTOCOL' });
    await first.close();
    await first.close();
    const second = await opened.newSession();
    await second.close();
    await opened.close();
    expect(fake.stats()).toMatchObject({ inits: 1, attemptsStarted: 2, attemptsEnded: 2, disposes: 1 });
    await expect(opened.newSession()).rejects.toMatchObject({ code: 'WORKER_PROTOCOL' });
  });

  it('refuses a second host on the engine instance another host owns', async () => {
    const fake = createFakeEngine();
    await host(fake.engine);
    await expect(host(fake.engine)).rejects.toMatchObject({ code: 'WORKER_PROTOCOL' });
  });

  it('refuses what is not an engine, an app key it does not take, and a relative artifactsDir resolves from cwd', async () => {
    const web = () => createFakeEngine().engine;
    await expect(launch(web as never)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', message: expect.stringContaining('got a function') });
    await expect(launch(undefined as never)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', message: expect.stringContaining('launch(web())') });
    await expect(host(web(), { app: { ...FAKE_APP, environment: 'staging' } as never })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    const opened = await host(createFakeEngine({ scene: shop, artifacts: true }).engine, { app: FAKE_APP, artifactsDir: 'shots' });
    const session = await opened.newSession();
    await session.app.open('/');
    expect(await session.app.screenshot('product')).toContain(path.join(dir, 'shots'));
    expect(String(session)).toBe('[object Object]');
    await session.close();
  });

  it('says a closed session is closed, and redacts a secret from the error an operation throws', async () => {
    const fake = createFakeEngine({
      scene: shop,
      onNavigate: (url) => { if (url.endsWith('/broken')) throw new Error('the page printed hunter2-secret and stopped'); },
    });
    const opened = await host(fake.engine, { app: FAKE_APP, secrets: { SHOP_PASSWORD: 'hunter2-secret' } });
    const session = await opened.newSession();
    const failure = await session.app.open('/broken').then(() => undefined, (cause: Error) => cause);
    // Whatever an engine throws reaches the program with a code.
    expect(failure).toMatchObject({ code: 'ENGINE_FAILURE', message: expect.stringContaining('the page printed') });
    expect(`${failure?.message} ${failure?.stack} ${String((failure?.cause as Error | undefined)?.message)}`).not.toContain('hunter2-secret');
    await session.close();
    await expect(session.screen.getByRole('button', 'Add to cart').tap()).rejects.toMatchObject({ code: 'CANCELLED', message: expect.stringContaining('the session is closed') });
    await expect(session.app.open('/')).rejects.toMatchObject({ code: 'CANCELLED' });
    // A read reaches the engine with no step around it, and says the same.
    await expect(session.screen.getByTestId('sale-price').count()).rejects.toMatchObject({ code: 'CANCELLED', message: 'the session is closed' });
  });

  it('saves state in memory, exports it only encrypted, and restores it on a host of the same engine and app', async () => {
    const fake = createFakeEngine({ scene: shop, state: true });
    const opened = await host(fake.engine, { app: FAKE_APP });
    const first = await opened.newSession();
    const state = await first.saveState();
    await first.close();
    expect(JSON.stringify(state)).toBe(`{"engine":"${fake.engine.name}","platform":"${opened.platform}"}`);

    const key = new Uint8Array(32).fill(7);
    const bytes = await state.export({ key });
    const document = JSON.parse(new TextDecoder().decode(bytes)) as { schemaVersion: string; state: Record<string, unknown> };
    expect(document.schemaVersion).toBe('session-state-1');
    expect(new TextDecoder().decode(bytes)).not.toContain('"ok"');
    await expect(SessionState.import(bytes, { key: new Uint8Array(32) })).rejects.toMatchObject({ code: 'SESSION_INVALID' });
    await expect(state.export({ key: new Uint8Array(16) })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(state.export({ key, plaintext: true } as never)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });

    const restored = await SessionState.import(bytes, { key });
    const second = await opened.newSession({ state: restored });
    await second.close();
    expect(fake.restoredStates).toEqual([{ format: 'fake-state', version: 1, data: { ok: true } }]);

    const elsewhere = await host(createFakeEngine({ state: true }).engine, { app: { url: 'http://127.0.0.1:4600' } });
    // The state itself names the app it was saved for; an imported one holds its digest alone.
    await expect(elsewhere.newSession({ state })).rejects.toMatchObject({
      code: 'SESSION_MISMATCH',
      message: expect.stringMatching(/saved for http:\/\/\S+, and this host drives http:\/\/127\.0\.0\.1:4600.*app\.identity/),
    });
    await expect(elsewhere.newSession({ state: restored })).rejects.toMatchObject({ code: 'SESSION_MISMATCH', message: expect.stringContaining('saved for another app') });
  });

  it('carries every secret value a saved session knew, so a host launched without them still redacts what the app echoes', async () => {
    const password = (): ScriptedNode[] => [{ id: 'password', role: 'textbox', name: 'Password', value: '' }];
    const saving = await host(createFakeEngine({ scene: password, state: true }).engine, { app: FAKE_APP, secrets: { SHOP_PASSWORD: 'hunter2-secret' } });
    const first = await saving.newSession();
    await first.app.open('/');
    await first.screen.getByLabel('Password').fill(saving.secret('SHOP_PASSWORD'));
    const key = new Uint8Array(32).fill(3);
    const bytes = await (await first.saveState()).export({ key });
    await first.close();
    expect(JSON.parse(new TextDecoder().decode(bytes))).toMatchObject({ secrecy: { names: ['SHOP_PASSWORD'] } });

    const echo = (): ScriptedNode[] => [{ id: 'echo', role: 'paragraph', name: '', text: 'remembered hunter2-secret' }];
    const restoring = await host(createFakeEngine({ scene: echo, state: true }).engine, { app: FAKE_APP });
    const second = await restoring.newSession({ state: await SessionState.import(bytes, { key }) });
    await second.app.open('/');
    expect(await second.screen.tree()).toContain('remembered');
    expect(await second.screen.tree()).not.toContain('hunter2-secret');
    await second.close();
  });

  it('fails a capture with the error classified and redacted, carrying no engine cause', async () => {
    const fake = createFakeEngine({
      state: true,
      onCapture: () => { throw Object.assign(new Error('capture failed with capture-secret-123'), { leaked: 'capture-secret-123' }); },
    });
    const opened = await host(fake.engine, { app: FAKE_APP, secrets: { CAPTURE: 'capture-secret-123' } });
    const session = await opened.newSession();
    const failure: unknown = await session.saveState().then(() => undefined, (cause: unknown) => cause);
    expect(failure).toMatchObject({ code: 'ENGINE_FAILURE' });
    expect(String((failure as Error).message)).not.toContain('capture-secret-123');
    expect((failure as Error).cause).toBeUndefined();
    await session.close();
  });

  it('hands secrets out by name and redacts their values from what the screen reads', async () => {
    const fake = createFakeEngine({ scene: () => [{ id: 'password', role: 'textbox', name: 'Password', value: '' }] });
    const opened = await host(fake.engine, { app: FAKE_APP, secrets: { SHOP_PASSWORD: 'hunter2-secret' } });
    expect(() => opened.secret('NOPE')).toThrow(expect.objectContaining({ code: 'SECRET_UNAVAILABLE' }));
    const session = await opened.newSession();
    await session.app.open('/');
    await session.screen.getByLabel('Password').fill(opened.secret('SHOP_PASSWORD'));
    expect(fake.callsOf(fake.attempts[0]!.attemptId, 'perform')[0]?.action).toMatchObject({ kind: 'fill', value: 'hunter2-secret', sensitive: true });
    expect(await session.screen.tree()).not.toContain('hunter2-secret');
    await session.close();
  });

  it('bounds each operation by its default timeout, which setDefaultTimeout moves, with no session deadline', async () => {
    const fake = createFakeEngine({ scene: shop });
    const opened = await host(fake.engine, { app: FAKE_APP, timeout: 10_000 });
    const session = await opened.newSession();
    await session.app.open('/');
    session.setDefaultTimeout(200);
    const started = Date.now();
    await expect(session.screen.getByRole('button', 'Missing').tap()).rejects.toMatchObject({ code: 'LOCATOR_NOT_FOUND' });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(() => session.setDefaultTimeout(0)).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    // The agent's engine operations take the same default.
    session.setDefaultTimeout(1_234);
    const before = fake.operations.length;
    const observer = { name: 'observer', version: '1', runStep: async (context: StepExecutorContext) => { await context.observe(); return { status: 'passed' as const, summary: 'looked' }; } };
    await createAgent(session, { executor: observer }).act('look at the page');
    const observes = fake.operations.slice(before).filter((operation) => operation.method === 'observe');
    expect(observes.length).toBeGreaterThan(0);
    for (const operation of observes) expect(operation.timeoutMs).toBeLessThanOrEqual(1_234);
    await session.close();
  });

  it('gives an app open the long default until a program sets a timeout, which then bounds it too', async () => {
    const device = () => createFakeEngine({ device: true, links: true, scene: shop });
    const app = { bundleId: 'com.example.shop', linkBase: 'shopapp://' };
    const openTimeout = async (fake: ReturnType<typeof device>, session: { app: { open(path: string): Promise<void> } }) => {
      const before = fake.operations.length;
      await session.app.open('/cart');
      return fake.operations.slice(before).find((operation) => operation.method === 'session.openLink')!.timeoutMs;
    };
    const plain = device();
    const session = await (await host(plain.engine, { app })).newSession();
    expect(await openTimeout(plain, session)).toBeGreaterThan(60_000);
    session.setDefaultTimeout(1_234);
    expect(await openTimeout(plain, session)).toBeLessThanOrEqual(1_234);
    await session.close();
    const bounded = device();
    const launched = await (await host(bounded.engine, { app, timeout: 5_000 })).newSession();
    expect(await openTimeout(bounded, launched)).toBeLessThanOrEqual(5_000);
    await launched.close();
  });

  it('opens a path as a link in the pinned app on a device target with a link base', async () => {
    const fake = createFakeEngine({ device: true, links: true, scene: shop });
    const opened = await host(fake.engine, { app: { bundleId: 'com.example.shop', linkBase: 'shopapp://' } });
    const session = await opened.newSession();
    await session.app.open('/products/A-1001');
    await session.app.open('https://shop.example.com/orders/42');
    await expect(session.app.open('javascript:alert(1)')).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect(fake.callsOf(fake.attempts[0]!.attemptId, 'session').filter((call) => call.method === 'openLink').map((call) => call.url)).toEqual([
      'shopapp://products/A-1001',
      'https://shop.example.com/orders/42',
    ]);
    await session.close();
    await expect(host(createFakeEngine({ device: true }).engine, { app: { bundleId: 'com.example.shop', linkBase: 'shopapp://' } }))
      .rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    // A path joins the base as written, so a query or fragment the parser drops when empty, or whitespace it trims, is refused too.
    for (const linkBase of ['file:///etc/', 'https://shop.example.com/?', 'shopapp://#', ' https://shop.example.com']) {
      await expect(host(createFakeEngine({ device: true, links: true }).engine, { app: { bundleId: 'com.example.shop', linkBase } }), linkBase)
        .rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    }
  });

  describe('createAgent', () => {
    it('stops before a guarded action, records the flow, and replays it to the same stop with no model', async () => {
      const brain = scripted();
      const cacheDir = path.join(dir, 'cache');
      const opened = await host(createFakeEngine({ scene: shop }).engine, { app: FAKE_APP });
      for (const round of [1, 2]) {
        const session = await opened.newSession();
        await session.app.open('/');
        const agent = createAgent(session, {
          executor: brain,
          guard: { stop: [{ role: 'button', name: /Pay/ }] },
          cache: { dir: cacheDir },
        });
        const result = await agent.act('checkout with the coupon', { cacheKey: 'checkout' });
        expect(result.status).toBe('stopped');
        expect(result.stoppedAt).toMatchObject({ kind: 'tap', node: { role: 'button', name: 'Pay now' } });
        expect(await session.screen.getByRole('checkbox').isChecked()).toBe(true);
        expect(await session.screen.getByRole('status', { name: 'Paid', visible: true }).count()).toBe(0);
        // A check after the step confirms its recording.
        await session.screen.getByRole('button', 'Pay now').waitFor();
        expect(result.cache?.mode).toBe(round === 1 ? 'missed' : 'self-finalized');
        await session.close();
        expect(brain.calls).toBe(1);
      }
      expect(readdirSync(cacheDir, { recursive: true }).filter((file) => String(file).endsWith('.json'))).toHaveLength(1);
    });

    it('replays a stop before a navigate to the same action, its destination included', async () => {
      // Adds to cart and applies the coupon, then heads for the confirmation page, which the guard keeps for the program.
      const brain = {
        name: 'navigator', version: '1', calls: 0,
        async runStep(context: StepExecutorContext) {
          brain.calls += 1;
          const { text } = await context.observe();
          await context.actions.tap({ id: idOf(text, 'button', 'Add to cart') });
          await context.actions.check({ id: idOf((await context.observe()).text, 'checkbox', 'Apply coupon SAVE10') }, true);
          await context.actions.navigate('/checkout/confirm');
          return { status: 'passed' as const, summary: 'confirmed' };
        },
      };
      const cacheDir = path.join(dir, 'cache');
      const opened = await host(createFakeEngine({ scene: shop, navigation: true }).engine, { app: FAKE_APP });
      const stops: unknown[] = [];
      for (const round of [1, 2]) {
        const session = await opened.newSession();
        await session.app.open('/');
        const agent = createAgent(session, { executor: brain, guard: { stop: [{ destination: /\/confirm/ }] }, cache: { dir: cacheDir } });
        const result = await agent.act('confirm the order', { cacheKey: 'confirm' });
        expect(result.status).toBe('stopped');
        stops.push(result.stoppedAt);
        await session.screen.getByRole('button', 'Pay now').waitFor();
        expect(result.cache?.mode).toBe(round === 1 ? 'missed' : 'self-finalized');
        await session.close();
      }
      expect(stops[0]).toMatchObject({ kind: 'navigate', destination: expect.stringContaining('/checkout/confirm') });
      expect(stops[1]).toEqual(stops[0]);
      expect(brain.calls).toBe(1);
    });

    it('judges each action of a batched turn on the screen the one before it left', async () => {
      // One button: the first tap turns "Continue" into "Pay now", the second pays.
      const scene = (): ScriptedNode[] => {
        const paid: ScriptedNode = { id: 'paid', role: 'status', name: 'Paid', states: { hidden: true } };
        const button: ScriptedNode = {
          id: 'next', role: 'button', name: 'Continue',
          on: () => {
            if (button.name === 'Pay now') paid.states = { hidden: false };
            button.name = 'Pay now';
          },
        };
        return [button, paid];
      };
      const hasty = {
        name: 'hasty', version: '1',
        async runStep(context: StepExecutorContext) {
          const id = idOf((await context.observe()).text, 'button', 'Continue');
          await context.actions.tap({ id });
          await context.actions.tap({ id });
          return { status: 'passed' as const, summary: 'paid' };
        },
      };
      const opened = await host(createFakeEngine({ scene }).engine, { app: FAKE_APP });
      const session = await opened.newSession();
      await session.app.open('/');
      const result = await createAgent(session, { executor: hasty, guard: { stop: [{ role: 'button', name: /pay/i }] } }).act('continue to payment');
      expect(result).toMatchObject({ status: 'stopped', stoppedAt: { kind: 'tap', node: { role: 'button', name: 'Pay now' } } });
      expect(await session.screen.getByRole('status', { name: 'Paid', visible: true }).count()).toBe(0);
      await session.close();
    });

    it('stops typed text that holds a line break under a rule on Enter, whatever modifier a press holds', async () => {
      const scene = (): ScriptedNode[] => [{ id: 'note', role: 'textbox', name: 'Note', value: '', states: { focused: true } }];
      const typist = (send: (context: StepExecutorContext, id: string) => Promise<void>) => ({
        name: 'typist', version: '1',
        async runStep(context: StepExecutorContext) {
          const id = idOf((await context.observe()).text, 'textbox', 'Note');
          await context.actions.tap({ id });
          await send(context, id);
          return { status: 'passed' as const, summary: 'typed' };
        },
      });
      const opened = await host(createFakeEngine({ scene, keyboard: true }).engine, { app: FAKE_APP });
      const session = await opened.newSession();
      await session.app.open('/');
      const guard = { stop: [{ key: 'Enter' }] };
      const typed = await createAgent(session, { executor: typist((context) => context.actions.typeText('thanks\n')), guard }).act('leave a note');
      expect(typed).toMatchObject({ status: 'stopped', stoppedAt: { kind: 'typeText', key: 'Enter' } });
      const pressed = await createAgent(session, { executor: typist((context, id) => context.actions.press({ id }, 'Shift+Enter')), guard }).act('leave a note');
      expect(pressed).toMatchObject({ status: 'stopped', stoppedAt: { kind: 'press', key: 'Shift+Enter' } });
      const plain = await createAgent(session, { executor: typist((context) => context.actions.typeText('thanks')), guard }).act('leave a note');
      expect(plain.status).toBe('done');
      await session.close();
    });

    it('asks check again when a stop it decided replays, and hands the step to the agent when it no longer stops', async () => {
      const brain = scripted();
      const cacheDir = path.join(dir, 'cache');
      const opened = await host(createFakeEngine({ scene: shop }).engine, { app: FAKE_APP });
      let limit = 30_000;
      const results = [];
      for (const round of [1, 2, 3]) {
        const session = await opened.newSession();
        await session.app.open('/');
        const agent = createAgent(session, {
          executor: brain,
          cache: { dir: cacheDir },
          guard: { check: (action) => (action.node?.name === 'Pay now' && limit < 39_000 ? 'stop' : 'allow') },
        });
        const result = await agent.act('checkout with the coupon', { cacheKey: 'checkout' });
        results.push({ status: result.status, mode: result.cache?.mode, calls: brain.calls });
        await session.screen.getByRole('button', 'Pay now').waitFor();
        await session.close();
        if (round === 2) limit = 50_000;
      }
      expect(results).toEqual([
        { status: 'stopped', mode: 'missed', calls: 1 },
        { status: 'stopped', mode: 'self-finalized', calls: 1 },
        { status: 'done', mode: 'agent-concluded', calls: 2 },
      ]);
    });

    it('refuses a denied action as POLICY_DENIED, which the agent reads and works around', async () => {
      const brain = scripted();
      const opened = await host(createFakeEngine({ scene: shop }).engine, { app: FAKE_APP });
      const session = await opened.newSession();
      await session.app.open('/');
      await session.screen.getByRole('button', 'Add to cart').tap();
      const agent = createAgent(session, { executor: brain, guard: { deny: [{ name: 'Delete account' }] } });
      const result = await agent.act('delete my account');
      expect(result.status).toBe('done');
      expect(brain.refusals).toEqual(['POLICY_DENIED']);
      await session.close();
    });

    it('checks no assertion, which only reads, and guards a navigate by where it goes and a project tool as unidentified', async () => {
      const brain = scripted();
      const fake = createFakeEngine({ scene: shop, navigation: true });
      const opened = await host(fake.engine, { app: FAKE_APP });
      const session = await opened.newSession();
      await session.app.open('/');
      await session.screen.getByRole('button', 'Add to cart').tap();
      const guard = { stop: [{}], deny: [] };
      const stopsEverything = createAgent(session, { executor: brain, guard });
      await expect(stopsEverything.assert('the total is 39,000')).rejects.toMatchObject({ code: 'ASSERTION_FAILED' });

      const denies = createAgent(session, { executor: brain, guard: { deny: [{ destination: /\/confirm/ }] } });
      expect((await denies.act('confirm the order')).status).toBe('done');
      expect(brain.refusals).toEqual(['POLICY_DENIED', 'POLICY_DENIED']);
      const allowsTools = createAgent(session, { executor: brain, guard: { deny: [{ destination: /\/confirm/ }], unidentified: 'allow' } });
      await allowsTools.act('confirm the order');
      expect(brain.refusals).toEqual(['POLICY_DENIED', 'POLICY_DENIED', 'POLICY_DENIED']);
      await session.close();
    });

    it('keeps a confirmed recording when the host closes the session, and after a failure the program caught', async () => {
      const brain = scripted();
      const cacheDir = path.join(dir, 'cache');
      const opened = await host(createFakeEngine({ scene: shop }).engine, { app: FAKE_APP });
      const session = await opened.newSession();
      await session.app.open('/');
      const agent = createAgent(session, { executor: brain, guard: { stop: [{ name: 'Pay now' }] }, cache: { dir: cacheDir } });
      await agent.act('checkout with the coupon', { cacheKey: 'checkout' });
      await session.screen.getByRole('button', 'Pay now').waitFor();
      await expect(session.screen.getByRole('button', 'Missing').waitFor({ timeout: 100 })).rejects.toMatchObject({ code: 'LOCATOR_NOT_FOUND' });
      await opened.close();
      expect(readdirSync(cacheDir, { recursive: true }).filter((file) => String(file).endsWith('.json'))).toHaveLength(1);
    });

    it('drops only what a caught agent failure found unconfirmed, and evicts nothing when a session closes before its check', async () => {
      const brain = scripted();
      const flaky: StepExecutor = {
        name: 'scripted', version: '1',
        runStep: async (context) => context.step.instruction.startsWith('find')
          ? { status: 'failed' as const, summary: 'there is no sale' }
          : brain.runStep(context),
      };
      const cacheDir = path.join(dir, 'cache');
      const recordings = () => readdirSync(cacheDir, { recursive: true }).filter((file) => String(file).endsWith('.json'));
      const opened = await host(createFakeEngine({ scene: shop }).engine, { app: FAKE_APP });
      const round = async (steps: (agent: ReturnType<typeof agentOn>, session: Awaited<ReturnType<typeof opened.newSession>>) => Promise<void>) => {
        const session = await opened.newSession();
        await session.app.open('/');
        await steps(agentOn(session), session);
        await session.close();
      };
      const agentOn = (session: Session) => createAgent(session, { executor: flaky, guard: { stop: [{ name: 'Pay now' }] }, cache: { dir: cacheDir } });
      const fails = (agent: ReturnType<typeof agentOn>) => expect(agent.act('find the sale', { cacheKey: 'sale' })).rejects.toMatchObject({ code: 'ACTION_FAILED' });

      // A recording made after a failure the program caught is confirmed by the check after it.
      await round(async (agent, session) => {
        await fails(agent);
        expect((await agent.act('checkout with the coupon', { cacheKey: 'checkout' })).cache?.mode).toBe('missed');
        await session.screen.getByRole('button', 'Pay now').waitFor();
      });
      expect(recordings()).toHaveLength(1);
      // A session that closes between a replay and its check leaves the recording alone.
      await round(async (agent) => {
        expect((await agent.act('checkout with the coupon', { cacheKey: 'checkout' })).cache?.mode).toBe('self-finalized');
      });
      expect(recordings()).toHaveLength(1);
      // So does a replay that a check confirms after a failure.
      await round(async (agent, session) => {
        await fails(agent);
        expect((await agent.act('checkout with the coupon', { cacheKey: 'checkout' })).cache?.mode).toBe('self-finalized');
        await session.screen.getByRole('button', 'Pay now').waitFor();
      });
      expect(recordings()).toHaveLength(1);
      // A recording still unconfirmed when a step fails is dropped, whatever passes later.
      await round(async (agent, session) => {
        expect((await agent.act('checkout with the coupon', { cacheKey: 'again' })).cache?.mode).toBe('missed');
        await fails(agent);
        await session.screen.getByRole('button', 'Pay now').waitFor();
      });
      expect(recordings()).toHaveLength(1);
      expect(brain.calls).toBe(2);
    });

    it('requires a cacheKey on an agent with a cache, refuses one without, and fails a call with no model as MODEL_UNAVAILABLE', async () => {
      const opened = await host(createFakeEngine({ scene: shop }).engine, { app: FAKE_APP });
      const session = await opened.newSession();
      const caching = createAgent(session, { executor: scripted(), cache: { dir: path.join(dir, 'cache') } });
      // @ts-expect-error -- an agent with a cache names its recording
      await expect(caching.act('checkout')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
      const live = createAgent(session, { executor: scripted() });
      // @ts-expect-error -- cacheKey needs an agent with a cache
      await expect(live.act('checkout', { cacheKey: 'checkout' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
      await expect(createAgent(session, {}).act('anything')).rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE', message: expect.stringContaining('pass one to createAgent') });
      // Options held in a variable hide the cache from the compiler: act takes either form, and the runtime refuses the wrong one.
      const held: Parameters<typeof createAgent>[1] = { executor: scripted(), cache: { dir: path.join(dir, 'cache') } };
      await expect(createAgent(session, held).act('checkout')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
      expect(() => createAgent({} as never, {})).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
      expect(() => createAgent(session, { guard: { stop: [{ nme: 'Pay' } as never] } })).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
      await session.close();
    });
  });
});
