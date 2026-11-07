import { test } from 'node:test';
import assert from 'node:assert/strict';
import { propose, validate, rosterText, lineSizes } from '../docs/lib/planner.js';
import { playersFromCsv } from '../docs/lib/csv.js';

const LV = ['Grön', 'Orange', 'Lila'];
const mk = (n, goalies = []) => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `Spelare ${i}`, level: LV[i % 3], canGoalie: goalies.includes(i), active: true }));
const uppdrag = [
  { key: 'A', date: '2026-11-28' }, { key: 'B', date: '2026-11-28' }, { key: 'C', date: '2026-11-28' }, { key: 'D', date: '2026-11-29' },
];
const S = { skaters: 7, goalies: 1, lineSize: 4, maxPerPlayer: 1 };

test('fyller lagen, en målvakt per lag, ingen spelare två gånger', () => {
  const players = mk(40, [0, 5, 10, 15, 20]);
  const r = propose({ uppdrag, players, availability: {}, locks: [], settings: S, levels: LV, history: [], seed: 7 });
  const all = [];
  for (const u of uppdrag) {
    const t = r.teams[u.key];
    assert.equal(t.goalies.length, 1);
    assert.ok(players.find((p) => p.id === t.goalies[0]).canGoalie);
    assert.equal(t.lines.flat().length, 7);
    assert.deepEqual(t.lines.map((l) => l.length).sort(), [3, 4]);
    all.push(...t.goalies, ...t.lines.flat());
  }
  assert.equal(new Set(all).size, all.length);
});

test('nivågrupperna sprids jämnt', () => {
  const players = mk(36, [0, 1, 2, 3]);
  const r = propose({ uppdrag: uppdrag.slice(0, 3), players, availability: {}, locks: [], settings: { ...S, skaters: 8 }, levels: LV, history: [], seed: 3 });
  const byId = new Map(players.map((p) => [p.id, p]));
  for (const lvl of LV) {
    const counts = ['A', 'B', 'C'].map((k) => r.teams[k].lines.flat().filter((id) => byId.get(id).level === lvl).length);
    assert.ok(Math.max(...counts) - Math.min(...counts) <= 1, `${lvl}: ${counts}`);
  }
});

test('kedjor grupperar liknande nivå', () => {
  const players = mk(30, [0, 1, 2]);
  const r = propose({ uppdrag: [{ key: 'A', date: 'd' }], players, availability: {}, locks: [], settings: { ...S, skaters: 8 }, levels: LV, history: [], seed: 1 });
  const byId = new Map(players.map((p) => [p.id, p]));
  for (const line of r.teams.A.lines) {
    const ranks = line.map((id) => LV.indexOf(byId.get(id).level));
    assert.ok(Math.max(...ranks) - Math.min(...ranks) <= 1);
  }
});

test('respekterar tillgänglighet, lås och tidskrockar', () => {
  const players = mk(20, [0, 1, 2, 3]);
  const availability = { A: { p4: false, p0: false } };
  const locks = [{ pid: 'p4', key: 'B', role: 'S' }, { pid: 'p1', key: 'A', role: 'G' }];
  const r = propose({ uppdrag: uppdrag.slice(0, 2), players, availability, locks, settings: { ...S, maxPerPlayer: 3 }, levels: LV, history: [], seed: 2 });
  assert.ok(!r.teams.A.lines.flat().includes('p4'));
  assert.ok(r.teams.B.lines.flat().includes('p4'));
  assert.deepEqual(r.teams.A.goalies, ['p1']);
  // A och B samma dag: ingen spelare i båda, trots max 3
  const a = new Set([...r.teams.A.goalies, ...r.teams.A.lines.flat()]);
  for (const id of [...r.teams.B.goalies, ...r.teams.B.lines.flat()]) assert.ok(!a.has(id));
});

test('flera dagar: samma spelare får spela båda dagarna om max tillåter', () => {
  const players = mk(9, [0]);
  const r = propose({ uppdrag: [{ key: 'A', date: 'lör' }, { key: 'D', date: 'sön' }], players, availability: {}, locks: [], settings: { ...S, skaters: 7, maxPerPlayer: 2 }, levels: LV, history: [], seed: 2 });
  assert.equal(r.teams.A.goalies[0], 'p0');
  assert.equal(r.teams.D.goalies[0], 'p0');
  assert.equal(r.teams.D.lines.flat().length, 7);
});

test('saknad målvakt syns i kontrollen', () => {
  const players = mk(16, [0]);
  const keys = ['A', 'B'];
  const r = propose({ uppdrag: uppdrag.slice(0, 2), players, availability: {}, locks: [], settings: S, levels: LV, history: [], seed: 4 });
  const round = { keys, settings: S, teams: Object.fromEntries(keys.map((k) => [k, { ...r.teams[k], review: [] }])) };
  const map = { A: { date: '2026-11-28', matches: [] }, B: { date: '2026-11-28', matches: [] } };
  const v = validate({ round, uppdragMap: map, players, availability: {}, levels: LV });
  const all = [...v.perTeam.A, ...v.perTeam.B].map((x) => x.text);
  assert.ok(all.includes('Målvakt saknas.'));
});

test('kontrollen hittar dubbelbokning samma dag och ej tillgänglig spelare', () => {
  const players = mk(4, [0]);
  const round = { keys: ['A', 'B'], settings: { ...S, skaters: 1 }, teams: { A: { goalies: ['p0'], lines: [['p1']], review: [] }, B: { goalies: ['p0'], lines: [['p2']], review: [] } } };
  const map = { A: { date: 'x', matches: [] }, B: { date: 'x', matches: [] } };
  const v = validate({ round, uppdragMap: map, players, availability: { B: { p2: false } }, levels: LV });
  assert.ok(v.perTeam.A.some((x) => x.text.includes('samma dag')));
  assert.ok(v.perTeam.B.some((x) => x.text.includes('kan inte')));
});

test('historiken varierar kedjorna', () => {
  const players = mk(8, []).map((p) => ({ ...p, level: 'Grön' }));
  const history = [{ teams: [{ goalies: [], lines: [['p0', 'p1', 'p2', 'p3'], ['p4', 'p5', 'p6', 'p7']] }] }];
  const r = propose({ uppdrag: [{ key: 'A', date: 'd' }], players, availability: {}, locks: [], settings: { ...S, goalies: 0, skaters: 8 }, levels: LV, history, seed: 9 });
  for (const line of r.teams.A.lines) {
    const fromFirst = line.filter((id) => ['p0', 'p1', 'p2', 'p3'].includes(id)).length;
    assert.equal(fromFirst, 2, 'kedjorna ska blandas');
  }
});

test('laglistan innehåller bara lagnamn och spelarnamn', () => {
  const players = mk(4, [0]);
  const txt = rosterText('Järfälla HC U9 blå', { goalies: ['p0'], lines: [['p1', 'p2'], ['p3']] }, players);
  assert.equal(txt, 'Järfälla HC U9 blå\n\nMålvakt\nSpelare 0\n\nUtespelare\nSpelare 1\nSpelare 2\nSpelare 3');
  assert.ok(!/Grön|Orange|Lila|Kedja/.test(txt));
});

test('kedjestorlekar', () => {
  assert.deepEqual(lineSizes(7, 4), [4, 3]);
  assert.deepEqual(lineSizes(9, 4), [3, 3, 3]);
  assert.deepEqual(lineSizes(8, 4), [4, 4]);
});

test('CSV-import med rubriker, semikolon och fel', () => {
  const csv = '﻿Namn;Nivågrupp;Kan stå i mål\nAlva A;grön;ja\n"Bo, B";Orange;nej\nCleo C;Blå;ja\nDante D;Lila;kanske\n';
  const r = playersFromCsv(csv, LV);
  assert.deepEqual(r.players, [{ name: 'Alva A', level: 'Grön', canGoalie: true }, { name: 'Bo, B', level: 'Orange', canGoalie: false }]);
  assert.equal(r.errors.length, 2);
  const r2 = playersFromCsv('Alva,Grön,x\nBo,Lila,', LV);
  assert.equal(r2.players.length, 2);
  assert.equal(r2.players[0].canGoalie, true);
});
