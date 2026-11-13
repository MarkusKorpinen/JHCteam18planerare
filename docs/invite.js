// Matchinbjudan för hemmapoolspel: planer, tröjfärger och hallinformation.
export const CLUB = 'Järfälla HC';
export const ARENAS = {
  jarfalla: { id: 'jarfalla', name: 'Järfälla Ishall', address: 'Mjölnarvägen 1, 177 41 Järfälla', standsTop: true },
  kallhall: { id: 'kallhall', name: 'Kallhälls Ishall', address: 'Källtorpsvägen 60, 176 74 Järfälla', standsTop: false },
};
export const DEFAULT_TEXTS = {
  rooms: {
    kallhall: 'Kallhälls Ishall har ett fåtal omklädningsrum. De öppnar tidigast en timme före ert lags första match, och flera lag kommer troligen att behöva dela rum. Järfälla HC:s matchvärd möter er på plats och visar er till rätt rum.',
    jarfalla: '',
  },
  important: {
    kallhall: 'Föräldrar får inte vara i omklädningsrumskorridoren eller i omklädningsrummen – det finns helt enkelt inte plats.',
    jarfalla: '',
  },
  parking: {
    kallhall: 'Fri parkering utanför Kallhälls Ishall.',
    jarfalla: 'Fri parkering mot P-skiva (4 timmar) utanför Järfälla Ishall.',
  },
  kiosk: 'Kiosk finns i ishallen.',
};
export const arenaFor = (venue) => (/kallh/i.test(venue || '') ? 'kallhall' : 'jarfalla');

const SUFFIX = /\s+(vit|röd|blå|svart|gul|grön|orange|lila|rosa|grå)$/i;
export const clubOf = (team) => String(team || '').replace(SUFFIX, '').trim();
export const isOurs = (team) => String(team || '').startsWith(CLUB);

// Färger: swehockey anger dem på engelska
const COLORS = {
  black: ['Svart', '#111111'], white: ['Vit', '#ffffff'], red: ['Röd', '#d7263d'], blue: ['Blå', '#1f5fbf'],
  green: ['Grön', '#1f8a4c'], yellow: ['Gul', '#f2c200'], orange: ['Orange', '#ef7d16'], purple: ['Lila', '#7a3fc4'],
  grey: ['Grå', '#8a8f98'], navy: ['Marinblå', '#14284b'], maroon: ['Vinröd', '#7a1427'], pink: ['Rosa', '#ec6ea3'],
  gold: ['Guld', '#c9a227'], silver: ['Silver', '#c0c4ca'], lightblue: ['Ljusblå', '#79b8ef'], brown: ['Brun', '#7b4a24'],
};
const ALIAS = {
  svart: 'black', vit: 'white', röd: 'red', blå: 'blue', grön: 'green', gul: 'yellow', lila: 'purple', grå: 'grey', gray: 'grey',
  marinblå: 'navy', 'dark blue': 'navy', mörkblå: 'navy', vinröd: 'maroon', rosa: 'pink', guld: 'gold', 'light blue': 'lightblue', ljusblå: 'lightblue', turquoise: 'lightblue', brun: 'brown',
};
export function colorKey(c) {
  if (!c) return null;
  const s = String(c).trim().toLowerCase().split(/[\/,]| och | and /)[0].trim();
  return COLORS[s] ? s : ALIAS[s] || s;
}
export const colorLabel = (c) => COLORS[colorKey(c)]?.[0] || (c ? String(c) : 'Okänd');
export const colorHex = (c) => COLORS[colorKey(c)]?.[1] || '#cccccc';
const GROUP = { navy: 'black', maroon: 'red' };
export function clash(a, b) {
  const x = colorKey(a), y = colorKey(b);
  if (!x || !y) return false;
  return (GROUP[x] || x) === (GROUP[y] || y);
}

// Tröjfärger per lag; saknas laget används en annan av föreningens lag (färgerna är samma i hela föreningen)
export function resolveColors(teams, teamColors = {}) {
  const out = {};
  for (const t of teams) {
    if (teamColors[t]?.home) { out[t] = { ...teamColors[t], from: t }; continue; }
    const sib = Object.keys(teamColors).find((x) => clubOf(x) === clubOf(t) && teamColors[x]?.home);
    if (sib) out[t] = { ...teamColors[sib], from: sib };
  }
  return out;
}

// Bygger matchlistan med id och planer
export function buildMatches(event, data = {}) {
  const list = [];
  (event?.data?.blocks || []).forEach((b, bi) => b.matches.forEach((m, mi) => {
    if (m.status === 'inställd') return;
    list.push({ id: `${b.block}#${mi}`, block: b.block, blockIndex: bi, order: mi, start: m.start || '', home: m.home, away: m.away });
  }));
  for (const m of data.extraMatches || []) list.push({ ...m, blockIndex: 99 });
  list.sort((a, b) => a.start.localeCompare(b.start) || a.blockIndex - b.blockIndex || a.order - b.order);
  // Plan: matcher som börjar samtidigt får plan 1, 2, 3, 4; första poolen vänster halva
  const bySlot = new Map();
  for (const m of list) { if (!bySlot.has(m.start)) bySlot.set(m.start, []); bySlot.get(m.start).push(m); }
  for (const [, ms] of bySlot) ms.forEach((m, i) => { m.autoPlan = (i % 4) + 1; });
  for (const m of list) m.plan = Number(data.plans?.[m.id]) || m.autoPlan;
  return list;
}

/**
 * Väljer tröja per lag och match. Så få lag som möjligt byter till bortaställ; måste någon byta
 * väljs Järfälla HC:s lag först. Helst samma tröja hela dagen.
 * @returns {{kits: Object<matchId, {home:'home'|'away', away:'home'|'away'}>, teams: Object<team, {...}>, warnings: string[]}}
 */
export function assignJerseys(matches, colors, forced = {}) {
  const teams = [...new Set(matches.flatMap((m) => [m.home, m.away]))];
  const col = (t, kit) => colors[t]?.[kit] || null;
  const warnings = [];
  for (const t of teams) if (!colors[t]?.home) warnings.push(`Tröjfärg saknas för ${t}. Fyll i den under ”Ändra inbjudan” → Tröjor och logotyper.`);
  const fixedAway = new Set(teams.filter((t) => forced[t] === 'away'));
  const fixedHome = new Set(teams.filter((t) => forced[t] === 'home'));
  const free = teams.filter((t) => !fixedAway.has(t) && !fixedHome.has(t));
  let best = null;
  const tryS = (S) => {
    // 1) alla i S i bortaställ hela dagen
    const dayKit = (t) => (S.has(t) ? 'away' : 'home');
    let fixedOk = true;
    for (const m of matches) if (clash(col(m.home, dayKit(m.home)), col(m.away, dayKit(m.away)))) { fixedOk = false; break; }
    if (fixedOk) {
      const kits = Object.fromEntries(matches.map((m) => [m.id, { home: dayKit(m.home), away: dayKit(m.away) }]));
      return { kits, mixed: 0 };
    }
    // 2) byt bara i de matcher där det krockar
    const kits = {};
    for (const m of matches) {
      const opts = [];
      for (const kh of S.has(m.home) && !fixedAway.has(m.home) ? ['home', 'away'] : [fixedAway.has(m.home) ? 'away' : 'home'])
        for (const ka of S.has(m.away) && !fixedAway.has(m.away) ? ['home', 'away'] : [fixedAway.has(m.away) ? 'away' : 'home'])
          if (!clash(col(m.home, kh), col(m.away, ka))) opts.push({ home: kh, away: ka });
      if (!opts.length) return null;
      const score = (o) => (o.home === 'away' ? (isOurs(m.home) ? 1 : 3) : 0) + (o.away === 'away' ? (isOurs(m.away) ? 1 : 3) : 0);
      opts.sort((a, b) => score(a) - score(b));
      kits[m.id] = opts[0];
    }
    let mixed = 0;
    for (const t of S) {
      const used = new Set(matches.filter((m) => m.home === t || m.away === t).map((m) => (m.home === t ? kits[m.id].home : kits[m.id].away)));
      if (used.size > 1) mixed++;
    }
    return { kits, mixed };
  };
  const limit = free.length <= 14 ? 1 << free.length : 0;
  for (let mask = 0; mask < limit; mask++) {
    const S = new Set(fixedAway);
    let size = 0, nonOurs = 0;
    for (let i = 0; i < free.length; i++) if (mask & (1 << i)) { S.add(free[i]); size++; if (!isOurs(free[i])) nonOurs++; }
    if (best && size * 1000 > best.cost) continue;
    const r = tryS(S);
    if (!r) continue;
    const used = new Set();
    for (const m of matches) { if (r.kits[m.id].home === 'away') used.add(m.home); if (r.kits[m.id].away === 'away') used.add(m.away); }
    const changed = [...used].filter((t) => !fixedAway.has(t));
    const cost = changed.length * 1000 + changed.filter((t) => !isOurs(t)).length * 10 + r.mixed;
    if (!best || cost < best.cost) best = { cost, kits: r.kits };
  }
  if (!best) {
    // Går inte att undvika krock (t.ex. samma hemma- och bortafärg): Järfälla byter, och varning
    const kits = {};
    for (const m of matches) {
      const k = { home: forced[m.home] || 'home', away: forced[m.away] || 'home' };
      if (clash(col(m.home, k.home), col(m.away, k.away))) {
        if (isOurs(m.home) || !isOurs(m.away)) k.home = k.home === 'home' ? 'away' : 'home'; else k.away = k.away === 'home' ? 'away' : 'home';
        if (clash(col(m.home, k.home), col(m.away, k.away))) warnings.push(`${m.home} och ${m.away} har samma tröjfärger. Kontakta lagen.`);
      }
      kits[m.id] = k;
    }
    best = { kits };
  }
  const summary = {};
  for (const t of teams) {
    const games = matches.filter((m) => m.home === t || m.away === t);
    const used = games.map((m) => (m.home === t ? best.kits[m.id].home : best.kits[m.id].away));
    const kinds = [...new Set(used)];
    summary[t] = {
      team: t, home: col(t, 'home'), away: col(t, 'away'),
      allDay: kinds.length === 1 ? kinds[0] : null,
      perMatch: games.map((m, i) => ({ id: m.id, kit: used[i], color: col(t, used[i]) })),
      changes: used.some((k) => k === 'away'),
    };
  }
  return { kits: best.kits, teams: summary, warnings };
}

// Rinkbild: fyra planer, logga i mittcirkeln. Läktare/bås ritas enligt hallen.
export function rinkSvg({ standsTop = true, logo = 'logo.png', highlight = [] } = {}) {
  const top = standsTop ? 'LÄKTARE' : 'BÅS', bottom = standsTop ? 'BÅS' : 'LÄKTARE';
  const plan = (n, x, y) => `<g><rect x="${x - 62}" y="${y - 17}" width="124" height="34" rx="6" fill="${highlight.includes(n) ? '#d6194b' : '#14284b'}"/><text x="${x}" y="${y + 6}" text-anchor="middle" font-size="17" font-weight="800" fill="#fff" font-family="Inter,Arial,sans-serif">PLAN ${n}</text></g>`;
  const pill = (label, y) => `<g><rect x="300" y="${y - 18}" width="200" height="36" rx="10" fill="#14284b"/><text x="400" y="${y + 6}" text-anchor="middle" font-size="16" font-weight="800" fill="#fff" letter-spacing="1" font-family="Inter,Arial,sans-serif">${label}</text></g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 420" role="img" aria-label="Planindelning: fyra planer, ${top.toLowerCase()} överst och ${bottom.toLowerCase()} nederst">
  <rect x="20" y="40" width="760" height="340" rx="120" fill="#f7fafc" stroke="#14284b" stroke-width="6"/>
  <line x1="400" y1="43" x2="400" y2="377" stroke="#d7263d" stroke-width="6"/>
  <line x1="270" y1="43" x2="270" y2="377" stroke="#1f5fbf" stroke-width="7"/>
  <line x1="530" y1="43" x2="530" y2="377" stroke="#1f5fbf" stroke-width="7"/>
  <line x1="68" y1="210" x2="392" y2="210" stroke="#14284b" stroke-width="3" stroke-dasharray="10 8"/>
  <line x1="408" y1="210" x2="732" y2="210" stroke="#14284b" stroke-width="3" stroke-dasharray="10 8"/>
  <line x1="62" y1="80" x2="62" y2="340" stroke="#d7263d" stroke-width="3"/>
  <line x1="738" y1="80" x2="738" y2="340" stroke="#d7263d" stroke-width="3"/>
  <circle cx="400" cy="210" r="62" fill="#fff" stroke="#d7263d" stroke-width="4"/>
  <image href="${logo}" x="348" y="158" width="104" height="104" preserveAspectRatio="xMidYMid meet"/>
  ${plan(2, 165, 125)}${plan(1, 165, 295)}${plan(3, 635, 125)}${plan(4, 635, 295)}
  ${pill(top, 22)}${pill(bottom, 398)}
</svg>`;
}
