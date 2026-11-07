-- Uppdatering: roller (lagplanerare / lagledare / ledare), rutinbank, ledarkommentarer per poolspel
-- och matchinbjudan för hemmapoolspel. Kör hela filen en gång i Supabase → SQL Editor.
-- Filen kan köras flera gånger. Inga spelare, omgångar eller inställningar tas bort.

-- ---------- roller ----------
alter table public.leaders add column if not exists planner boolean not null default false;
alter table public.leaders add column if not exists teamlead boolean not null default false;
alter table public.invites add column if not exists planner boolean not null default false;
alter table public.invites add column if not exists teamlead boolean not null default false;
-- Befintliga administratörer behåller all åtkomst.
update public.leaders set planner = true, teamlead = true where role = 'admin';

create or replace function public.is_planner() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.leaders where user_id = auth.uid() and (role = 'admin' or planner));
$$;
create or replace function public.is_teamlead() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.leaders where user_id = auth.uid() and (role = 'admin' or teamlead));
$$;

-- Nya konton får rollerna från inbjudan
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
    insert into public.leaders (user_id, email, name, role, planner, teamlead)
      values (new.id, lower(new.email), nm, inv.role, inv.planner or inv.role = 'admin', inv.teamlead or inv.role = 'admin');
    delete from public.invites where id = inv.id;
    return new;
  end if;
  if not exists (select 1 from public.leaders where role = 'admin')
     and lower(new.email) = (select lower(admin_email) from public.app_config where id = 1) then
    insert into public.leaders (user_id, email, name, role, planner, teamlead) values (new.id, lower(new.email), nm, 'admin', true, true);
    return new;
  end if;
  raise exception 'Inbjudan saknas eller har gått ut.';
end $$;

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
  insert into public.leaders (user_id, email, name, role, planner, teamlead)
    values (uid, lower(p_email), left(coalesce(p_name, ''), 60), inv.role, inv.planner, inv.teamlead)
    on conflict (user_id) do update set name = case when excluded.name <> '' then excluded.name else leaders.name end,
      role = case when inv.role = 'admin' then 'admin' else leaders.role end,
      planner = leaders.planner or inv.planner, teamlead = leaders.teamlead or inv.teamlead;
  delete from public.invites where id = inv.id;
  return true;
end $$;

create or replace function public.set_leader_roles(p_user uuid, p_admin boolean, p_planner boolean, p_teamlead boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Endast för administratörer.'; end if;
  if p_user = auth.uid() and not p_admin then raise exception 'Du kan inte ta bort din egen administratörsroll.'; end if;
  update public.leaders set role = case when p_admin then 'admin' else 'leader' end, planner = p_planner, teamlead = p_teamlead
   where user_id = p_user;
end $$;

-- ---------- nivågrupper i egen tabell, bara för lagplanerare ----------
create table if not exists public.player_levels (
  player_id uuid primary key references public.players (id) on delete cascade,
  level text not null
);
do $$ begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'players' and column_name = 'level') then
    insert into public.player_levels (player_id, level) select id, level from public.players where level is not null
      on conflict (player_id) do nothing;
    alter table public.players drop column level;
  end if;
end $$;

create or replace function public.save_settings(p_data jsonb, p_rename jsonb default '{}') returns void
language plpgsql security definer set search_path = public as $$
declare k text;
begin
  if not public.is_admin() then raise exception 'Endast för administratörer.'; end if;
  update public.settings set data = p_data where id = 1;
  for k in select jsonb_object_keys(coalesce(p_rename, '{}')) loop
    update public.player_levels set level = p_rename ->> k where level = k;
  end loop;
end $$;

-- ---------- omgångar: bara lagplanerare ändrar ----------
create or replace function public.save_round(p_id uuid, p_base int, p_name text, p_status text, p_data jsonb, p_force boolean default false, p_history jsonb default null)
returns public.rounds
language plpgsql security definer set search_path = public as $$
declare
  r public.rounds;
begin
  if not public.is_planner() then raise exception 'Endast lagplanerare kan ändra lagen.'; end if;
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
  if not public.is_planner() then raise exception 'Endast lagplanerare.'; end if;
  if exists (select 1 from public.rounds where id = p_id and status = 'fastställt') then
    raise exception 'Öppna omgången som utkast innan du tar bort den.';
  end if;
  delete from public.rounds where id = p_id;
end $$;

create or replace function public.ack_changes(p_key text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_planner() then raise exception 'Endast lagplanerare.'; end if;
  update public.schedule_changes set ack_at = now(), ack_by_name = public.my_name()
   where uppdrag_key = p_key and ack_at is null;
end $$;

-- ---------- ledarnas kommentarer per poolspel ----------
create table if not exists public.pool_comments (
  id uuid primary key default gen_random_uuid(),
  uppdrag_key text not null,
  user_id uuid not null default auth.uid(),
  name text,
  text text not null check (length(text) between 1 and 1000),
  at timestamptz not null default now(),
  read_by uuid[] not null default '{}'
);
create or replace function public.pool_comment_defaults() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.user_id := auth.uid(); new.name := public.my_name(); new.at := now(); new.read_by := array[auth.uid()];
  return new;
end $$;
drop trigger if exists pool_comment_defaults on public.pool_comments;
create trigger pool_comment_defaults before insert on public.pool_comments for each row execute function public.pool_comment_defaults();
create or replace function public.mark_pool_comments_read(p_key text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_planner() then return; end if;
  update public.pool_comments set read_by = array_append(read_by, auth.uid())
   where uppdrag_key = p_key and not (auth.uid() = any (read_by));
end $$;

-- ---------- rutinbank ----------
create table if not exists public.routine_categories (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 1 and 40),
  sort int not null default 0
);
create table if not exists public.routines (
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(title) between 1 and 120),
  category_id uuid references public.routine_categories (id) on delete set null,
  status text not null default 'utkast' check (status in ('utkast', 'publicerad')),
  content jsonb not null default '{}',
  version int not null default 1,
  created_by uuid default auth.uid(),
  created_by_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by_name text,
  published_at timestamptz,
  published_by_name text
);
create table if not exists public.routine_versions (
  id bigint generated always as identity primary key,
  routine_id uuid not null references public.routines (id) on delete cascade,
  version int not null,
  title text,
  content jsonb,
  saved_at timestamptz not null default now(),
  saved_by_name text
);
-- Alla ledare får skriva utkast utan kategori. Bara lagledare publicerar, väljer kategori och tar bort.
create or replace function public.routine_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.created_by := auth.uid(); new.created_by_name := public.my_name(); new.created_at := now(); new.version := 1;
  else
    new.created_by := old.created_by; new.created_by_name := old.created_by_name; new.created_at := old.created_at;
    new.version := old.version + 1;
    insert into public.routine_versions (routine_id, version, title, content, saved_by_name)
      values (old.id, old.version, old.title, old.content, old.updated_by_name);
  end if;
  new.updated_at := now(); new.updated_by_name := public.my_name();
  if not public.is_teamlead() then
    if new.status <> 'utkast' or new.category_id is not null then
      raise exception 'Bara lagledare kan publicera rutiner och välja kategori.';
    end if;
    if tg_op = 'UPDATE' and old.created_by is distinct from auth.uid() then
      raise exception 'Du kan bara ändra dina egna utkast.';
    end if;
  end if;
  if new.status = 'publicerad' and (tg_op = 'INSERT' or old.status <> 'publicerad') then
    new.published_at := now(); new.published_by_name := public.my_name();
  elsif new.status = 'utkast' then
    new.published_at := null; new.published_by_name := null;
  end if;
  return new;
end $$;
drop trigger if exists routine_guard on public.routines;
create trigger routine_guard before insert or update on public.routines for each row execute function public.routine_guard();

-- ---------- matchinbjudan ----------
-- Tröjfärger per lag (hämtas från swehockey av GitHub-synken, kan ändras för hand)
create table if not exists public.team_colors (
  team text primary key,
  home text,
  away text,
  source text not null default 'manual' check (source in ('swehockey', 'manual')),
  updated_at timestamptz not null default now()
);
-- Logotyp per förening (laddas upp av lagledare/lagplanerare)
create table if not exists public.clubs (
  name text primary key,
  logo text,
  updated_at timestamptz not null default now()
);
-- Hela poolspelsschemat för hemmapoolspel (alla lag, hämtas av GitHub-synken)
create table if not exists public.home_events (
  key text primary key,          -- datum|hall
  date text not null,
  venue text not null,
  data jsonb not null,           -- {blocks:[{block, group, matches:[{start, home, away}]}]}
  fetched_at timestamptz not null default now()
);
-- Inställningar per inbjudan (hall, planer, tröjval, övrig information)
create table if not exists public.invitations (
  event_key text primary key,
  data jsonb not null default '{}',
  updated_at timestamptz not null default now(),
  updated_by_name text
);
create or replace function public.invitation_defaults() returns trigger
language plpgsql security definer set search_path = public as $$
begin new.updated_at := now(); new.updated_by_name := public.my_name(); return new; end $$;
drop trigger if exists invitation_defaults on public.invitations;
create trigger invitation_defaults before insert or update on public.invitations for each row execute function public.invitation_defaults();

insert into public.team_colors (team, home, away, source) values
  ('Hässelby Kälvesta HC svart', 'Black', 'White', 'swehockey'), ('Hässelby Kälvesta HC vit', 'Black', 'White', 'swehockey'),
  ('IK Göta blå', 'Red', 'White', 'swehockey'), ('IK Göta svart', 'Red', 'White', 'swehockey'),
  ('Järfälla HC blå', 'Red', 'White', 'swehockey'), ('Järfälla HC röd', 'Red', 'White', 'swehockey'), ('Järfälla HC vit', 'Red', 'White', 'swehockey'),
  ('Kista HC', 'Black', 'White', 'swehockey'),
  ('Mälarö Hockeyförening blå', 'Blue', 'White', 'swehockey'), ('Mälarö Hockeyförening vit', 'Blue', 'White', 'swehockey'),
  ('Sollentuna HC röd', 'Red', 'White', 'swehockey'), ('Sollentuna HC vit', 'Red', 'White', 'swehockey'),
  ('Spånga IS IK blå', 'Blue', 'White', 'swehockey'), ('Spånga IS IK vit', 'Blue', 'White', 'swehockey'),
  ('Sundbybergs IK grön', 'Green', 'White', 'swehockey'), ('Sundbybergs IK vit', 'Green', 'White', 'swehockey'),
  ('Vallentuna Hockey röd', 'Red', 'White', 'swehockey'), ('Vallentuna Hockey vit', 'Red', 'White', 'swehockey'),
  ('Väsby IK HK grön', 'Green', 'White', 'swehockey'), ('Väsby IK HK vit', 'Green', 'White', 'swehockey')
on conflict (team) do nothing;

-- ---------- åtkomstregler ----------
alter table public.player_levels enable row level security;
alter table public.pool_comments enable row level security;
alter table public.routine_categories enable row level security;
alter table public.routines enable row level security;
alter table public.routine_versions enable row level security;
alter table public.team_colors enable row level security;
alter table public.clubs enable row level security;
alter table public.home_events enable row level security;
alter table public.invitations enable row level security;

-- spelare: alla ledare läser namn, bara lagplanerare ändrar
drop policy if exists players_all on public.players;
drop policy if exists players_read on public.players;
create policy players_read on public.players for select to authenticated using (public.is_leader());
drop policy if exists players_write on public.players;
create policy players_write on public.players for all to authenticated using (public.is_planner()) with check (public.is_planner());
drop policy if exists player_levels_planner on public.player_levels;
create policy player_levels_planner on public.player_levels for all to authenticated using (public.is_planner()) with check (public.is_planner());
drop policy if exists availability_all on public.availability;
create policy availability_all on public.availability for all to authenticated using (public.is_planner()) with check (public.is_planner());

-- tränare: alla läser (syns på fastställda lag), lagplanerare ändrar
drop policy if exists coaches_all on public.coaches;
drop policy if exists coaches_read on public.coaches;
create policy coaches_read on public.coaches for select to authenticated using (public.is_leader());
drop policy if exists coaches_write on public.coaches;
create policy coaches_write on public.coaches for all to authenticated using (public.is_planner()) with check (public.is_planner());
drop policy if exists coach_availability_all on public.coach_availability;
create policy coach_availability_all on public.coach_availability for all to authenticated using (public.is_planner()) with check (public.is_planner());

-- omgångar: lagplanerare ser allt, övriga bara fastställda
drop policy if exists rounds_read on public.rounds;
create policy rounds_read on public.rounds for select to authenticated using (public.is_planner() or (public.is_leader() and status = 'fastställt'));
drop policy if exists rounds_insert on public.rounds;
create policy rounds_insert on public.rounds for insert to authenticated with check (public.is_planner());
drop policy if exists history_read on public.history;
create policy history_read on public.history for select to authenticated using (public.is_planner());
drop policy if exists comments_read on public.comments;
create policy comments_read on public.comments for select to authenticated using (public.is_planner());
drop policy if exists comments_insert on public.comments;
create policy comments_insert on public.comments for insert to authenticated with check (public.is_planner());
drop policy if exists comments_delete on public.comments;
create policy comments_delete on public.comments for delete to authenticated using (public.is_planner() and (user_id = auth.uid() or public.is_admin()));

-- kommentarer per poolspel
drop policy if exists pool_comments_read on public.pool_comments;
create policy pool_comments_read on public.pool_comments for select to authenticated using (public.is_leader());
drop policy if exists pool_comments_insert on public.pool_comments;
create policy pool_comments_insert on public.pool_comments for insert to authenticated with check (public.is_leader());
drop policy if exists pool_comments_delete on public.pool_comments;
create policy pool_comments_delete on public.pool_comments for delete to authenticated using (user_id = auth.uid() or public.is_planner());

-- rutiner
drop policy if exists routine_categories_read on public.routine_categories;
create policy routine_categories_read on public.routine_categories for select to authenticated using (public.is_leader());
drop policy if exists routine_categories_write on public.routine_categories;
create policy routine_categories_write on public.routine_categories for all to authenticated using (public.is_teamlead()) with check (public.is_teamlead());
drop policy if exists routines_read on public.routines;
create policy routines_read on public.routines for select to authenticated
  using (public.is_leader() and (status = 'publicerad' or created_by = auth.uid() or public.is_teamlead()));
drop policy if exists routines_insert on public.routines;
create policy routines_insert on public.routines for insert to authenticated with check (public.is_leader());
drop policy if exists routines_update on public.routines;
create policy routines_update on public.routines for update to authenticated
  using (public.is_teamlead() or (created_by = auth.uid() and status = 'utkast')) with check (public.is_leader());
drop policy if exists routines_delete on public.routines;
create policy routines_delete on public.routines for delete to authenticated using (public.is_teamlead() or (created_by = auth.uid() and status = 'utkast'));
drop policy if exists routine_versions_read on public.routine_versions;
create policy routine_versions_read on public.routine_versions for select to authenticated using (public.is_teamlead());

-- matchinbjudan: alla läser, lagledare och lagplanerare ändrar
drop policy if exists team_colors_read on public.team_colors;
create policy team_colors_read on public.team_colors for select to authenticated using (public.is_leader());
drop policy if exists team_colors_write on public.team_colors;
create policy team_colors_write on public.team_colors for all to authenticated using (public.is_teamlead() or public.is_planner()) with check (public.is_teamlead() or public.is_planner());
drop policy if exists clubs_read on public.clubs;
create policy clubs_read on public.clubs for select to authenticated using (public.is_leader());
drop policy if exists clubs_write on public.clubs;
create policy clubs_write on public.clubs for all to authenticated using (public.is_teamlead() or public.is_planner()) with check (public.is_teamlead() or public.is_planner());
drop policy if exists home_events_read on public.home_events;
create policy home_events_read on public.home_events for select to authenticated using (public.is_leader());
drop policy if exists invitations_read on public.invitations;
create policy invitations_read on public.invitations for select to authenticated using (public.is_leader());
drop policy if exists invitations_write on public.invitations;
create policy invitations_write on public.invitations for all to authenticated using (public.is_teamlead() or public.is_planner()) with check (public.is_teamlead() or public.is_planner());

grant select, insert, update, delete on all tables in schema public to authenticated, service_role;
grant usage, select on all sequences in schema public to authenticated, service_role;
revoke all on all tables in schema public from anon;
revoke execute on function public.set_leader_roles, public.mark_pool_comments_read from anon, public;
grant execute on function public.set_leader_roles, public.mark_pool_comments_read, public.is_planner, public.is_teamlead to authenticated;
