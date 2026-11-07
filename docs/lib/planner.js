// Lagförslag och kontroller. Ren logik utan I/O, så att den går att testa.
//
// Begrepp
//   uppdrag  = ett lags deltagande i ett poolspel (block + lag), t.ex. "U9 röd i Kallhälls Ishall 28/11".
//              Samma trupp gäller för alla lagets matcher i poolspelet.
//   omgång   = de uppdrag som ledaren valt att planera tillsammans.

export const RULES = [
  'Bara aktiva spelare som inte är markerade ”kan inte” för poolspelet tas ut.',
  'En spelare tas aldrig ut i två poolspel samma dag (tidskrock). Spelare kan inte heller tas ut fler gånger i omgången än inställningen ”Max poolspel per spelare”.',
  'Låsta placeringar läggs in först och flyttas aldrig av ett nytt förslag.',
  'Målvakter väljs bara bland spelare som kan stå i mål. Den som stått i mål minst antal gånger i fastställda lag går först.',
  'Utespelare fördelas så att varje nivågrupp blir så jämnt spridd som möjligt mellan lagen. Spelare med minst antal möjliga poolspel placeras först. Vid lika går den som spelat minst antal poolspel hittills före.',
  'Efter fördelningen provas byten mellan lagen så länge nivåfördelningen blir jämnare.',
  'Inom varje lag sorteras utespelarna efter nivå och delas i kedjor, så att spelare på liknande nivå spelar ihop.',
  'Bland likvärdiga kedjeindelningar väljs den där spelarna har spelat minst tillsammans i tidigare fastställda lag.',
  'Saknas spelare, till exempel en målvakt, lämnas platsen tom och lagkortet visar en varning.',
];

export const DEFAULT_ROUND_SETTINGS = { skaters: 7, goalies: 1, lineSize: 4, maxPerPlayer: 1 };

// ---------- hjälpfunktioner ----------
export function rng(seed) {
  let a = (seed >>> 0) || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

export function lineSizes(n, size) {
  if (n <= 0) return [];
  const k = Math.max(1, Math.ceil(n / Math.max(1, size)));
  const base = Math.floor(n / k), extra = n % k;
  return Array.from({ length: k }, (_, i) => base + (i < extra ? 1 : 0));
}

// Statistik ur fastställda lag
export function historyStats(history) {
  const pairs = new Map(), teamPairs = new Map(), apps = new Map(), goalieApps = new Map();
  const inc = (m, k, v = 1) => m.set(k, (m.get(k) || 0) + v);
  for (const h of history || []) {
    for (const t of h.teams || []) {
      for (const g of t.goalies || []) { inc(goalieApps, g); inc(apps, g); }
      const all = (t.lines || []).flat();
      for (const p of all) inc(apps, p);
      for (const line of t.lines || [])
        for (let i = 0; i < line.length; i++)
          for (let j = i + 1; j < line.length; j++) inc(pairs, pairKey(line[i], line[j]));
      for (let i = 0; i < all.length; i++)
        for (let j = i + 1; j < all.length; j++) inc(teamPairs, pairKey(all[i], all[j]));
    }
  }
  return { pairs, teamPairs, apps, goalieApps, pairCount: (a, b) => pairs.get(pairKey(a, b)) || 0, teamPairCount: (a, b) => teamPairs.get(pairKey(a, b)) || 0 };
}

const isAvailable = (availability, key, pid) => !(availability?.[key]?.[pid] === false);

// ---------- förslag ----------
/**
 * @param {object} o
 * @param {Array<{key,date}>} o.uppdrag
 * @param {Array<{id,name,level,canGoalie,active}>} o.players
 * @param {object} o.availability  {key: {pid: false}}
 * @param {Array<{pid,key,role}>} o.locks
 * @param {object} o.settings     {skaters, goalies, lineSize, maxPerPlayer}
 * @param {Array<string>} o.levels nivånamn i ordning
 * @param {Array} o.history
 * @param {number} o.seed
 */
export function propose(o) {
  const s = { ...DEFAULT_ROUND_SETTINGS, ...(o.settings || {}) };
  const rand = rng(o.seed ?? 1);
  const levels = o.levels || [];
  const rank = (p) => { const i = levels.indexOf(p.level); return i < 0 ? levels.length : i; };
  const stats = historyStats(o.history);
  const players = (o.players || []).filter((p) => p.active !== false);
  const byId = new Map(players.map((p) => [p.id, p]));
  const U = o.uppdrag.map((u) => ({ key: u.key, date: u.date, goalies: [], skaters: [] }));
  const uByKey = new Map(U.map((u) => [u.key, u]));
  const usedDates = new Map(); // pid -> Set(date)
  const usedCount = new Map();
  const locked = new Set();
  const notes = [];

  const place = (pid, u, role) => {
    (role === 'G' ? u.goalies : u.skaters).push(pid);
    if (!usedDates.has(pid)) usedDates.set(pid, new Set());
    usedDates.get(pid).add(u.date);
    usedCount.set(pid, (usedCount.get(pid) || 0) + 1);
  };
  const eligible = (pid, u) =>
    byId.has(pid) &&
    isAvailable(o.availability, u.key, pid) &&
    !(usedDates.get(pid)?.has(u.date)) &&
    (usedCount.get(pid) || 0) < s.maxPerPlayer &&
    !u.goalies.includes(pid) && !u.skaters.includes(pid);

  // 1. Låsta placeringar
  for (const l of o.locks || []) {
    const u = uByKey.get(l.key);
    if (!u || !byId.has(l.pid)) continue;
    place(l.pid, u, l.role === 'G' ? 'G' : 'S');
    locked.add(`${l.pid}@${l.key}`);
  }

  // 2. Målvakter: knappast tillgång först
  for (;;) {
    const needing = U.filter((u) => u.goalies.length < s.goalies);
    if (!needing.length) break;
    const cands = (u) => players.filter((p) => p.canGoalie && eligible(p.id, u));
    needing.sort((a, b) => cands(a).length - cands(b).length || a.key.localeCompare(b.key));
    const u = needing.find((x) => cands(x).length > 0);
    if (!u) break;
    const c = cands(u).map((p) => ({ p, r: rand() }));
    c.sort((a, b) =>
      (usedCount.get(a.p.id) || 0) - (usedCount.get(b.p.id) || 0) ||
      (stats.goalieApps.get(a.p.id) || 0) - (stats.goalieApps.get(b.p.id) || 0) ||
      a.r - b.r);
    place(c[0].p.id, u, 'G');
  }

  // 3. Utespelare
  const supplyIds = players.filter((p) => U.some((u) => eligible(p.id, u))).map((p) => p.id);
  const levelShare = {};
  for (const pid of supplyIds) { const l = byId.get(pid).level; levelShare[l] = (levelShare[l] || 0) + 1; }
  const supplyTotal = supplyIds.length || 1;
  const target = (lvl) => (s.skaters * (levelShare[lvl] || 0)) / supplyTotal;
  const levelCount = (u, lvl) => u.skaters.filter((id) => byId.get(id)?.level === lvl).length;
  const tieRand = new Map(players.map((p) => [p.id, rand()]));

  for (;;) {
    const open = U.filter((u) => u.skaters.length < s.skaters);
    if (!open.length) break;
    const options = new Map();
    for (const p of players) {
      const opts = open.filter((u) => eligible(p.id, u));
      if (opts.length) options.set(p.id, opts);
    }
    if (!options.size) break;
    const order = [...options.keys()].sort((a, b) =>
      (usedCount.get(a) || 0) - (usedCount.get(b) || 0) ||
      options.get(a).length - options.get(b).length ||
      (stats.apps.get(a) || 0) - (stats.apps.get(b) || 0) ||
      tieRand.get(a) - tieRand.get(b));
    const pid = order[0];
    const p = byId.get(pid);
    let best = null, bestCost = Infinity;
    for (const u of options.get(pid)) {
      const over = levelCount(u, p.level) + 1 - target(p.level);
      const fill = u.skaters.length / s.skaters;
      const pairs = u.skaters.reduce((acc, q) => acc + stats.teamPairCount(pid, q), 0);
      const cost = over * 10 + fill * 4 + pairs * 0.5 + rand() * 0.01;
      if (cost < bestCost) { bestCost = cost; best = u; }
    }
    place(pid, best, 'S');
  }

  // 4. Byten som jämnar ut nivåerna
  const imbalance = () => {
    let sum = 0;
    for (const u of U) for (const lvl of Object.keys(levelShare)) {
      const d = levelCount(u, lvl) - (u.skaters.length * (levelShare[lvl] || 0)) / supplyTotal;
      sum += d * d;
    }
    return sum;
  };
  const canSwapInto = (pid, from, to) => {
    if (!isAvailable(o.availability, to.key, pid)) return false;
    if (to.goalies.includes(pid) || to.skaters.includes(pid)) return false;
    if (from.date === to.date) return true;
    return !(usedDates.get(pid)?.has(to.date));
  };
  const moveDate = (pid, from, to) => { const d = usedDates.get(pid); d.delete(from.date); d.add(to.date); };
  let improved = true, guard = 0;
  while (improved && guard++ < 200) {
    improved = false;
    const base = imbalance();
    outer: for (const a of U) for (const b of U) {
      if (a === b) continue;
      for (const pa of a.skaters) for (const pb of b.skaters) {
        if (locked.has(`${pa}@${a.key}`) || locked.has(`${pb}@${b.key}`)) continue;
        if (byId.get(pa).level === byId.get(pb).level) continue;
        if (!canSwapInto(pa, a, b) || !canSwapInto(pb, b, a)) continue;
        a.skaters[a.skaters.indexOf(pa)] = pb; b.skaters[b.skaters.indexOf(pb)] = pa;
        if (imbalance() < base - 1e-9) { moveDate(pa, a, b); moveDate(pb, b, a); improved = true; break outer; }
        a.skaters[a.skaters.indexOf(pb)] = pa; b.skaters[b.skaters.indexOf(pa)] = pb;
      }
    }
  }

  // 5. Kedjor
  const teams = {};
  for (const u of U) {
    teams[u.key] = { goalies: u.goalies, lines: buildLines(u.skaters, s.lineSize, byId, rank, stats, rand) };
  }
  const unplaced = players
    .filter((p) => !usedCount.get(p.id) && o.uppdrag.some((u) => isAvailable(o.availability, u.key, p.id)))
    .map((p) => p.id);
  return { teams, unplaced, notes };
}

export function buildLines(skaters, lineSize, byId, rank, stats, rand) {
  const sizes = lineSizes(skaters.length, lineSize);
  if (!sizes.length) return [];
  let best = null, bestCost = Infinity;
  for (let iter = 0; iter < 300; iter++) {
    const order = skaters
      .map((id) => ({ id, r: rank(byId.get(id) || {}), x: rand() }))
      .sort((a, b) => a.r - b.r || a.x - b.x);
    const sz = iter % 2 ? [...sizes].reverse() : sizes;
    const lines = []; let i = 0;
    for (const n of sz) { lines.push(order.slice(i, i + n)); i += n; }
    let cost = 0;
    for (const line of lines) {
      const rs = line.map((x) => x.r);
      cost += (Math.max(...rs) - Math.min(...rs)) * 100;
      for (let a = 0; a < line.length; a++)
        for (let b = a + 1; b < line.length; b++) cost += stats.pairCount(line[a].id, line[b].id) * 10;
    }
    if (cost < bestCost) { bestCost = cost; best = lines.map((l) => l.map((x) => x.id)); }
  }
  return best;
}

// ---------- kontroller ----------
export function validate({ round, uppdragMap, players, availability, levels }) {
  const s = { ...DEFAULT_ROUND_SETTINGS, ...(round.settings || {}) };
  const byId = new Map(players.map((p) => [p.id, p]));
  const name = (id) => byId.get(id)?.name || 'Okänd spelare';
  const perTeam = {};
  const global = [];
  const placements = new Map(); // pid -> [{key,date}]
  for (const key of round.keys) {
    const t = round.teams?.[key] || { goalies: [], lines: [] };
    const u = uppdragMap[key];
    const w = [];
    const skaters = (t.lines || []).flat();
    if (!u) w.push({ level: 'error', text: 'Poolspelet finns inte längre i schemat.' });
    else if (u.missing) w.push({ level: 'error', text: 'Poolspelet saknas i källan. Kontrollera med arrangören innan ni skickar laglistan.' });
    else if (u.matches?.some((m) => m.missing)) w.push({ level: 'warn', text: 'En eller flera matcher saknas i källan.' });
    if ((t.goalies || []).length < s.goalies)
      w.push({ level: 'error', text: s.goalies - (t.goalies || []).length === 1 ? 'Målvakt saknas.' : `${s.goalies - t.goalies.length} målvakter saknas.` });
    if (skaters.length < s.skaters) w.push({ level: 'error', text: `${s.skaters - skaters.length} utespelare saknas (${skaters.length} av ${s.skaters}).` });
    if (skaters.length > s.skaters) w.push({ level: 'info', text: `${skaters.length - s.skaters} fler utespelare än önskat.` });
    for (const g of t.goalies || []) if (byId.has(g) && !byId.get(g).canGoalie) w.push({ level: 'warn', text: `${name(g)} är inte markerad som målvakt.` });
    for (const pid of [...(t.goalies || []), ...skaters]) {
      const p = byId.get(pid);
      if (!p) { w.push({ level: 'warn', text: 'En spelare finns inte längre i spelarlistan.' }); continue; }
      if (p.active === false) w.push({ level: 'warn', text: `${p.name} är arkiverad.` });
      if (!isAvailable(availability, key, pid)) w.push({ level: 'error', text: `${p.name} kan inte detta poolspel.` });
      if (!placements.has(pid)) placements.set(pid, []);
      placements.get(pid).push({ key, date: u?.date });
    }
    for (const r of t.review || []) if (!r.ack) w.push({ level: 'review', text: `Schemat har ändrats: ${r.items.join('; ')}` });
    perTeam[key] = w;
  }
  for (const [pid, list] of placements) {
    const dates = new Map();
    for (const pl of list) { if (!dates.has(pl.date)) dates.set(pl.date, []); dates.get(pl.date).push(pl.key); }
    for (const [, keys] of dates) if (keys.length > 1) for (const k of keys)
      perTeam[k].push({ level: 'error', text: `${name(pid)} är uttagen i ${keys.length} poolspel samma dag.` });
    if (list.length > s.maxPerPlayer) global.push({ level: 'warn', text: `${name(pid)} är uttagen ${list.length} gånger (max ${s.maxPerPlayer}).` });
  }
  const unplaced = players.filter((p) => p.active !== false && !placements.has(p.id) && round.keys.some((k) => isAvailable(availability, k, p.id)));
  const levelDist = {};
  for (const key of round.keys) {
    const sk = (round.teams?.[key]?.lines || []).flat();
    levelDist[key] = Object.fromEntries((levels || []).map((l) => [l, sk.filter((id) => byId.get(id)?.level === l).length]));
  }
  return { perTeam, global, unplaced: unplaced.map((p) => p.id), levelDist };
}

// Laglista att dela: bara lagnamn och spelarnamn
export function rosterText(teamName, team, players) {
  const byId = new Map(players.map((p) => [p.id, p]));
  const n = (id) => byId.get(id)?.name || '';
  const g = (team?.goalies || []).map(n).filter(Boolean);
  const sk = (team?.lines || []).flat().map(n).filter(Boolean);
  return [teamName, '', 'Målvakt', ...g, '', 'Utespelare', ...sk].join('\n');
}
