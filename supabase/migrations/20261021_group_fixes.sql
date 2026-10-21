begin;

-- Group fixes of 2026-10-21. Safe to re-run; fresh deployments get the same from supabase/schema.sql.
--  1. Split a bill by the days each person lived there: stay dates on members, a billing period on
--     expenses and upcoming bills (a paid upcoming bill keeps its period).
--  2. Only the owner can delete a group (anyone, once no owner is left).
--  3. Joining matches a spot by first name only, never by surname.
--  4. Correcting an upcoming bill keeps everyone's check marks and the amount they actually sent.

-- Split by days stayed: when each person lived there (inclusive, open ends allowed),
-- and the dates a bill covers. Shares are then weighted by days in the bill's period.
alter table public.group_members add column if not exists stay_from date;
alter table public.group_members add column if not exists stay_to date;
alter table public.expenses add column if not exists period_start date;
alter table public.expenses add column if not exists period_end date;
alter table public.upcoming_bills add column if not exists period_start date;
alter table public.upcoming_bills add column if not exists period_end date;
alter table public.upcoming_bill_shares add column if not exists paid_cents bigint check (paid_cents is null or paid_cents >= 0);

create or replace function public.set_member_stay(mid uuid, p_from date, p_to date) returns void
language plpgsql security definer set search_path = public as $$
declare
  m public.group_members;
begin
  select * into m from public.group_members where id = mid;
  if not found or not public.is_group_member(m.group_id) then raise exception 'Not allowed'; end if;
  if p_to < p_from then raise exception 'The last day is before the first day'; end if;
  if m.stay_from is not distinct from p_from and m.stay_to is not distinct from p_to then return; end if;
  update public.group_members set stay_from = p_from, stay_to = p_to where id = mid;
  perform public.log_activity(m.group_id, 'member_stay',
    public.actor_name(m.group_id) || ' set ' || m.display_name || '''s dates: '
      || coalesce(to_char(p_from, 'Mon FMDD, YYYY'), 'from the start') || ' to ' || coalesce(to_char(p_to, 'Mon FMDD, YYYY'), 'now'));
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
  src_items jsonb := coalesce(p->'source_items','[]'::jsonb);
  src_tax bigint := coalesce((p->>'source_tax_cents')::bigint,0);
  src_tip bigint := coalesce((p->>'source_tip_cents')::bigint,0);
  converted jsonb;
  per_start date := nullif(p->>'period_start', '')::date;
  per_end date := nullif(p->>'period_end', '')::date;
begin
  if not public.is_group_member(p_group) then raise exception 'You are not in this group'; end if;
  select * into g from public.groups where id = p_group for share;
  if total is null or total <= 0 or total > 9007199254740991 then raise exception 'Amount must be positive and within the supported range'; end if;
  if (per_start is null) <> (per_end is null) or per_end < per_start then raise exception 'A billing period needs a first and last day, in order'; end if;
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
  if jsonb_typeof(src_items) is distinct from 'array' or src_tax<0 or src_tip<0 then raise exception 'Invalid original itemization'; end if;
  if jsonb_array_length(src_items)>0 then
    if src is null or jsonb_array_length(item_data)=0 then raise exception 'Original items require a converted itemized bill'; end if;
    if src_amt <> (select sum((x->>'amount_cents')::bigint) from jsonb_array_elements(src_items) x)+src_tax+src_tip or round(src_amt*rate)<>total then raise exception 'Original items must match the source and converted total'; end if;
    converted := public.convert_itemized_bill(p_group,src_items,src_tax,src_tip,total);
    if converted->'items'<>item_data or (converted->>'tax_cents')::bigint<>tax or (converted->>'tip_cents')::bigint<>tip then raise exception 'Converted line amounts do not match the saved exchange rate'; end if;
  elsif src_tax<>0 or src_tip<>0 then raise exception 'Original tax and tip require original items'; end if;
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
    source_currency=src, source_amount_cents=src_amt, fx_rate=rate, fx_date=rate_date,
    source_items=src_items,source_tax_cents=src_tax,source_tip_cents=src_tip,
    period_start=per_start, period_end=per_end where id=eid;

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

create or replace function public.delete_group(gid uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_group_member(gid) then raise exception 'You are not in this group'; end if;
  -- Deleting is permanent for everyone: only the owner, or anyone once no owner is left in the group.
  if not exists (select 1 from public.group_members where group_id = gid and user_id = auth.uid() and role = 'owner')
     and exists (select 1 from public.group_members where group_id = gid and role = 'owner' and is_active and user_id is not null) then
    raise exception 'Only the group''s owner can delete it';
  end if;
  delete from public.groups where id = gid;
end $$;

-- Best unclaimed spot for the signed-in user in a group: {member_id, how: 'email'|'name'} or null.
create or replace function public.suggest_spot(gid uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  me public.profiles;
  full_name text;
  mine text[];
  ids uuid[];
begin
  if auth.uid() is null then return null; end if;
  select * into me from public.profiles where id = auth.uid();
  select coalesce(nullif(raw_user_meta_data->>'full_name', ''), nullif(raw_user_meta_data->>'name', ''), me.display_name)
    into full_name from auth.users where id = auth.uid();
  -- 1) email
  if me.email is not null then
    select array_agg(id) into ids from public.group_members
     where group_id = gid and user_id is null and is_active and lower(email) = lower(me.email);
    if coalesce(array_length(ids, 1), 0) = 1 then return jsonb_build_object('member_id', ids[1], 'how', 'email'); end if;
  end if;
  -- 2) name: the spot's full name equals mine, or the spot's first name equals my first name
  --    (first names only, so a spot called "Jordan" never auto-claims "Michael Jordan")
  mine := array_remove(array[(public.name_tokens(full_name))[1], (public.name_tokens(me.display_name))[1]], null);
  if coalesce(array_length(mine, 1), 0) = 0 then return null; end if;
  select array_agg(id) into ids from public.group_members m
   where m.group_id = gid and m.user_id is null and m.is_active
     and (array_to_string(public.name_tokens(m.display_name), ' ') = array_to_string(public.name_tokens(full_name), ' ')
          or (char_length((public.name_tokens(m.display_name))[1]) >= 2 and (public.name_tokens(m.display_name))[1] = any (mine)));
  if coalesce(array_length(ids, 1), 0) = 1 then return jsonb_build_object('member_id', ids[1], 'how', 'name'); end if;
  return null;
end $$;

create or replace function public.set_share_paid(bid uuid, mid uuid, p_paid boolean) returns void
language plpgsql security definer set search_path = public as $$
declare
  b public.upcoming_bills;
  me public.group_members;
  who text;
  actor text;
begin
  select * into b from public.upcoming_bills where id = bid;
  if not found or not public.is_group_member(b.group_id) then raise exception 'Not allowed'; end if;
  if b.status <> 'upcoming' then raise exception 'This bill was already marked paid'; end if;
  select * into me from public.group_members where group_id = b.group_id and user_id = auth.uid();
  if not (me.id = mid or b.created_by = auth.uid() or me.role = 'owner') then
    raise exception 'Only that person, the bill creator, or the group owner can change this';
  end if;
  update public.upcoming_bill_shares
     set paid_at = case when p_paid then coalesce(paid_at, now()) else null end,
         paid_marked_by = case when p_paid then auth.uid() else null end,
         paid_cents = case when p_paid then coalesce(paid_cents, amount_cents) else null end
   where bill_id = bid and member_id = mid;
  if not found then raise exception 'That person is not part of this bill'; end if;
  select display_name into who from public.group_members where id = mid;
  actor := public.actor_name(b.group_id);
  perform public.log_activity(b.group_id, case when p_paid then 'upcoming_share_paid' else 'upcoming_share_unpaid' end,
    case when me.id = mid then actor || case when p_paid then ' marked their share of "' else ' unmarked their share of "' end
         else actor || case when p_paid then ' marked ' else ' unmarked ' end || who || '''s share of "' end
    || b.title || '" as ' || case when p_paid then 'paid' else 'not paid' end,
    null, (select amount_cents from public.upcoming_bill_shares where bill_id = bid and member_id = mid));
end $$;

-- Keep check marks when a bill is edited. A ticked person keeps the amount they actually sent,
-- so correcting an estimate leaves only the difference owing.
create or replace function public.save_upcoming_bill(p_id uuid, p_group uuid, p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  bid uuid;
  total bigint := (p->>'amount_cents')::bigint;
  ttl text := left(trim(coalesce(p->>'title', '')), 100);
  ssum bigint;
  bad int;
  kept jsonb := '[]'::jsonb;
  per_start date := nullif(p->>'period_start', '')::date;
  per_end date := nullif(p->>'period_end', '')::date;
begin
  if not public.is_group_member(p_group) then raise exception 'You are not in this group'; end if;
  perform 1 from public.groups where id=p_group for share;
  if total is null or total <= 0 then raise exception 'Amount must be greater than zero'; end if;
  if ttl = '' then raise exception 'Add a name for the bill'; end if;
  if (per_start is null) <> (per_end is null) or per_end < per_start then raise exception 'A billing period needs a first and last day, in order'; end if;
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
    insert into public.upcoming_bills (group_id, title, amount_cents, due_date, is_estimate, category, notes, period_start, period_end)
    values (p_group, ttl, total, nullif(p->>'due_date', '')::date, coalesce((p->>'is_estimate')::boolean, false),
            coalesce(nullif(p->>'category', ''), 'utilities'), nullif(trim(coalesce(p->>'notes', '')), ''), per_start, per_end)
    returning id into bid;
  else
    update public.upcoming_bills set
      title = ttl, amount_cents = total, due_date = nullif(p->>'due_date', '')::date,
      is_estimate = coalesce((p->>'is_estimate')::boolean, false),
      category = coalesce(nullif(p->>'category', ''), 'utilities'),
      notes = nullif(trim(coalesce(p->>'notes', '')), ''), period_start = per_start, period_end = per_end, updated_at = now()
    where id = p_id and group_id = p_group and status = 'upcoming'
    returning id into bid;
    if bid is null then raise exception 'That bill no longer exists or was already paid'; end if;
    select coalesce(jsonb_agg(jsonb_build_object('member_id', member_id, 'sent', coalesce(paid_cents, amount_cents), 'paid_at', paid_at, 'by', paid_marked_by)), '[]'::jsonb)
      into kept from public.upcoming_bill_shares where bill_id = bid and paid_at is not null;
    delete from public.upcoming_bill_shares where bill_id = bid;
  end if;

  insert into public.upcoming_bill_shares (bill_id, member_id, amount_cents)
  select bid, (x->>'member_id')::uuid, (x->>'amount_cents')::bigint
  from jsonb_array_elements(p->'shares') x where (x->>'amount_cents')::bigint > 0;

  update public.upcoming_bill_shares s
     set paid_at = (k->>'paid_at')::timestamptz, paid_marked_by = nullif(k->>'by', '')::uuid, paid_cents = (k->>'sent')::bigint
    from jsonb_array_elements(kept) k
   where s.bill_id = bid and s.member_id = (k->>'member_id')::uuid;

  perform public.log_activity(p_group, case when p_id is null then 'upcoming_added' else 'upcoming_updated' end,
    public.actor_name(p_group) || case when p_id is null then ' added upcoming bill "' else ' updated upcoming bill "' end || ttl || '"'
      || coalesce(' (due ' || to_char(nullif(p->>'due_date', '')::date, 'Mon FMDD') || ')', ''),
    null, total);
  return bid;
end $$;

-- Marking the whole bill paid also records ticked shares as payments to the (single) payer.
create or replace function public.mark_upcoming_paid(bid uuid, p_payers jsonb, p_date date default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  b public.upcoming_bills;
  eid uuid;
  payer uuid;
  s record;
begin
  select * into b from public.upcoming_bills where id = bid for update;
  if not found or not public.is_group_member(b.group_id) then raise exception 'Not allowed'; end if;
  if b.status <> 'upcoming' then raise exception 'This bill was already marked paid'; end if;
  if jsonb_typeof(p_payers) <> 'array' or jsonb_array_length(p_payers) = 0 then raise exception 'Choose who paid'; end if;
  -- Checked-off shares were paid to one person, so they need exactly one payer to become payments.
  if jsonb_array_length(p_payers) <> 1 and exists (select 1 from public.upcoming_bill_shares where bill_id = bid and paid_at is not null) then
    raise exception 'Some shares are checked off as paid. Choose a single payer, or uncheck them first.';
  end if;
  eid := public.save_expense(null, b.group_id, jsonb_build_object(
    'description', b.title, 'amount_cents', b.amount_cents, 'category', b.category,
    'expense_date', coalesce(p_date, current_date), 'notes', b.notes, 'split_type', 'exact',
    'period_start', b.period_start, 'period_end', b.period_end,
    'is_payment', false, 'repeat_interval', 'none', 'payers', p_payers,
    'splits', (select coalesce(jsonb_agg(jsonb_build_object('member_id', x.member_id, 'amount_cents', x.amount_cents)), '[]'::jsonb)
               from public.upcoming_bill_shares x where x.bill_id = bid)));
  if jsonb_array_length(p_payers) = 1 then
    payer := (p_payers->0->>'member_id')::uuid;
    for s in select * from public.upcoming_bill_shares where bill_id = bid and paid_at is not null and member_id <> payer and coalesce(paid_cents, amount_cents) > 0 loop
      perform public.save_expense(null, b.group_id, jsonb_build_object(
        'description', 'Payment', 'amount_cents', coalesce(s.paid_cents, s.amount_cents), 'category', 'payment',
        'expense_date', coalesce(s.paid_at::date, coalesce(p_date, current_date)),
        'notes', 'Share of "' || b.title || '" (checked off in Upcoming bills)',
        'split_type', 'exact', 'is_payment', true, 'repeat_interval', 'none',
        'payers', jsonb_build_array(jsonb_build_object('member_id', s.member_id, 'amount_cents', coalesce(s.paid_cents, s.amount_cents))),
        'splits', jsonb_build_array(jsonb_build_object('member_id', payer, 'amount_cents', coalesce(s.paid_cents, s.amount_cents)))));
    end loop;
  end if;
  update public.upcoming_bills set status = 'paid', expense_id = eid, updated_at = now() where id = bid;
  return eid;
end $$;

commit;
