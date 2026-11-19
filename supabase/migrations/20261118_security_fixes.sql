begin;

-- 2026-11-18 review fixes. Safe to re-run; fresh deployments get the same from supabase/schema.sql.
-- ensure_profile claimed spots with an email taken from raw_user_meta_data, which a guest can set to anyone's
-- address; it now uses only a confirmed email. log_purchase_with_token now locks per user, so two identical
-- posts arriving together are logged once.

create or replace function public.ensure_profile() returns void
language plpgsql security definer set search_path = public as $$
declare u auth.users; p public.profiles; mail text; meta jsonb; ident jsonb;
begin
  if auth.uid() is null then return; end if;
  select * into u from auth.users where id = auth.uid();
  if u.id is null then return; end if;
  -- A linked Google or GitHub identity carries the name and email a guest never had.
  if to_regclass('auth.identities') is not null then
    execute 'select identity_data from auth.identities where user_id = $1 and provider <> ''anonymous'' order by created_at desc limit 1'
      into ident using u.id;
  end if;
  meta := coalesce(u.raw_user_meta_data, '{}'::jsonb) || coalesce(ident, '{}'::jsonb);
  -- Only a verified email may claim spots: never raw_user_meta_data, which the signed-in user can write.
  mail := lower(nullif(coalesce(case when to_jsonb(u)->>'email_confirmed_at' is not null then u.email end,
                                case when coalesce((ident->>'email_verified')::boolean, false) then ident->>'email' end), ''));
  insert into public.profiles (id, display_name, email, avatar_url)
  values (u.id,
    left(coalesce(nullif(meta->>'full_name', ''), nullif(meta->>'name', ''), nullif(meta->>'user_name', ''),
                  nullif(split_part(coalesce(mail, ''), '@', 1), ''), 'Guest'), 40),
    mail, coalesce(meta->>'avatar_url', meta->>'picture'))
  on conflict (id) do nothing;
  select * into p from public.profiles where id = u.id;
  if p.email is null and mail is not null then
    update public.profiles set email = mail,
      avatar_url = coalesce(avatar_url, meta->>'avatar_url', meta->>'picture'),
      display_name = case when display_name in ('', 'Guest', 'New user')
        then left(coalesce(nullif(meta->>'full_name', ''), nullif(meta->>'name', ''), nullif(meta->>'user_name', ''),
                           split_part(mail, '@', 1)), 40) else display_name end
    where id = u.id;
    update public.group_members m set display_name = (select display_name from public.profiles where id = u.id)
    where m.user_id = u.id and m.display_name in ('Guest', 'New user');
    update public.group_members m set user_id = u.id
    where m.id in (
      select distinct on (x.group_id) x.id from public.group_members x
      where x.user_id is null and lower(x.email) = mail
        and not exists (select 1 from public.group_members y where y.group_id = x.group_id and y.user_id = u.id)
      order by x.group_id, x.created_at);
  end if;
end $$;

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
  perform pg_advisory_xact_lock(hashtextextended('purchases:' || u::text, 0));
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

notify pgrst, 'reload schema';
commit;
