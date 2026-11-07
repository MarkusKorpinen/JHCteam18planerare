import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { normalize, runSync } from '../docs/lib/schedule.js';
import { newRound, ACTIONS, view, snapshot, pendingReview } from '../docs/lib/rounds.js';
import { playersFromCsv } from '../docs/lib/csv.js';

const fixture = JSON.parse(readFileSync(new URL('../docs/demo/schedule.json', import.meta.url)));
const mem = {};
globalThis.localStorage = { getItem: (k) => mem[k] ?? null, setItem: (k, v) => { mem[k] = v; }, removeItem: (k) => { delete mem[k]; } };
globalThis.location = { origin: 'https://exempel.github.io', pathname: '/lagplanerare/' };

// Enkel minnesbackend för runSync
function memBackend() {
  const s = { uppdrag: {}, last_success: null, changes: [], errors: [] };
  return {
    s,
    getSchedule: async () => ({ uppdrag: s.uppdrag, last_success: s.last_success }),
    applySync: async (exp, uppdrag, changes) => { s.uppdrag = uppdrag; s.last_success = new Date().toISOString(); s.changes.push(...changes); return { ok: true, changes: changes.length }; },
    syncFailed: async (e) => { s.errors.push(e); },
  };
}
const fetchJson = (data) => async () => ({ ok: true, json: async () => structuredClone(data) });

test('synk: baslinje, ändrad tid/hall, försvunnen match och trasig källa', async () => {
  const b = memBackend();
  let r = await runSync(b, { fetchImpl: fetchJson(fixture) });
  assert.ok(r.ok); assert.equal(b.s.changes.length, 0, 'första hämtningen är baslinje');
  assert.equal(Object.keys(b.s.uppdrag).length, 51);
  const key = Object.keys(b.s.uppdrag).find((k) => b.s.uppdrag[k].date === '2026-11-28');
  const [block, team] = key.split('|');
  const changed = structuredClone(fixture);
  const ms = changed.matches.filter((m) => m.block === block && m.teams.includes(team));
  ms[0].start = '07:05'; ms.forEach((m) => (m.venue = 'Ny hall'));
  changed.matches = changed.matches.filter((m) => m !== ms[2]);
  r = await runSync(b, { fetchImpl: fetchJson(changed) });
  assert.equal(r.changes, 1);
  const txt = b.s.changes[0].items.join(' | ');
  assert.match(txt, /Ny hall/); assert.match(txt, /Ny tid/); assert.match(txt, /Match saknas i källan/);
  assert.equal(b.s.changes[0].label, b.s.uppdrag[key].label);
  r = await runSync(b, { fetchImpl: fetchJson({ matches: [], teams: [] }) });
  assert.equal(r.ok, false); assert.equal(b.s.errors.length, 1);
  assert.ok(Object.keys(b.s.uppdrag).length > 40, 'förra schemat behålls');
  r = await runSync(b, { fetchImpl: async () => { throw new TypeError('nät'); } });
  assert.equal(r.ok, false); assert.match(r.error, /nå matchkällan/);
});

function ctx() {
  const uppdrag = normalize(fixture);
  const players = playersFromCsv(['Namn;Nivå;Mål', ...Array.from({ length: 40 }, (_, i) => `Spelare ${i};${['Grön', 'Orange', 'Lila'][i % 3]};${i % 8 === 0 ? 'ja' : 'nej'}`)].join('\n'), ['Grön', 'Orange', 'Lila'])
    .players.map((p, i) => ({ ...p, id: `p${i}`, active: true }));
  return { uppdrag, players, availability: {}, levels: ['Grön', 'Orange', 'Lila'], history: [], teamPrefix: 'Järfälla HC', me: { name: 'Anna' }, changes: [] };
}

test('omgång: skapa, flytta, låsa, nytt förslag, fastställa', () => {
  const c = ctx();
  const keys = Object.values(c.uppdrag).filter((u) => u.date === '2026-11-28').map((u) => u.key);
  const r = { ...newRound('Test', keys, { skaters: 7, goalies: 1, lineSize: 4, maxPerPlayer: 1 }, c), id: 'r1', createdAt: '2026-11-07T10:00:00Z' };
  assert.equal(r.log[0].by, 'Anna');
  for (const k of keys) { assert.equal(r.teams[k].goalies.length, 1); assert.equal(r.teams[k].lines.flat().length, 7); }
  const pid = r.teams[keys[0]].lines[0][0];
  const txt = ACTIONS.move(r, { pid, fromKey: keys[0], toKey: keys[1], role: 'S', line: 0, lock: true }, c);
  assert.match(txt, /flyttade Spelare \d+ till U9/);
  assert.ok(r.teams[keys[1]].lines[0].includes(pid));
  assert.deepEqual(r.locks, [{ pid, key: keys[1], role: 'S' }]);
  for (let i = 0; i < 5; i++) { ACTIONS.propose(r, {}, c); assert.ok(r.teams[keys[1]].lines.flat().includes(pid)); }
  const v = view(r, c);
  assert.match(v.copy[keys[0]], /^Järfälla HC U9 \S+\n\nMålvakt\n.+\n\nUtespelare\n/);
  assert.ok(!/Grön|Orange|Lila|Kedja/.test(v.copy.all));
  // schemaändring efter att omgången skapades ska granskas, äldre och kvitterade inte
  c.changes = [
    { uppdrag_key: keys[0], items: ['Ny tid'], at: '2026-11-08T00:00:00Z' },
    { uppdrag_key: keys[0], items: ['Gammal'], at: '2026-11-01T00:00:00Z' },
    { uppdrag_key: keys[1], items: ['Kvitterad'], at: '2026-11-08T00:00:00Z', ack_at: 'x' },
  ];
  assert.equal(pendingReview(r, keys[0], c.changes).length, 1);
  assert.equal(pendingReview(r, keys[1], c.changes).length, 0);
  assert.ok(view(r, c).validation.perTeam[keys[0]].some((x) => x.level === 'review'));
  ACTIONS.confirm(r);
  const snap = snapshot(r, c);
  assert.equal(snap.teams.length, keys.length);
  assert.throws(() => ACTIONS.settings(r, { settings: { skaters: 0, goalies: 1, lineSize: 4, maxPerPlayer: 1 } }));
});

test('Supabase-klienten: inloggning, konfliktfel och inbjudningskod', async () => {
  const { createSupabaseBackend } = await import('../docs/backend-supabase.js');
  const calls = [];
  let mode = 'ok';
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts, body: opts.body ? JSON.parse(opts.body) : null });
    const json = (status, data) => ({ ok: status < 300, status, json: async () => data });
    if (url.includes('/auth/v1/token?grant_type=password')) {
      return JSON.parse(opts.body).password === 'ratt-losen-123'
        ? json(200, { access_token: 'AT', refresh_token: 'RT', expires_in: 3600, user: { id: 'u1' } })
        : json(400, { error: 'invalid_grant', error_description: 'Invalid login credentials' });
    }
    if (url.includes('/rest/v1/leaders')) return json(200, [{ user_id: 'u1', email: 'a@x.se', name: 'Anna', role: 'admin' }]);
    if (url.includes('/rest/v1/rpc/save_round')) {
      if (mode === 'conflict') return json(400, { code: 'P0001', message: 'conflict', details: JSON.stringify({ version: 5, updatedByName: 'Leo', updatedAt: '2026-11-07T10:00:00Z', last: { by: 'Leo', text: 'flyttade X' } }) });
      return json(200, { id: 'r1', name: 'T', status: 'utkast', version: 2, data: { keys: ['k'], teams: {}, settings: {}, locks: [], log: [] } });
    }
    if (url.includes('/rest/v1/invites') && opts.method === 'POST') return json(201, [{ expires_at: '2026-11-14T00:00:00Z' }]);
    return json(200, []);
  };
  const B = createSupabaseBackend({ url: 'https://abc.supabase.co/', anonKey: 'ANON' });
  await assert.rejects(B.login('a@x.se', 'fel'), /Fel e-post eller lösenord/);
  const me = await B.login('A@x.se ', 'ratt-losen-123');
  assert.equal(me.role, 'admin');
  assert.equal(calls.find((c) => c.url.includes('grant_type=password')).body.email, 'a@x.se');
  assert.equal(calls.at(-1).opts.headers.authorization, 'Bearer AT');

  const saved = await B.saveRound({ id: 'r1', name: 'T', status: 'utkast', keys: ['k'], teams: {}, settings: {}, locks: [], log: [], comments: [] }, 1);
  assert.equal(saved.version, 2);
  const args = calls.at(-1).body;
  assert.equal(args.p_base, 1); assert.ok(!('comments' in args.p_data));
  mode = 'conflict';
  await assert.rejects(B.saveRound({ id: 'r1', name: 'T', status: 'utkast', keys: [] }, 1), (e) => e.conflict?.updatedByName === 'Leo' && e.status === 409);

  const inv = await B.createInvite('Leo@X.se', 'leader');
  const code = decodeURIComponent(inv.link.split('#/inbjudan/')[1].split('/')[0]);
  assert.match(inv.link, /^https:\/\/exempel\.github\.io\/lagplanerare\/#\/inbjudan\/[\w-]+\/leo%40x\.se$/);
  const posted = calls.find((c) => c.url.endsWith('/rest/v1/invites') && c.opts.method === 'POST').body;
  assert.equal(posted.code_hash, createHash('sha256').update(code).digest('hex'), 'samma hash som databasens hash_code()');
  assert.equal(posted.email, 'leo@x.se');
  // anonyma anrop (inbjudan) använder anon-nyckeln även när en session finns
  await B.inviteStatus('leo@x.se', code);
  assert.equal(calls.at(-1).opts.headers.authorization, undefined);
  assert.equal(calls.at(-1).opts.headers.apikey, 'ANON');
});
