begin;

-- Close 3 functions that answered outside the group (2026-10-23). Safe to re-run; fresh deployments get the
-- same from supabase/schema.sql. The app's client calls none of them. remove_member, get_invite and join_group
-- call them as the definer, which keeps EXECUTE, so invites, joining and removing members work as before.
-- member_balance(mid): any member's balance, to anyone holding the member id, signed in or not.
-- suggest_spot(gid): the member id of an unclaimed spot matching your name, in a group you are not in.
-- spot_looks_like_me(mid): whether a spot in any group matches your name or email.
revoke all on function public.member_balance(uuid) from public, anon, authenticated;
revoke all on function public.suggest_spot(uuid) from public, anon, authenticated;
revoke all on function public.spot_looks_like_me(uuid) from public, anon, authenticated;

notify pgrst, 'reload schema';
commit;
