-- Testar åtkomstregler och funktioner. Körs av test/run-sql-tests.sh mot en tom databas.
\set ON_ERROR_STOP on
update public.app_config set admin_email = 'anna@exempel.se';

create or replace function pg_temp.expect_error(sql text, pattern text) returns void language plpgsql as $$
begin
  execute sql;
  raise exception 'FÖRVÄNTADE FEL men det gick igenom: %', sql;
exception when others then
  if sqlerrm like 'FÖRVÄNTADE FEL%' then raise; end if;
  if sqlerrm !~* pattern then raise exception 'Fel meddelande för %: %', sql, sqlerrm; end if;
end $$;
create or replace function pg_temp.as_user(uid uuid) returns void language sql as $$
  select set_config('request.jwt.claim.sub', coalesce(uid::text, ''), false), set_config('request.jwt.claim.role', case when uid is null then 'anon' else 'authenticated' end, false);
$$;

-- 1. Konto utan inbjudan stoppas, administratören får skapa sitt konto
select pg_temp.expect_error($$insert into auth.users (email, raw_user_meta_data) values ('okand@exempel.se', '{}')$$, 'Inbjudan saknas');
insert into auth.users (id, email, raw_user_meta_data) values ('00000000-0000-0000-0000-00000000000a', 'Anna@Exempel.se', '{"name":"Anna"}');
select pg_temp.expect_error($$insert into auth.users (email, raw_user_meta_data) values ('anna2@exempel.se', '{}')$$, 'Inbjudan saknas');
do $$ begin assert (select role from public.leaders where email = 'anna@exempel.se') = 'admin'; end $$;

-- 2. Admin skapar inbjudan som ledare
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
insert into public.invites (email, code_hash, role) values ('leo@exempel.se', public.hash_code('kod-123'), 'leader');
do $$ begin assert (select count(*) from public.invites) = 1; end $$;
reset role;

-- anonym ser status men inte om okända konton finns
set role anon;
select pg_temp.as_user(null);
do $$ begin
  assert (public.invite_status('leo@exempel.se', 'kod-123') ->> 'valid')::boolean;
  assert not (public.invite_status('leo@exempel.se', 'fel') ->> 'valid')::boolean;
  assert not (public.invite_status('anna@exempel.se', 'x') ->> 'existing')::boolean;
end $$;
do $$ begin assert (select count(*) from public.players) = 0; end $$;
select pg_temp.expect_error($$insert into public.players (name, level) values ('X', 'Grön')$$, 'row-level security|permission');
select pg_temp.expect_error($$select public.save_round(gen_random_uuid(), 1, 'x', 'utkast', '{}')$$, 'permission denied');
do $$ begin assert (select count(*) from public.invites) = 0; end $$;
reset role;

-- Fel kod stoppas, rätt kod skapar ledaren och förbrukar inbjudan
select pg_temp.expect_error($$insert into auth.users (email, raw_user_meta_data) values ('leo@exempel.se', '{"invite_code":"fel"}')$$, 'Inbjudan saknas');
insert into auth.users (id, email, raw_user_meta_data) values ('00000000-0000-0000-0000-00000000000b', 'leo@exempel.se', '{"invite_code":"kod-123","name":"Leo"}');
do $$ begin
  assert (select role from public.leaders where email = 'leo@exempel.se') = 'leader';
  assert (select count(*) from public.invites) = 0;
end $$;

-- 3. En inloggad användare utan ledarrad ser ingenting
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000ff');
do $$ begin assert (select count(*) from public.settings) = 0; assert (select count(*) from public.leaders) = 0; end $$;

-- 4. Ledaren arbetar
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
insert into public.players (name, level, can_goalie) values ('Alva A', 'Grön', true), ('Bo B', 'Lila', false);
do $$ begin assert (select count(*) from public.players) = 2; end $$;
insert into public.availability (uppdrag_key, player_id) select 'k1', id from public.players where name = 'Bo B';
select pg_temp.expect_error($$insert into public.invites (email, code_hash) values ('x@x.se', 'h')$$, 'row-level security');
update public.leaders set role = 'admin'; -- påverkar 0 rader
do $$ begin assert (select role from public.leaders where user_id = auth.uid()) = 'leader'; end $$;
select pg_temp.expect_error($$select public.set_leader_role('00000000-0000-0000-0000-00000000000b', 'admin')$$, 'administratörer');
select pg_temp.expect_error($$select public.save_settings('{}')$$, 'administratörer');

-- omgång, versionskonflikt och historik
insert into public.rounds (name, data) values ('Test', '{"keys":["k1"],"teams":{"k1":{"goalies":[],"lines":[]}}}');
do $$
declare r public.rounds; rid uuid;
begin
  select * into r from public.rounds;
  assert r.version = 1 and r.created_by_name = 'Leo' and r.status = 'utkast';
  r := public.save_round(r.id, 1, 'Test', 'utkast', '{"keys":["k1"],"log":[{"by":"Leo","text":"flyttade"}]}');
  assert r.version = 2;
  begin
    perform public.save_round(r.id, 1, 'Test', 'utkast', '{}');
    raise exception 'borde ha stoppats';
  exception when others then
    assert sqlerrm = 'conflict', sqlerrm;
  end;
  r := public.save_round(r.id, 1, 'Test', 'utkast', '{"keys":["k1"]}', true);
  assert r.version = 3;
  r := public.save_round(r.id, 3, 'Test', 'fastställt', r.data, false, '{"teams":[]}');
  assert r.status = 'fastställt' and r.confirmed_by_name = 'Leo';
  assert (select count(*) from public.history) = 1;
  r := public.save_round(r.id, 4, 'Test', 'utkast', r.data);
  assert (select count(*) from public.history) = 0 and r.confirmed_at is null;
end $$;
update public.rounds set version = 99; -- påverkar 0 rader
do $$ begin assert (select max(version) from public.rounds) = 5; end $$;

-- kommentarer: namn sätts av databasen, bara egna kan tas bort
insert into public.comments (round_id, uppdrag_key, text, name, user_id) select id, 'k1', 'Hej', 'Fejk', '00000000-0000-0000-0000-00000000000a' from public.rounds;
do $$ begin assert (select name from public.comments) = 'Leo'; end $$;

-- synk
do $$
declare res jsonb;
begin
  res := public.apply_sync(null, '{"k1":{"label":"U9 blå"}}', '[{"key":"k1","items":["Ny tid"],"label":"U9 blå","date":"2026-11-28"}]', '{}', 'manual');
  assert (res ->> 'changes')::int = 1;
  res := public.apply_sync(null, '{}', '[]', '{}', 'manual');
  assert (res ->> 'skipped')::boolean, 'gammal synk ska hoppas över';
  perform public.ack_changes('k1');
  assert (select ack_by_name from public.schedule_changes) = 'Leo';
  perform public.sync_failed('Nätverksfel', 'auto');
  assert (select last_error from public.schedule) = 'Nätverksfel';
  assert (select uppdrag from public.schedule) ? 'k1';
end $$;
reset role;

-- service-nyckeln (GitHub Action) kan synka
set role service_role;
select set_config('request.jwt.claim.sub', '', false), set_config('request.jwt.claim.role', 'service_role', false);
do $$ begin
  assert (public.apply_sync((select last_success from public.schedule), '{"k2":{}}', '[]', '{}', 'cron') ->> 'ok')::boolean;
  assert (select uppdrag from public.schedule) ? 'k2';
end $$;
reset role;

-- 5. Admin: inställningar byter nivånamn, ny inloggningslänk, ta bort ledare
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
select public.save_settings('{"levels":[{"name":"Blå"}]}', '{"Grön":"Blå"}');
do $$ begin assert (select level from public.players where name = 'Alva A') = 'Blå'; end $$;
insert into public.invites (email, code_hash) values ('leo@exempel.se', public.hash_code('ny-kod'));
reset role;
set role anon;
select pg_temp.as_user(null);
do $$ begin assert (public.invite_status('leo@exempel.se', 'ny-kod') ->> 'existing')::boolean; end $$;
select pg_temp.expect_error($$select public.reset_password_with_invite('leo@exempel.se', 'ny-kod', 'kort', 'Leo')$$, '10 tecken');
select public.reset_password_with_invite('leo@exempel.se', 'ny-kod', 'ett-langt-losenord', 'Leo L');
reset role;
do $$ begin
  assert (select encrypted_password from auth.users where email = 'leo@exempel.se') = extensions.crypt('ett-langt-losenord', (select encrypted_password from auth.users where email = 'leo@exempel.se'));
  assert (select name from public.leaders where email = 'leo@exempel.se') = 'Leo L';
end $$;
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
select pg_temp.expect_error($$select public.remove_leader('00000000-0000-0000-0000-00000000000a')$$, 'dig själv');
select public.remove_leader('00000000-0000-0000-0000-00000000000b');
do $$ begin assert (select count(*) from public.leaders) = 1; end $$;
reset role;
\echo 'ALLA SQL-TESTER GICK IGENOM'
