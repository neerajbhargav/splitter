import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import type { FinanceContext } from '../src/lib/finance-types.ts';

// Execute the production module, replacing only its browser dependencies. No
// network, live auth session, or duplicated finance-client implementation.
const source = fs.readFileSync(new URL('../src/lib/finance-data.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  fileName: 'finance-data.ts',
}).outputText;
type FinanceModule = typeof import('../src/lib/finance-data.ts');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const context: FinanceContext = { userId: A, currency: 'USD' };
const tables = ['finance_settings', 'personal_debts', 'budget_months', 'budget_transactions', 'personal_subscriptions'];
type Row = { id?: string; user_id: string; [key: string]: unknown };
type Query = { table: string; filters: [string, unknown][]; orders: [string, unknown][]; from: number; to: number; single: boolean; actor: string | null };
type Rpc = { name: string; args: Record<string, unknown>; actor: string | null };
type Response = { data: unknown; error: { message: string } | null };
type State = {
  active: string | null;
  authError: { message: string } | null;
  authCalls: number;
  notifications: number;
  queries: Query[];
  delivered: Row[];
  rpcs: Rpc[];
  onGetUser?: (call: number, user: string | null) => void;
  onQuery?: (query: Query, rows: Row[]) => void;
  onRpc?: (rpc: Rpc) => Response | Promise<Response>;
};

function harness(seed: Record<string, Row[]> = {}) {
  const state: State = { active: A, authError: null, authCalls: 0, notifications: 0, queries: [], delivered: [], rpcs: [] };
  const client = {
    auth: {
      async getUser() {
        const user = state.active;
        state.authCalls++;
        state.onGetUser?.(state.authCalls, user);
        return { data: { user: user ? { id: user } : null }, error: state.authError };
      },
    },
    from(table: string) {
      const query: Query = { table, filters: [], orders: [], from: 0, to: 999, single: false, actor: null };
      const builder = {
        select(columns: string) { assert.equal(columns, '*'); return builder; },
        eq(column: string, value: unknown) { query.filters.push([column, value]); return builder; },
        order(column: string, options: unknown) { query.orders.push([column, options]); return builder; },
        range(from: number, to: number) { query.from = from; query.to = to; return builder; },
        maybeSingle() { query.single = true; return builder; },
        then(resolve: (response: Response) => unknown, reject: (error: unknown) => unknown) {
          return Promise.resolve().then(() => {
            query.actor = state.active;
            state.queries.push(query);
            // Emulate RLS for the current request plus the actual query's filters.
            const rows = (seed[table] ?? [])
              .filter(row => row.user_id === query.actor && query.filters.every(([column, value]) => row[column] === value))
              .slice(query.from, query.to + 1);
            state.delivered.push(...rows);
            state.onQuery?.(query, rows);
            return { data: query.single ? rows[0] ?? null : rows, error: null };
          }).then(resolve, reject);
        },
      };
      return builder;
    },
    async rpc(name: string, args: Record<string, unknown>) {
      const rpc = { name, args, actor: state.active };
      state.rpcs.push(rpc);
      return state.onRpc ? await state.onRpc(rpc) : { data: 'saved-id', error: null };
    },
  };
  const module = { exports: {} };
  vm.runInNewContext(compiled, {
    module,
    exports: module.exports,
    require(name: string) {
      if (name === './supabase/client') return { supabaseBrowser: () => client };
      if (name === './data') return { friendly: (message: string) => message, notifyChanged: () => { state.notifications++; } };
      throw new Error(`Unexpected production import: ${name}`);
    },
  }, { filename: 'finance-data.transpiled.cjs' });
  return { api: module.exports as FinanceModule, state };
}

const debt = { name: 'Private draft', balance_cents: 10000, apr_bps: 0, minimum_cents: 100 };
const budget = { month: '2020-01-01', income_cents: 10000, categories: [] };
const transaction = { description: 'Private expense', amount_cents: 100, expense_date: '2020-01-01' };
const subscription = { name: 'Private subscription', amount_cents: 100, cycle: 'monthly' as const, anchor_date: '2020-01-01', status: 'active' as const, notes: '' };
const writes = [
  { name: 'save_finance_settings', args: {}, invoke: (api: FinanceModule) => api.financeApi.saveSettings(context) },
  { name: 'save_personal_debt', args: { p: debt }, invoke: (api: FinanceModule) => api.financeApi.saveDebt(debt, context) },
  { name: 'delete_personal_debt', args: { p_id: 'debt-id' }, invoke: (api: FinanceModule) => api.financeApi.deleteDebt('debt-id', context) },
  { name: 'save_budget_month', args: { p: budget }, invoke: (api: FinanceModule) => api.financeApi.saveBudget(budget, context) },
  { name: 'save_budget_transaction', args: { p: transaction }, invoke: (api: FinanceModule) => api.financeApi.saveTransaction(transaction, context) },
  { name: 'delete_budget_transaction', args: { p_id: 'entry-id' }, invoke: (api: FinanceModule) => api.financeApi.deleteTransaction('entry-id', context) },
  { name: 'save_personal_subscription', args: { p: subscription }, invoke: (api: FinanceModule) => api.financeApi.saveSubscription(subscription, context) },
  { name: 'delete_personal_subscription', args: { p_id: 'subscription-id' }, invoke: (api: FinanceModule) => api.financeApi.deleteSubscription('subscription-id', context) },
];
const isContextError = (error: unknown) => !!error && typeof error === 'object' && 'name' in error && error.name === 'FinanceContextError';

function paginatedSeed() {
  return Object.fromEntries(tables.map(table => [table, table === 'budget_transactions'
    ? [...Array.from({ length: 1001 }, (_, index) => ({ id: `A-${index}`, user_id: A })), ...Array.from({ length: 1001 }, (_, index) => ({ id: `B-${index}`, user_id: B }))]
    : [{ id: `A-${table}`, user_id: A }, { id: `B-${table}`, user_id: B }]]));
}

test('finance load filters all tables and every pagination request to the expected owner', async () => {
  const { api, state } = harness(paginatedSeed());
  const bundle = await api.loadFinance(A);
  assert.equal(state.authCalls, 2);
  assert.equal(bundle.transactions.length, 1001);
  assert.equal(bundle.settings?.user_id, A);
  assert.deepEqual([...new Set(state.queries.map(query => query.table))].sort(), [...tables].sort());
  for (const query of state.queries) assert.deepEqual(query.filters, [['user_id', A]], query.table);
  const pages = state.queries.filter(query => query.table === 'budget_transactions');
  assert.deepEqual(pages.map(query => [query.from, query.to]), [[0, 999], [1000, 1999]]);
  assert.ok(state.delivered.every(row => row.user_id === A));
  assert.equal(state.notifications, 0);
});

test('finance pagination rejects an A-to-B auth change and never fetches B records', async () => {
  const { api, state } = harness(paginatedSeed());
  state.onQuery = query => {
    if (query.table === 'budget_transactions' && query.from === 0) state.active = B;
  };
  await assert.rejects(api.loadFinance(A), isContextError);
  assert.equal(state.authCalls, 2);
  assert.ok(state.queries.some(query => query.table === 'budget_transactions' && query.from === 1000 && query.actor === B), 'the second page really runs after the switch');
  for (const query of state.queries) assert.deepEqual(query.filters, [['user_id', A]]);
  assert.ok(state.delivered.length >= 1000, 'the first A page was delivered');
  assert.ok(state.delivered.every(row => row.user_id === A), 'no B record escaped via any table or later page');
});

test('finance load refuses a stale account before querying any table', async () => {
  const { api, state } = harness(paginatedSeed());
  state.active = B;
  await assert.rejects(api.loadFinance(A), isContextError);
  assert.equal(state.authCalls, 1);
  assert.equal(state.queries.length, 0);
});

for (const write of writes) {
  test(`${write.name} blocks an A draft in B before RPC`, async () => {
    const { api, state } = harness();
    state.active = B;
    await assert.rejects(write.invoke(api), isContextError);
    assert.equal(state.authCalls, 1);
    assert.equal(state.rpcs.length, 0);
    assert.equal(state.notifications, 0);
  });
  test(`${write.name} sends expected user and currency and checks auth after RPC`, async () => {
    const { api, state } = harness();
    assert.equal(await write.invoke(api), 'saved-id');
    assert.equal(state.authCalls, 2);
    assert.equal(state.rpcs.length, 1);
    assert.equal(state.rpcs[0].name, write.name);
    // Normalize VM realm prototypes while retaining the complete RPC payload.
    assert.deepEqual(JSON.parse(JSON.stringify(state.rpcs[0].args)), { ...write.args, p_user: A, p_currency: 'USD' });
    assert.equal(state.notifications, 1);
  });
}

test('auth switches after getUser returns A: RPC still carries A so server can reject it', async () => {
  const { api, state } = harness();
  state.onGetUser = call => { if (call === 1) state.active = B; };
  state.onRpc = rpc => {
    assert.equal(rpc.actor, B);
    assert.equal(rpc.args.p_user, A);
    assert.equal(rpc.args.p_currency, 'USD');
    return { data: null, error: { message: 'Expected account does not match signed-in account' } };
  };
  await assert.rejects(api.financeApi.saveDebt(debt, context), /Expected account/);
  assert.equal(state.rpcs.length, 1);
  assert.equal(state.notifications, 0);
});

test('currency changes after auth check: stale currency reaches the server guard unchanged', async () => {
  const { api, state } = harness();
  let serverCurrency = 'USD';
  state.onGetUser = call => { if (call === 1) serverCurrency = 'EUR'; };
  state.onRpc = rpc => {
    assert.equal(rpc.actor, A);
    assert.equal(rpc.args.p_user, A);
    assert.equal(rpc.args.p_currency, 'USD');
    assert.notEqual(rpc.args.p_currency, serverCurrency);
    return { data: null, error: { message: 'Finance currency changed. Reload before saving.' } };
  };
  await assert.rejects(api.financeApi.saveDebt(debt, context), /Finance currency changed/);
  assert.equal(state.rpcs.length, 1);
  assert.equal(state.notifications, 0);
});

test('account changes while RPC resolves: reject success and do not notify the new account', async () => {
  const { api, state } = harness();
  state.onRpc = rpc => {
    assert.equal(rpc.actor, A);
    assert.equal(rpc.args.p_user, A);
    state.active = B;
    return { data: 'saved-for-A', error: null };
  };
  await assert.rejects(api.financeApi.saveDebt(debt, context), isContextError);
  assert.equal(state.authCalls, 2);
  assert.equal(state.rpcs.length, 1);
  assert.equal(state.notifications, 0);
});

test('auth lookup failures block finance reads and writes even when a user object is returned', async () => {
  const { api, state } = harness();
  state.authError = { message: 'Auth unavailable' };
  await assert.rejects(api.loadFinance(A), isContextError);
  await assert.rejects(api.financeApi.saveDebt(debt, context), isContextError);
  assert.equal(state.queries.length, 0);
  assert.equal(state.rpcs.length, 0);
  assert.equal(state.notifications, 0);
});
