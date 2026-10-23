// In-memory Postgres (PGlite) with Supabase's auth/storage stubs, the full schema, and optional migrations on top.
import fs from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const read = (p: string) => fs.readFileSync(new URL(p, import.meta.url), "utf8");

export async function freshDb(...migrations: string[]) {
  const db = new PGlite();
  await db.exec(`create role anon nologin;create role authenticated nologin;
    create schema auth;create table auth.users(id uuid primary key default gen_random_uuid(),email text,raw_user_meta_data jsonb default '{}'::jsonb);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    create schema storage;create table storage.buckets(id text primary key,name text,public boolean);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,owner uuid);
    alter table storage.objects enable row level security;
    create function storage.foldername(name text) returns text[] language sql immutable as $$ select (string_to_array(name,'/'))[1:array_length(string_to_array(name,'/'),1)-1] $$;
    grant usage on schema public,auth,storage to anon,authenticated;grant all on all tables in schema storage to authenticated;
    -- Supabase grants every new public table, sequence and function to anon and authenticated; the schema's revokes then apply.
    alter default privileges in schema public grant all on tables to anon,authenticated;
    alter default privileges in schema public grant all on sequences to anon,authenticated;
    alter default privileges in schema public grant all on functions to anon,authenticated;`);
  await db.exec(read("../supabase/schema.sql"));
  // An existing deployment gets the same result from each migration, and they are safe to re-run.
  for (const m of migrations) for (let i = 0; i < 2; i++) await db.exec(read(`../supabase/migrations/${m}`));
  const as = (id: string) => db.query(`select set_config('request.jwt.claim.sub',$1,false)`, [id]);
  const user = async (id: string, email: string, name: string) =>
    db.query(`insert into auth.users(id,email,raw_user_meta_data) values ($1,$2,$3::jsonb)`, [id, email, JSON.stringify({ name })]);
  return { db, as, user };
}
