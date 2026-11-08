// Läser den publika matchdatan (JHCmatcher, docs/data/schedule.json) och gör om den till
// "uppdrag" = ett Järfälla-lags deltagande i ett poolspel. Används både i webbläsaren och i GitHub Action.
export const DEFAULT_SOURCE = 'https://markuskorpinen.github.io/JHCmatcher/data/schedule.json';

export async function fetchSource(source = DEFAULT_SOURCE, fetchImpl = fetch) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30000);
  let res;
  try { res = await fetchImpl(source + (source.includes('?') ? '&' : '?') + 't=' + Date.now(), { signal: ctrl.signal, cache: 'no-store' }); }
  catch (e) { throw new Error(e.name === 'AbortError' ? 'Källan svarade inte inom 30 sekunder.' : 'Kunde inte nå matchkällan.'); }
  finally { clearTimeout(t); }
  if (!res.ok) throw new Error(`Matchkällan svarade ${res.status}.`);
  let data;
  try { data = await res.json(); } catch { throw new Error('Matchkällan gav inte giltig JSON.'); }
  if (!Array.isArray(data.matches) || !Array.isArray(data.teams)) throw new Error('Matchkällan har oväntat format.');
  return data;
}

const COLORS = ['blå', 'gul', 'röd', 'svart', 'vit', 'grön', 'orange', 'lila', 'rosa'];
const colorOf = (teamName) => teamName.toLowerCase().split(/\s+/).find((w) => COLORS.includes(w)) || '';

export function normalize(src, age = 'U9') {
  const teams = new Map(src.teams.filter((t) => t.age === age && !t.girls).map((t) => [t.id, t]));
  const uppdrag = {};
  for (const m of src.matches) {
    if (m.age !== age || m.girls) continue;
    for (const tid of m.teams || []) {
      if (!teams.has(tid)) continue;
      const key = `${m.block}|${tid}`;
      const t = teams.get(tid);
      if (!uppdrag[key]) {
        uppdrag[key] = {
          key, block: m.block, teamId: tid, label: t.label, teamName: t.name, color: colorOf(t.name),
          kind: m.block_kind, group: m.group, host: m.host || null, sourceUrl: m.source_url,
          date: m.date, venue: m.venue, matches: [], missing: false,
        };
      }
      uppdrag[key].matches.push({
        id: m.id, date: m.date, start: m.time_placeholder ? null : m.start, startFromAbove: !!m.time_from_row_above,
        home: m.home, away: m.away, venue: m.venue, status: m.status, missing: !!m.missing_since,
      });
    }
  }
  for (const u of Object.values(uppdrag)) {
    u.matches.sort((a, b) => (a.start || '99').localeCompare(b.start || '99'));
    const live = u.matches.filter((m) => !m.missing);
    const pool = live.length ? live : u.matches;
    u.date = pool.map((m) => m.date).filter(Boolean).sort()[0] || u.date;
    const venues = {};
    for (const m of pool) venues[m.venue] = (venues[m.venue] || 0) + 1;
    u.venue = Object.entries(venues).sort((a, b) => b[1] - a[1])[0]?.[0] || u.venue;
    u.missing = live.length === 0;
  }
  return uppdrag;
}

// Returnerar {uppdrag (sammanslaget), changes: [{key, items[]}]}
export function diffUppdrag(prev, next, isBaseline) {
  const out = { ...next };
  const changes = [];
  if (isBaseline) return { uppdrag: out, changes };
  // Cuper har datumet i nyckeln. Försvinner en och dyker upp igen med samma lag och serie räknas den som flyttad.
  const groupOf = (u) => `${String(u.block).split('-')[0]}|${u.teamId}|${u.group || ''}`;
  const added = Object.values(next).filter((n) => !prev?.[n.key]);
  const movedTo = new Map();
  for (const [key, p] of Object.entries(prev || {})) {
    if (next[key] || p.missing) continue;
    const n = added.find((a) => groupOf(a) === groupOf(p) && ![...movedTo.values()].includes(a.key));
    if (n) movedTo.set(key, n.key);
  }
  const movedFrom = new Map([...movedTo].map(([a, b]) => [b, a]));
  for (const [key, p] of Object.entries(prev || {})) {
    const n = next[key];
    if (!n && movedTo.has(key)) {
      const m = next[movedTo.get(key)];
      const items = [`Poolspelet har flyttats ${p.date} → ${m.date}`];
      if (p.venue !== m.venue) items.push(`Ny hall ${p.venue} → ${m.venue}`);
      items.push(`Nya tider: ${m.matches.filter((x) => !x.missing).map((x) => x.start || 'ej satt').join(', ')}`);
      changes.push({ key, items, movedTo: m.key });
      out[key] = { ...p, missing: true, movedTo: m.key, matches: p.matches.map((x) => ({ ...x, missing: true })) };
      continue;
    }
    if (!n) {
      if (!p.missing) changes.push({ key, items: ['Poolspelet saknas i källan'] });
      out[key] = { ...p, missing: true, matches: p.matches.map((m) => ({ ...m, missing: true })) };
      continue;
    }
    const items = [];
    if (p.date !== n.date) items.push(`Poolspelet har flyttats ${p.date} → ${n.date}`);
    if (p.venue !== n.venue) items.push(`Ny hall ${p.venue} → ${n.venue}`);
    const nm = new Map(n.matches.map((m) => [m.id, m]));
    for (const m of p.matches) {
      const x = nm.get(m.id);
      const vs = `${m.home}–${m.away}`;
      if (!x || (x.missing && !m.missing)) { if (!m.missing) items.push(`Match saknas i källan: ${vs}`); continue; }
      if (x.missing) continue;
      if (m.missing && !x.missing) items.push(`Match tillbaka i källan: ${vs}`);
      if ((m.start || '') !== (x.start || '')) items.push(`Ny tid ${vs}: ${m.start || 'ej satt'} → ${x.start || 'ej satt'}`);
      if (m.venue !== x.venue && p.venue === n.venue) items.push(`Ny hall ${vs}: ${m.venue} → ${x.venue}`);
      if (m.date !== x.date && p.date === n.date) items.push(`Nytt datum ${vs}: ${m.date} → ${x.date}`);
      if (m.status !== x.status) items.push(`Status ${vs}: ${x.status}`);
    }
    const pm = new Set(p.matches.map((m) => m.id));
    for (const m of n.matches) if (!pm.has(m.id) && !m.missing) items.push(`Ny match ${m.home}–${m.away}${m.start ? ' ' + m.start : ''}`);
    if (p.missing && !n.missing) items.push('Poolspelet finns i källan igen');
    if (items.length) changes.push({ key, items });
  }
  for (const key of Object.keys(next)) if (!prev?.[key]) changes.push({ key, items: [movedFrom.has(key) ? `Flyttat hit från ${prev[movedFrom.get(key)].date}` : 'Nytt poolspel i källan'], isNew: true });
  return { uppdrag: out, changes };
}

// Hela synken: hämta, jämför med sparat schema och spara via backend.
// backend: { getSchedule() -> {uppdrag,last_success}, applySync(expected, uppdrag, changes, source, trigger), syncFailed(error, trigger) }
export async function runSync(backend, { source = DEFAULT_SOURCE, trigger = 'manual', fetchImpl } = {}) {
  const cur = await backend.getSchedule();
  try {
    const src = await fetchSource(source, fetchImpl);
    const next = normalize(src, 'U9');
    if (!Object.keys(next).length) throw new Error('Källan innehöll inga U9-matcher. Förra schemat behålls.');
    const { uppdrag, changes } = diffUppdrag(cur.uppdrag || {}, next, !cur.last_success);
    const rows = changes.map((c) => ({ key: c.key, items: c.items, isNew: !!c.isNew, label: uppdrag[c.key]?.label, date: uppdrag[c.key]?.date }));
    const info = { url: source, generatedAt: src.generated_at, lastSuccess: src.last_success, lastAttemptOk: src.last_attempt_ok, warnings: (src.warnings || []).slice(0, 10) };
    const res = await backend.applySync(cur.last_success || null, uppdrag, rows, info, trigger);
    return { ok: true, changes: res?.changes ?? rows.length, skipped: !!res?.skipped };
  } catch (e) {
    await backend.syncFailed(e.message, trigger).catch(() => {});
    return { ok: false, error: e.message };
  }
}
