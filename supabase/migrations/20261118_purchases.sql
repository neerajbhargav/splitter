begin;

-- 2026-11-18: Apple Pay logging through a secret link. Safe to re-run; fresh deployments get the same from supabase/schema.sql.
alter table public.personal_tokens drop constraint if exists personal_tokens_kind_check;
alter table public.personal_tokens add constraint personal_tokens_kind_check check (kind in ('calendar', 'scores', 'purchases'));
alter table public.finance_transactions drop constraint if exists finance_transactions_source_check;
alter table public.finance_transactions add constraint finance_transactions_source_check check (source in ('manual', 'csv', 'plaid', 'subscription', 'applepay'));

create or replace function public.create_personal_token(p_kind text) returns text
language plpgsql security definer set search_path = public as $$
declare
  u uuid := auth.uid();
  t text;
begin
  if u is null then raise exception 'Not signed in'; end if;
  if p_kind is null or p_kind not in ('calendar', 'scores', 'purchases') then raise exception 'Unknown link type'; end if;
  t := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  insert into public.personal_tokens (user_id, kind, token_hash) values (u, p_kind, public._token_hash(t))
  on conflict (user_id, kind) do update set token_hash = excluded.token_hash, created_at = now(), last_used_at = null;
  return t;
end $$;

-- Apple Pay logging: an iPhone Shortcuts automation posts every Apple Pay tap to
-- /api/finance/purchases/<token>. The server reads this context, picks the account and category,
-- and logs the purchase with log_purchase_with_token. Both take the secret link, never a session.
create or replace function public.purchase_context_with_token(p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare u uuid := public._token_user(p_token, 'purchases'); cur text;
begin
  select currency into cur from public.finance_settings where user_id = u;
  if cur is null then raise exception 'Open Money in SPLITTER once, then try again'; end if;
  return jsonb_build_object(
    'currency', cur,
    'accounts', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'last4', last4, 'type', type)), '[]'::jsonb)
                 from public.finance_accounts where user_id = u),
    'categories', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name)), '[]'::jsonb)
                   from public.finance_categories where user_id = u and not archived),
    'history', (select coalesce(jsonb_agg(jsonb_build_object('description', h.description, 'category_id', h.category_id, 'date', h.date)), '[]'::jsonb)
                from (select description, category_id, date from public.finance_transactions
                      where user_id = u and kind = 'expense' and category_id is not null
                      order by date desc, created_at desc limit 400) h));
end $$;

-- p: { date, description, amount_cents, account_id?, category_id? }. A tap the Shortcut sends twice
-- within two minutes (same amount, merchant and card) is logged once.
create or replace function public.log_purchase_with_token(p_token text, p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  u uuid := public._token_user(p_token, 'purchases');
  d date := public._finance_date(p, 'date');
  descr text := public._finance_text(p, 'description', 140);
  amt bigint := public._finance_money(p, 'amount_cents');
  acc uuid := public._finance_optional_uuid(p, 'account_id');
  cat uuid := public._finance_optional_uuid(p, 'category_id');
  v_id uuid;
begin
  if not exists (select 1 from public.finance_settings where user_id = u) then raise exception 'Open Money in SPLITTER once, then try again'; end if;
  if d > current_date + 1 or d < current_date - 7 then raise exception 'That purchase date is out of range'; end if;
  perform public._finance_check_refs(u, acc, cat, null);
  select id into v_id from public.finance_transactions
   where user_id = u and source = 'applepay' and amount_cents = amt and lower(description) = lower(descr)
     and account_id is not distinct from acc and created_at > now() - interval '2 minutes'
   limit 1;
  if v_id is not null then return jsonb_build_object('id', v_id, 'duplicate', true); end if;
  if (select count(*) from public.finance_transactions where user_id = u and source = 'applepay' and created_at > now() - interval '1 day') >= 300 then
    raise exception 'Too many purchases logged today. Check the Shortcut, or make a new link if this one leaked.';
  end if;
  if (select count(*) from public.finance_transactions where user_id = u) >= 100000 then raise exception 'You can keep up to 100,000 transactions'; end if;
  insert into public.finance_transactions (user_id, account_id, date, description, amount_cents, kind, category_id, source)
  values (u, acc, d, descr, amt, 'expense', cat, 'applepay') returning id into v_id;
  return jsonb_build_object('id', v_id, 'duplicate', false);
end $$;

revoke all on function public.purchase_context_with_token(text), public.log_purchase_with_token(text, jsonb) from public;
grant execute on function public.purchase_context_with_token(text), public.log_purchase_with_token(text, jsonb) to anon, authenticated;

notify pgrst, 'reload schema';
commit;
