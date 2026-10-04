begin;

-- Credit score sync: scores read from the bureau sites in the owner's own browser are upserted
-- by (bureau, day, model), so running the sync again never creates duplicates.

alter table public.finance_credit_scores add column if not exists origin text not null default 'manual' check(origin in('manual','sync'));
alter table public.finance_credit_scores add column if not exists synced_at timestamptz;

create or replace function public.sync_finance_credit_scores(p_rows jsonb,p_user uuid,p_currency text) returns jsonb
language plpgsql security definer set search_path=public as $$
declare u uuid:=public._finance_owner_lock(p_user,p_currency);e jsonb;v_bureau text;v_score numeric;v_model text;v_date date;v_source text;
 existing record;ins integer:=0;upd integer:=0;same integer:=0;seen text[]:='{}';k text;begin
 if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) not between 1 and 20 then raise exception 'Send 1 to 20 scores';end if;
 for e in select value from jsonb_array_elements(p_rows) loop
  if jsonb_typeof(e)<>'object' then raise exception 'Invalid score';end if;
  v_bureau:=e->>'bureau';
  if v_bureau is null or v_bureau not in('equifax','experian','transunion') then raise exception 'Choose Equifax, Experian or TransUnion';end if;
  if jsonb_typeof(e->'score') is distinct from 'number' then raise exception 'Enter a score from 250 to 900';end if;
  v_score:=(e->>'score')::numeric;
  if v_score<>trunc(v_score) or v_score not between 250 and 900 then raise exception 'Enter a score from 250 to 900';end if;
  v_model:=public._finance_text(e,'model',40,false);
  v_date:=public._finance_date(e,'as_of');
  if v_date>current_date+1 then raise exception 'That date hasn''t happened yet';end if;
  v_source:=public._finance_text(e,'source',60,false);
  k:=v_bureau||'|'||v_date||'|'||lower(v_model);
  if k=any(seen) then continue;end if;seen:=seen||k;
  select id,score into existing from public.finance_credit_scores where user_id=u and bureau=v_bureau and as_of=v_date and lower(model)=lower(v_model) for update;
  if found then
   if existing.score=v_score then
    update public.finance_credit_scores set synced_at=now() where id=existing.id;same:=same+1;
   else
    update public.finance_credit_scores set score=v_score::smallint,source=v_source,origin='sync',synced_at=now(),updated_at=now() where id=existing.id;upd:=upd+1;
   end if;
  else
   if(select count(*) from public.finance_credit_scores where user_id=u)>=3000 then raise exception 'You can keep up to 3000 scores';end if;
   insert into public.finance_credit_scores(user_id,bureau,score,model,as_of,source,origin,synced_at) values(u,v_bureau,v_score::smallint,v_model,v_date,v_source,'sync',now());
   ins:=ins+1;
  end if;
 end loop;
 return jsonb_build_object('inserted',ins,'updated',upd,'unchanged',same);
end $$;

revoke all on function public.sync_finance_credit_scores(jsonb,uuid,text) from public,anon,authenticated;
grant execute on function public.sync_finance_credit_scores(jsonb,uuid,text) to authenticated;
do $$ begin
 if exists(select 1 from pg_publication where pubname='supabase_realtime') and not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='finance_credit_scores') then alter publication supabase_realtime add table public.finance_credit_scores;end if;
end $$;
notify pgrst,'reload schema';
commit;
