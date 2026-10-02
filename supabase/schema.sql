-- =====================================================================
-- SPLITTER database schema
-- Paste this whole file into Supabase > SQL Editor > New query > Run.
-- Safe to re-run: tables use IF NOT EXISTS, functions use CREATE OR REPLACE,
-- triggers and policies are dropped and recreated.
--
-- Design:
--   * Reads go through Row Level Security (you only see groups you belong to).
--   * Every write goes through a SECURITY DEFINER function below that checks
--     membership, validates totals, and writes an activity row.
--   * Clients subscribe to realtime changes on `activity`, `groups`,
--     `group_members` and `comments`, so every device updates live.
--   * Money is stored as integer cents (bigint). No floating point.
-- =====================================================================

-- ---------- utility functions ----------------------------------------

create or replace function public.new_invite_code() returns text
language sql volatile as $$
  select substr(replace(gen_random_uuid()::text, '-', ''), 1, 12);
$$;

create or replace function public.member_color(n int) returns text
language sql immutable as $$
  select (array['#c9a96e','#8cc4a0','#8fa8d8','#e58a6f','#b79ad8',
                '#d8c25f','#6fb7b7','#d88fb0','#9cb86f','#d89a6f'])[(abs(n) % 10) + 1];
$$;

create or replace function public.next_repeat(d date, iv text) returns date
language sql immutable as $$
  select case iv
    when 'weekly'   then d + 7
    when 'biweekly' then d + 14
    when 'monthly'  then (d + interval '1 month')::date
    when 'yearly'   then (d + interval '1 year')::date
    else null end;
$$;

create or replace function public.try_uuid(t text) returns uuid
language plpgsql immutable as $$
begin
  return t::uuid;
exception when others then
  return null;
end $$;

create or replace function public.fmt_cents(c bigint) returns text
language sql immutable as $$
  select to_char(c / 100.0, 'FM999,999,990.00');
$$;

-- ---------- tables ----------------------------------------------------

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '',
  email text,
  avatar_url text,
  default_currency text not null default 'USD',
  created_at timestamptz not null default now()
);
create index if not exists profiles_email_idx on public.profiles (lower(email));

create table if not exists public.groups (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) between 1 and 60),
  kind text not null default 'home' check (kind in ('home','trip','couple','other')),
  currency text not null default 'USD' check (char_length(currency) = 3),
  simplify_debts boolean not null default true,
  invite_code text not null unique default public.new_invite_code(),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.group_members (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  display_name text not null check (char_length(trim(display_name)) between 1 and 40),
  email text,
  phone text,
  color text not null default '#c9a96e',
  role text not null default 'member' check (role in ('owner','member')),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index if not exists group_members_user_uniq
  on public.group_members (group_id, user_id) where user_id is not null;
create index if not exists group_members_user_idx on public.group_members (user_id);
create index if not exists group_members_group_idx on public.group_members (group_id);

create table if not exists public.expenses (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  description text not null check (char_length(trim(description)) between 1 and 100),
  amount_cents bigint not null check (amount_cents > 0),
  currency text not null default 'USD',
  category text not null default 'general',
  expense_date date not null default current_date,
  notes text,
  split_type text not null default 'equal' check (split_type in ('equal','exact','percent','shares')),
  is_payment boolean not null default false,
  receipt_path text,
  repeat_interval text not null default 'none'
    check (repeat_interval in ('none','weekly','biweekly','monthly','yearly')),
  next_repeat_on date,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists expenses_group_idx on public.expenses (group_id, expense_date desc);
create index if not exists expenses_repeat_idx on public.expenses (next_repeat_on)
  where repeat_interval <> 'none' and deleted_at is null;

create table if not exists public.expense_payers (
  expense_id uuid not null references public.expenses(id) on delete cascade,
  member_id uuid not null references public.group_members(id) on delete cascade,
  amount_cents bigint not null check (amount_cents >= 0),
  primary key (expense_id, member_id)
);
create index if not exists expense_payers_member_idx on public.expense_payers (member_id);

create table if not exists public.expense_splits (
  expense_id uuid not null references public.expenses(id) on delete cascade,
  member_id uuid not null references public.group_members(id) on delete cascade,
  amount_cents bigint not null check (amount_cents >= 0),
  weight numeric,
  primary key (expense_id, member_id)
);
create index if not exists expense_splits_member_idx on public.expense_splits (member_id);

create table if not exists public.comments (
  id uuid primary key default gen_random_uuid(),
  expense_id uuid not null references public.expenses(id) on delete cascade,
  group_id uuid not null references public.groups(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null default auth.uid(),
  body text not null check (char_length(trim(body)) between 1 and 1000),
  created_at timestamptz not null default now()
);
create index if not exists comments_expense_idx on public.comments (expense_id, created_at);

create table if not exists public.activity (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  expense_id uuid references public.expenses(id) on delete set null,
  actor_id uuid references auth.users(id) on delete set null,
  kind text not null,
  summary text not null,
  amount_cents bigint,
  created_at timestamptz not null default now()
);
create index if not exists activity_group_idx on public.activity (group_id, created_at desc);

-- ---------- membership helpers ----------------------------------------

create or replace function public.is_group_member(gid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.group_members m
    where m.group_id = gid and m.user_id = auth.uid() and m.is_active
  );
$$;

create or replace function public.shares_group_with(other uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.group_members a
    join public.group_members b on a.group_id = b.group_id
    where a.user_id = auth.uid() and a.is_active and b.user_id = other
  );
$$;

create or replace function public.actor_name(gid uuid) returns text
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select display_name from public.group_members where group_id = gid and user_id = auth.uid() limit 1),
    (select nullif(display_name, '') from public.profiles where id = auth.uid()),
    'Someone');
$$;

create or replace function public.log_activity(gid uuid, p_kind text, p_summary text,
  eid uuid default null, amt bigint default null) returns void
language sql security definer set search_path = public as $$
  insert into public.activity (group_id, expense_id, actor_id, kind, summary, amount_cents)
  values (gid, eid, auth.uid(), p_kind, p_summary, amt);
$$;

create or replace function public.member_balance(mid uuid) returns bigint
language sql stable security definer set search_path = public as $$
  select coalesce((select sum(p.amount_cents) from public.expense_payers p
                   join public.expenses e on e.id = p.expense_id
                   where p.member_id = mid and e.deleted_at is null), 0)
       - coalesce((select sum(s.amount_cents) from public.expense_splits s
                   join public.expenses e on e.id = s.expense_id
                   where s.member_id = mid and e.deleted_at is null), 0);
$$;

-- ---------- profiles --------------------------------------------------

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name, email, avatar_url)
  values (
    new.id,
    left(coalesce(nullif(new.raw_user_meta_data->>'full_name', ''),
                  nullif(new.raw_user_meta_data->>'name', ''),
                  nullif(new.raw_user_meta_data->>'user_name', ''),
                  nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
                  'New user'), 40),
    lower(new.email),
    coalesce(new.raw_user_meta_data->>'avatar_url', new.raw_user_meta_data->>'picture'))
  on conflict (id) do nothing;

  -- Someone added this email to a group before the person signed up: claim that spot.
  if new.email is not null then
    update public.group_members m set user_id = new.id
    where m.id in (
      select distinct on (x.group_id) x.id from public.group_members x
      where x.user_id is null and lower(x.email) = lower(new.email)
        and not exists (select 1 from public.group_members y
                        where y.group_id = x.group_id and y.user_id = new.id)
      order by x.group_id, x.created_at);
  end if;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Backfill for accounts created before this schema was installed.
create or replace function public.ensure_profile() returns void
language plpgsql security definer set search_path = public as $$
declare u auth.users;
begin
  if auth.uid() is null then return; end if;
  if exists (select 1 from public.profiles where id = auth.uid()) then return; end if;
  select * into u from auth.users where id = auth.uid();
  insert into public.profiles (id, display_name, email, avatar_url)
  values (u.id,
    left(coalesce(nullif(u.raw_user_meta_data->>'full_name', ''), nullif(u.raw_user_meta_data->>'name', ''),
                  nullif(split_part(coalesce(u.email, ''), '@', 1), ''), 'New user'), 40),
    lower(u.email),
    coalesce(u.raw_user_meta_data->>'avatar_url', u.raw_user_meta_data->>'picture'))
  on conflict (id) do nothing;
end $$;

create or replace function public.update_profile(p_name text, p_currency text default null) returns void
language plpgsql security definer set search_path = public as $$
declare nm text := left(trim(p_name), 40);
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if nm is null or nm = '' then raise exception 'Name cannot be empty'; end if;
  update public.profiles
     set display_name = nm,
         default_currency = coalesce(upper(nullif(trim(p_currency), '')), default_currency)
   where id = auth.uid();
  update public.group_members set display_name = nm where user_id = auth.uid();
end $$;

-- ---------- groups & members -----------------------------------------

create or replace function public.add_member_internal(gid uuid, p_name text, p_email text, p_phone text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  em text := nullif(lower(trim(coalesce(p_email, ''))), '');
  nm text := nullif(trim(coalesce(p_name, '')), '');
  uid uuid;
  mid uuid;
  n int;
begin
  if nm is null and em is null then raise exception 'Add a name or an email'; end if;
  if em is not null then
    select id into uid from public.profiles where lower(email) = em limit 1;
    if uid is not null then
      select id into mid from public.group_members where group_id = gid and user_id = uid;
      if mid is not null then
        update public.group_members set is_active = true where id = mid;
        return mid;
      end if;
    end if;
    select id into mid from public.group_members
     where group_id = gid and user_id is null and lower(email) = em limit 1;
    if mid is not null then
      update public.group_members set is_active = true where id = mid;
      return mid;
    end if;
  end if;
  if uid is not null and nm is null then
    select display_name into nm from public.profiles where id = uid;
  end if;
  select count(*) into n from public.group_members where group_id = gid;
  insert into public.group_members (group_id, user_id, display_name, email, phone, color)
  values (gid, uid, left(coalesce(nm, split_part(em, '@', 1)), 40), em,
          nullif(trim(coalesce(p_phone, '')), ''), public.member_color(n))
  returning id into mid;
  return mid;
end $$;

create or replace function public.create_group(p_name text, p_kind text default 'home',
  p_currency text default 'USD', p_members jsonb default '[]'::jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  gid uuid;
  me public.profiles;
  m jsonb;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  perform public.ensure_profile();
  select * into me from public.profiles where id = auth.uid();
  insert into public.groups (name, kind, currency, created_by)
  values (trim(p_name), coalesce(nullif(p_kind, ''), 'home'), upper(coalesce(nullif(p_currency, ''), 'USD')), auth.uid())
  returning id into gid;
  insert into public.group_members (group_id, user_id, display_name, email, role, color)
  values (gid, auth.uid(), left(coalesce(nullif(me.display_name, ''), 'Me'), 40), me.email, 'owner', public.member_color(0));
  for m in select * from jsonb_array_elements(coalesce(p_members, '[]'::jsonb)) loop
    if coalesce(nullif(trim(m->>'name'), ''), nullif(trim(m->>'email'), '')) is not null then
      perform public.add_member_internal(gid, m->>'name', m->>'email', m->>'phone');
    end if;
  end loop;
  perform public.log_activity(gid, 'group_created', public.actor_name(gid) || ' created the group "' || trim(p_name) || '"');
  return gid;
end $$;

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

create or replace function public.add_member(gid uuid, p_name text, p_email text default null, p_phone text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare mid uuid; nm text;
begin
  if not public.is_group_member(gid) then raise exception 'You are not in this group'; end if;
  mid := public.add_member_internal(gid, p_name, p_email, p_phone);
  select display_name into nm from public.group_members where id = mid;
  perform public.log_activity(gid, 'member_added', public.actor_name(gid) || ' added ' || nm);
  return mid;
end $$;

create or replace function public.update_member(mid uuid, p_name text, p_email text default null, p_phone text default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  m public.group_members;
  em text := nullif(lower(trim(coalesce(p_email, ''))), '');
  uid uuid;
begin
  select * into m from public.group_members where id = mid;
  if not found or not public.is_group_member(m.group_id) then raise exception 'Not allowed'; end if;
  update public.group_members set
    display_name = left(coalesce(nullif(trim(p_name), ''), display_name), 40),
    phone = nullif(trim(coalesce(p_phone, '')), ''),
    email = case when m.user_id is null then em else email end
  where id = mid;
  -- Linking a placeholder to an existing account by email.
  if m.user_id is null and em is not null then
    select id into uid from public.profiles where lower(email) = em limit 1;
    if uid is not null and not exists (select 1 from public.group_members where group_id = m.group_id and user_id = uid) then
      update public.group_members set user_id = uid where id = mid;
    end if;
  end if;
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

create or replace function public.leave_group(gid uuid) returns void
language plpgsql security definer set search_path = public as $$
declare mid uuid;
begin
  select id into mid from public.group_members where group_id = gid and user_id = auth.uid() and is_active;
  if mid is null then raise exception 'You are not in this group'; end if;
  perform public.remove_member(mid);
end $$;

create or replace function public.delete_group(gid uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_group_member(gid) then raise exception 'You are not in this group'; end if;
  delete from public.groups where id = gid;
end $$;

create or replace function public.regenerate_invite(gid uuid) returns text
language plpgsql security definer set search_path = public as $$
declare code text;
begin
  if not public.is_group_member(gid) then raise exception 'You are not in this group'; end if;
  update public.groups set invite_code = public.new_invite_code() where id = gid returning invite_code into code;
  return code;
end $$;

-- Public preview of an invite link (works before sign-in, so the join page can show the group name).
create or replace function public.get_invite(p_code text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare g public.groups;
begin
  select * into g from public.groups where invite_code = p_code;
  if not found then return null; end if;
  return jsonb_build_object(
    'group_id', g.id,
    'name', g.name,
    'kind', g.kind,
    'member_count', (select count(*) from public.group_members where group_id = g.id and is_active),
    'already_member', public.is_group_member(g.id),
    'placeholders', case when auth.uid() is null then '[]'::jsonb else coalesce((
      select jsonb_agg(jsonb_build_object('id', id, 'display_name', display_name, 'color', color) order by created_at)
      from public.group_members where group_id = g.id and user_id is null and is_active), '[]'::jsonb) end);
end $$;

create or replace function public.join_group(p_code text, p_claim uuid default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  g public.groups;
  me public.profiles;
  mid uuid;
  nm text;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  perform public.ensure_profile();
  select * into g from public.groups where invite_code = p_code;
  if not found then raise exception 'This invite link is invalid or was reset'; end if;
  select * into me from public.profiles where id = auth.uid();
  select id into mid from public.group_members where group_id = g.id and user_id = auth.uid();
  if mid is not null then
    update public.group_members set is_active = true where id = mid;
    return g.id;
  end if;
  if p_claim is not null then
    update public.group_members set user_id = auth.uid(), email = coalesce(email, me.email), is_active = true
     where id = p_claim and group_id = g.id and user_id is null
     returning id into mid;
    if mid is null then raise exception 'That spot was already claimed by someone else'; end if;
  else
    insert into public.group_members (group_id, user_id, display_name, email, color)
    values (g.id, auth.uid(), left(coalesce(nullif(me.display_name, ''), 'New member'), 40), me.email,
            public.member_color((select count(*)::int from public.group_members where group_id = g.id)))
    returning id into mid;
  end if;
  select display_name into nm from public.group_members where id = mid;
  perform public.log_activity(g.id, 'member_joined', nm || ' joined the group');
  return g.id;
end $$;


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

-- ---------- expenses ----------------------------------------------------

-- p = { description, amount_cents, category, expense_date, notes, split_type, is_payment,
--       receipt_path, repeat_interval,
--       payers: [{member_id, amount_cents}], splits: [{member_id, amount_cents, weight}] }
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

create or replace function public.delete_expense(eid uuid) returns void
language plpgsql security definer set search_path = public as $$
declare e public.expenses;
begin
  select * into e from public.expenses where id = eid;
  if not found or not public.is_group_member(e.group_id) then raise exception 'Not allowed'; end if;
  if e.deleted_at is not null then return; end if;
  update public.expenses set deleted_at = now(), updated_by = auth.uid() where id = eid;
  perform public.log_activity(e.group_id, case when e.is_payment then 'payment_deleted' else 'expense_deleted' end,
    public.actor_name(e.group_id) || ' deleted "' || e.description || '"', eid, e.amount_cents);
end $$;

create or replace function public.restore_expense(eid uuid) returns void
language plpgsql security definer set search_path = public as $$
declare e public.expenses;
begin
  select * into e from public.expenses where id = eid;
  if not found or not public.is_group_member(e.group_id) then raise exception 'Not allowed'; end if;
  if e.deleted_at is null then return; end if;
  update public.expenses set deleted_at = null, updated_by = auth.uid(), updated_at = now() where id = eid;
  perform public.log_activity(e.group_id, 'expense_restored',
    public.actor_name(e.group_id) || ' restored "' || e.description || '"', eid, e.amount_cents);
end $$;

-- Creates any recurring expenses that have come due in the caller's groups.
-- The app calls this when it loads, so no cron job is needed.
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

-- ---------- comments ----------------------------------------------------

create or replace function public.on_comment_insert() returns trigger
language plpgsql security definer set search_path = public as $$
declare descr text; nm text;
begin
  select description into descr from public.expenses where id = new.expense_id;
  select display_name into nm from public.group_members where group_id = new.group_id and user_id = new.user_id limit 1;
  insert into public.activity (group_id, expense_id, actor_id, kind, summary)
  values (new.group_id, new.expense_id, new.user_id, 'comment',
          coalesce(nm, 'Someone') || ' commented on "' || coalesce(descr, 'an expense') || '": ' || left(new.body, 80));
  return new;
end $$;

drop trigger if exists comments_activity on public.comments;
create trigger comments_activity after insert on public.comments
  for each row execute function public.on_comment_insert();

-- ---------- row level security -----------------------------------------

alter table public.profiles enable row level security;
alter table public.groups enable row level security;
alter table public.group_members enable row level security;
alter table public.expenses enable row level security;
alter table public.expense_payers enable row level security;
alter table public.expense_splits enable row level security;
alter table public.comments enable row level security;
alter table public.activity enable row level security;

drop policy if exists "profiles read" on public.profiles;
create policy "profiles read" on public.profiles for select to authenticated
  using (id = auth.uid() or public.shares_group_with(id));

drop policy if exists "groups read" on public.groups;
create policy "groups read" on public.groups for select to authenticated
  using (public.is_group_member(id));

drop policy if exists "members read" on public.group_members;
create policy "members read" on public.group_members for select to authenticated
  using (public.is_group_member(group_id));

drop policy if exists "expenses read" on public.expenses;
create policy "expenses read" on public.expenses for select to authenticated
  using (public.is_group_member(group_id));

drop policy if exists "payers read" on public.expense_payers;
create policy "payers read" on public.expense_payers for select to authenticated
  using (exists (select 1 from public.expenses e where e.id = expense_id and public.is_group_member(e.group_id)));

drop policy if exists "splits read" on public.expense_splits;
create policy "splits read" on public.expense_splits for select to authenticated
  using (exists (select 1 from public.expenses e where e.id = expense_id and public.is_group_member(e.group_id)));

drop policy if exists "comments read" on public.comments;
create policy "comments read" on public.comments for select to authenticated
  using (public.is_group_member(group_id));

drop policy if exists "comments write" on public.comments;
create policy "comments write" on public.comments for insert to authenticated
  with check (user_id = auth.uid() and public.is_group_member(group_id)
              and exists (select 1 from public.expenses e where e.id = expense_id and e.group_id = comments.group_id));

drop policy if exists "comments delete own" on public.comments;
create policy "comments delete own" on public.comments for delete to authenticated
  using (user_id = auth.uid());

drop policy if exists "activity read" on public.activity;
create policy "activity read" on public.activity for select to authenticated
  using (public.is_group_member(group_id));

-- Writes happen through the functions above. Lock down direct table writes.
revoke insert, update, delete on public.profiles, public.groups, public.group_members, public.expenses,
  public.expense_payers, public.expense_splits, public.activity from anon, authenticated;
revoke update on public.comments from anon, authenticated;

-- Internal helpers are not callable from the browser.
revoke execute on function public.log_activity(uuid, text, text, uuid, bigint) from public, anon, authenticated;
revoke execute on function public.add_member_internal(uuid, text, text, text) from public, anon, authenticated;

grant execute on function public.get_invite(text) to anon, authenticated;

-- ---------- realtime -----------------------------------------------------

do $$
declare t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  foreach t in array array['activity', 'groups', 'group_members', 'comments'] loop
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- ---------- receipt storage ----------------------------------------------

insert into storage.buckets (id, name, public)
values ('receipts', 'receipts', false)
on conflict (id) do nothing;

drop policy if exists "receipts read" on storage.objects;
create policy "receipts read" on storage.objects for select to authenticated
  using (bucket_id = 'receipts' and public.is_group_member(public.try_uuid((storage.foldername(name))[1])));

drop policy if exists "receipts upload" on storage.objects;
create policy "receipts upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'receipts' and public.is_group_member(public.try_uuid((storage.foldername(name))[1])));

drop policy if exists "receipts delete" on storage.objects;
create policy "receipts delete" on storage.objects for delete to authenticated
  using (bucket_id = 'receipts' and owner = auth.uid());

-- =====================================================================
-- Upcoming bills: bills that are known but not paid yet. They show each
-- person's share but do NOT affect balances until marked paid, which turns
-- the bill into a normal expense with the same split.
-- =====================================================================

create table if not exists public.upcoming_bills (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  title text not null check (char_length(trim(title)) between 1 and 100),
  amount_cents bigint not null check (amount_cents > 0),
  due_date date,
  is_estimate boolean not null default false,
  category text not null default 'utilities',
  notes text,
  status text not null default 'upcoming' check (status in ('upcoming', 'paid')),
  expense_id uuid references public.expenses(id) on delete set null,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists upcoming_bills_group_idx on public.upcoming_bills (group_id, status, due_date);

create table if not exists public.upcoming_bill_shares (
  bill_id uuid not null references public.upcoming_bills(id) on delete cascade,
  member_id uuid not null references public.group_members(id) on delete cascade,
  amount_cents bigint not null check (amount_cents >= 0),
  primary key (bill_id, member_id)
);

-- p = { title, amount_cents, due_date, is_estimate, category, notes, shares: [{member_id, amount_cents}] }
create or replace function public.save_upcoming_bill(p_id uuid, p_group uuid, p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  bid uuid;
  total bigint := (p->>'amount_cents')::bigint;
  ttl text := left(trim(coalesce(p->>'title', '')), 100);
  ssum bigint;
  bad int;
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
    delete from public.upcoming_bill_shares where bill_id = bid;
  end if;

  insert into public.upcoming_bill_shares (bill_id, member_id, amount_cents)
  select bid, (x->>'member_id')::uuid, (x->>'amount_cents')::bigint
  from jsonb_array_elements(p->'shares') x where (x->>'amount_cents')::bigint > 0;

  perform public.log_activity(p_group, case when p_id is null then 'upcoming_added' else 'upcoming_updated' end,
    public.actor_name(p_group) || case when p_id is null then ' added upcoming bill "' else ' updated upcoming bill "' end || ttl || '"'
      || coalesce(' (due ' || to_char(nullif(p->>'due_date', '')::date, 'Mon FMDD') || ')', ''),
    null, total);
  return bid;
end $$;

create or replace function public.delete_upcoming_bill(bid uuid) returns void
language plpgsql security definer set search_path = public as $$
declare b public.upcoming_bills;
begin
  select * into b from public.upcoming_bills where id = bid;
  if not found or not public.is_group_member(b.group_id) then raise exception 'Not allowed'; end if;
  delete from public.upcoming_bills where id = bid;
  perform public.log_activity(b.group_id, 'upcoming_deleted',
    public.actor_name(b.group_id) || ' removed upcoming bill "' || b.title || '"', null, b.amount_cents);
end $$;

-- Turns an upcoming bill into a real expense with the same split. p_payers = [{member_id, amount_cents}]
create or replace function public.mark_upcoming_paid(bid uuid, p_payers jsonb, p_date date default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  b public.upcoming_bills;
  eid uuid;
begin
  select * into b from public.upcoming_bills where id = bid for update;
  if not found or not public.is_group_member(b.group_id) then raise exception 'Not allowed'; end if;
  if b.status <> 'upcoming' then raise exception 'This bill was already marked paid'; end if;
  eid := public.save_expense(null, b.group_id, jsonb_build_object(
    'description', b.title,
    'amount_cents', b.amount_cents,
    'category', b.category,
    'expense_date', coalesce(p_date, current_date),
    'notes', b.notes,
    'split_type', 'exact',
    'is_payment', false,
    'repeat_interval', 'none',
    'payers', p_payers,
    'splits', (select coalesce(jsonb_agg(jsonb_build_object('member_id', s.member_id, 'amount_cents', s.amount_cents)), '[]'::jsonb)
               from public.upcoming_bill_shares s where s.bill_id = bid)));
  update public.upcoming_bills set status = 'paid', expense_id = eid, updated_at = now() where id = bid;
  return eid;
end $$;

alter table public.upcoming_bills enable row level security;
alter table public.upcoming_bill_shares enable row level security;

drop policy if exists "upcoming read" on public.upcoming_bills;
create policy "upcoming read" on public.upcoming_bills for select to authenticated
  using (public.is_group_member(group_id));

drop policy if exists "upcoming shares read" on public.upcoming_bill_shares;
create policy "upcoming shares read" on public.upcoming_bill_shares for select to authenticated
  using (exists (select 1 from public.upcoming_bills b where b.id = bill_id and public.is_group_member(b.group_id)));

revoke insert, update, delete on public.upcoming_bills, public.upcoming_bill_shares from anon, authenticated;

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'upcoming_bills') then
    alter publication supabase_realtime add table public.upcoming_bills;
  end if;
end $$;

-- =====================================================================
-- Smarter joining: match the person to their spot automatically
--   1. a spot whose email matches the account's email
--   2. otherwise a spot whose name matches the account's name (first name or full name)
-- Only when there is no single clear match does the app ask "which one is you?".
-- =====================================================================

create or replace function public.name_tokens(t text) returns text[]
language sql immutable as $$
  select coalesce(array_remove(regexp_split_to_array(lower(regexp_replace(coalesce(t, ''), '[^[:alpha:] ]', ' ', 'g')), '\s+'), ''), '{}');
$$;

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
  mine := public.name_tokens(coalesce(full_name, '')) || public.name_tokens(coalesce(me.display_name, ''));
  if coalesce(array_length(mine, 1), 0) = 0 then return null; end if;
  select array_agg(id) into ids from public.group_members m
   where m.group_id = gid and m.user_id is null and m.is_active
     and (array_to_string(public.name_tokens(m.display_name), ' ') = array_to_string(public.name_tokens(full_name), ' ')
          or (char_length((public.name_tokens(m.display_name))[1]) >= 2 and (public.name_tokens(m.display_name))[1] = any (mine)));
  if coalesce(array_length(ids, 1), 0) = 1 then return jsonb_build_object('member_id', ids[1], 'how', 'name'); end if;
  return null;
end $$;

-- Does a spot's name plausibly belong to the signed-in user? (used to double-check manual picks)
create or replace function public.spot_looks_like_me(mid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.group_members m, auth.users u
    where m.id = mid and u.id = auth.uid()
      and ((m.email is not null and lower(m.email) = lower(u.email))
           or public.name_tokens(m.display_name) && (public.name_tokens(u.raw_user_meta_data->>'full_name')
                                                    || public.name_tokens(u.raw_user_meta_data->>'name')
                                                    || public.name_tokens((select display_name from public.profiles where id = u.id)))));
$$;

create or replace function public.get_invite(p_code text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare g public.groups; sug jsonb;
begin
  select * into g from public.groups where invite_code = p_code;
  if not found then return null; end if;
  if auth.uid() is not null then sug := public.suggest_spot(g.id); end if;
  return jsonb_build_object(
    'group_id', g.id,
    'name', g.name,
    'kind', g.kind,
    'member_count', (select count(*) from public.group_members where group_id = g.id and is_active),
    'already_member', public.is_group_member(g.id),
    'me_name', (select display_name from public.profiles where id = auth.uid()),
    'suggested', sug,
    'placeholders', case when auth.uid() is null then '[]'::jsonb else coalesce((
      select jsonb_agg(jsonb_build_object('id', id, 'display_name', display_name, 'color', color,
                                          'looks_like_me', public.spot_looks_like_me(id)) order by created_at)
      from public.group_members where group_id = g.id and user_id is null and is_active), '[]'::jsonb) end);
end $$;

drop function if exists public.join_group(text, uuid);
-- p_claim: a specific spot. p_new: join as a new person. Neither: use the automatic match.
create or replace function public.join_group(p_code text, p_claim uuid default null, p_new boolean default false) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  g public.groups;
  me public.profiles;
  mid uuid;
  nm text;
  sug jsonb;
  how text := 'new';
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  perform public.ensure_profile();
  select * into g from public.groups where invite_code = p_code;
  if not found then raise exception 'This invite link is invalid or was reset'; end if;
  select * into me from public.profiles where id = auth.uid();
  select id into mid from public.group_members where group_id = g.id and user_id = auth.uid();
  if mid is not null then
    update public.group_members set is_active = true where id = mid;
    return g.id;
  end if;
  if p_claim is null and not p_new then
    sug := public.suggest_spot(g.id);
    if sug is not null then p_claim := (sug->>'member_id')::uuid; how := sug->>'how';
    elsif exists (select 1 from public.group_members where group_id = g.id and user_id is null and is_active) then
      raise exception 'Choose which name is you';
    end if;
  elsif p_claim is not null then how := 'picked';
  end if;
  if p_claim is not null then
    update public.group_members set user_id = auth.uid(), email = coalesce(email, me.email), is_active = true
     where id = p_claim and group_id = g.id and user_id is null
     returning id into mid;
    if mid is null then raise exception 'That spot was already claimed by someone else'; end if;
  else
    insert into public.group_members (group_id, user_id, display_name, email, color)
    values (g.id, auth.uid(), left(coalesce(nullif(me.display_name, ''), 'New member'), 40), me.email,
            public.member_color((select count(*)::int from public.group_members where group_id = g.id)))
    returning id into mid;
  end if;
  select display_name into nm from public.group_members where id = mid;
  perform public.log_activity(g.id, 'member_joined', nm || ' joined the group'
    || case how when 'email' then ' (matched by email)' when 'name' then ' (matched by name)'
                when 'picked' then case when coalesce(me.display_name, '') <> nm then ' as ' || me.display_name else '' end
                else '' end);
  return g.id;
end $$;

-- "That's not me": the signed-in user gives their spot back (keeps its expenses) so they can pick again.
create or replace function public.unclaim_my_spot(gid uuid) returns text
language plpgsql security definer set search_path = public as $$
declare m public.group_members; code text; me_name text;
begin
  select * into m from public.group_members where group_id = gid and user_id = auth.uid();
  if not found then raise exception 'You are not in this group'; end if;
  select display_name into me_name from public.profiles where id = auth.uid();
  update public.group_members set user_id = null,
    email = case when lower(email) = lower((select email from public.profiles where id = auth.uid())) then null else email end
   where id = m.id;
  insert into public.activity (group_id, actor_id, kind, summary)
  values (gid, auth.uid(), 'member_unclaimed', coalesce(me_name, 'Someone') || ' said they are not ' || m.display_name || ' and is picking again');
  select invite_code into code from public.groups where id = gid;
  return code;
end $$;

-- =====================================================================
-- Upcoming bills: per-person "paid my share" check marks.
-- A person can tick their own share; the bill's creator or the group owner
-- can tick anyone's. When the bill is marked paid, ticked shares become
-- payments to whoever paid the bill.
-- =====================================================================
alter table public.upcoming_bill_shares add column if not exists paid_at timestamptz;
alter table public.upcoming_bill_shares add column if not exists paid_marked_by uuid references auth.users(id) on delete set null;

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
         paid_marked_by = case when p_paid then auth.uid() else null end
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

-- Keep check marks when a bill is edited (for people whose share didn't change).
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
    'is_payment', false, 'repeat_interval', 'none', 'payers', p_payers,
    'splits', (select coalesce(jsonb_agg(jsonb_build_object('member_id', x.member_id, 'amount_cents', x.amount_cents)), '[]'::jsonb)
               from public.upcoming_bill_shares x where x.bill_id = bid)));
  if jsonb_array_length(p_payers) = 1 then
    payer := (p_payers->0->>'member_id')::uuid;
    for s in select * from public.upcoming_bill_shares where bill_id = bid and paid_at is not null and member_id <> payer loop
      perform public.save_expense(null, b.group_id, jsonb_build_object(
        'description', 'Payment', 'amount_cents', s.amount_cents, 'category', 'payment',
        'expense_date', coalesce(s.paid_at::date, coalesce(p_date, current_date)),
        'notes', 'Share of "' || b.title || '" (checked off in Upcoming bills)',
        'split_type', 'exact', 'is_payment', true, 'repeat_interval', 'none',
        'payers', jsonb_build_array(jsonb_build_object('member_id', s.member_id, 'amount_cents', s.amount_cents)),
        'splits', jsonb_build_array(jsonb_build_object('member_id', payer, 'amount_cents', s.amount_cents))));
    end loop;
  end if;
  update public.upcoming_bills set status = 'paid', expense_id = eid, updated_at = now() where id = bid;
  return eid;
end $$;
