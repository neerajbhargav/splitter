begin;
-- Free expense tools. Existing ledger amounts remain in the group's base currency.
alter table public.groups add column if not exists default_split jsonb;
alter table public.expenses add column if not exists items jsonb not null default '[]'::jsonb;
alter table public.expenses add column if not exists tax_cents bigint not null default 0 check (tax_cents >= 0);
alter table public.expenses add column if not exists tip_cents bigint not null default 0 check (tip_cents >= 0);
alter table public.expenses add column if not exists source_currency text;
alter table public.expenses add column if not exists source_amount_cents bigint;
alter table public.expenses add column if not exists fx_rate numeric;
alter table public.expenses add column if not exists fx_date date;

-- Recompute item splits on the server, never trusting the client's allocation.
create or replace function public.itemized_splits(gid uuid, items jsonb, tax bigint, tip bigint)
returns jsonb language plpgsql set search_path = public as $$
declare it jsonb; bad int; result jsonb;
begin
  if tax is null or tip is null or tax < 0 or tip < 0 then raise exception 'Invalid tax or tip'; end if;
  if jsonb_typeof(items) is distinct from 'array' then raise exception 'Items must be an array'; end if;
  if jsonb_array_length(items) not between 1 and 100 then raise exception 'Add between 1 and 100 items'; end if;
  for it in select value from jsonb_array_elements(items) loop
    if char_length(trim(coalesce(it->>'description',''))) not between 1 and 100
      or coalesce((it->>'amount_cents')::bigint,0) <= 0
      or (it->>'amount_cents')::numeric <> (it->>'amount_cents')::bigint then raise exception 'Invalid item name or amount'; end if;
    if jsonb_typeof(it->'member_ids') is distinct from 'array' then raise exception 'Assign each item'; end if;
    if jsonb_array_length(it->'member_ids') = 0 or
      (select count(distinct value) from jsonb_array_elements_text(it->'member_ids')) <> jsonb_array_length(it->'member_ids') then raise exception 'Invalid item assignments'; end if;
    select count(*) into bad from jsonb_array_elements_text(it->'member_ids') m
      where not exists(select 1 from public.group_members where id=public.try_uuid(m.value) and group_id=gid);
    if bad > 0 then raise exception 'Item assignees must belong to this group'; end if;
  end loop;
  with parts as (
    select it.value, m.value::uuid member_id,
      row_number() over(partition by it.ordinality order by m.value) rn,
      jsonb_array_length(it.value->'member_ids')::bigint n
    from jsonb_array_elements(items) with ordinality it
    cross join lateral jsonb_array_elements_text(it.value->'member_ids') m
  ), bases as (
    select member_id, sum((value->>'amount_cents')::bigint/n + case when rn <= (value->>'amount_cents')::bigint % n then 1 else 0 end)::bigint base
    from parts group by member_id
  ), raw as (
    select *, (tax::numeric+tip)*base/sum(base) over() exact from bases
  ), ranked as (
    select *, row_number() over(order by exact-floor(exact) desc, member_id) rank,
      (tax::numeric+tip)-sum(floor(exact)) over() remainder from raw
  ) select jsonb_agg(jsonb_build_object('member_id',member_id,'amount_cents',base+floor(exact)::bigint+case when rank<=remainder then 1 else 0 end) order by member_id)
    into result from ranked where base+floor(exact)+case when rank<=remainder then 1 else 0 end > 0;
  return coalesce(result,'[]'::jsonb);
end $$;
revoke all on function public.itemized_splits(uuid,jsonb,bigint,bigint) from public, anon, authenticated;

create or replace function public.save_default_split(gid uuid, p jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare n numeric; bad int;
begin
  if not public.is_group_member(gid) then raise exception 'You are not in this group'; end if;
  if p is not null and p <> 'null'::jsonb then
    if coalesce(p->>'type','') not in ('equal','percent','shares') or jsonb_typeof(p->'members') is distinct from 'array' then raise exception 'Invalid default split'; end if;
    if jsonb_array_length(p->'members') = 0 or
      (select count(distinct value->>'member_id') from jsonb_array_elements(p->'members')) <> jsonb_array_length(p->'members') then raise exception 'Pick unique people'; end if;
    select count(*),sum((x->>'weight')::numeric) into bad,n from jsonb_array_elements(p->'members') x
      where (x->>'weight') is null or (x->>'weight')::numeric < 0 or (x->>'weight')::numeric::text in ('NaN','Infinity','-Infinity')
        or not exists(select 1 from public.group_members where id=public.try_uuid(x->>'member_id') and group_id=gid and is_active);
    if bad > 0 then raise exception 'Defaults need active group members and nonnegative weights'; end if;
    select sum((x->>'weight')::numeric) into n from jsonb_array_elements(p->'members') x;
    if n <= 0 or (p->>'type'='percent' and abs(n-100) > 0.001) then raise exception 'Percentages must add to 100; shares need a positive weight'; end if;
  else p := null;
  end if;
  update public.groups set default_split=p,updated_at=now() where id=gid;
  perform public.log_activity(gid,'group_updated', public.actor_name(gid)||case when p is null then ' reset the default split' else ' saved the default split' end);
end $$;
revoke all on function public.save_default_split(uuid,jsonb) from public, anon;
grant execute on function public.save_default_split(uuid,jsonb) to authenticated;


create or replace function public.update_group(gid uuid, p_name text, p_kind text,
  p_currency text, p_simplify boolean)
returns void language plpgsql security definer set search_path = public as $$
declare g public.groups;
begin
  if not public.is_group_member(gid) then raise exception 'You are not in this group'; end if;
  select * into g from public.groups where id = gid for update;
  if upper(coalesce(nullif(trim(p_currency),''),g.currency)) <> g.currency and
    (exists(select 1 from public.expenses where group_id=gid) or exists(select 1 from public.upcoming_bills where group_id=gid)) then
    raise exception 'A group with bills cannot change its base currency. Convert foreign expenses when adding them instead.';
  end if;
  update public.groups set
    name = coalesce(nullif(trim(p_name), ''), name),
    kind = coalesce(nullif(p_kind, ''), kind),
    currency = coalesce(upper(nullif(trim(p_currency), '')), currency),
    simplify_debts = coalesce(p_simplify, simplify_debts),
    updated_at = now()
  where id = gid;
  if p_simplify is not null and p_simplify <> g.simplify_debts then
    perform public.log_activity(gid, 'group_updated', public.actor_name(gid) || ' turned simplify debts '
      || case when p_simplify then 'on' else 'off' end);
  end if;
  if nullif(trim(p_name), '') is not null and trim(p_name) <> g.name then
    perform public.log_activity(gid, 'group_updated', public.actor_name(gid) || ' renamed the group to "' || trim(p_name) || '"');
  end if;
  if nullif(trim(p_currency), '') is not null and upper(trim(p_currency)) <> g.currency then
    perform public.log_activity(gid, 'group_updated', public.actor_name(gid) || ' changed the currency to ' || upper(trim(p_currency)));
  end if;
end $$;
create or replace function public.save_expense(p_id uuid, p_group uuid, p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  g public.groups;
  old public.expenses;
  eid uuid;
  total bigint := (p->>'amount_cents')::bigint;
  descr text := left(trim(coalesce(p->>'description', '')), 100);
  d date := coalesce(nullif(p->>'expense_date', '')::date, current_date);
  rep text := coalesce(nullif(p->>'repeat_interval', ''), 'none');
  is_pay boolean := coalesce((p->>'is_payment')::boolean, false);
  psum bigint;
  ssum bigint;
  bad int;
  who_paid text;
  who_got text;
  summary text;
  item_data jsonb := coalesce(p->'items','[]'::jsonb);
  tax bigint := coalesce((p->>'tax_cents')::bigint,0);
  tip bigint := coalesce((p->>'tip_cents')::bigint,0);
  src text := nullif(p->>'source_currency','');
  src_amt bigint := (p->>'source_amount_cents')::bigint;
  rate numeric := (p->>'fx_rate')::numeric;
  rate_date date := (p->>'fx_date')::date;
begin
  if not public.is_group_member(p_group) then raise exception 'You are not in this group'; end if;
  select * into g from public.groups where id = p_group for share;
  if total is null or total <= 0 or total > 9007199254740991 then raise exception 'Amount must be positive and within the supported range'; end if;
  if jsonb_typeof(item_data) is distinct from 'array' then raise exception 'Items must be an array'; end if;
  if tax < 0 or tip < 0 then raise exception 'Tax and tip cannot be negative'; end if;
  if jsonb_array_length(item_data)>0 then
    if is_pay then raise exception 'Payments cannot be itemized'; end if;
    if total <> (select sum((x->>'amount_cents')::bigint) from jsonb_array_elements(item_data) x)+tax+tip then raise exception 'Items, tax and tip must match the total'; end if;
    p := jsonb_set(jsonb_set(p,'{splits}',public.itemized_splits(p_group,item_data,tax,tip)),'{split_type}','"exact"'::jsonb);
  elsif tax<>0 or tip<>0 then raise exception 'Tax and tip require items'; end if;
  if src is not null then
    if is_pay or src !~ '^[A-Z]{3}$' or src=g.currency or src_amt is null or src_amt<=0 or src_amt>9007199254740991
      or rate is null or rate<=0 or rate::text in ('NaN','Infinity','-Infinity') or rate_date is null or rate_date>current_date
      or abs(round(src_amt*rate)-total)>1 then raise exception 'Invalid currency conversion; apply a valid source amount and rate'; end if;
  elsif src_amt is not null or rate is not null or rate_date is not null then raise exception 'Currency conversion needs a source currency'; end if;
  if descr = '' then raise exception 'Add a description'; end if;
  if jsonb_typeof(p->'payers') <> 'array' or jsonb_typeof(p->'splits') <> 'array' then
    raise exception 'Payers and splits are required';
  end if;

  select coalesce(sum((x->>'amount_cents')::bigint), 0) into psum from jsonb_array_elements(p->'payers') x;
  select coalesce(sum((x->>'amount_cents')::bigint), 0) into ssum from jsonb_array_elements(p->'splits') x;
  if psum <> total then raise exception 'Paid amounts add up to % but the total is %', public.fmt_cents(psum), public.fmt_cents(total); end if;
  if ssum <> total then raise exception 'Split amounts add up to % but the total is %', public.fmt_cents(ssum), public.fmt_cents(total); end if;

  select count(*) into bad from (
    select x from jsonb_array_elements(p->'payers') x
    union all select x from jsonb_array_elements(p->'splits') x) t(x)
  where (x->>'amount_cents')::bigint < 0 or coalesce(nullif(x->>'weight', '')::numeric, 0) < 0;
  if bad > 0 then raise exception 'Amounts, percentages and shares can''t be negative'; end if;

  select count(*) into bad from (
    select x from jsonb_array_elements(p->'payers') x
    union all select x from jsonb_array_elements(p->'splits') x) t(x)
  where not exists (select 1 from public.group_members m
                    where m.id = public.try_uuid(x->>'member_id') and m.group_id = p_group);
  if bad > 0 then raise exception 'Every person in an expense must belong to this group'; end if;

  if (select count(distinct x->>'member_id') from jsonb_array_elements(p->'payers') x) <> jsonb_array_length(p->'payers')
     or (select count(distinct x->>'member_id') from jsonb_array_elements(p->'splits') x) <> jsonb_array_length(p->'splits') then
    raise exception 'A person appears twice in the same expense';
  end if;

  if is_pay then rep := 'none'; end if;

  if p_id is null then
    insert into public.expenses (group_id, description, amount_cents, currency, category, expense_date, notes,
      split_type, is_payment, receipt_path, repeat_interval, next_repeat_on, created_by)
    values (p_group, descr, total, g.currency,
      case when is_pay then 'payment' else coalesce(nullif(p->>'category', ''), 'general') end,
      d, nullif(trim(coalesce(p->>'notes', '')), ''),
      coalesce(nullif(p->>'split_type', ''), 'equal'), is_pay, nullif(p->>'receipt_path', ''),
      rep, public.next_repeat(d, rep), auth.uid())
    returning id into eid;
  else
    select * into old from public.expenses where id = p_id and group_id = p_group and deleted_at is null for update;
    if not found then raise exception 'That expense no longer exists'; end if;
    update public.expenses set
      description = descr,
      amount_cents = total,
      category = case when is_pay then 'payment' else coalesce(nullif(p->>'category', ''), 'general') end,
      expense_date = d,
      notes = nullif(trim(coalesce(p->>'notes', '')), ''),
      split_type = coalesce(nullif(p->>'split_type', ''), 'equal'),
      receipt_path = case when p ? 'receipt_path' then nullif(p->>'receipt_path', '') else receipt_path end,
      repeat_interval = rep,
      next_repeat_on = case
        when rep = 'none' then null
        when rep = old.repeat_interval and d = old.expense_date and old.next_repeat_on is not null then old.next_repeat_on
        else public.next_repeat(d, rep) end,
      updated_by = auth.uid(),
      updated_at = now()
    where id = p_id;
    delete from public.expense_payers where expense_id = p_id;
    delete from public.expense_splits where expense_id = p_id;
    eid := p_id;
  end if;

  update public.expenses set items=item_data, tax_cents=tax, tip_cents=tip,
    source_currency=src, source_amount_cents=src_amt, fx_rate=rate, fx_date=rate_date where id=eid;

  insert into public.expense_payers (expense_id, member_id, amount_cents)
  select eid, (x->>'member_id')::uuid, (x->>'amount_cents')::bigint
  from jsonb_array_elements(p->'payers') x where (x->>'amount_cents')::bigint > 0;

  insert into public.expense_splits (expense_id, member_id, amount_cents, weight)
  select eid, (x->>'member_id')::uuid, (x->>'amount_cents')::bigint, nullif(x->>'weight', '')::numeric
  from jsonb_array_elements(p->'splits') x where (x->>'amount_cents')::bigint > 0;

  if is_pay then
    select string_agg(m.display_name, ', ') into who_paid from public.expense_payers ep
      join public.group_members m on m.id = ep.member_id where ep.expense_id = eid;
    select string_agg(m.display_name, ', ') into who_got from public.expense_splits es
      join public.group_members m on m.id = es.member_id where es.expense_id = eid;
    summary := public.actor_name(p_group) || case when p_id is null then ' recorded a payment: ' else ' updated a payment: ' end
      || who_paid || ' paid ' || who_got;
  else
    summary := public.actor_name(p_group) || case when p_id is null then ' added "' else ' updated "' end || descr || '"';
  end if;
  perform public.log_activity(p_group,
    case when is_pay then (case when p_id is null then 'payment_added' else 'payment_updated' end)
         else (case when p_id is null then 'expense_added' else 'expense_updated' end) end,
    summary, eid, total);
  return eid;
end $$;
create or replace function public.process_recurring() returns int
language plpgsql security definer set search_path = public as $$
declare
  r public.expenses;
  nxt date;
  newid uuid;
  cnt int := 0;
  guard int;
begin
  if auth.uid() is null then return 0; end if;
  for r in
    select e.* from public.expenses e
    where e.repeat_interval <> 'none' and e.deleted_at is null and not e.is_payment
      and e.next_repeat_on is not null and e.next_repeat_on <= current_date
      and public.is_group_member(e.group_id)
    for update skip locked
  loop
    nxt := r.next_repeat_on;
    guard := 0;
    while nxt <= current_date and guard < 60 loop
      insert into public.expenses (group_id, description, amount_cents, currency, category, expense_date,
        notes, split_type, is_payment, repeat_interval, created_by, items, tax_cents, tip_cents, source_currency, source_amount_cents, fx_rate, fx_date)
      values (r.group_id, r.description, r.amount_cents, r.currency, r.category, nxt,
        r.notes, r.split_type, false, 'none', r.created_by, r.items, r.tax_cents, r.tip_cents, r.source_currency, r.source_amount_cents, r.fx_rate, r.fx_date)
      returning id into newid;
      insert into public.expense_payers (expense_id, member_id, amount_cents)
        select newid, member_id, amount_cents from public.expense_payers where expense_id = r.id;
      insert into public.expense_splits (expense_id, member_id, amount_cents, weight)
        select newid, member_id, amount_cents, weight from public.expense_splits where expense_id = r.id;
      insert into public.activity (group_id, expense_id, actor_id, kind, summary, amount_cents)
        values (r.group_id, newid, null, 'expense_recurring',
                '"' || r.description || '" repeated (' || r.repeat_interval || ')', r.amount_cents);
      nxt := public.next_repeat(nxt, r.repeat_interval);
      cnt := cnt + 1;
      guard := guard + 1;
    end loop;
    update public.expenses set next_repeat_on = nxt where id = r.id;
  end loop;
  return cnt;
end $$;
create or replace function public.save_upcoming_bill(p_id uuid, p_group uuid, p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  bid uuid;
  total bigint := (p->>'amount_cents')::bigint;
  ttl text := left(trim(coalesce(p->>'title', '')), 100);
  ssum bigint;
  bad int;
  kept jsonb := '[]'::jsonb;
begin
  if not public.is_group_member(p_group) then raise exception 'You are not in this group'; end if;
  perform 1 from public.groups where id=p_group for share;
  if total is null or total <= 0 then raise exception 'Amount must be greater than zero'; end if;
  if ttl = '' then raise exception 'Add a name for the bill'; end if;
  if jsonb_typeof(p->'shares') <> 'array' or jsonb_array_length(p->'shares') = 0 then raise exception 'Choose who splits this bill'; end if;
  select coalesce(sum((x->>'amount_cents')::bigint), 0) into ssum from jsonb_array_elements(p->'shares') x;
  if ssum <> total then raise exception 'Shares add up to % but the bill is %', public.fmt_cents(ssum), public.fmt_cents(total); end if;
  select count(*) into bad from jsonb_array_elements(p->'shares') x
   where (x->>'amount_cents')::bigint < 0
      or not exists (select 1 from public.group_members m where m.id = public.try_uuid(x->>'member_id') and m.group_id = p_group);
  if bad > 0 then raise exception 'Every person in a bill must belong to this group'; end if;
  if (select count(distinct x->>'member_id') from jsonb_array_elements(p->'shares') x) <> jsonb_array_length(p->'shares') then
    raise exception 'A person appears twice in the same bill';
  end if;

  if p_id is null then
    insert into public.upcoming_bills (group_id, title, amount_cents, due_date, is_estimate, category, notes)
    values (p_group, ttl, total, nullif(p->>'due_date', '')::date, coalesce((p->>'is_estimate')::boolean, false),
            coalesce(nullif(p->>'category', ''), 'utilities'), nullif(trim(coalesce(p->>'notes', '')), ''))
    returning id into bid;
  else
    update public.upcoming_bills set
      title = ttl, amount_cents = total, due_date = nullif(p->>'due_date', '')::date,
      is_estimate = coalesce((p->>'is_estimate')::boolean, false),
      category = coalesce(nullif(p->>'category', ''), 'utilities'),
      notes = nullif(trim(coalesce(p->>'notes', '')), ''), updated_at = now()
    where id = p_id and group_id = p_group and status = 'upcoming'
    returning id into bid;
    if bid is null then raise exception 'That bill no longer exists or was already paid'; end if;
    select coalesce(jsonb_agg(jsonb_build_object('member_id', member_id, 'amount_cents', amount_cents, 'paid_at', paid_at, 'by', paid_marked_by)), '[]'::jsonb)
      into kept from public.upcoming_bill_shares where bill_id = bid and paid_at is not null;
    delete from public.upcoming_bill_shares where bill_id = bid;
  end if;

  insert into public.upcoming_bill_shares (bill_id, member_id, amount_cents)
  select bid, (x->>'member_id')::uuid, (x->>'amount_cents')::bigint
  from jsonb_array_elements(p->'shares') x where (x->>'amount_cents')::bigint > 0;

  update public.upcoming_bill_shares s
     set paid_at = (k->>'paid_at')::timestamptz, paid_marked_by = nullif(k->>'by', '')::uuid
    from jsonb_array_elements(kept) k
   where s.bill_id = bid and s.member_id = (k->>'member_id')::uuid and s.amount_cents = (k->>'amount_cents')::bigint;

  perform public.log_activity(p_group, case when p_id is null then 'upcoming_added' else 'upcoming_updated' end,
    public.actor_name(p_group) || case when p_id is null then ' added upcoming bill "' else ' updated upcoming bill "' end || ttl || '"'
      || coalesce(' (due ' || to_char(nullif(p->>'due_date', '')::date, 'Mon FMDD') || ')', ''),
    null, total);
  return bid;
end $$;
create or replace function public.remove_member(mid uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  m public.group_members;
  bal bigint;
  actor text;
begin
  select * into m from public.group_members where id = mid;
  if not found or not public.is_group_member(m.group_id) then raise exception 'Not allowed'; end if;
  bal := public.member_balance(mid);
  if bal <> 0 then
    raise exception '% still has a balance of %. Settle up first.', m.display_name, public.fmt_cents(abs(bal));
  end if;
  actor := public.actor_name(m.group_id);
  if m.user_id = auth.uid() then
    perform public.log_activity(m.group_id, 'member_left', m.display_name || ' left the group');
  else
    perform public.log_activity(m.group_id, 'member_removed', actor || ' removed ' || m.display_name);
  end if;
  if exists (select 1 from public.expense_payers where member_id = mid)
     or exists (select 1 from public.expense_splits where member_id = mid)
     or exists (select 1 from public.expenses e cross join lateral jsonb_array_elements(e.items) it where e.group_id=m.group_id and (it->'member_ids') @> to_jsonb(array[mid::text])) then
    update public.group_members set is_active = false where id = mid;
  else
    delete from public.group_members where id = mid;
  end if;
  -- Nobody with an account left: clean the group up.
  if not exists (select 1 from public.group_members where group_id = m.group_id and user_id is not null and is_active) then
    delete from public.groups where id = m.group_id;
  end if;
end $$;
notify pgrst, 'reload schema';
commit;
