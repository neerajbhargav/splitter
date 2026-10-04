begin;

-- SPLITTER Finance planning: custom debt payment plans, a pay schedule with per-paycheck
-- allocations, and credit score history for the three bureaus. Same model as the ledger:
-- owner-only reads through RLS, every write through a validated security-definer RPC.

-- ---------- pay schedule (lives on the settings row) ----------
alter table public.finance_settings add column if not exists pay_cycle text check(pay_cycle is null or pay_cycle in('weekly','biweekly','semimonthly','monthly'));
alter table public.finance_settings add column if not exists pay_anchor date check(pay_anchor is null or pay_anchor between date '1900-01-01' and date '2200-12-31');
alter table public.finance_settings add column if not exists pay_day2 smallint check(pay_day2 is null or pay_day2 between 1 and 31);
alter table public.finance_settings add column if not exists paycheck_cents bigint not null default 0 check(paycheck_cents between 0 and 1000000000000);

-- ---------- custom debt plan (one per person) ----------
create table if not exists public.finance_debt_plans (
 user_id uuid primary key references auth.users(id) on delete cascade,
 strategy text not null default 'avalanche' check(strategy in('avalanche','snowball','custom')),
 extra_monthly_cents bigint not null default 0 check(extra_monthly_cents between 0 and 1000000000000),
 rollover boolean not null default true,
 priority jsonb not null default '[]'::jsonb check(jsonb_typeof(priority)='array'),
 payments jsonb not null default '[]'::jsonb check(jsonb_typeof(payments)='array'),
 extra_changes jsonb not null default '[]'::jsonb check(jsonb_typeof(extra_changes)='array'),
 lump_sums jsonb not null default '[]'::jsonb check(jsonb_typeof(lump_sums)='array'),
 created_at timestamptz not null default now(),updated_at timestamptz not null default now()
);

-- ---------- paychecks ----------
create table if not exists public.finance_paychecks (
 id uuid primary key default gen_random_uuid(),user_id uuid not null references auth.users(id) on delete cascade,
 pay_date date not null check(pay_date between date '1900-01-01' and date '2200-12-31'),
 amount_cents bigint not null check(amount_cents between 1 and 1000000000000),
 allocations jsonb not null default '[]'::jsonb check(jsonb_typeof(allocations)='array'),
 note text not null default '' check(length(note)<=300),
 received boolean not null default false,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 unique(user_id,pay_date)
);

-- ---------- credit scores ----------
create table if not exists public.finance_credit_scores (
 id uuid primary key default gen_random_uuid(),user_id uuid not null references auth.users(id) on delete cascade,
 bureau text not null check(bureau in('equifax','experian','transunion')),
 score smallint not null check(score between 250 and 900),
 model text not null default '' check(length(model)<=40),
 as_of date not null check(as_of between date '1900-01-01' and date '2200-12-31'),
 source text not null default '' check(length(source)<=60),
 note text not null default '' check(length(note)<=200),
 created_at timestamptz not null default now(),updated_at timestamptz not null default now()
);
create unique index if not exists finance_credit_scores_day on public.finance_credit_scores(user_id,bureau,as_of,lower(model));
create index if not exists finance_credit_scores_owner on public.finance_credit_scores(user_id,as_of);

do $$ declare t text; begin
 foreach t in array array['finance_debt_plans','finance_paychecks','finance_credit_scores'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('drop policy if exists finance_owner_read on public.%I',t);
  execute format('create policy finance_owner_read on public.%I for select to authenticated using(user_id=auth.uid())',t);
  execute format('revoke all on public.%I from anon,authenticated',t);
  execute format('grant select on public.%I to authenticated',t);
 end loop;
end $$;

-- ---------- helpers ----------
create or replace function public._finance_month(v jsonb) returns text
language plpgsql set search_path=public as $$
declare y integer;m integer;begin
 if jsonb_typeof(v) is distinct from 'string' or v#>>'{}' !~ '^\d{4}-\d{2}$' then raise exception 'Choose a valid month';end if;
 y:=split_part(v#>>'{}','-',1)::integer;m:=split_part(v#>>'{}','-',2)::integer;
 if y<1900 or y>2200 or m<1 or m>12 then raise exception 'Choose a valid month';end if;
 return v#>>'{}';
end $$;

-- Liability ids in a plan must belong to the caller.
create or replace function public._finance_debt_ref(u uuid,v jsonb,allow_null boolean) returns uuid
language plpgsql security definer set search_path=public as $$
declare r uuid;begin
 if v is null or jsonb_typeof(v)='null' or v#>>'{}'='' then
  if allow_null then return null;end if;raise exception 'Choose a debt';
 end if;
 if jsonb_typeof(v)<>'string' or v#>>'{}' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'Invalid debt';end if;
 r:=(v#>>'{}')::uuid;
 if not exists(select 1 from public.finance_accounts a where a.id=r and a.user_id=u and a.type in('credit','loan')) then raise exception 'Debt not found';end if;
 return r;
end $$;

-- ---------- currency lock now also covers planning amounts ----------
create or replace function public.save_finance_settings(p_currency text,p_user uuid) returns void
language plpgsql security definer set search_path=public as $$
declare u uuid:=public._finance_owner_lock(p_user,p_currency,true);old text;begin
 if p_currency is null or p_currency !~ '^[A-Z]{3}$' then raise exception 'Choose a valid currency';end if;
 select currency into old from public.finance_settings where user_id=u;
 if old<>p_currency and(
   exists(select 1 from public.finance_accounts where user_id=u) or exists(select 1 from public.finance_holdings where user_id=u)
   or exists(select 1 from public.personal_subscriptions where user_id=u) or exists(select 1 from public.budget_months where user_id=u)
   or exists(select 1 from public.finance_transactions where user_id=u) or exists(select 1 from public.finance_paychecks where user_id=u)
   or exists(select 1 from public.finance_debt_plans where user_id=u and(extra_monthly_cents>0 or jsonb_array_length(payments)>0 or jsonb_array_length(lump_sums)>0 or jsonb_array_length(extra_changes)>0))
   or exists(select 1 from public.finance_settings where user_id=u and(monthly_gross_cents>0 or monthly_net_cents>0 or housing_cents>0 or car_cents>0 or paycheck_cents>0))
 ) then raise exception 'Currency is locked while personal finance records exist. Changing a label would not convert your money.';end if;
 update public.finance_settings set currency=p_currency,updated_at=clock_timestamp() where user_id=u;
end $$;

-- ---------- pay schedule ----------
create or replace function public.save_finance_pay_schedule(p jsonb,p_user uuid,p_currency text) returns void
language plpgsql security definer set search_path=public as $$
declare u uuid:=public._finance_owner_lock(p_user,p_currency);v_cycle text;v_anchor date;v_day2 smallint;v_amount bigint;begin
 if p->'pay_cycle' is null or jsonb_typeof(p->'pay_cycle')='null' then
  update public.finance_settings set pay_cycle=null,pay_anchor=null,pay_day2=null,paycheck_cents=0,updated_at=clock_timestamp() where user_id=u;
  return;
 end if;
 v_cycle:=p->>'pay_cycle';
 if v_cycle not in('weekly','biweekly','semimonthly','monthly') then raise exception 'Choose how often you get paid';end if;
 v_anchor:=public._finance_date(p,'pay_anchor');
 v_amount:=public._finance_money(p,'paycheck_cents',true);
 if v_cycle='semimonthly' then
  if jsonb_typeof(p->'pay_day2') is distinct from 'number' or (p->>'pay_day2')::numeric<>trunc((p->>'pay_day2')::numeric) or (p->>'pay_day2')::numeric not between 1 and 31 then raise exception 'Choose your second payday of the month';end if;
  v_day2:=(p->>'pay_day2')::smallint;
  if v_day2=extract(day from v_anchor)::smallint then raise exception 'Your two paydays need to be on different days';end if;
 else v_day2:=null;end if;
 update public.finance_settings set pay_cycle=v_cycle,pay_anchor=v_anchor,pay_day2=v_day2,paycheck_cents=v_amount,updated_at=clock_timestamp() where user_id=u;
end $$;

-- ---------- debt plan ----------
create or replace function public.save_finance_debt_plan(p jsonb,p_user uuid,p_currency text) returns void
language plpgsql security definer set search_path=public as $$
declare u uuid:=public._finance_owner_lock(p_user,p_currency);v_strategy text:=p->>'strategy';v_extra bigint;v_roll boolean;
 e jsonb;ids uuid[]:='{}';acc uuid;months text[]:='{}';mo text;n numeric;
 v_priority jsonb:='[]';v_payments jsonb:='[]';v_changes jsonb:='[]';v_lumps jsonb:='[]';amt bigint;dd integer;lid uuid;begin
 if v_strategy is null or v_strategy not in('avalanche','snowball','custom') then raise exception 'Choose a payoff strategy';end if;
 v_extra:=public._finance_money(p,'extra_monthly_cents',true);
 if jsonb_typeof(p->'rollover') is distinct from 'boolean' then raise exception 'Invalid rollover setting';end if;
 v_roll:=(p->>'rollover')::boolean;
 for k in 0..3 loop
  if jsonb_typeof(p->(array['priority','payments','extra_changes','lump_sums'])[k+1]) is distinct from 'array' then raise exception 'Invalid payment plan';end if;
 end loop;
 if jsonb_array_length(p->'priority')>200 or jsonb_array_length(p->'payments')>200 or jsonb_array_length(p->'extra_changes')>60 or jsonb_array_length(p->'lump_sums')>120 then raise exception 'This payment plan has too many entries';end if;

 for e in select value from jsonb_array_elements(p->'priority') loop
  acc:=public._finance_debt_ref(u,e,false);
  if acc=any(ids) then raise exception 'Each debt can appear once in your order';end if;
  ids:=ids||acc;v_priority:=v_priority||to_jsonb(acc::text);
 end loop;

 ids:='{}';
 for e in select value from jsonb_array_elements(p->'payments') loop
  if jsonb_typeof(e)<>'object' then raise exception 'Invalid payment plan';end if;
  acc:=public._finance_debt_ref(u,e->'account_id',false);
  if acc=any(ids) then raise exception 'Each debt can have one monthly payment';end if;ids:=ids||acc;
  if e->'monthly_cents' is null or jsonb_typeof(e->'monthly_cents')='null' then amt:=null;else amt:=public._finance_money(e,'monthly_cents');end if;
  if e->'due_day' is null or jsonb_typeof(e->'due_day')='null' then dd:=null;
  elsif jsonb_typeof(e->'due_day')<>'number' then raise exception 'Choose a due day from 1 to 31';
  else n:=(e->>'due_day')::numeric;if n<>trunc(n) or n not between 1 and 31 then raise exception 'Choose a due day from 1 to 31';end if;dd:=n::integer;end if;
  v_payments:=v_payments||jsonb_build_array(jsonb_build_object('account_id',acc,'monthly_cents',amt,'due_day',dd));
 end loop;

 for e in select value from jsonb_array_elements(p->'extra_changes') loop
  if jsonb_typeof(e)<>'object' then raise exception 'Invalid payment plan';end if;
  mo:=public._finance_month(e->'month');
  if mo=any(months) then raise exception 'You already have a change starting %',mo;end if;months:=months||mo;
  amt:=public._finance_money(e,'extra_monthly_cents',true);
  v_changes:=v_changes||jsonb_build_array(jsonb_build_object('month',mo,'extra_monthly_cents',amt));
 end loop;
 select coalesce(jsonb_agg(x order by x->>'month'),'[]') into v_changes from jsonb_array_elements(v_changes) x;

 for e in select value from jsonb_array_elements(p->'lump_sums') loop
  if jsonb_typeof(e)<>'object' then raise exception 'Invalid payment plan';end if;
  lid:=coalesce(public._finance_optional_uuid(e,'id'),gen_random_uuid());
  mo:=public._finance_month(e->'month');
  amt:=public._finance_money(e,'amount_cents');
  acc:=public._finance_debt_ref(u,e->'account_id',true);
  v_lumps:=v_lumps||jsonb_build_array(jsonb_build_object('id',lid,'month',mo,'account_id',acc,'amount_cents',amt,'note',public._finance_text(e,'note',80,false)));
 end loop;
 select coalesce(jsonb_agg(x order by x->>'month',x->>'id'),'[]') into v_lumps from jsonb_array_elements(v_lumps) x;

 insert into public.finance_debt_plans(user_id,strategy,extra_monthly_cents,rollover,priority,payments,extra_changes,lump_sums)
 values(u,v_strategy,v_extra,v_roll,v_priority,v_payments,v_changes,v_lumps)
 on conflict(user_id) do update set strategy=excluded.strategy,extra_monthly_cents=excluded.extra_monthly_cents,rollover=excluded.rollover,
  priority=excluded.priority,payments=excluded.payments,extra_changes=excluded.extra_changes,lump_sums=excluded.lump_sums,updated_at=clock_timestamp();
end $$;

-- ---------- paychecks ----------
create or replace function public.save_finance_paycheck(p jsonb,p_user uuid,p_currency text) returns uuid
language plpgsql security definer set search_path=public as $$
declare u uuid:=public._finance_owner_lock(p_user,p_currency);v_id uuid:=public._finance_optional_uuid(p,'id');v_date date:=public._finance_date(p,'pay_date');
 v_amount bigint:=public._finance_money(p,'amount_cents');v_note text:=public._finance_text(p,'note',300,false);v_received boolean;
 e jsonb;v_alloc jsonb:='[]';aid uuid;kind text;ref uuid;amt bigint;seen uuid[]:='{}';total numeric:=0;begin
 if jsonb_typeof(p->'received') is distinct from 'boolean' then raise exception 'Invalid paycheck status';end if;
 v_received:=(p->>'received')::boolean;
 if jsonb_typeof(p->'allocations') is distinct from 'array' then raise exception 'Invalid paycheck plan';end if;
 if jsonb_array_length(p->'allocations')>80 then raise exception 'A paycheck can have up to 80 lines';end if;
 for e in select value from jsonb_array_elements(p->'allocations') loop
  if jsonb_typeof(e)<>'object' then raise exception 'Invalid paycheck plan';end if;
  aid:=coalesce(public._finance_optional_uuid(e,'id'),gen_random_uuid());
  if aid=any(seen) then raise exception 'Invalid paycheck plan';end if;seen:=seen||aid;
  kind:=e->>'kind';
  if kind is null or kind not in('bill','debt','spending','savings','other') then raise exception 'Invalid paycheck line type';end if;
  ref:=public._finance_optional_uuid(e,'ref_id');
  if ref is not null then
   if kind='debt' then perform public._finance_debt_ref(u,e->'ref_id',false);
   elsif kind='bill' then
    if not exists(select 1 from public.personal_subscriptions where id=ref and user_id=u) then raise exception 'Bill not found';end if;
   elsif kind in('spending','savings') then
    if not exists(select 1 from public.finance_categories where id=ref and user_id=u) then raise exception 'Category not found';end if;
   else ref:=null;end if;
  end if;
  amt:=public._finance_money(e,'amount_cents',true);total:=total+amt;
  if jsonb_typeof(coalesce(e->'done','false'::jsonb))<>'boolean' then raise exception 'Invalid paycheck line';end if;
  v_alloc:=v_alloc||jsonb_build_array(jsonb_build_object('id',aid,'label',public._finance_text(e,'label',80),'kind',kind,'ref_id',ref,'amount_cents',amt,'done',coalesce((e->>'done')::boolean,false)));
 end loop;
 if total>1000000000000 then raise exception 'These amounts are too large';end if;
 if v_id is null then
  if(select count(*) from public.finance_paychecks where user_id=u)>=1000 then raise exception 'You can keep up to 1000 paychecks';end if;
  if exists(select 1 from public.finance_paychecks where user_id=u and pay_date=v_date) then raise exception 'You already have a paycheck planned for that day';end if;
  insert into public.finance_paychecks(user_id,pay_date,amount_cents,allocations,note,received) values(u,v_date,v_amount,v_alloc,v_note,v_received) returning id into v_id;
 else
  if exists(select 1 from public.finance_paychecks where user_id=u and pay_date=v_date and id<>v_id) then raise exception 'You already have a paycheck planned for that day';end if;
  update public.finance_paychecks set pay_date=v_date,amount_cents=v_amount,allocations=v_alloc,note=v_note,received=v_received,updated_at=now() where id=v_id and user_id=u;
  if not found then raise exception 'Paycheck not found';end if;
 end if;return v_id;
end $$;
create or replace function public.delete_finance_paycheck(p_id uuid,p_user uuid,p_currency text) returns void
language plpgsql security definer set search_path=public as $$
begin delete from public.finance_paychecks where id=p_id and user_id=public._finance_owner_lock(p_user,p_currency);if not found then raise exception 'Paycheck not found';end if;end $$;

-- ---------- credit scores ----------
create or replace function public.save_finance_credit_score(p jsonb,p_user uuid,p_currency text) returns uuid
language plpgsql security definer set search_path=public as $$
declare u uuid:=public._finance_owner_lock(p_user,p_currency);v_id uuid:=public._finance_optional_uuid(p,'id');v_bureau text:=p->>'bureau';
 v_score numeric;v_model text:=public._finance_text(p,'model',40,false);v_date date:=public._finance_date(p,'as_of');
 v_source text:=public._finance_text(p,'source',60,false);v_note text:=public._finance_text(p,'note',200,false);begin
 if v_bureau is null or v_bureau not in('equifax','experian','transunion') then raise exception 'Choose Equifax, Experian or TransUnion';end if;
 if jsonb_typeof(p->'score') is distinct from 'number' then raise exception 'Enter a score from 250 to 900';end if;
 v_score:=(p->>'score')::numeric;
 if v_score<>trunc(v_score) or v_score not between 250 and 900 then raise exception 'Enter a score from 250 to 900';end if;
 if v_date>current_date+1 then raise exception 'That date hasn''t happened yet';end if;
 if exists(select 1 from public.finance_credit_scores where user_id=u and bureau=v_bureau and as_of=v_date and lower(model)=lower(v_model) and id is distinct from v_id) then
  raise exception 'You already logged that score for this day';end if;
 if v_id is null then
  if(select count(*) from public.finance_credit_scores where user_id=u)>=3000 then raise exception 'You can keep up to 3000 scores';end if;
  insert into public.finance_credit_scores(user_id,bureau,score,model,as_of,source,note) values(u,v_bureau,v_score::smallint,v_model,v_date,v_source,v_note) returning id into v_id;
 else
  update public.finance_credit_scores set bureau=v_bureau,score=v_score::smallint,model=v_model,as_of=v_date,source=v_source,note=v_note,updated_at=now() where id=v_id and user_id=u;
  if not found then raise exception 'Score not found';end if;
 end if;return v_id;
end $$;
create or replace function public.delete_finance_credit_score(p_id uuid,p_user uuid,p_currency text) returns void
language plpgsql security definer set search_path=public as $$
begin delete from public.finance_credit_scores where id=p_id and user_id=public._finance_owner_lock(p_user,p_currency);if not found then raise exception 'Score not found';end if;end $$;

-- ---------- grants ----------
do $$ declare f regprocedure;begin
 for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like '\_finance\_%' loop
  execute format('revoke all on function %s from public,anon,authenticated',f);
 end loop;
 for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=any(array[
  'save_finance_settings','save_finance_pay_schedule','save_finance_debt_plan','save_finance_paycheck','delete_finance_paycheck',
  'save_finance_credit_score','delete_finance_credit_score']) loop
  execute format('revoke all on function %s from public,anon,authenticated',f);
  execute format('grant execute on function %s to authenticated',f);
 end loop;
end $$;
notify pgrst,'reload schema';
commit;
