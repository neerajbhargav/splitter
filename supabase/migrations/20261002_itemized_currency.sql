begin;

-- Original receipt lines for foreign-currency itemized bills.
alter table public.expenses add column if not exists source_items jsonb not null default '[]'::jsonb;
alter table public.expenses add column if not exists source_tax_cents bigint not null default 0 check(source_tax_cents>=0);
alter table public.expenses add column if not exists source_tip_cents bigint not null default 0 check(source_tip_cents>=0);

create or replace function public.convert_itemized_bill(gid uuid, source_items jsonb, tax bigint, tip bigint, target_total bigint)
returns jsonb language plpgsql set search_path=public as $$
declare source_total numeric; result jsonb;
begin
  perform public.itemized_splits(gid,source_items,tax,tip); -- names, members, integers, positive lines
  select sum((value->>'amount_cents')::bigint)+tax+tip into source_total from jsonb_array_elements(source_items);
  if source_total>9007199254740991 or target_total<=0 or target_total>9007199254740991 then raise exception 'Bill total is too large or invalid'; end if;
  with components as (
    select ordinality i,(value->>'amount_cents')::bigint amount,value item from jsonb_array_elements(source_items) with ordinality
    union all select jsonb_array_length(source_items)+1,tax,null::jsonb
    union all select jsonb_array_length(source_items)+2,tip,null::jsonb
  ), raw as (
    select *,target_total::numeric*amount/source_total exact from components
  ), ranked as (
    select *,row_number() over(order by exact-floor(exact) desc,i) rank,target_total-sum(floor(exact)) over() remainder from raw
  ), allocated as (
    select *,floor(exact)::bigint+case when rank<=remainder then 1 else 0 end converted from ranked
  ) select jsonb_build_object('items',jsonb_agg(jsonb_set(item,'{amount_cents}',to_jsonb(converted)) order by i) filter(where item is not null),
    'tax_cents',max(converted) filter(where i=jsonb_array_length(source_items)+1),
    'tip_cents',max(converted) filter(where i=jsonb_array_length(source_items)+2)) into result from allocated;
  return result;
end $$;
revoke all on function public.convert_itemized_bill(uuid,jsonb,bigint,bigint,bigint) from public,anon,authenticated;

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
    source_items=src_items,source_tax_cents=src_tax,source_tip_cents=src_tip where id=eid;

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
        notes, split_type, is_payment, repeat_interval, created_by, items, tax_cents, tip_cents, source_currency, source_amount_cents, fx_rate, fx_date, source_items, source_tax_cents, source_tip_cents)
      values (r.group_id, r.description, r.amount_cents, r.currency, r.category, nxt,
        r.notes, r.split_type, false, 'none', r.created_by, r.items, r.tax_cents, r.tip_cents, r.source_currency, r.source_amount_cents, r.fx_rate, r.fx_date, r.source_items, r.source_tax_cents, r.source_tip_cents)
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
notify pgrst, 'reload schema';
commit;
