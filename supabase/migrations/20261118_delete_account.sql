begin;

-- 2026-11-18: lets anyone delete their own account from the Account page. Safe to re-run; fresh
-- deployments get the same from supabase/schema.sql.
-- Deletes the signed-in account. Personal finance rows, links for other apps and the profile go with it:
-- their foreign keys to auth.users cascade. In a group someone else has joined, the person's spot stays as
-- an unclaimed spot with its name, so the others keep their history and balances; its email and phone are
-- cleared. A group nobody else has joined is deleted with the account.
create or replace function public.delete_my_account() returns jsonb
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); gone int; kept int;
begin
  if me is null then raise exception 'Not signed in'; end if;
  with solo as (
    select m.group_id from public.group_members m where m.user_id = me
    except
    select o.group_id from public.group_members o where o.user_id is not null and o.user_id <> me
  ) delete from public.groups g using solo where g.id = solo.group_id;
  get diagnostics gone = row_count;
  update public.group_members set email = null, phone = null where user_id = me;
  get diagnostics kept = row_count;
  delete from auth.users where id = me;
  return jsonb_build_object('groups_deleted', gone, 'spots_kept', kept);
end $$;
revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;

notify pgrst, 'reload schema';
commit;
