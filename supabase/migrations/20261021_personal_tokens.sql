begin;

-- Personal secret links (2026-10-21). Safe to re-run; fresh deployments get the same from supabase/schema.sql.
-- A calendar feed and a credit-score sync for apps that can't sign in. Only a SHA-256 hash of
-- each token is stored; making a new link replaces the old one, and turning it off deletes it.
create table if not exists public.personal_tokens (
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('calendar', 'scores')),
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  primary key (user_id, kind)
);
alter table public.personal_tokens enable row level security;
revoke all on public.personal_tokens from public, anon, authenticated;

create or replace function public._token_hash(t text) returns text
language sql immutable as $$ select encode(sha256(convert_to(coalesce(t, ''), 'UTF8')), 'hex') $$;

create or replace function public.create_personal_token(p_kind text) returns text
language plpgsql security definer set search_path = public as $$
declare
  u uuid := auth.uid();
  t text;
begin
  if u is null then raise exception 'Not signed in'; end if;
  if p_kind is null or p_kind not in ('calendar', 'scores') then raise exception 'Unknown link type'; end if;
  t := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  insert into public.personal_tokens (user_id, kind, token_hash) values (u, p_kind, public._token_hash(t))
  on conflict (user_id, kind) do update set token_hash = excluded.token_hash, created_at = now(), last_used_at = null;
  return t;
end $$;

create or replace function public.revoke_personal_token(p_kind text) returns void
language sql security definer set search_path = public as $$
  delete from public.personal_tokens where user_id = auth.uid() and kind = p_kind;
$$;

create or replace function public.personal_token_status() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_object_agg(kind, jsonb_build_object('created_at', created_at, 'last_used_at', last_used_at)), '{}'::jsonb)
  from public.personal_tokens where user_id = auth.uid();
$$;

create or replace function public._token_user(p_token text, p_kind text) returns uuid
language plpgsql security definer set search_path = public as $$
declare u uuid;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then raise exception 'Invalid or turned-off link'; end if;
  update public.personal_tokens set last_used_at = now()
   where token_hash = public._token_hash(p_token) and kind = p_kind
  returning user_id into u;
  if u is null then raise exception 'Invalid or turned-off link'; end if;
  return u;
end $$;

create or replace function public.sync_credit_scores_with_token(p_token text, p_rows jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  u uuid := public._token_user(p_token, 'scores');
  cur text;
begin
  select currency into cur from public.finance_settings where user_id = u;
  if cur is null then raise exception 'Open Finance once before syncing scores'; end if;
  -- Act as the owner for this transaction only, so the usual ownership checks and validation apply.
  perform set_config('request.jwt.claim.sub', u::text, true);
  return public.sync_finance_credit_scores(p_rows, u, cur);
end $$;

-- Everything the reminder calendar needs, for the token's owner only.
create or replace function public.calendar_feed(p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare u uuid := public._token_user(p_token, 'calendar');
begin
  return jsonb_build_object(
    'settings', (select jsonb_build_object('currency', currency, 'pay_cycle', pay_cycle, 'pay_anchor', pay_anchor, 'pay_day2', pay_day2, 'paycheck_cents', paycheck_cents)
                 from public.finance_settings where user_id = u),
    'subscriptions', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'amount_cents', amount_cents, 'cycle', cycle, 'anchor_date', anchor_date, 'status', status)), '[]'::jsonb)
                      from public.personal_subscriptions where user_id = u),
    'debt_plan', (select jsonb_build_object('payments', payments) from public.finance_debt_plans where user_id = u),
    'accounts', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'balance_cents', balance_cents, 'minimum_cents', minimum_cents)), '[]'::jsonb)
                 from public.finance_accounts where user_id = u),
    'bills', (select coalesce(jsonb_agg(jsonb_build_object('id', b.id, 'title', b.title, 'due_date', b.due_date,
                'share_cents', s.amount_cents - case when s.paid_at is not null then coalesce(s.paid_cents, s.amount_cents) else 0 end,
                'currency', g.currency, 'group_name', g.name)), '[]'::jsonb)
              from public.upcoming_bills b
              join public.upcoming_bill_shares s on s.bill_id = b.id
              join public.group_members m on m.id = s.member_id and m.user_id = u and m.is_active
              join public.groups g on g.id = b.group_id
              where b.status = 'upcoming'));
end $$;

revoke execute on function public._token_user(text, text) from public, anon, authenticated;
revoke execute on function public.create_personal_token(text), public.revoke_personal_token(text), public.personal_token_status() from public, anon;
grant execute on function public.create_personal_token(text), public.revoke_personal_token(text), public.personal_token_status() to authenticated;
grant execute on function public.calendar_feed(text), public.sync_credit_scores_with_token(text, jsonb) to anon, authenticated;

notify pgrst, 'reload schema';
commit;
