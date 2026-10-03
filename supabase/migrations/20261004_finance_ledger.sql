begin;

-- SPLITTER Finance v2: Folio's accounts, holdings, ledger, categories, health profile and bank
-- connections merged into the private finance workspace. Reads stay owner-only through RLS;
-- every write goes through validated security-definer RPCs that lock the owner's settings row.
-- Existing debts, budget months and budget entries are migrated, then the old tables are dropped.

alter table public.finance_settings add column if not exists monthly_gross_cents bigint not null default 0 check(monthly_gross_cents between 0 and 1000000000000);
alter table public.finance_settings add column if not exists monthly_net_cents bigint not null default 0 check(monthly_net_cents between 0 and 1000000000000);
alter table public.finance_settings add column if not exists housing_cents bigint not null default 0 check(housing_cents between 0 and 1000000000000);
alter table public.finance_settings add column if not exists car_cents bigint not null default 0 check(car_cents between 0 and 1000000000000);
alter table public.finance_settings add column if not exists categories_seeded boolean not null default false;

create table if not exists public.finance_connections (
 id uuid primary key default gen_random_uuid(),user_id uuid not null references auth.users(id) on delete cascade,
 provider text not null default 'plaid' check(provider='plaid'),
 item_id text not null check(length(item_id) between 1 and 200),
 institution text not null default 'Bank' check(length(institution) between 1 and 100),
 status text not null default 'ok' check(status in('ok','reauth','error')),
 last_synced_at timestamptz,
 error text check(error is null or length(error)<=300),
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 unique(user_id,item_id)
);
create unique index if not exists finance_connections_owner_id on public.finance_connections(user_id,id);
-- Plaid access tokens are AES-GCM ciphertext produced by the server with a key only the server has.
-- No client grants exist on this table; the owner can fetch ciphertext only through an RPC.
create table if not exists public.finance_connection_secrets (
 connection_id uuid primary key references public.finance_connections(id) on delete cascade,
 user_id uuid not null references auth.users(id) on delete cascade,
 token_ciphertext text not null check(length(token_ciphertext) between 20 and 4000),
 sync_cursor text check(sync_cursor is null or length(sync_cursor)<=4000),
 updated_at timestamptz not null default now()
);

create table if not exists public.finance_accounts (
 id uuid primary key default gen_random_uuid(),user_id uuid not null references auth.users(id) on delete cascade,
 name text not null check(length(trim(name)) between 1 and 100),
 institution text not null default '' check(length(institution)<=100),
 type text not null check(type in('checking','savings','cash','investment','credit','loan')),
 balance_cents bigint not null default 0 check(balance_cents between -1000000000000 and 1000000000000),
 last4 text check(last4 is null or last4 ~ '^[0-9A-Za-z]{2,4}$'),
 apr_bps integer check(apr_bps is null or apr_bps between 0 and 100000),
 minimum_cents bigint check(minimum_cents is null or minimum_cents between 1 and 1000000000000),
 in_payoff boolean not null default true,
 source text not null default 'manual' check(source in('manual','csv','plaid')),
 connection_id uuid,
 external_id text check(external_id is null or length(external_id) between 1 and 200),
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 constraint finance_accounts_liability_fields check(type in('credit','loan') or(apr_bps is null and minimum_cents is null)),
 constraint finance_accounts_liability_balance check(type not in('credit','loan') or balance_cents>=0),
 constraint finance_accounts_connection foreign key(user_id,connection_id) references public.finance_connections(user_id,id) on delete set null(connection_id)
);
create unique index if not exists finance_accounts_owner_id on public.finance_accounts(user_id,id);
create unique index if not exists finance_accounts_external on public.finance_accounts(user_id,external_id) where external_id is not null;

create table if not exists public.finance_holdings (
 id uuid primary key default gen_random_uuid(),user_id uuid not null references auth.users(id) on delete cascade,
 account_id uuid not null,
 symbol text not null check(symbol ~ '^[A-Z0-9][A-Z0-9.\-]{0,11}$'),
 name text not null default '' check(length(name)<=100),
 shares numeric(24,8) not null check(shares>0 and shares<=1000000000),
 price_cents bigint not null check(price_cents between 0 and 1000000000000),
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 constraint finance_holdings_value check(shares*price_cents<=1000000000000),
 constraint finance_holdings_account foreign key(user_id,account_id) references public.finance_accounts(user_id,id) on delete cascade
);

create table if not exists public.finance_categories (
 id uuid primary key default gen_random_uuid(),user_id uuid not null references auth.users(id) on delete cascade,
 name text not null check(length(trim(name)) between 1 and 40),
 kind text not null check(kind in('needs','wants','savings')),
 sort integer not null default 0 check(sort between 0 and 100000),
 archived boolean not null default false,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now()
);
create unique index if not exists finance_categories_owner_id on public.finance_categories(user_id,id);
create unique index if not exists finance_categories_owner_name on public.finance_categories(user_id,lower(name));

alter table public.budget_months add column if not exists limits jsonb not null default '[]'::jsonb check(jsonb_typeof(limits)='array' and jsonb_array_length(limits)<=60);

alter table public.personal_subscriptions add column if not exists category_id uuid;
alter table public.personal_subscriptions add column if not exists account_id uuid;
create unique index if not exists personal_subscriptions_owner_id on public.personal_subscriptions(user_id,id);
do $$ begin
 if not exists(select 1 from pg_constraint where conname='personal_subscriptions_category') then
  alter table public.personal_subscriptions add constraint personal_subscriptions_category foreign key(user_id,category_id) references public.finance_categories(user_id,id) on delete set null(category_id);
 end if;
 if not exists(select 1 from pg_constraint where conname='personal_subscriptions_account') then
  alter table public.personal_subscriptions add constraint personal_subscriptions_account foreign key(user_id,account_id) references public.finance_accounts(user_id,id) on delete set null(account_id);
 end if;
end $$;

create table if not exists public.finance_transactions (
 id uuid primary key default gen_random_uuid(),user_id uuid not null references auth.users(id) on delete cascade,
 account_id uuid,
 date date not null check(date between date '1900-01-01' and date '2200-12-31'),
 description text not null check(length(trim(description)) between 1 and 140),
 amount_cents bigint not null check(amount_cents between 1 and 1000000000000),
 kind text not null default 'expense' check(kind in('expense','income','transfer')),
 category_id uuid,
 subscription_id uuid,
 source text not null default 'manual' check(source in('manual','csv','plaid','subscription')),
 external_id text check(external_id is null or length(external_id) between 1 and 200),
 import_batch uuid,
 pending boolean not null default false,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 constraint finance_transactions_category_kind check(kind='expense' or category_id is null),
 constraint finance_transactions_account foreign key(user_id,account_id) references public.finance_accounts(user_id,id) on delete set null(account_id),
 constraint finance_transactions_category foreign key(user_id,category_id) references public.finance_categories(user_id,id) on delete set null(category_id),
 constraint finance_transactions_subscription foreign key(user_id,subscription_id) references public.personal_subscriptions(user_id,id) on delete set null(subscription_id)
);
create index if not exists finance_transactions_owner_date on public.finance_transactions(user_id,date);
create unique index if not exists finance_transactions_external on public.finance_transactions(user_id,external_id) where external_id is not null;
create unique index if not exists finance_transactions_subscription_day on public.finance_transactions(user_id,subscription_id,date) where subscription_id is not null;
create index if not exists finance_transactions_batch on public.finance_transactions(user_id,import_batch) where import_batch is not null;

do $$ declare t text; begin
 foreach t in array array['finance_settings','finance_accounts','finance_holdings','finance_categories','budget_months','finance_transactions','personal_subscriptions','finance_connections'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('drop policy if exists finance_owner_read on public.%I',t);
  execute format('create policy finance_owner_read on public.%I for select to authenticated using(user_id=auth.uid())',t);
  execute format('revoke all on public.%I from anon,authenticated',t);
  execute format('grant select on public.%I to authenticated',t);
 end loop;
 alter table public.finance_connection_secrets enable row level security;
 revoke all on public.finance_connection_secrets from anon,authenticated;
end $$;

-- ---------- helpers ----------
create or replace function public._finance_seed_categories(u uuid) returns void
language plpgsql security definer set search_path=public as $$
declare seeded boolean;begin
 select categories_seeded into seeded from public.finance_settings where user_id=u for update;
 if coalesce(seeded,false) then return;end if;
 insert into public.finance_categories(user_id,name,kind,sort)
 select u,d.name,d.kind,d.sort from(values
  ('Housing','needs',10),('Groceries','needs',20),('Utilities','needs',30),('Transport','needs',40),('Health','needs',50),('Debt payments','needs',60),
  ('Dining','wants',70),('Shopping','wants',80),('Subscriptions','wants',90),('Entertainment','wants',100),('Travel','wants',110),('Other','wants',120),
  ('Savings','savings',130),('Investing','savings',140)
 ) d(name,kind,sort)
 on conflict do nothing;
 update public.finance_settings set categories_seeded=true where user_id=u;
end $$;

create or replace function public._finance_owner_lock(p_user uuid,p_currency text,p_allow_currency_change boolean default false) returns uuid
language plpgsql security definer set search_path=public as $$
declare u uuid:=auth.uid(); cur text;actual text;begin
 if u is null then raise exception 'Not signed in';end if;
 if p_user is null or p_user<>u then raise exception 'Your signed-in account changed. Reload before saving this draft.';end if;
 if p_currency is null or p_currency !~ '^[A-Z]{3}$' then raise exception 'A valid draft currency is required';end if;
 select default_currency into cur from public.profiles where id=u;
 if cur is null or cur !~ '^[A-Z]{3}$' then cur:=p_currency;end if;
 insert into public.finance_settings(user_id,currency) values(u,cur)
 on conflict(user_id) do update set updated_at=clock_timestamp();
 select currency into actual from public.finance_settings where user_id=u;
 if not p_allow_currency_change and actual<>p_currency then raise exception 'Your finance currency changed. Close and reopen the draft, then review its amounts.';end if;
 perform public._finance_seed_categories(u);
 return u;
end $$;

create or replace function public._finance_text(p jsonb,k text,max_len integer,required boolean default true) returns text
language plpgsql set search_path=public as $$
declare v text;begin
 if p->k is null or jsonb_typeof(p->k)='null' then
  if required then raise exception 'Enter a % of 1 to % characters',replace(k,'_',' '),max_len;end if;return '';
 end if;
 if jsonb_typeof(p->k)<>'string' then raise exception 'Invalid %',replace(k,'_',' ');end if;
 v:=trim(p->>k);
 if required and length(v)=0 then raise exception 'Enter a % of 1 to % characters',replace(k,'_',' '),max_len;end if;
 if length(v)>max_len then raise exception 'Keep the % under % characters',replace(k,'_',' '),max_len+1;end if;
 return v;
end $$;
create or replace function public._finance_signed_money(p jsonb,k text) returns bigint
language plpgsql set search_path=public as $$
declare v numeric;begin
 if jsonb_typeof(p->k) is distinct from 'number' then raise exception 'Enter a valid amount for %',replace(k,'_',' ');end if;
 v:=(p->>k)::numeric;
 if v<>trunc(v) or abs(v)>1000000000000 then raise exception 'Invalid amount for %',replace(k,'_',' ');end if;
 return v::bigint;
end $$;
create or replace function public._finance_optional_uuid(p jsonb,k text) returns uuid
language plpgsql set search_path=public as $$
begin
 if p->k is null or jsonb_typeof(p->k)='null' or p->>k='' then return null;end if;
 if jsonb_typeof(p->k)<>'string' or p->>k !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'Invalid %',replace(k,'_',' ');end if;
 return (p->>k)::uuid;
end $$;
create or replace function public._finance_date(p jsonb,k text) returns date
language plpgsql set search_path=public as $$
declare d date;begin
 if jsonb_typeof(p->k) is distinct from 'string' or p->>k !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'Choose a valid date';end if;
 begin d:=(p->>k)::date;exception when others then raise exception 'Choose a valid date';end;
 if d not between date '1900-01-01' and date '2200-12-31' then raise exception 'Choose a date between 1900 and 2200';end if;
 return d;
end $$;

-- ---------- one-time migration of v1 finance data ----------
do $$
declare r record;nid uuid;has_old_categories boolean;
begin
 has_old_categories:=exists(select 1 from information_schema.columns where table_schema='public' and table_name='budget_months' and column_name='categories');
 -- Seed Folio categories for everyone who already has a finance workspace.
 for r in select user_id from public.finance_settings where not categories_seeded loop
  perform public._finance_seed_categories(r.user_id);
 end loop;

 if has_old_categories then
  create temporary table _finance_category_map(old_id uuid,user_id uuid,new_id uuid,primary key(old_id,user_id)) on commit drop;
  for r in
   select b.user_id,(c->>'id')::uuid old_id,left(trim(c->>'name'),40) name,c->>'kind' kind,b.month
   from public.budget_months b cross join lateral jsonb_array_elements(b.categories) c
   where c->>'id' ~* '^[0-9a-f-]{36}$' and length(trim(coalesce(c->>'name','')))>0 and c->>'kind' in('needs','wants','savings')
   order by b.month,c->>'name'
  loop
   insert into public.finance_settings(user_id) values(r.user_id) on conflict(user_id) do nothing;
   perform public._finance_seed_categories(r.user_id);
   select id into nid from public.finance_categories where user_id=r.user_id and lower(name)=lower(r.name);
   if nid is null then
    insert into public.finance_categories(user_id,name,kind,sort) values(r.user_id,r.name,r.kind,1000+(select count(*) from public.finance_categories where user_id=r.user_id)::integer) returning id into nid;
   else
    update public.finance_categories set kind=r.kind,archived=false where id=nid;
   end if;
   insert into _finance_category_map values(r.old_id,r.user_id,nid) on conflict do nothing;
  end loop;
  update public.budget_months b set limits=coalesce((
   select jsonb_agg(jsonb_build_object('category_id',x.new_id,'limit_cents',x.limit_cents) order by x.new_id)
   from(select m.new_id,sum(greatest(0,(c->>'limit_cents')::bigint)) limit_cents
        from jsonb_array_elements(b.categories) c join _finance_category_map m on m.old_id=(c->>'id')::uuid and m.user_id=b.user_id
        group by m.new_id) x),'[]'::jsonb)
  where jsonb_array_length(b.categories)>0;

  if to_regclass('public.budget_transactions') is not null then
   insert into public.finance_transactions(id,user_id,date,description,amount_cents,kind,category_id,subscription_id,source,created_at,updated_at)
   select t.id,t.user_id,t.expense_date,left(t.description,140),t.amount_cents,'expense',m.new_id,t.subscription_id,
          case when t.subscription_id is null then 'manual' else 'subscription' end,t.created_at,t.updated_at
   from public.budget_transactions t left join _finance_category_map m on m.old_id=t.category_id and m.user_id=t.user_id
   on conflict(id) do nothing;
  end if;
  alter table public.budget_months drop column categories;
 elsif to_regclass('public.budget_transactions') is not null then
  insert into public.finance_transactions(id,user_id,date,description,amount_cents,kind,subscription_id,source,created_at,updated_at)
  select t.id,t.user_id,t.expense_date,left(t.description,140),t.amount_cents,'expense',t.subscription_id,
         case when t.subscription_id is null then 'manual' else 'subscription' end,t.created_at,t.updated_at
  from public.budget_transactions t on conflict(id) do nothing;
 end if;

 if to_regclass('public.personal_debts') is not null then
  insert into public.finance_accounts(id,user_id,name,institution,type,balance_cents,apr_bps,minimum_cents,in_payoff,source,created_at,updated_at)
  select d.id,d.user_id,d.name,'',case when d.name ~* '(loan|mortgage|auto|car|student|personal|lending)' then 'loan' else 'credit' end,
         d.balance_cents,d.apr_bps,d.minimum_cents,true,'manual',d.created_at,d.updated_at
  from public.personal_debts d on conflict(id) do nothing;
 end if;
end $$;

drop function if exists public.save_personal_debt(jsonb,uuid,text);
drop function if exists public.delete_personal_debt(uuid,uuid,text);
drop function if exists public.save_budget_transaction(jsonb,uuid,text);
drop function if exists public.delete_budget_transaction(uuid,uuid,text);
drop table if exists public.budget_transactions;
drop table if exists public.personal_debts;

-- ---------- settings + profile ----------
create or replace function public.save_finance_settings(p_currency text,p_user uuid) returns void
language plpgsql security definer set search_path=public as $$
declare u uuid:=public._finance_owner_lock(p_user,p_currency,true);old text;begin
 if p_currency is null or p_currency !~ '^[A-Z]{3}$' then raise exception 'Choose a valid currency';end if;
 select currency into old from public.finance_settings where user_id=u;
 if old<>p_currency and(
   exists(select 1 from public.finance_accounts where user_id=u) or exists(select 1 from public.finance_holdings where user_id=u)
   or exists(select 1 from public.personal_subscriptions where user_id=u) or exists(select 1 from public.budget_months where user_id=u)
   or exists(select 1 from public.finance_transactions where user_id=u)
   or exists(select 1 from public.finance_settings where user_id=u and(monthly_gross_cents>0 or monthly_net_cents>0 or housing_cents>0 or car_cents>0))
 ) then raise exception 'Currency is locked while personal finance records exist. Changing a label would not convert your money.';end if;
 update public.finance_settings set currency=p_currency,updated_at=clock_timestamp() where user_id=u;
end $$;

create or replace function public.save_finance_profile(p jsonb,p_user uuid,p_currency text) returns void
language plpgsql security definer set search_path=public as $$
declare u uuid:=public._finance_owner_lock(p_user,p_currency);begin
 update public.finance_settings set
  monthly_gross_cents=public._finance_money(p,'monthly_gross_cents',true),
  monthly_net_cents=public._finance_money(p,'monthly_net_cents',true),
  housing_cents=public._finance_money(p,'housing_cents',true),
  car_cents=public._finance_money(p,'car_cents',true),
  updated_at=clock_timestamp()
 where user_id=u;
end $$;

-- First visit: create settings + default categories without requiring another write.
create or replace function public.ensure_finance_workspace(p_user uuid,p_currency text) returns void
language plpgsql security definer set search_path=public as $$
declare u uuid:=auth.uid();cur text;begin
 if u is null or p_user is distinct from u then raise exception 'Your signed-in account changed. Reload before continuing.';end if;
 select currency into cur from public.finance_settings where user_id=u;
 if cur is null then
  if p_currency is null or p_currency !~ '^[A-Z]{3}$' then raise exception 'A valid currency is required';end if;
  insert into public.finance_settings(user_id,currency) values(u,p_currency) on conflict(user_id) do nothing;
 end if;
 perform public._finance_seed_categories(u);
end $$;

-- ---------- accounts + holdings ----------
create or replace function public.save_finance_account(p jsonb,p_user uuid,p_currency text) returns uuid
language plpgsql security definer set search_path=public as $$
declare u uuid:=public._finance_owner_lock(p_user,p_currency);v_id uuid:=public._finance_optional_uuid(p,'id');
 v_name text:=public._finance_text(p,'name',100);v_inst text:=public._finance_text(p,'institution',100,false);
 v_type text:=p->>'type';bal bigint:=public._finance_signed_money(p,'balance_cents');v_last4 text;apr numeric;minimum bigint;payoff boolean;old_type text;begin
 if v_type is null or v_type not in('checking','savings','cash','investment','credit','loan') then raise exception 'Choose an account type';end if;
 if p->'last4' is null or jsonb_typeof(p->'last4')='null' or p->>'last4'='' then v_last4:=null;
 elsif jsonb_typeof(p->'last4')<>'string' or p->>'last4' !~ '^[0-9A-Za-z]{2,4}$' then raise exception 'Last 4 should be up to 4 letters or digits';
 else v_last4:=p->>'last4';end if;
 if v_type in('credit','loan') then
  if bal<0 then raise exception 'Enter the amount you owe as a positive number';end if;
  if p->'apr_bps' is null or jsonb_typeof(p->'apr_bps')='null' then apr:=null;
  elsif jsonb_typeof(p->'apr_bps')<>'number' then raise exception 'Enter an APR between 0 and 1000 percent';
  else apr:=(p->>'apr_bps')::numeric;if apr<>trunc(apr) or apr not between 0 and 100000 then raise exception 'Enter an APR between 0 and 1000 percent';end if;end if;
  if p->'minimum_cents' is null or jsonb_typeof(p->'minimum_cents')='null' then minimum:=null;else minimum:=public._finance_money(p,'minimum_cents');end if;
  payoff:=coalesce((p->>'in_payoff')::boolean,true);
 else apr:=null;minimum:=null;payoff:=true;end if;
 if v_id is null then
  if(select count(*) from public.finance_accounts where user_id=u)>=200 then raise exception 'You can track up to 200 accounts';end if;
  insert into public.finance_accounts(user_id,name,institution,type,balance_cents,last4,apr_bps,minimum_cents,in_payoff)
  values(u,v_name,v_inst,v_type,bal,v_last4,apr,minimum,payoff) returning id into v_id;
 else
  select type into old_type from public.finance_accounts where id=v_id and user_id=u for update;
  if not found then raise exception 'Account not found';end if;
  if old_type='investment' and v_type<>'investment' and exists(select 1 from public.finance_holdings where account_id=v_id and user_id=u) then raise exception 'Remove this account''s holdings before changing its type';end if;
  update public.finance_accounts set name=v_name,institution=v_inst,type=v_type,balance_cents=bal,last4=v_last4,apr_bps=apr,minimum_cents=minimum,in_payoff=payoff,updated_at=now() where id=v_id and user_id=u;
 end if;return v_id;
end $$;
create or replace function public.delete_finance_account(p_id uuid,p_user uuid,p_currency text) returns void
language plpgsql security definer set search_path=public as $$
begin delete from public.finance_accounts where id=p_id and user_id=public._finance_owner_lock(p_user,p_currency);if not found then raise exception 'Account not found';end if;end $$;

create or replace function public.save_finance_holding(p jsonb,p_user uuid,p_currency text) returns uuid
language plpgsql security definer set search_path=public as $$
declare u uuid:=public._finance_owner_lock(p_user,p_currency);v_id uuid:=public._finance_optional_uuid(p,'id');acc uuid:=public._finance_optional_uuid(p,'account_id');
 sym text:=upper(public._finance_text(p,'symbol',12));v_name text:=public._finance_text(p,'name',100,false);sh numeric;price bigint:=public._finance_money(p,'price_cents',true);begin
 if acc is null or not exists(select 1 from public.finance_accounts where id=acc and user_id=u and type='investment') then raise exception 'Choose one of your investment accounts';end if;
 if sym !~ '^[A-Z0-9][A-Z0-9.\-]{0,11}$' then raise exception 'Enter a ticker like VTI or BRK.B';end if;
 if jsonb_typeof(p->'shares')<>'string' or p->>'shares' !~ '^\d{1,10}(\.\d{1,8})?$' then raise exception 'Enter shares as a number with up to 8 decimals';end if;
 sh:=(p->>'shares')::numeric;
 if sh<=0 or sh>1000000000 then raise exception 'Shares must be greater than zero';end if;
 if sh*price>1000000000000 then raise exception 'That holding is too large to track';end if;
 if v_id is null then
  if(select count(*) from public.finance_holdings where user_id=u)>=500 then raise exception 'You can track up to 500 holdings';end if;
  insert into public.finance_holdings(user_id,account_id,symbol,name,shares,price_cents) values(u,acc,sym,v_name,sh,price) returning id into v_id;
 else
  update public.finance_holdings set account_id=acc,symbol=sym,name=v_name,shares=sh,price_cents=price,updated_at=now() where id=v_id and user_id=u;
  if not found then raise exception 'Holding not found';end if;
 end if;return v_id;
end $$;
create or replace function public.delete_finance_holding(p_id uuid,p_user uuid,p_currency text) returns void
language plpgsql security definer set search_path=public as $$
begin delete from public.finance_holdings where id=p_id and user_id=public._finance_owner_lock(p_user,p_currency);if not found then raise exception 'Holding not found';end if;end $$;

-- ---------- categories ----------
create or replace function public.save_finance_category(p jsonb,p_user uuid,p_currency text) returns uuid
language plpgsql security definer set search_path=public as $$
declare u uuid:=public._finance_owner_lock(p_user,p_currency);v_id uuid:=public._finance_optional_uuid(p,'id');v_name text:=public._finance_text(p,'name',40);v_kind text:=p->>'kind';
 v_archived boolean:=coalesce((p->>'archived')::boolean,false);v_sort integer;begin
 if v_kind is null or v_kind not in('needs','wants','savings') then raise exception 'Choose needs, wants or savings';end if;
 if exists(select 1 from public.finance_categories where user_id=u and lower(name)=lower(v_name) and id is distinct from v_id) then raise exception 'You already have a category called %',v_name;end if;
 if v_id is null then
  if(select count(*) from public.finance_categories where user_id=u)>=60 then raise exception 'You can have up to 60 categories';end if;
  select coalesce(max(sort),0)+10 into v_sort from public.finance_categories where user_id=u;
  insert into public.finance_categories(user_id,name,kind,sort,archived) values(u,v_name,v_kind,least(v_sort,100000),v_archived) returning id into v_id;
 else
  update public.finance_categories set name=v_name,kind=v_kind,archived=v_archived,updated_at=now() where id=v_id and user_id=u;
  if not found then raise exception 'Category not found';end if;
 end if;return v_id;
end $$;
-- Deleting never silently erases history: its entries, subscriptions and budget limits move to p_reassign (or become uncategorized).
create or replace function public.delete_finance_category(p_id uuid,p_reassign uuid,p_user uuid,p_currency text) returns void
language plpgsql security definer set search_path=public as $$
declare u uuid:=public._finance_owner_lock(p_user,p_currency);begin
 if not exists(select 1 from public.finance_categories where id=p_id and user_id=u) then raise exception 'Category not found';end if;
 if p_reassign is not null and(p_reassign=p_id or not exists(select 1 from public.finance_categories where id=p_reassign and user_id=u)) then raise exception 'Choose another of your categories';end if;
 update public.finance_transactions set category_id=p_reassign,updated_at=now() where user_id=u and category_id=p_id;
 update public.personal_subscriptions set category_id=p_reassign,updated_at=now() where user_id=u and category_id=p_id;
 update public.budget_months b set limits=coalesce((
  select jsonb_agg(jsonb_build_object('category_id',x.cid,'limit_cents',x.lim) order by x.cid) from(
   select case when (l->>'category_id')::uuid=p_id then p_reassign else (l->>'category_id')::uuid end cid,sum((l->>'limit_cents')::bigint) lim
   from jsonb_array_elements(b.limits) l group by 1) x where x.cid is not null),'[]'::jsonb),updated_at=now()
 where b.user_id=u and exists(select 1 from jsonb_array_elements(b.limits) l where (l->>'category_id')::uuid=p_id);
 delete from public.finance_categories where id=p_id and user_id=u;
end $$;

-- ---------- budgets ----------
create or replace function public.save_budget_month(p jsonb,p_user uuid,p_currency text) returns uuid
language plpgsql security definer set search_path=public as $$
declare u uuid:=public._finance_owner_lock(p_user,p_currency);m date:=public._finance_date(p,'month');income bigint:=public._finance_money(p,'income_cents',true);
 lims jsonb:=p->'limits';clean jsonb:='[]'::jsonb;l jsonb;cid uuid;seen uuid[]:='{}';lim bigint;v_id uuid;begin
 if extract(day from m)<>1 or m>date '2200-12-01' then raise exception 'Choose a valid budget month';end if;
 if jsonb_typeof(lims) is distinct from 'array' or jsonb_array_length(lims)>60 then raise exception 'Use up to 60 budget categories';end if;
 for l in select value from jsonb_array_elements(lims) loop
  cid:=public._finance_optional_uuid(l,'category_id');lim:=public._finance_money(l,'limit_cents',true);
  if cid is null or cid=any(seen) then raise exception 'Each category can appear once in a month';end if;
  if not exists(select 1 from public.finance_categories where id=cid and user_id=u) then raise exception 'Choose one of your categories';end if;
  seen:=array_append(seen,cid);clean:=clean||jsonb_build_array(jsonb_build_object('category_id',cid,'limit_cents',lim));
 end loop;
 insert into public.budget_months(user_id,month,income_cents,limits) values(u,m,income,clean)
 on conflict(user_id,month) do update set income_cents=excluded.income_cents,limits=excluded.limits,updated_at=now() returning id into v_id;return v_id;
end $$;
create or replace function public.delete_budget_month(p_id uuid,p_user uuid,p_currency text) returns void
language plpgsql security definer set search_path=public as $$
begin delete from public.budget_months where id=p_id and user_id=public._finance_owner_lock(p_user,p_currency);if not found then raise exception 'Budget not found';end if;end $$;

-- ---------- ledger ----------
create or replace function public._finance_check_refs(u uuid,acc uuid,cat uuid,sub uuid) returns void
language plpgsql security definer set search_path=public as $$
begin
 if acc is not null and not exists(select 1 from public.finance_accounts where id=acc and user_id=u) then raise exception 'Account not found';end if;
 if cat is not null and not exists(select 1 from public.finance_categories where id=cat and user_id=u) then raise exception 'Category not found';end if;
 if sub is not null and not exists(select 1 from public.personal_subscriptions where id=sub and user_id=u) then raise exception 'Subscription not found';end if;
end $$;
create or replace function public.save_finance_transaction(p jsonb,p_user uuid,p_currency text) returns uuid
language plpgsql security definer set search_path=public as $$
declare u uuid:=public._finance_owner_lock(p_user,p_currency);v_id uuid:=public._finance_optional_uuid(p,'id');d date:=public._finance_date(p,'date');
 descr text:=public._finance_text(p,'description',140);amt bigint:=public._finance_money(p,'amount_cents');v_kind text:=p->>'kind';
 acc uuid:=public._finance_optional_uuid(p,'account_id');cat uuid:=public._finance_optional_uuid(p,'category_id');sub uuid:=public._finance_optional_uuid(p,'subscription_id');src text;begin
 if v_kind is null or v_kind not in('expense','income','transfer') then raise exception 'Choose expense, income or transfer';end if;
 if d>current_date+1 then raise exception 'Log transactions once they happen. Use Subscriptions or Budget to plan future costs.';end if;
 if v_kind<>'expense' then cat:=null;end if;
 perform public._finance_check_refs(u,acc,cat,sub);
 if v_id is null then
  if(select count(*) from public.finance_transactions where user_id=u)>=100000 then raise exception 'You can keep up to 100,000 transactions';end if;
  src:=case when sub is null then 'manual' else 'subscription' end;
  insert into public.finance_transactions(user_id,account_id,date,description,amount_cents,kind,category_id,subscription_id,source)
  values(u,acc,d,descr,amt,v_kind,cat,sub,src) returning id into v_id;
 else
  update public.finance_transactions set account_id=acc,date=d,description=descr,amount_cents=amt,kind=v_kind,category_id=cat,subscription_id=sub,updated_at=now()
  where id=v_id and user_id=u;
  if not found then raise exception 'Transaction not found';end if;
 end if;return v_id;
exception when unique_violation then raise exception 'This subscription already has a charge logged on that date.';
end $$;
create or replace function public.delete_finance_transaction(p_id uuid,p_user uuid,p_currency text) returns void
language plpgsql security definer set search_path=public as $$
begin delete from public.finance_transactions where id=p_id and user_id=public._finance_owner_lock(p_user,p_currency);if not found then raise exception 'Transaction not found';end if;end $$;
create or replace function public.recategorize_finance_transactions(p_ids uuid[],p_category uuid,p_user uuid,p_currency text) returns integer
language plpgsql security definer set search_path=public as $$
declare u uuid:=public._finance_owner_lock(p_user,p_currency);n integer;begin
 if coalesce(array_length(p_ids,1),0) not between 1 and 5000 then raise exception 'Choose 1 to 5000 transactions';end if;
 perform public._finance_check_refs(u,null,p_category,null);
 update public.finance_transactions set category_id=p_category,updated_at=now() where user_id=u and id=any(p_ids) and kind='expense';
 get diagnostics n=row_count;return n;
end $$;
-- CSV import: validated batch insert. Rows already imported (same external_id) are skipped, so re-importing a file is harmless.
create or replace function public.import_finance_transactions(p_account uuid,p_rows jsonb,p_user uuid,p_currency text) returns jsonb
language plpgsql security definer set search_path=public as $$
declare u uuid:=public._finance_owner_lock(p_user,p_currency);r jsonb;batch uuid:=gen_random_uuid();d date;amt bigint;v_kind text;cat uuid;ext text;descr text;inserted integer:=0;total integer;begin
 if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) not between 1 and 5000 then raise exception 'Import 1 to 5000 rows at a time';end if;
 perform public._finance_check_refs(u,p_account,null,null);
 select count(*) into total from public.finance_transactions where user_id=u;
 if total+jsonb_array_length(p_rows)>100000 then raise exception 'This import would pass the 100,000 transaction limit';end if;
 for r in select value from jsonb_array_elements(p_rows) loop
  d:=public._finance_date(r,'date');descr:=public._finance_text(r,'description',140);amt:=public._finance_money(r,'amount_cents');v_kind:=r->>'kind';
  cat:=public._finance_optional_uuid(r,'category_id');ext:=public._finance_text(r,'external_id',200);
  if v_kind is null or v_kind not in('expense','income','transfer') then raise exception 'Invalid transaction type in import';end if;
  if ext !~ '^csv:' then raise exception 'Invalid import fingerprint';end if;
  if v_kind<>'expense' then cat:=null;end if;
  if cat is not null and not exists(select 1 from public.finance_categories where id=cat and user_id=u) then cat:=null;end if;
  insert into public.finance_transactions(user_id,account_id,date,description,amount_cents,kind,category_id,source,external_id,import_batch)
  values(u,p_account,d,descr,amt,v_kind,cat,'csv',ext,batch) on conflict(user_id,external_id) where external_id is not null do nothing;
  if found then inserted:=inserted+1;end if;
 end loop;
 if p_account is not null and inserted>0 then update public.finance_accounts set source=case when source='manual' then 'csv' else source end where id=p_account and user_id=u;end if;
 return jsonb_build_object('batch',case when inserted>0 then batch end,'inserted',inserted,'skipped',jsonb_array_length(p_rows)-inserted);
end $$;
create or replace function public.undo_finance_import(p_batch uuid,p_user uuid,p_currency text) returns integer
language plpgsql security definer set search_path=public as $$
declare u uuid:=public._finance_owner_lock(p_user,p_currency);n integer;begin
 delete from public.finance_transactions where user_id=u and import_batch=p_batch;get diagnostics n=row_count;
 if n=0 then raise exception 'That import was already removed';end if;return n;
end $$;

-- ---------- subscriptions ----------
drop function if exists public.save_personal_subscription(jsonb,uuid,text);
create or replace function public.save_personal_subscription(p jsonb,p_user uuid,p_currency text) returns uuid
language plpgsql security definer set search_path=public as $$
declare u uuid:=public._finance_owner_lock(p_user,p_currency);v_id uuid:=public._finance_optional_uuid(p,'id');v_name text:=public._finance_text(p,'name',100);
 amt bigint:=public._finance_money(p,'amount_cents',true);v_cycle text:=p->>'cycle';d date:=public._finance_date(p,'anchor_date');v_status text:=p->>'status';
 v_notes text:=public._finance_text(p,'notes',500,false);cat uuid:=public._finance_optional_uuid(p,'category_id');acc uuid:=public._finance_optional_uuid(p,'account_id');begin
 if v_cycle is null or v_cycle not in('weekly','monthly','quarterly','yearly') then raise exception 'Choose how often it renews';end if;
 if v_status is null or v_status not in('active','paused','canceled') then raise exception 'Invalid subscription status';end if;
 perform public._finance_check_refs(u,acc,cat,null);
 if v_id is null then
  if(select count(*) from public.personal_subscriptions where user_id=u)>=500 then raise exception 'You can track up to 500 subscriptions';end if;
  insert into public.personal_subscriptions(user_id,name,amount_cents,cycle,anchor_date,status,notes,category_id,account_id) values(u,v_name,amt,v_cycle,d,v_status,v_notes,cat,acc) returning id into v_id;
 else
  update public.personal_subscriptions set name=v_name,amount_cents=amt,cycle=v_cycle,anchor_date=d,status=v_status,notes=v_notes,category_id=cat,account_id=acc,updated_at=now() where id=v_id and user_id=u;
  if not found then raise exception 'Subscription not found';end if;
 end if;return v_id;
end $$;

-- ---------- Plaid (called by SPLITTER's server routes with the signed-in user's session) ----------
create or replace function public.plaid_save_connection(p_item_id text,p_institution text,p_ciphertext text,p_user uuid,p_currency text) returns uuid
language plpgsql security definer set search_path=public as $$
declare u uuid:=public._finance_owner_lock(p_user,p_currency);v_id uuid;begin
 if p_item_id is null or length(p_item_id) not between 1 and 200 then raise exception 'Invalid bank item';end if;
 if p_ciphertext is null or length(p_ciphertext) not between 20 and 4000 then raise exception 'Invalid bank token';end if;
 if(select count(*) from public.finance_connections where user_id=u)>=20 then raise exception 'You can link up to 20 banks';end if;
 insert into public.finance_connections(user_id,item_id,institution,status) values(u,p_item_id,left(coalesce(nullif(trim(p_institution),''),'Bank'),100),'ok')
 on conflict(user_id,item_id) do update set institution=excluded.institution,status='ok',error=null,updated_at=now() returning id into v_id;
 insert into public.finance_connection_secrets(connection_id,user_id,token_ciphertext) values(v_id,u,p_ciphertext)
 on conflict(connection_id) do update set token_ciphertext=excluded.token_ciphertext,updated_at=now();
 return v_id;
end $$;
create or replace function public.plaid_connection_secret(p_connection uuid,p_user uuid,p_currency text) returns table(item_id text,token_ciphertext text,sync_cursor text)
language plpgsql security definer set search_path=public as $$
declare u uuid:=public._finance_owner_lock(p_user,p_currency);begin
 return query select c.item_id,s.token_ciphertext,s.sync_cursor from public.finance_connections c join public.finance_connection_secrets s on s.connection_id=c.id where c.id=p_connection and c.user_id=u;
 if not found then raise exception 'Bank connection not found';end if;
end $$;
create or replace function public.plaid_upsert_accounts(p_connection uuid,p_accounts jsonb,p_user uuid,p_currency text) returns integer
language plpgsql security definer set search_path=public as $$
declare u uuid:=public._finance_owner_lock(p_user,p_currency);a jsonb;inst text;n integer:=0;v_type text;bal bigint;ext text;begin
 select institution into inst from public.finance_connections where id=p_connection and user_id=u;
 if not found then raise exception 'Bank connection not found';end if;
 if jsonb_typeof(p_accounts) is distinct from 'array' or jsonb_array_length(p_accounts)>100 then raise exception 'Invalid bank accounts';end if;
 for a in select value from jsonb_array_elements(p_accounts) loop
  v_type:=a->>'type';if v_type not in('checking','savings','cash','investment','credit','loan') then continue;end if;
  bal:=public._finance_signed_money(a,'balance_cents');if v_type in('credit','loan') then bal:=abs(bal);end if;
  ext:='plaid:'||public._finance_text(a,'account_id',150);
  insert into public.finance_accounts as fa(user_id,name,institution,type,balance_cents,last4,source,connection_id,external_id)
  values(u,left(public._finance_text(a,'name',100),100),inst,v_type,bal,case when a->>'mask' ~ '^[0-9A-Za-z]{2,4}$' then a->>'mask' end,'plaid',p_connection,ext)
  on conflict(user_id,external_id) where external_id is not null do update set balance_cents=excluded.balance_cents,connection_id=excluded.connection_id,institution=excluded.institution,source='plaid',
   type=case when (fa.type in('credit','loan'))=(excluded.type in('credit','loan')) then fa.type else excluded.type end,updated_at=now();
  n:=n+1;
 end loop;return n;
end $$;
create or replace function public.plaid_apply_sync(p_connection uuid,p_upserts jsonb,p_removed jsonb,p_cursor text,p_user uuid,p_currency text) returns jsonb
language plpgsql security definer set search_path=public as $$
declare u uuid:=public._finance_owner_lock(p_user,p_currency);t jsonb;acc uuid;cat uuid;ext text;v_kind text;n_up integer:=0;n_rm integer:=0;begin
 if not exists(select 1 from public.finance_connections where id=p_connection and user_id=u) then raise exception 'Bank connection not found';end if;
 if jsonb_typeof(p_upserts) is distinct from 'array' or jsonb_array_length(p_upserts)>1000 then raise exception 'Invalid sync page';end if;
 if jsonb_typeof(p_removed) is distinct from 'array' or jsonb_array_length(p_removed)>1000 then raise exception 'Invalid sync page';end if;
 for t in select value from jsonb_array_elements(p_upserts) loop
  ext:='plaid:'||public._finance_text(t,'transaction_id',150);
  select id into acc from public.finance_accounts where user_id=u and external_id='plaid:'||(t->>'account_id');
  v_kind:=t->>'kind';if v_kind not in('expense','income','transfer') then v_kind:='expense';end if;
  cat:=null;if v_kind='expense' and t->>'category' is not null then select id into cat from public.finance_categories where user_id=u and lower(name)=lower(t->>'category') and not archived;end if;
  insert into public.finance_transactions as ft(user_id,account_id,date,description,amount_cents,kind,category_id,source,external_id,pending)
  values(u,acc,public._finance_date(t,'date'),left(public._finance_text(t,'description',140),140),public._finance_money(t,'amount_cents'),v_kind,cat,'plaid',ext,coalesce((t->>'pending')::boolean,false))
  on conflict(user_id,external_id) where external_id is not null do update set account_id=excluded.account_id,date=excluded.date,description=excluded.description,amount_cents=excluded.amount_cents,
   kind=excluded.kind,pending=excluded.pending,
   category_id=case when excluded.kind<>'expense' then null else coalesce(ft.category_id,excluded.category_id) end,updated_at=now();
  n_up:=n_up+1;
 end loop;
 delete from public.finance_transactions where user_id=u and external_id=any(select 'plaid:'||x from jsonb_array_elements_text(p_removed) x);
 get diagnostics n_rm=row_count;
 if p_cursor is null or length(p_cursor) not between 1 and 4000 then raise exception 'Invalid sync cursor';end if;
 update public.finance_connection_secrets set sync_cursor=p_cursor,updated_at=now() where connection_id=p_connection and user_id=u;
 update public.finance_connections set status='ok',error=null,last_synced_at=now(),updated_at=now() where id=p_connection and user_id=u;
 return jsonb_build_object('upserted',n_up,'removed',n_rm);
end $$;
create or replace function public.plaid_set_status(p_connection uuid,p_status text,p_error text,p_user uuid,p_currency text) returns void
language plpgsql security definer set search_path=public as $$
declare u uuid:=public._finance_owner_lock(p_user,p_currency);begin
 if p_status not in('ok','reauth','error') then raise exception 'Invalid status';end if;
 update public.finance_connections set status=p_status,error=left(p_error,300),updated_at=now() where id=p_connection and user_id=u;
 if not found then raise exception 'Bank connection not found';end if;
end $$;
-- Unlinking keeps accounts and history as manual records.
create or replace function public.delete_finance_connection(p_connection uuid,p_user uuid,p_currency text) returns void
language plpgsql security definer set search_path=public as $$
declare u uuid:=public._finance_owner_lock(p_user,p_currency);begin
 update public.finance_accounts set source='manual',external_id=null where user_id=u and connection_id=p_connection;
 delete from public.finance_connections where id=p_connection and user_id=u;
 if not found then raise exception 'Bank connection not found';end if;
end $$;

-- ---------- grants ----------
do $$ declare f regprocedure;begin
 for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like '\_finance\_%' loop
  execute format('revoke all on function %s from public,anon,authenticated',f);
 end loop;
 for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=any(array[
  'save_finance_settings','save_finance_profile','ensure_finance_workspace','save_finance_account','delete_finance_account','save_finance_holding','delete_finance_holding',
  'save_finance_category','delete_finance_category','save_budget_month','delete_budget_month','save_finance_transaction','delete_finance_transaction',
  'recategorize_finance_transactions','import_finance_transactions','undo_finance_import','save_personal_subscription','delete_personal_subscription',
  'plaid_save_connection','plaid_connection_secret','plaid_upsert_accounts','plaid_apply_sync','plaid_set_status','delete_finance_connection']) loop
  execute format('revoke all on function %s from public,anon,authenticated',f);
  execute format('grant execute on function %s to authenticated',f);
 end loop;
end $$;
do $$ begin
 if exists(select 1 from pg_publication where pubname='supabase_realtime') and not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='finance_settings') then alter publication supabase_realtime add table public.finance_settings;end if;
end $$;
notify pgrst,'reload schema';
commit;
