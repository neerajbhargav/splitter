begin;

-- Personal finances never belong to a group and are visible only to their owner.
create table if not exists public.finance_settings (
 user_id uuid primary key references auth.users(id) on delete cascade,
 currency text not null default 'USD' check(currency ~ '^[A-Z]{3}$'),
 created_at timestamptz not null default now(),updated_at timestamptz not null default now()
);
create table if not exists public.personal_debts (
 id uuid primary key default gen_random_uuid(),user_id uuid not null references auth.users(id) on delete cascade,
 name text not null check(length(trim(name)) between 1 and 100),
 balance_cents bigint not null check(balance_cents between 1 and 1000000000000),
 apr_bps integer not null check(apr_bps between 0 and 100000),
 minimum_cents bigint not null check(minimum_cents between 1 and 1000000000000),
 created_at timestamptz not null default now(),updated_at timestamptz not null default now()
);
create table if not exists public.budget_months (
 id uuid primary key default gen_random_uuid(),user_id uuid not null references auth.users(id) on delete cascade,
 month date not null check(extract(day from month)=1 and month between date '1900-01-01' and date '2200-12-01'),
 income_cents bigint not null default 0 check(income_cents between 0 and 1000000000000),
 categories jsonb not null default '[]'::jsonb check(jsonb_typeof(categories)='array' and jsonb_array_length(categories)<=30),
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),unique(user_id,month)
);
create table if not exists public.personal_subscriptions (
 id uuid primary key default gen_random_uuid(),user_id uuid not null references auth.users(id) on delete cascade,
 name text not null check(length(trim(name)) between 1 and 100),
 amount_cents bigint not null check(amount_cents between 0 and 1000000000000),
 cycle text not null check(cycle in('weekly','monthly','quarterly','yearly')),
 anchor_date date not null check(anchor_date between date '1900-01-01' and date '2200-12-31'),
 status text not null default 'active' check(status in('active','paused','canceled')),
 notes text not null default '' check(length(notes)<=500),
 created_at timestamptz not null default now(),updated_at timestamptz not null default now()
);
create table if not exists public.budget_transactions (
 id uuid primary key default gen_random_uuid(),user_id uuid not null references auth.users(id) on delete cascade,
 description text not null check(length(trim(description)) between 1 and 100),
 amount_cents bigint not null check(amount_cents between 1 and 1000000000000),
 expense_date date not null check(expense_date between date '1900-01-01' and date '2200-12-31'),
 category_id uuid,subscription_id uuid references public.personal_subscriptions(id) on delete set null,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now()
);
create index if not exists personal_debts_owner on public.personal_debts(user_id);
create index if not exists budget_months_owner_month on public.budget_months(user_id,month);
create index if not exists personal_subscriptions_owner on public.personal_subscriptions(user_id);
create index if not exists budget_transactions_owner_date on public.budget_transactions(user_id,expense_date);
create unique index if not exists budget_subscription_daily_charge on public.budget_transactions(user_id,subscription_id,expense_date) where subscription_id is not null;

do $$ declare t text; begin
 foreach t in array array['finance_settings','personal_debts','budget_months','personal_subscriptions','budget_transactions'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('drop policy if exists finance_owner_read on public.%I',t);
  execute format('create policy finance_owner_read on public.%I for select to authenticated using(user_id=auth.uid())',t);
  execute format('revoke all on public.%I from anon,authenticated',t);
  execute format('grant select on public.%I to authenticated',t);
 end loop;
end $$;

-- All writes lock the owner's settings row. It is also the private realtime
-- invalidation signal, so deletions sync without exposing cross-user delete events.
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
 return u;
end $$;
create or replace function public._finance_money(p jsonb,k text,allow_zero boolean default false) returns bigint
language plpgsql set search_path=public as $$
declare v numeric;begin
 if jsonb_typeof(p->k) is distinct from 'number' then raise exception 'Enter a valid amount for %',k;end if;
 v:=(p->>k)::numeric;
 if v<>trunc(v) or v>1000000000000 or v<(case when allow_zero then 0 else 1 end) then raise exception 'Invalid amount for %',k;end if;
 return v::bigint;
end $$;
create or replace function public._finance_name(p jsonb,k text default 'name') returns text
language plpgsql set search_path=public as $$
declare v text:=trim(p->>k);begin
 if jsonb_typeof(p->k) is distinct from 'string' or v is null or length(v) not between 1 and 100 then raise exception 'Enter a name or description of 1 to 100 characters';end if;
 return v;
end $$;

create or replace function public.save_finance_settings(p_currency text,p_user uuid) returns void
language plpgsql security definer set search_path=public as $$
declare u uuid:=public._finance_owner_lock(p_user,p_currency,true);old text;begin
 if p_currency is null or p_currency !~ '^[A-Z]{3}$' then raise exception 'Choose a valid currency';end if;
 select currency into old from public.finance_settings where user_id=u;
 if old<>p_currency and(exists(select 1 from public.personal_debts where user_id=u) or exists(select 1 from public.personal_subscriptions where user_id=u) or exists(select 1 from public.budget_months where user_id=u) or exists(select 1 from public.budget_transactions where user_id=u)) then raise exception 'Currency is locked while personal finance records exist. Changing a label would not convert your money.';end if;
 update public.finance_settings set currency=p_currency,updated_at=clock_timestamp() where user_id=u;
end $$;
create or replace function public.save_personal_debt(p jsonb,p_user uuid,p_currency text) returns uuid
language plpgsql security definer set search_path=public as $$
declare u uuid:=public._finance_owner_lock(p_user,p_currency);v_id uuid:=(p->>'id')::uuid;v_name text:=public._finance_name(p);bal bigint:=public._finance_money(p,'balance_cents');minimum bigint:=public._finance_money(p,'minimum_cents');apr numeric:=(p->>'apr_bps')::numeric;begin
 if jsonb_typeof(p->'apr_bps') is distinct from 'number' or apr is null or apr<>trunc(apr) or apr not between 0 and 100000 then raise exception 'Enter a valid APR between 0 and 1000 percent';end if;
 if v_id is null then
  if(select count(*) from public.personal_debts where user_id=u)>=100 then raise exception 'You can track up to 100 debts';end if;
  insert into public.personal_debts(user_id,name,balance_cents,apr_bps,minimum_cents) values(u,v_name,bal,apr,minimum) returning id into v_id;
 else
  update public.personal_debts set name=v_name,balance_cents=bal,apr_bps=apr,minimum_cents=minimum,updated_at=now() where id=v_id and user_id=u;
  if not found then raise exception 'Debt not found';end if;
 end if;return v_id;
end $$;
create or replace function public.delete_personal_debt(p_id uuid,p_user uuid,p_currency text) returns void
language plpgsql security definer set search_path=public as $$
begin delete from public.personal_debts where id=p_id and user_id=public._finance_owner_lock(p_user,p_currency);if not found then raise exception 'Debt not found';end if;end $$;

create or replace function public.save_budget_month(p jsonb,p_user uuid,p_currency text) returns uuid
language plpgsql security definer set search_path=public as $$
declare u uuid:=public._finance_owner_lock(p_user,p_currency);m date:=(p->>'month')::date;income bigint:=public._finance_money(p,'income_cents',true);cats jsonb:=p->'categories';clean jsonb:='[]'::jsonb;c jsonb;cid uuid;seen uuid[]:='{}';kind text;label text;lim bigint;v_id uuid;begin
 if m is null or extract(day from m)<>1 or m not between date '1900-01-01' and date '2200-12-01' then raise exception 'Choose a valid budget month';end if;
 if jsonb_typeof(cats) is distinct from 'array' or jsonb_array_length(cats)>30 then raise exception 'Use up to 30 budget categories';end if;
 for c in select value from jsonb_array_elements(cats) loop
  cid:=(c->>'id')::uuid;label:=public._finance_name(c);kind:=c->>'kind';lim:=public._finance_money(c,'limit_cents',true);
  if cid is null or cid=any(seen) or kind is null or kind not in('needs','wants','savings') then raise exception 'Invalid or duplicate budget category';end if;
  seen:=array_append(seen,cid);clean:=clean||jsonb_build_array(jsonb_build_object('id',cid,'name',label,'kind',kind,'limit_cents',lim));
 end loop;
 if exists(select 1 from public.budget_transactions where user_id=u and expense_date>=m and expense_date<m+interval '1 month' and category_id is not null and not(category_id=any(seen))) then raise exception 'A category has logged entries. Move or delete its entries before removing the category.';end if;
 insert into public.budget_months(user_id,month,income_cents,categories) values(u,m,income,clean)
 on conflict(user_id,month) do update set income_cents=excluded.income_cents,categories=excluded.categories,updated_at=now() returning id into v_id;return v_id;
end $$;
create or replace function public.save_budget_transaction(p jsonb,p_user uuid,p_currency text) returns uuid
language plpgsql security definer set search_path=public as $$
declare u uuid:=public._finance_owner_lock(p_user,p_currency);v_id uuid:=(p->>'id')::uuid;descr text:=public._finance_name(p,'description');amt bigint:=public._finance_money(p,'amount_cents');d date:=(p->>'expense_date')::date;m date;old_month date;cat uuid:=(p->>'category_id')::uuid;sub uuid:=(p->>'subscription_id')::uuid;begin
 if d is null or d not between date '1900-01-01' and date '2200-12-31' or d>current_date+1 then raise exception 'Choose a valid date, not a future payment';end if;m:=date_trunc('month',d)::date;
 if v_id is not null then
  select date_trunc('month',expense_date)::date into old_month from public.budget_transactions where id=v_id and user_id=u for update;
  if not found then raise exception 'Budget entry not found';end if;
 end if;
 if(v_id is null or old_month<>m) and(select count(*) from public.budget_transactions where user_id=u and expense_date>=m and expense_date<m+interval '1 month')>=5000 then raise exception 'You can log up to 5000 entries per month';end if;
 if sub is not null and not exists(select 1 from public.personal_subscriptions where id=sub and user_id=u) then raise exception 'Subscription not found';end if;
 if cat is not null and not exists(select 1 from public.budget_months b cross join lateral jsonb_array_elements(b.categories)c where b.user_id=u and b.month=m and(c->>'id')::uuid=cat) then raise exception 'Choose a category from this budget month, or leave it uncategorized';end if;
 insert into public.budget_months(user_id,month) values(u,m) on conflict(user_id,month) do nothing;
 if v_id is null then
  insert into public.budget_transactions(user_id,description,amount_cents,expense_date,category_id,subscription_id) values(u,descr,amt,d,cat,sub) returning id into v_id;
 else
  update public.budget_transactions set description=descr,amount_cents=amt,expense_date=d,category_id=cat,subscription_id=sub,updated_at=now() where id=v_id and user_id=u;
  if not found then raise exception 'Budget entry not found';end if;
 end if;return v_id;
exception when unique_violation then raise exception 'This subscription already has a logged charge on that date. Edit its existing entry in Budget instead.';
end $$;
create or replace function public.delete_budget_transaction(p_id uuid,p_user uuid,p_currency text) returns void
language plpgsql security definer set search_path=public as $$
begin delete from public.budget_transactions where id=p_id and user_id=public._finance_owner_lock(p_user,p_currency);if not found then raise exception 'Budget entry not found';end if;end $$;

create or replace function public.save_personal_subscription(p jsonb,p_user uuid,p_currency text) returns uuid
language plpgsql security definer set search_path=public as $$
declare u uuid:=public._finance_owner_lock(p_user,p_currency);v_id uuid:=(p->>'id')::uuid;v_name text:=public._finance_name(p);amt bigint:=public._finance_money(p,'amount_cents',true);v_cycle text:=p->>'cycle';d date:=(p->>'anchor_date')::date;v_status text:=p->>'status';v_notes text:=coalesce(p->>'notes','');begin
 if v_cycle is null or v_cycle not in('weekly','monthly','quarterly','yearly') or v_status is null or v_status not in('active','paused','canceled') or d is null or d not between date '1900-01-01' and date '2200-12-31' or length(v_notes)>500 or(p?'notes' and jsonb_typeof(p->'notes') is distinct from 'string') then raise exception 'Enter valid subscription dates, cycle and status';end if;
 if v_id is null then
  if(select count(*) from public.personal_subscriptions where user_id=u)>=500 then raise exception 'You can track up to 500 subscriptions';end if;
  insert into public.personal_subscriptions(user_id,name,amount_cents,cycle,anchor_date,status,notes) values(u,v_name,amt,v_cycle,d,v_status,v_notes) returning id into v_id;
 else
  update public.personal_subscriptions set name=v_name,amount_cents=amt,cycle=v_cycle,anchor_date=d,status=v_status,notes=v_notes,updated_at=now() where id=v_id and user_id=u;
  if not found then raise exception 'Subscription not found';end if;
 end if;return v_id;
end $$;
create or replace function public.delete_personal_subscription(p_id uuid,p_user uuid,p_currency text) returns void
language plpgsql security definer set search_path=public as $$
begin delete from public.personal_subscriptions where id=p_id and user_id=public._finance_owner_lock(p_user,p_currency);if not found then raise exception 'Subscription not found';end if;end $$;

revoke all on function public._finance_owner_lock(uuid,text,boolean) from public,anon,authenticated;
revoke all on function public._finance_money(jsonb,text,boolean) from public,anon,authenticated;
revoke all on function public._finance_name(jsonb,text) from public,anon,authenticated;
do $$ declare f regprocedure;begin
 for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=any(array['save_finance_settings','save_personal_debt','delete_personal_debt','save_budget_month','save_budget_transaction','delete_budget_transaction','save_personal_subscription','delete_personal_subscription']) loop
  execute format('revoke all on function %s from public,anon,authenticated',f);
  execute format('grant execute on function %s to authenticated',f);
 end loop;
end $$;
do $$ begin
 if exists(select 1 from pg_publication where pubname='supabase_realtime') and not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='finance_settings') then alter publication supabase_realtime add table public.finance_settings;end if;
end $$;
notify pgrst,'reload schema';
commit;
