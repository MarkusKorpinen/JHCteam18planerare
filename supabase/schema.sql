-- JHC U9 lagplanerare – databas för Supabase.
-- Klistra in hela filen i Supabase → SQL Editor → New query och tryck Run.
-- Byt först ut DIN@EPOST.SE längst ned mot administratörens e-post.
-- Filen kan köras igen: den ändrar inga sparade spelare eller omgångar.

create extension if not exists pgcrypto with schema extensions;

-- ---------- tabeller ----------
create table if not exists public.app_config (
  id int primary key default 1 check (id = 1),
  admin_email text not null
);

create table if not exists public.leaders (
  user_id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  name text not null default '',
  role text not null default 'leader' check (role in ('leader', 'admin')),
  created_at timestamptz not null default now()
);

create table if not exists public.invites (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  code_hash text not null,
  role text not null default 'leader' check (role in ('leader', 'admin')),
  expires_at timestamptz not null default now() + interval '7 days',
  created_by uuid,
  created_at timestamptz not null default now()
);

create table if not exists public.settings (
  id int primary key default 1 check (id = 1),
  data jsonb not null
);

create table if not exists public.players (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 1 and 60),
  level text not null,
  can_goalie boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- En rad betyder att spelaren INTE kan poolspelet.
create table if not exists public.availability (
  uppdrag_key text not null,
  player_id uuid not null references public.players (id) on delete cascade,
  set_by uuid default auth.uid(),
  set_at timestamptz not null default now(),
  primary key (uppdrag_key, player_id)
);

create table if not exists public.schedule (
  id int primary key default 1 check (id = 1),
  uppdrag jsonb not null default '{}',
  last_attempt timestamptz,
  last_success timestamptz,
  last_error text,
  last_trigger text,
  source jsonb
);

create table if not exists public.schedule_changes (
  id bigint generated always as identity primary key,
  uppdrag_key text not null,
  label text,
  date text,
  items jsonb not null,
  is_new boolean not null default false,
  at timestamptz not null default now(),
  ack_at timestamptz,
  ack_by_name text
);
create index if not exists schedule_changes_key on public.schedule_changes (uppdrag_key);

create table if not exists public.rounds (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 1 and 80),
  status text not null default 'utkast' check (status in ('utkast', 'fastställt')),
  data jsonb not null,
  version int not null default 1,
  created_at timestamptz not null default now(),
  created_by_name text,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  updated_by_name text,
  confirmed_at timestamptz,
  confirmed_by_name text
);

create table if not exists public.history (
  round_id uuid primary key references public.rounds (id) on delete cascade,
  round_name text,
  confirmed_at timestamptz not null default now(),
  data jsonb not null
);

create table if not exists public.comments (
  id uuid primary key default gen_random_uuid(),
  round_id uuid not null references public.rounds (id) on delete cascade,
  uppdrag_key text not null,
  user_id uuid not null default auth.uid(),
  name text,
  text text not null check (length(text) between 1 and 1000),
  at timestamptz not null default now()
);

insert into public.settings (id, data) values (1, '{
  "levels": [{"name":"Grön","color":"#2e9e5b"},{"name":"Orange","color":"#e8862a"},{"name":"Lila","color":"#8a55c9"}],
  "teamPrefix": "Järfälla HC",
  "syncHours": 24,
  "roundDefaults": {"skaters":7,"goalies":1,"lineSize":4,"maxPerPlayer":1}
}') on conflict (id) do nothing;
insert into public.schedule (id) values (1) on conflict (id) do nothing;

-- ---------- hjälpfunktioner ----------
create or replace function public.is_leader() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.leaders where user_id = auth.uid());
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.leaders where user_id = auth.uid() and role = 'admin');
$$;

create or replace function public.my_name() returns text
language sql stable security definer set search_path = public as $$
  select coalesce(nullif(name, ''), email) from public.leaders where user_id = auth.uid();
$$;

create or replace function public.hash_code(p_code text) returns text
language sql immutable as $$
  select encode(sha256(convert_to(coalesce(p_code, ''), 'UTF8')), 'hex');
$$;

-- ---------- konton ----------
-- Körs när någon skapar ett konto. Utan giltig inbjudan stoppas kontot helt.
create or replace function public.on_auth_user_created() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  inv public.invites;
  nm text := left(coalesce(new.raw_user_meta_data ->> 'name', ''), 60);
begin
  select * into inv from public.invites
   where lower(email) = lower(new.email)
     and code_hash = public.hash_code(new.raw_user_meta_data ->> 'invite_code')
     and expires_at > now()
   limit 1;
  if found then
    insert into public.leaders (user_id, email, name, role) values (new.id, lower(new.email), nm, inv.role);
    delete from public.invites where id = inv.id;
    return new;
  end if;
  if not exists (select 1 from public.leaders where role = 'admin')
     and lower(new.email) = (select lower(admin_email) from public.app_config where id = 1) then
    insert into public.leaders (user_id, email, name, role) values (new.id, lower(new.email), nm, 'admin');
    return new;
  end if;
  raise exception 'Inbjudan saknas eller har gått ut.';
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.on_auth_user_created();

-- Kontrollerar en inbjudningslänk innan sidan visar formuläret.
create or replace function public.invite_status(p_email text, p_code text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'valid', exists (select 1 from public.invites where lower(email) = lower(p_email) and code_hash = public.hash_code(p_code) and expires_at > now()),
    'existing', exists (select 1 from public.invites where lower(email) = lower(p_email) and code_hash = public.hash_code(p_code) and expires_at > now())
                and exists (select 1 from auth.users where lower(email) = lower(p_email)),
    'first_admin', not exists (select 1 from public.leaders where role = 'admin') and lower(p_email) = (select lower(admin_email) from public.app_config where id = 1)
  );
$$;

-- Ny inloggningslänk för en befintlig ledare (glömt lösenord eller återinbjuden).
create or replace function public.reset_password_with_invite(p_email text, p_code text, p_password text, p_name text) returns boolean
language plpgsql security definer set search_path = public, extensions as $$
declare
  inv public.invites;
  uid uuid;
begin
  if length(coalesce(p_password, '')) < 10 then raise exception 'Lösenordet måste ha minst 10 tecken.'; end if;
  select * into inv from public.invites
   where lower(email) = lower(p_email) and code_hash = public.hash_code(p_code) and expires_at > now() limit 1;
  if not found then raise exception 'Inbjudan saknas eller har gått ut.'; end if;
  select id into uid from auth.users where lower(email) = lower(p_email);
  if uid is null then raise exception 'Kontot finns inte.'; end if;
  update auth.users set encrypted_password = extensions.crypt(p_password, extensions.gen_salt('bf')), updated_at = now() where id = uid;
  insert into public.leaders (user_id, email, name, role)
    values (uid, lower(p_email), left(coalesce(p_name, ''), 60), inv.role)
    on conflict (user_id) do update set name = case when excluded.name <> '' then excluded.name else leaders.name end,
                                        role = case when inv.role = 'admin' then 'admin' else leaders.role end;
  delete from public.invites where id = inv.id;
  return true;
end $$;

create or replace function public.set_my_name(p_name text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_leader() then raise exception 'Ingen åtkomst.'; end if;
  update public.leaders set name = left(trim(p_name), 60) where user_id = auth.uid();
end $$;

create or replace function public.set_leader_role(p_user uuid, p_role text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Endast för administratörer.'; end if;
  if p_user = auth.uid() then raise exception 'Du kan inte ändra din egen roll.'; end if;
  update public.leaders set role = case when p_role = 'admin' then 'admin' else 'leader' end where user_id = p_user;
end $$;

create or replace function public.remove_leader(p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Endast för administratörer.'; end if;
  if p_user = auth.uid() then raise exception 'Du kan inte ta bort dig själv.'; end if;
  delete from auth.users where id = p_user; -- tar också bort ledarraden
end $$;

-- ---------- omgångar ----------
create or replace function public.round_defaults() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.created_by_name := public.my_name();
  new.updated_by := auth.uid();
  new.updated_by_name := public.my_name();
  new.version := 1;
  new.status := 'utkast';
  return new;
end $$;
drop trigger if exists round_defaults on public.rounds;
create trigger round_defaults before insert on public.rounds for each row execute function public.round_defaults();

-- Sparar ett utkast. Stoppas om någon annan har sparat sedan p_base (om inte p_force).
create or replace function public.save_round(p_id uuid, p_base int, p_name text, p_status text, p_data jsonb, p_force boolean default false, p_history jsonb default null)
returns public.rounds
language plpgsql security definer set search_path = public as $$
declare
  r public.rounds;
begin
  if not public.is_leader() then raise exception 'Ingen åtkomst.'; end if;
  select * into r from public.rounds where id = p_id for update;
  if not found then raise exception 'Omgången finns inte.'; end if;
  if r.version <> p_base and not coalesce(p_force, false) then
    raise exception 'conflict' using errcode = 'P0001', detail = jsonb_build_object(
      'version', r.version, 'updatedByName', r.updated_by_name, 'updatedAt', r.updated_at,
      'last', coalesce(r.data -> 'log', '[]'::jsonb) -> 0)::text;
  end if;
  if p_status not in ('utkast', 'fastställt') then raise exception 'Ogiltig status.'; end if;
  update public.rounds set
    name = left(p_name, 80), data = p_data, version = r.version + 1, status = p_status,
    updated_at = now(), updated_by = auth.uid(), updated_by_name = public.my_name(),
    confirmed_at = case when p_status = 'fastställt' then coalesce(case when r.status = 'fastställt' then r.confirmed_at end, now()) end,
    confirmed_by_name = case when p_status = 'fastställt' then coalesce(case when r.status = 'fastställt' then r.confirmed_by_name end, public.my_name()) end
  where id = p_id returning * into r;
  if p_status = 'fastställt' and p_history is not null then
    insert into public.history (round_id, round_name, confirmed_at, data) values (r.id, r.name, r.confirmed_at, p_history)
      on conflict (round_id) do update set round_name = excluded.round_name, data = excluded.data;
  elsif p_status = 'utkast' then
    delete from public.history where round_id = r.id;
  end if;
  return r;
end $$;

create or replace function public.delete_round(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_leader() then raise exception 'Ingen åtkomst.'; end if;
  if exists (select 1 from public.rounds where id = p_id and status = 'fastställt') then
    raise exception 'Öppna omgången som utkast innan du tar bort den.';
  end if;
  delete from public.rounds where id = p_id;
end $$;

create or replace function public.comment_defaults() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.user_id := auth.uid();
  new.name := public.my_name();
  new.at := now();
  return new;
end $$;
drop trigger if exists comment_defaults on public.comments;
create trigger comment_defaults before insert on public.comments for each row execute function public.comment_defaults();

-- ---------- schema ----------
-- Sparar resultatet av en synk. Anropas av webbläsaren (ledare) eller av GitHub Action (service-nyckel).
create or replace function public.apply_sync(p_expected timestamptz, p_uppdrag jsonb, p_changes jsonb, p_source jsonb, p_trigger text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  cur public.schedule;
  c jsonb;
begin
  if not (public.is_leader() or coalesce(auth.role(), '') = 'service_role') then raise exception 'Ingen åtkomst.'; end if;
  select * into cur from public.schedule where id = 1 for update;
  if cur.last_success is distinct from p_expected then
    return jsonb_build_object('ok', true, 'skipped', true, 'changes', 0);
  end if;
  for c in select * from jsonb_array_elements(coalesce(p_changes, '[]')) loop
    insert into public.schedule_changes (uppdrag_key, label, date, items, is_new)
      values (c ->> 'key', c ->> 'label', c ->> 'date', c -> 'items', coalesce((c ->> 'isNew')::boolean, false));
  end loop;
  update public.schedule set uppdrag = p_uppdrag, last_attempt = now(), last_success = now(), last_error = null,
    last_trigger = p_trigger, source = p_source where id = 1;
  return jsonb_build_object('ok', true, 'changes', jsonb_array_length(coalesce(p_changes, '[]')));
end $$;

create or replace function public.sync_failed(p_error text, p_trigger text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not (public.is_leader() or coalesce(auth.role(), '') = 'service_role') then raise exception 'Ingen åtkomst.'; end if;
  update public.schedule set last_attempt = now(), last_error = left(p_error, 500), last_trigger = p_trigger where id = 1;
end $$;

create or replace function public.ack_changes(p_key text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_leader() then raise exception 'Ingen åtkomst.'; end if;
  update public.schedule_changes set ack_at = now(), ack_by_name = public.my_name()
   where uppdrag_key = p_key and ack_at is null;
end $$;

-- ---------- inställningar ----------
create or replace function public.save_settings(p_data jsonb, p_rename jsonb default '{}') returns void
language plpgsql security definer set search_path = public as $$
declare k text;
begin
  if not public.is_admin() then raise exception 'Endast för administratörer.'; end if;
  update public.settings set data = p_data where id = 1;
  for k in select jsonb_object_keys(coalesce(p_rename, '{}')) loop
    update public.players set level = p_rename ->> k, updated_at = now() where level = k;
  end loop;
end $$;

-- ---------- åtkomstregler (RLS) ----------
alter table public.app_config enable row level security;
alter table public.leaders enable row level security;
alter table public.invites enable row level security;
alter table public.settings enable row level security;
alter table public.players enable row level security;
alter table public.availability enable row level security;
alter table public.schedule enable row level security;
alter table public.schedule_changes enable row level security;
alter table public.rounds enable row level security;
alter table public.history enable row level security;
alter table public.comments enable row level security;

drop policy if exists leaders_read on public.leaders;
create policy leaders_read on public.leaders for select to authenticated using (public.is_leader());

drop policy if exists invites_admin on public.invites;
create policy invites_admin on public.invites for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists settings_read on public.settings;
create policy settings_read on public.settings for select to authenticated using (public.is_leader());

drop policy if exists players_all on public.players;
create policy players_all on public.players for all to authenticated using (public.is_leader()) with check (public.is_leader());

drop policy if exists availability_all on public.availability;
create policy availability_all on public.availability for all to authenticated using (public.is_leader()) with check (public.is_leader());

drop policy if exists schedule_read on public.schedule;
create policy schedule_read on public.schedule for select to authenticated using (public.is_leader());

drop policy if exists changes_read on public.schedule_changes;
create policy changes_read on public.schedule_changes for select to authenticated using (public.is_leader());

drop policy if exists rounds_read on public.rounds;
create policy rounds_read on public.rounds for select to authenticated using (public.is_leader());
drop policy if exists rounds_insert on public.rounds;
create policy rounds_insert on public.rounds for insert to authenticated with check (public.is_leader());

drop policy if exists history_read on public.history;
create policy history_read on public.history for select to authenticated using (public.is_leader());

drop policy if exists comments_read on public.comments;
create policy comments_read on public.comments for select to authenticated using (public.is_leader());
drop policy if exists comments_insert on public.comments;
create policy comments_insert on public.comments for insert to authenticated with check (public.is_leader());
drop policy if exists comments_delete on public.comments;
create policy comments_delete on public.comments for delete to authenticated using (public.is_leader() and (user_id = auth.uid() or public.is_admin()));

-- Funktioner som inte ska kunna anropas utan inloggning
revoke execute on function public.save_round, public.delete_round, public.apply_sync, public.sync_failed,
  public.ack_changes, public.save_settings, public.set_my_name, public.set_leader_role, public.remove_leader from anon, public;
grant execute on function public.save_round, public.delete_round, public.apply_sync, public.sync_failed,
  public.ack_changes, public.save_settings, public.set_my_name, public.set_leader_role, public.remove_leader to authenticated;
grant execute on function public.apply_sync, public.sync_failed to service_role;
grant execute on function public.invite_status, public.reset_password_with_invite to anon, authenticated;
revoke execute on function public.on_auth_user_created from anon, authenticated, public;

-- ---------- första administratören ----------
-- BYT UT adressen nedan. Den personen kan skapa sitt konto utan inbjudan, en gång.
insert into public.app_config (id, admin_email) values (1, 'MARKUS@KORPINEN.SE')
  on conflict (id) do update set admin_email = excluded.admin_email;
