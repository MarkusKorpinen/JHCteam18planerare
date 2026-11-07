// Egna poolspel och matcher (som inte finns på swehockey) görs om till samma form som de hämtade,
// så att lagplanering och matchinbjudan fungerar likadant.
// Ett eget poolspel: { id, date, venue, title, data: { ourTeams: ['Järfälla HC blå', ...], opponents: [...], matches: [{start, home, away, plan}] } }
export const OUR_COLORS = ['blå', 'gul', 'röd', 'svart', 'vit'];
export const customKey = (ev) => `custom:${ev.id}`;

export function customToUppdrag(ev, age = 'U9') {
  const out = {};
  const block = customKey(ev);
  const matches = (ev.data?.matches || []).filter((m) => m.home && m.away);
  for (const team of ev.data?.ourTeams || []) {
    const color = (team.match(/\b(blå|gul|röd|svart|vit|grön|orange|lila|rosa)$/i)?.[1] || '').toLowerCase();
    const key = `${block}|${age}:${team}`;
    out[key] = {
      key, block, teamId: `${age}:${team}`, label: `${age} ${color || team}`, teamName: team, color,
      kind: 'eget', group: ev.title || 'Eget poolspel', host: 'Järfälla HC', sourceUrl: null, custom: true,
      date: ev.date, venue: ev.venue, missing: false, changes: [],
      matches: matches.filter((m) => m.home === team || m.away === team).map((m, i) => ({
        id: `${block}#${team}#${i}`, date: ev.date, start: m.start || null, home: m.home, away: m.away, venue: ev.venue, status: 'planerad', missing: false,
      })).sort((a, b) => (a.start || '').localeCompare(b.start || '')),
    };
  }
  return out;
}

// Till matchinbjudan: ett "hemmapoolspel" med ett block. Planer som valts i formuläret följer med.
export function customToHomeEvent(ev) {
  const block = customKey(ev);
  const matches = (ev.data?.matches || []).filter((m) => m.home && m.away);
  return {
    key: block, date: ev.date, venue: ev.venue, custom: true, title: ev.title || '',
    data: { blocks: [{ block, matches: matches.map((m) => ({ start: m.start || '', home: m.home, away: m.away, status: 'planerad' })) }] },
    plans: Object.fromEntries(matches.map((m, i) => [`${block}#${i}`, Number(m.plan) || null]).filter(([, p]) => p)),
  };
}

// Lägger ihop hämtat schema och egna poolspel
export function mergeCustom(state, events, age = 'U9') {
  const uppdrag = { ...(state.schedule?.uppdrag || {}) };
  const home = [...(state.homeEvents || [])];
  for (const ev of events || []) {
    Object.assign(uppdrag, customToUppdrag(ev, age));
    home.push(customToHomeEvent(ev));
  }
  home.sort((a, b) => a.date.localeCompare(b.date));
  return { ...state, schedule: { ...state.schedule, uppdrag }, homeEvents: home };
}

export function addMinutes(hhmm, min) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || '');
  if (!m) return '';
  const t = Number(m[1]) * 60 + Number(m[2]) + min;
  return `${String(Math.floor(t / 60) % 24).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}
