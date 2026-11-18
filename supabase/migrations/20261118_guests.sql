begin;

-- 2026-11-18: guest mode. Safe to re-run; fresh deployments get the same from supabase/schema.sql.
-- Guest mode: Supabase anonymous sign-ins give a guest a real account with no email, so every table,
-- policy and RPC works as it does for anyone else. Connecting Google or GitHub later (linkIdentity)
-- keeps the same user id, so nothing has to move. ensure_profile then fills in what the guest lacked.

-- The account deletion delete_my_account() does, for any user id. Internal only.
create or replace function public._delete_account(p_user uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare gone int; kept int;
begin
  if p_user is null then raise exception 'Not signed in'; end if;
  with solo as (
    select m.group_id from public.group_members m where m.user_id = p_user
    except
    select o.group_id from public.group_members o where o.user_id is not null and o.user_id <> p_user
  ) delete from public.groups g using solo where g.id = solo.group_id;
  get diagnostics gone = row_count;
  update public.group_members set email = null, phone = null where user_id = p_user;
  get diagnostics kept = row_count;
  delete from auth.users where id = p_user;
  return jsonb_build_object('groups_deleted', gone, 'spots_kept', kept);
end $$;
revoke all on function public._delete_account(uuid) from public, anon, authenticated;

create or replace function public.delete_my_account() returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  return public._delete_account(auth.uid());
end $$;
revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;

-- Makes sure the signed-in user has a profile. After a guest connects Google or GitHub it also copies
-- the new email, name and picture into the profile (keeping a name the guest chose) and claims any
-- group spot someone added that email to, the same way a new sign-up does.
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
  mail := lower(nullif(coalesce(u.email, meta->>'email'), ''));
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

-- Deletes guest accounts nobody has used for p_days, with everything delete_my_account removes.
-- Run daily by pg_cron where it is available. Never granted to callers.
create or replace function public.purge_stale_guests(p_days integer default 30) returns integer
language plpgsql security definer set search_path = public as $$
declare g uuid; n int := 0;
begin
  if p_days is null or p_days < 7 then raise exception 'Keep guests for at least 7 days'; end if;
  for g in
    select u.id from auth.users u
    where u.is_anonymous
      and greatest(u.created_at, coalesce(u.last_sign_in_at, u.created_at),
                   coalesce((select max(greatest(s.updated_at, s.created_at, s.refreshed_at::timestamptz)) from auth.sessions s where s.user_id = u.id), u.created_at))
          < now() - make_interval(days => p_days)
    limit 5000
  loop
    perform public._delete_account(g);
    n := n + 1;
  end loop;
  return n;
end $$;
revoke all on function public.purge_stale_guests(integer) from public, anon, authenticated;

-- Daily guest cleanup where pg_cron exists (Supabase has it; the in-memory test database does not).
do $$ begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron with schema pg_catalog;
    perform cron.schedule('splitter-purge-stale-guests', '17 9 * * *', 'select public.purge_stale_guests(30)');
  end if;
end $$;

notify pgrst, 'reload schema';
commit;
