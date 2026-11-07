// Demoläge: påhittade spelare som bara sparas i den här webbläsaren. Ingen inloggning, ingen databas.
import { playersFromCsv } from './lib/csv.js';
import { runSync } from './lib/schedule.js';
import { newRound, ACTIONS, addLog, snapshot } from './lib/rounds.js';

const KEY = 'jhc-planerare-demo-4';
const FIRST = ['Alva', 'Bo', 'Cleo', 'Dante', 'Ebbe', 'Freja', 'Gustav', 'Hedda', 'Isak', 'Juni', 'Kasper', 'Lova', 'Malte', 'Nova', 'Otto', 'Penny', 'Rasmus', 'Saga', 'Tage', 'Ugo', 'Vera', 'Wilmer', 'Ylva', 'Ziggy', 'Alvin', 'Bianca', 'Colin', 'Disa', 'Elton', 'Fanny', 'Gry', 'Hjalmar', 'Ines', 'Jack', 'Kim', 'Leon', 'Majken', 'Nils', 'Olle', 'Pim', 'Rut', 'Sigge'];
const LAST = ['Ahl', 'Berg', 'Dahl', 'Ek', 'Falk', 'Grahn', 'Holm', 'Lind', 'Mårs', 'Nord', 'Ros', 'Sjö', 'Tall', 'Udd', 'Wik'];
export function fakeCsv(n = 42) {
  const lv = ['Grön', 'Orange', 'Lila'];
  const rows = ['Namn;Nivågrupp;Kan stå i mål;Grupp'];
  for (let i = 0; i < n; i++) {
    const level = lv[i % 10 < 3 ? 0 : i % 10 < 7 ? 1 : 2];
    rows.push(`${FIRST[i % FIRST.length]} ${LAST[(i * 7) % LAST.length]};${level};${[2, 9, 15, 21, 27, 33, 38, 40].includes(i) ? 'ja' : 'nej'};${i >= 32 ? 'reserv' : 'ordinarie'}`);
  }
  return rows.join('\n');
}
const uuid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const clone = (x) => structuredClone(x);
const ME = { id: 'demo', email: 'demo@exempel.se', name: 'Demoledare', role: 'admin' };

export function createDemoBackend({ source = 'demo/schedule.json' } = {}) {
  let db = null;
  try { db = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch {}
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch {} };
  const ctxFor = () => ({
    uppdrag: db.schedule.uppdrag, players: db.players, availability: availMap(), levels: db.settings.levels.map((l) => l.name),
    history: db.history, teamPrefix: db.settings.teamPrefix, me: ME, changes: db.changes, coaches: db.coaches || [],
  });
  const availMap = () => { const a = {}; for (const x of db.availability) (a[x.key] ||= {})[x.pid] = false; return a; };
  const stamp = (r, text) => { r.version = (r.version || 0) + 1; r.updatedAt = now(); r.updatedByName = ME.name; if (text) addLog(r, ME, text); };
  const syncApi = {
    getSchedule: async () => ({ uppdrag: db.schedule.uppdrag, last_success: db.schedule.last_success }),
    applySync: async (exp, uppdrag, changes, src, trigger) => {
      for (const c of changes) db.changes.unshift({ id: uuid(), uppdrag_key: c.key, label: c.label, date: c.date, items: c.items, is_new: c.isNew, at: now() });
      Object.assign(db.schedule, { uppdrag, last_attempt: now(), last_success: now(), last_error: null, last_trigger: trigger, source: src });
      save();
      return { ok: true, changes: changes.length };
    },
    syncFailed: async (error, trigger) => { Object.assign(db.schedule, { last_attempt: now(), last_error: error, last_trigger: trigger }); save(); },
  };

  const demoCoaches = (r) => r.keys.forEach((k, i) => { r.teams[k].coaches = [db.coaches[i % 6].id, ...(i + 4 < 6 ? [db.coaches[i + 4].id] : [])]; });
  async function seed() {
    db = {
      settings: { levels: [{ name: 'Grön', color: '#2e9e5b' }, { name: 'Orange', color: '#e8862a' }, { name: 'Lila', color: '#8a55c9' }], teamPrefix: 'Järfälla HC', syncHours: 24, roundDefaults: { skaters: 7, goalies: 1, lineSize: 4, maxPerPlayer: 1 } },
      players: playersFromCsv(fakeCsv(), ['Grön', 'Orange', 'Lila']).players.map((p) => ({ id: uuid(), ...p, active: true })),
      coaches: ['Anna Andersson', 'Bertil Berg', 'Cecilia Carlsson', 'David Dahl', 'Eva Ek', 'Fredrik Falk'].map((name) => ({ id: uuid(), name, active: true })),
      availability: [], schedule: { uppdrag: {} }, changes: [], rounds: [], history: [], comments: [],
    };
    await runSync(syncApi, { source, trigger: 'demo' });
    const U = Object.values(db.schedule.uppdrag);
    const on = (d) => U.filter((u) => u.date === d).map((u) => u.key);
    for (const [name, dates] of [['Omgång 10–11 okt', ['2026-10-10', '2026-10-11']], ['Omgång 17 okt', ['2026-10-17']], ['Omgång 7 nov', ['2026-11-07']]]) {
      const keys = dates.flatMap(on);
      if (!keys.length) continue;
      const r = { ...newRound(name, keys, db.settings.roundDefaults, ctxFor()), id: uuid(), createdAt: now(), version: 0 };
      demoCoaches(r);
      r.status = 'fastställt'; r.confirmedAt = now(); r.confirmedBy = ME.name; stamp(r, 'fastställde omgången');
      db.rounds.unshift(r);
      db.history.push({ ...snapshot(r, ctxFor()), confirmedAt: r.confirmedAt });
    }
    const keys = on('2026-11-28');
    if (keys.length) {
      for (const i of [0, 5, 11]) db.availability.push({ key: keys[0], pid: db.players[i].id });
      for (const k of keys) db.availability.push({ key: k, pid: db.players[2].id });
      const r = { ...newRound('Omgång 28 nov', keys, db.settings.roundDefaults, ctxFor()), id: uuid(), createdAt: now(), version: 0 };
      demoCoaches(r);
      stamp(r);
      db.rounds.unshift(r);
      db.comments.push({ id: uuid(), roundId: r.id, key: keys[0], userId: 'leo', name: 'Leo Ledare', text: 'Bra om Vera får spela med Otto den här gången.', at: now() });
    }
    save();
  }

  const findRound = (id) => db.rounds.find((r) => r.id === id) || (() => { throw new Error('Omgången finns inte.'); })();
  return {
    mode: 'demo',
    async me() { if (!db) await seed(); return ME; },
    async reset() { localStorage.removeItem(KEY); db = null; await seed(); },
    async logout() {},
    async loadState() {
      return {
        settings: clone(db.settings), players: clone(db.players), coaches: clone(db.coaches || []), availability: availMap(), schedule: clone(db.schedule),
        changes: clone(db.changes),
        rounds: db.rounds.map((r) => ({ id: r.id, name: r.name, status: r.status, keys: r.keys, createdAt: r.createdAt, updatedAt: r.updatedAt, updatedByName: r.updatedByName, confirmedAt: r.confirmedAt })),
        history: clone(db.history),
      };
    },
    async addPlayer(p) { const x = { id: uuid(), name: p.name, level: p.level, canGoalie: !!p.canGoalie, squad: p.squad === 'reserv' ? 'reserv' : 'ordinarie', active: true }; db.players.push(x); save(); return x; },
    async updatePlayer(id, patch) { Object.assign(db.players.find((p) => p.id === id), patch); save(); },
    async importPlayers({ add, update, archive }) {
      for (const p of add) db.players.push({ id: uuid(), squad: 'ordinarie', ...p, active: true });
      for (const p of update) Object.assign(db.players.find((x) => x.id === p.id), { level: p.level, canGoalie: p.canGoalie, active: true, ...(p.squad ? { squad: p.squad } : {}) });
      for (const a of archive) db.players.find((x) => x.id === a.id).active = false;
      save();
    },
    async addCoach(name) { const c = { id: uuid(), name, active: true }; (db.coaches ||= []).push(c); save(); return c; },
    async updateCoach(id, patch) { Object.assign(db.coaches.find((c) => c.id === id), patch); save(); },
    async setAvailability(key, pid, available) {
      db.availability = db.availability.filter((a) => !(a.key === key && a.pid === pid));
      if (!available) db.availability.push({ key, pid });
      save();
    },
    ...syncApi,
    async ackChanges(key) { for (const c of db.changes) if (c.uppdrag_key === key && !c.ack_at) { c.ack_at = now(); c.ack_by_name = ME.name; } save(); },
    async createRound(r) { const x = { ...clone(r), id: uuid(), createdAt: now(), version: 0 }; stamp(x); db.rounds.unshift(x); save(); return clone(x); },
    async getRound(id) { return { ...clone(findRound(id)), comments: clone(db.comments.filter((c) => c.roundId === id)) }; },
    async getRoundVersion(id) { const r = findRound(id); return { version: r.version, updatedAt: r.updatedAt, updatedByName: r.updatedByName, last: r.log?.[0] }; },
    async saveRound(r, base, { history } = {}) {
      const i = db.rounds.findIndex((x) => x.id === r.id);
      const old = db.rounds[i];
      const x = { ...clone(r), version: old.version };
      delete x.comments;
      stamp(x);
      if (x.status === 'fastställt' && old.status !== 'fastställt') { x.confirmedAt = now(); x.confirmedBy = ME.name; }
      if (x.status === 'utkast') { x.confirmedAt = null; x.confirmedBy = null; db.history = db.history.filter((h) => h.roundId !== x.id); }
      if (x.status === 'fastställt' && history) { db.history = db.history.filter((h) => h.roundId !== x.id); db.history.push({ ...history, confirmedAt: x.confirmedAt }); }
      db.rounds[i] = x; save();
      return clone(x);
    },
    async deleteRound(id) { db.rounds = db.rounds.filter((r) => r.id !== id); save(); },
    async addComment(roundId, key, text) { db.comments.push({ id: uuid(), roundId, key, userId: ME.id, name: ME.name, text, at: now() }); save(); },
    async deleteComment(id) { db.comments = db.comments.filter((c) => c.id !== id); save(); },
    async listLeaders() { return { users: [ME, { id: 'leo', email: 'leo@exempel.se', name: 'Leo Ledare', role: 'leader' }], invites: [] }; },
    async createInvite(email) { return { email, expires: new Date(Date.now() + 7 * 864e5).toISOString(), link: `${location.origin}${location.pathname}#/inbjudan/DEMO-KOD/${encodeURIComponent(email)}` }; },
    async deleteInvite() {}, async setRole() {}, async removeLeader() {}, async setMyName() {},
    async saveSettings(data, rename) {
      db.settings = data;
      for (const p of db.players) if (rename?.[p.level]) p.level = rename[p.level];
      save();
    },
    async exportAll() { return clone(db); },
  };
}
