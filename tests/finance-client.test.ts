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
const tables = ['finance_settings', 'finance_accounts', 'finance_holdings', 'finance_categories', 'budget_months', 'finance_transactions', 'personal_subscriptions', 'finance_connections'];
const HOLDING_COLUMNS = 'id,user_id,account_id,symbol,name,shares::text,price_cents,created_at,updated_at';
const CONNECTION_COLUMNS = 'id,user_id,provider,institution,status,last_synced_at,error,created_at,updated_at';
const expectedColumns: Record<string, string> = { finance_holdings: HOLDING_COLUMNS, finance_connections: CONNECTION_COLUMNS };
const expectedOrder: Record<string, string> = { finance_accounts: 'created_at', finance_holdings: 'created_at', finance_categories: 'sort', budget_months: 'month', finance_transactions: 'date', personal_subscriptions: 'created_at', finance_connections: 'created_at' };
type Row = { id?: string; user_id: string; [key: string]: unknown };
type Query = { table: string; columns: string; filters: [string, unknown][]; orders: [string, unknown][]; from: number; to: number; single: boolean; actor: string | null };
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
      const query: Query = { table, columns: '', filters: [], orders: [], from: 0, to: 999, single: false, actor: null };
      const builder = {
        select(columns: string) { query.columns = columns; return builder; },
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


const account = { name: 'Private account', type: 'checking' };
const holding = { account_id: 'acc', symbol: 'VTI', name: 'Fund', shares: '1.5', price_cents: 100 };
const category = { name: 'Private category', kind: 'wants' as const };
const budget = { month: '2020-01-01', income_cents: 10000, limits: [] };
const transaction = { description: 'Private expense', amount_cents: 100, date: '2020-01-01' };
const importRows = [{ date: '2020-01-01', description: 'Row', amount_cents: 100, kind: 'expense', category_id: null, external_id: 'csv:1' }];
const subscription = { name: 'Private subscription', amount_cents: 100, cycle: 'monthly', anchor_date: '2020-01-01', status: 'active', notes: '' };
const profile = { income_cents: 1 };
type Api = FinanceModule['financeApi'];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const writes: { name: string; args: Record<string, unknown>; invoke: (api: Api) => Promise<unknown> }[] = [
  { name: 'ensure_finance_workspace', args: {}, invoke: api => api.ensureWorkspace(context) },
  { name: 'save_finance_settings', args: {}, invoke: api => api.saveSettings(context) },
  { name: 'save_finance_profile', args: { p: profile }, invoke: api => api.saveProfile(profile as never, context) },
  { name: 'save_finance_account', args: { p: account }, invoke: api => api.saveAccount(account as never, context) },
  { name: 'delete_finance_account', args: { p_id: 'x' }, invoke: api => api.deleteAccount('x', context) },
  { name: 'save_finance_holding', args: { p: holding }, invoke: api => api.saveHolding(holding as never, context) },
  { name: 'delete_finance_holding', args: { p_id: 'x' }, invoke: api => api.deleteHolding('x', context) },
  { name: 'save_finance_category', args: { p: category }, invoke: api => api.saveCategory(category as never, context) },
  { name: 'delete_finance_category', args: { p_id: 'x', p_reassign: null }, invoke: api => api.deleteCategory('x', null, context) },
  { name: 'delete_finance_category', args: { p_id: 'x', p_reassign: 'y' }, invoke: api => api.deleteCategory('x', 'y', context) },
  { name: 'save_budget_month', args: { p: budget }, invoke: api => api.saveBudget(budget as never, context) },
  { name: 'delete_budget_month', args: { p_id: 'x' }, invoke: api => api.deleteBudget('x', context) },
  { name: 'save_finance_transaction', args: { p: transaction }, invoke: api => api.saveTransaction(transaction as never, context) },
  { name: 'delete_finance_transaction', args: { p_id: 'x' }, invoke: api => api.deleteTransaction('x', context) },
  { name: 'recategorize_finance_transactions', args: { p_ids: ['a'], p_category: 'c' }, invoke: api => api.recategorize(['a'], 'c', context) },
  { name: 'recategorize_finance_transactions', args: { p_ids: ['a'], p_category: null }, invoke: api => api.recategorize(['a'], null, context) },
  { name: 'import_finance_transactions', args: { p_account: 'acc', p_rows: importRows }, invoke: api => api.importTransactions('acc', importRows as never, context) },
  { name: 'import_finance_transactions', args: { p_account: null, p_rows: importRows }, invoke: api => api.importTransactions(null, importRows as never, context) },
  { name: 'undo_finance_import', args: { p_batch: 'b' }, invoke: api => api.undoImport('b', context) },
  { name: 'save_personal_subscription', args: { p: subscription }, invoke: api => api.saveSubscription(subscription as never, context) },
  { name: 'delete_personal_subscription', args: { p_id: 'x' }, invoke: api => api.deleteSubscription('x', context) },
  { name: 'delete_finance_connection', args: { p_connection: 'c' }, invoke: api => api.deleteConnection('c', context) },
];
const isContextError = (error: unknown) => !!error && typeof error === 'object' && 'name' in error && error.name === 'FinanceContextError';
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

function paginatedSeed(): Record<string, Row[]> {
  return Object.fromEntries(tables.map(table => [table, table === 'finance_transactions'
    ? [...Array.from({ length: 1001 }, (_, index) => ({ id: `A-${index}`, user_id: A, date: '2026-01-01' })), ...Array.from({ length: 1001 }, (_, index) => ({ id: `B-${index}`, user_id: B }))]
    : [{ id: `A-${table}`, user_id: A }, { id: `B-${table}`, user_id: B }]]));
}

test('finance load filters all tables and every pagination request to the expected owner', async () => {
  const { api, state } = harness(paginatedSeed());
  const bundle = await api.loadFinance(A);
  assert.equal(state.authCalls, 2);
  assert.equal(bundle.user_id, A);
  assert.equal(bundle.transactions.length, 1001);
  assert.equal(bundle.settings?.user_id, A);
  assert.deepEqual([...new Set(state.queries.map(query => query.table))].sort(), [...tables].sort());
  for (const query of state.queries) assert.deepEqual(query.filters, [['user_id', A]], query.table);
  const pages = state.queries.filter(query => query.table === 'finance_transactions');
  assert.deepEqual(pages.map(query => [query.from, query.to]), [[0, 999], [1000, 1999]]);
  assert.ok(state.delivered.every(row => row.user_id === A));
  assert.equal(state.notifications, 0);
});

test('finance load selects the expected columns, ordering and read shape per table', async () => {
  const { api, state } = harness(paginatedSeed());
  await api.loadFinance(A);
  for (const table of tables) {
    const queries = state.queries.filter(query => query.table === table);
    assert.ok(queries.length > 0, table);
    for (const query of queries) {
      assert.equal(query.columns, expectedColumns[table] ?? '*', table);
      if (table === 'finance_settings') {
        assert.equal(query.single, true);
        assert.deepEqual(query.orders, []);
        assert.deepEqual([query.from, query.to], [0, 999]);
      } else {
        assert.equal(query.single, false);
        assert.deepEqual(plain(query.orders), [[expectedOrder[table], { ascending: true }], ['id', { ascending: true }]], table);
      }
    }
  }
  // Provider tokens live in a separate secret table that the browser never reads.
  assert.ok(!state.queries.some(query => /secret|token/i.test(query.table) || /secret|token/i.test(query.columns)));
});

test('finance load normalizes holdings shares, budget months and non-array limits', async () => {
  const seed = paginatedSeed();
  seed.finance_holdings = [{ id: 'h', user_id: A, shares: 12.5 }];
  seed.budget_months = [
    { id: 'm1', user_id: A, month: '2026-10-01T00:00:00', limits: null },
    { id: 'm2', user_id: A, month: '2026-11-01', limits: { bad: true } },
    { id: 'm3', user_id: A, month: '2026-12-01', limits: [{ category_id: 'c', limit_cents: 5 }] },
  ];
  const { api } = harness(seed);
  const bundle = await api.loadFinance(A);
  assert.equal(bundle.holdings[0].shares, '12.5');
  assert.equal(typeof bundle.holdings[0].shares, 'string');
  assert.deepEqual(plain(bundle.budgets.map(b => b.month)), ['2026-10-01', '2026-11-01', '2026-12-01']);
  assert.deepEqual(plain(bundle.budgets.map(b => b.limits)), [[], [], [{ category_id: 'c', limit_cents: 5 }]]);
  assert.equal(bundle.settings?.user_id, A);
});

test('finance load with no settings row returns null settings', async () => {
  const seed = paginatedSeed();
  seed.finance_settings = [{ id: 's', user_id: B }];
  const { api } = harness(seed);
  assert.equal((await api.loadFinance(A)).settings, null);
});

test('finance pagination rejects an A-to-B auth change and never fetches B records', async () => {
  const { api, state } = harness(paginatedSeed());
  state.onQuery = query => {
    if (query.table === 'finance_transactions' && query.from === 0) state.active = B;
  };
  await assert.rejects(api.loadFinance(A), isContextError);
  assert.equal(state.authCalls, 2);
  assert.ok(state.queries.some(query => query.table === 'finance_transactions' && query.from === 1000 && query.actor === B), 'the second page really runs after the switch');
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
  const label = `${write.name} ${JSON.stringify(write.args).slice(0, 40)}`;
  test(`${label} blocks an A draft in B before RPC`, async () => {
    const { api, state } = harness();
    state.active = B;
    await assert.rejects(write.invoke(api.financeApi), isContextError);
    assert.equal(state.authCalls, 1);
    assert.equal(state.rpcs.length, 0);
    assert.equal(state.notifications, 0);
  });
  test(`${label} sends expected user and currency and checks auth after RPC`, async () => {
    const { api, state } = harness();
    assert.equal(await write.invoke(api.financeApi), 'saved-id');
    assert.equal(state.authCalls, 2);
    assert.equal(state.rpcs.length, 1);
    assert.equal(state.rpcs[0].name, write.name);
    assert.deepEqual(plain(state.rpcs[0].args), plain({ ...write.args, p_user: A, p_currency: 'USD' }));
    assert.equal(state.notifications, 1);
  });
  test(`${label} rejects without notifying when the session changes during the RPC`, async () => {
    const { api, state } = harness();
    state.onRpc = () => { state.active = B; return { data: 'saved-for-A', error: null }; };
    await assert.rejects(write.invoke(api.financeApi), isContextError);
    assert.equal(state.authCalls, 2);
    assert.equal(state.rpcs.length, 1);
    assert.equal(state.notifications, 0);
  });
}

test('every financeApi method is covered by the write table', () => {
  const { api } = harness();
  const covered = new Set(writes.map(w => w.name));
  assert.equal(Object.keys(api.financeApi).length, 19);
  assert.equal(covered.size, 19);
  assert.ok(Object.values(api.financeApi).every(fn => typeof fn === 'function'));
});

test('server errors surface as errors and never notify', async () => {
  const { api, state } = harness();
  state.onRpc = () => ({ data: null, error: { message: 'Nope' } });
  await assert.rejects(api.financeApi.saveAccount(account as never, context), /Nope/);
  assert.equal(state.notifications, 0);
  assert.equal(state.authCalls, 1);
});

test('auth switches after getUser returns A: RPC still carries A so server can reject it', async () => {
  const { api, state } = harness();
  state.onGetUser = call => { if (call === 1) state.active = B; };
  state.onRpc = rpc => {
    assert.equal(rpc.actor, B);
    assert.equal(rpc.args.p_user, A);
    assert.equal(rpc.args.p_currency, 'USD');
    return { data: null, error: { message: 'Expected account does not match signed-in account' } };
  };
  await assert.rejects(api.financeApi.saveAccount(account as never, context), /Expected account/);
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
  await assert.rejects(api.financeApi.saveAccount(account as never, context), /Finance currency changed/);
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
  await assert.rejects(api.financeApi.saveAccount(account as never, context), isContextError);
  assert.equal(state.authCalls, 2);
  assert.equal(state.rpcs.length, 1);
  assert.equal(state.notifications, 0);
});

test('auth lookup failures block finance reads and writes even when a user object is returned', async () => {
  const { api, state } = harness();
  state.authError = { message: 'Auth unavailable' };
  await assert.rejects(api.loadFinance(A), isContextError);
  await assert.rejects(api.financeApi.saveAccount(account as never, context), isContextError);
  assert.equal(state.queries.length, 0);
  assert.equal(state.rpcs.length, 0);
  assert.equal(state.notifications, 0);
});
