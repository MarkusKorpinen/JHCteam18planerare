// Ändringar på en omgång. Körs i webbläsaren; databasen kontrollerar versionen när de sparas.
// En omgång: { id, name, status, version, keys, settings, teams: {key: {goalies, lines}}, locks, log, lastSeed }
// ctx: { uppdrag, players, availability, levels, history, teamPrefix, me }
import { propose, validate, rosterText, DEFAULT_ROUND_SETTINGS, isReserve } from './planner.js?v=20261108c';

const fail = (msg) => { throw new Error(msg); };
export const emptyTeam = () => ({ goalies: [], lines: [] });

export function sortKeys(keys, uppdrag) {
  return [...keys].sort((a, b) =>
    (uppdrag[a]?.date || '').localeCompare(uppdrag[b]?.date || '') || (uppdrag[a]?.label || '').localeCompare(uppdrag[b]?.label || ''));
}

export function newRound(name, keys, defaults, ctx) {
  const r = {
    name, status: 'utkast', keys: sortKeys(keys, ctx.uppdrag),
    settings: { ...DEFAULT_ROUND_SETTINGS, ...(defaults || {}) },
    teams: Object.fromEntries(keys.map((k) => [k, emptyTeam()])), locks: [], log: [],
  };
  ACTIONS.propose(r, {}, ctx);
  addLog(r, ctx.me, 'skapade omgången med ett första förslag');
  return r;
}

export function addLog(r, me, text) {
  r.log = [{ at: new Date().toISOString(), by: me?.name || '', text }, ...(r.log || [])].slice(0, 100);
}

function removeFrom(team, pid) {
  team.goalies = team.goalies.filter((x) => x !== pid);
  team.lines = team.lines.map((l) => l.filter((x) => x !== pid)).filter((l) => l.length);
}
const roleOf = (team, pid) => (team?.goalies.includes(pid) ? 'G' : team?.lines.some((l) => l.includes(pid)) ? 'S' : null);
const label = (ctx, k) => ctx.uppdrag[k]?.label || 'okänt lag';
const playerName = (ctx, id) => ctx.players.find((p) => p.id === id)?.name || fail('Okänd spelare.');

export const ACTIONS = {
  propose(r, b, ctx) {
    const seed = Number.isInteger(b.seed) ? b.seed : (Date.now() ^ Math.floor(Math.random() * 1e9)) >>> 0;
    const res = propose({
      uppdrag: r.keys.map((k) => ({ key: k, date: ctx.uppdrag[k]?.date || k, venue: ctx.uppdrag[k]?.venue })),
      players: ctx.players, availability: ctx.availability, locks: r.locks, settings: r.settings,
      coaches: ctx.coaches || [], coachAvailability: ctx.coachAvailability || {}, coachLocks: r.coachLocks || [],
      levels: ctx.levels, history: (ctx.history || []).filter((h) => h.roundId !== r.id), seed,
    });
    for (const k of r.keys) r.teams[k] = { ...(r.teams[k] || {}), goalies: res.teams[k].goalies, lines: res.teams[k].lines, coaches: res.teams[k].coaches };
    r.lastSeed = seed;
    return 'skapade ett nytt förslag';
  },
  move(r, b, ctx) {
    const name = playerName(ctx, b.pid);
    if (b.fromKey) removeFrom(r.teams[b.fromKey] || fail('Okänt lag.'), b.pid);
    const lock = r.locks.find((l) => l.pid === b.pid && l.key === b.fromKey);
    if (b.toKey) {
      if (!r.keys.includes(b.toKey)) fail('Okänt lag.');
      const t = (r.teams[b.toKey] ||= emptyTeam());
      removeFrom(t, b.pid);
      if (b.role === 'G') t.goalies.push(b.pid);
      else if (Number.isInteger(b.line) && b.line >= 0 && b.line < t.lines.length) t.lines[b.line].push(b.pid);
      else t.lines.push([b.pid]);
      if (lock) { lock.key = b.toKey; lock.role = b.role === 'G' ? 'G' : 'S'; }
      // Reserver föreslås aldrig automatiskt, så en manuellt tillagd reserv låses för att ligga kvar vid nytt förslag.
      const wantLock = b.lock || isReserve(ctx.players.find((p) => p.id === b.pid));
      if (wantLock) { r.locks = r.locks.filter((l) => !(l.pid === b.pid && l.key === b.toKey)); r.locks.push({ pid: b.pid, key: b.toKey, role: b.role === 'G' ? 'G' : 'S' }); }
      r.locks = r.locks.filter((l, i, a) => a.findIndex((x) => x.pid === l.pid && x.key === l.key) === i);
    } else if (lock) r.locks = r.locks.filter((l) => l !== lock);
    return `flyttade ${name} till ${b.toKey ? `${label(ctx, b.toKey)} (${b.role === 'G' ? 'målvakt' : 'utespelare'})` : 'ej uttagna'}`;
  },
  // Lägger till en redan uttagen spelare i ytterligare ett lag (bara manuellt). Båda placeringarna låses.
  addExtra(r, b, ctx) {
    const name = playerName(ctx, b.pid);
    if (!r.keys.includes(b.toKey)) fail('Okänt lag.');
    const t = (r.teams[b.toKey] ||= emptyTeam());
    if (t.goalies.includes(b.pid) || t.lines.some((l) => l.includes(b.pid))) fail(`${name} är redan med i laget.`);
    for (const k of r.keys) {
      const role = roleOf(r.teams[k], b.pid);
      if (role && !r.locks.some((l) => l.pid === b.pid && l.key === k)) r.locks.push({ pid: b.pid, key: k, role });
    }
    if (b.role === 'G') t.goalies.push(b.pid);
    else if (Number.isInteger(b.line) && b.line >= 0 && b.line < t.lines.length) t.lines[b.line].push(b.pid);
    else t.lines.push([b.pid]);
    r.locks.push({ pid: b.pid, key: b.toKey, role: b.role === 'G' ? 'G' : 'S' });
    return `lade till ${name} även i ${label(ctx, b.toKey)} (${b.role === 'G' ? 'målvakt' : 'utespelare'})`;
  },
  // Byter ut en spelare som inte kan mot en ersättare på samma plats (målvakt eller samma kedja)
  replace(r, b, ctx) {
    const outName = playerName(ctx, b.outPid), inName = playerName(ctx, b.inPid);
    const t = r.teams[b.key] || fail('Okänt lag.');
    if (t.goalies.includes(b.inPid) || t.lines.some((l) => l.includes(b.inPid))) fail(`${inName} är redan med i laget.`);
    let role = null;
    const gi = t.goalies.indexOf(b.outPid);
    if (gi >= 0) { t.goalies[gi] = b.inPid; role = 'G'; }
    else for (const l of t.lines) { const i = l.indexOf(b.outPid); if (i >= 0) { l[i] = b.inPid; role = 'S'; break; } }
    if (!role) fail(`${outName} är inte med i laget.`);
    r.locks = r.locks.filter((l) => !(l.pid === b.outPid && l.key === b.key));
    r.locks.push({ pid: b.inPid, key: b.key, role });
    return `kallade in ${inName} i stället för ${outName} i ${label(ctx, b.key)}`;
  },
  lock(r, b, ctx) {
    const name = playerName(ctx, b.pid);
    r.locks = r.locks.filter((l) => !(l.pid === b.pid && l.key === b.key));
    if (b.locked) r.locks.push({ pid: b.pid, key: b.key, role: roleOf(r.teams[b.key], b.pid) || fail('Spelaren är inte placerad i laget.') });
    return `${b.locked ? 'låste' : 'låste upp'} ${name}`;
  },
  settings(r, b) {
    const s = {};
    for (const [k, min, max] of [['skaters', 1, 20], ['goalies', 0, 3], ['lineSize', 1, 10]]) {
      const v = Number(b.settings?.[k]);
      if (!Number.isInteger(v) || v < min || v > max) fail('Ogiltigt värde i inställningarna.');
      s[k] = v;
    }
    r.settings = { ...r.settings, ...s, maxPerPlayer: 1 };
    return `ändrade inställningarna till ${s.skaters} utespelare, ${s.goalies} målvakt, kedja ${s.lineSize}`;
  },
  setKeys(r, b, ctx) {
    const keys = [...new Set(b.keys || [])];
    if (!keys.length) fail('Välj minst ett poolspel.');
    for (const k of keys) r.teams[k] ||= emptyTeam();
    for (const k of r.keys) if (!keys.includes(k)) delete r.teams[k];
    r.locks = r.locks.filter((l) => keys.includes(l.key));
    r.coachLocks = (r.coachLocks || []).filter((l) => keys.includes(l.key));
    r.keys = sortKeys(keys, ctx.uppdrag);
    return 'ändrade vilka poolspel som ingår';
  },
  setCoaches(r, b, ctx) {
    const t = r.teams[b.key] || fail('Okänt lag.');
    const ids = [...new Set(b.ids || [])];
    t.coaches = ids;
    // Manuellt valda tränare låses så att de ligger kvar vid nytt förslag
    r.coachLocks = [...(r.coachLocks || []).filter((l) => l.key !== b.key), ...ids.map((cid) => ({ cid, key: b.key }))];
    const names = ids.map((id) => (ctx.coaches || []).find((c) => c.id === id)?.name).filter(Boolean);
    return `valde tränare för ${label(ctx, b.key)}: ${names.join(', ') || 'inga'}`;
  },
  rename(r, b) {
    const name = String(b.name || '').trim().slice(0, 80) || fail('Namnet är tomt.');
    r.name = name;
    return `döpte om omgången till ${name}`;
  },
  confirm(r) { r.status = 'fastställt'; return 'fastställde omgången'; },
  reopen(r) { r.status = 'utkast'; return 'öppnade omgången igen som utkast'; },
};
export const ALLOWED_WHEN_CONFIRMED = new Set(['reopen', 'rename']);

export const teamName = (ctx, key) => `${ctx.teamPrefix || ''} ${ctx.uppdrag[key]?.label || ''}`.trim();

// Ögonblicksbild till historiken när omgången fastställs
export function snapshot(r, ctx) {
  return {
    roundId: r.id, roundName: r.name,
    teams: r.keys.map((k) => ({ key: k, date: ctx.uppdrag[k]?.date, label: ctx.uppdrag[k]?.label, goalies: [...(r.teams[k]?.goalies || [])], lines: (r.teams[k]?.lines || []).map((l) => [...l]), coaches: [...(r.teams[k]?.coaches || [])] })),
  };
}

// Schemaändringar som ska granskas för ett lag i omgången
export function pendingReview(r, key, changes) {
  return (changes || []).filter((c) => c.uppdrag_key === key && !c.is_new && !c.ack_at && c.at > (r.createdAt || ''));
}

export function view(r, ctx) {
  const withReview = { ...r, teams: Object.fromEntries(r.keys.map((k) => [k, { ...(r.teams[k] || emptyTeam()), review: pendingReview(r, k, ctx.changes).map((c) => ({ at: c.at, items: c.items, ack: false })) }])) };
  const validation = validate({ round: withReview, uppdragMap: ctx.uppdrag, players: ctx.players, availability: ctx.availability, levels: ctx.levels, coaches: ctx.coaches || [], coachAvailability: ctx.coachAvailability || {}, history: ctx.history || [] });
  const copy = {};
  for (const k of r.keys) copy[k] = rosterText(teamName(ctx, k), r.teams[k], ctx.players);
  copy.all = r.keys.map((k) => copy[k]).join('\n\n\n');
  return { validation, copy };
}
