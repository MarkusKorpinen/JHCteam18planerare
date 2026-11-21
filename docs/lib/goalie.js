// Målvaktssvar som alla ledare kan sätta. Samma regler finns i databasfunktionen set_goalie
// (supabase/migration-malvakt-aktiviteter.sql), så att ledare kan svara utan att få ändra lagen i övrigt.
//   ok    – spelaren har accepterat att stå i mål. Är spelaren utespelare i laget byter hen plats
//           med en målvakt som inte har accepterat (eller blir extra målvakt om alla har accepterat).
//   unok  – ta bort accepterat för spelaren
//   none  – ingen i laget har accepterat att stå i mål
//   clear – ta bort markeringen ”ingen har accepterat”
const fail = (m) => { throw new Error(m); };

export function applyGoalie(r, key, pid, state, me = {}, now = new Date().toISOString()) {
  const t = r.teams?.[key] || fail('Okänt lag.');
  t.goalies ||= []; t.lines ||= []; t.goalieOk ||= [];
  r.locks ||= [];
  let swapped = null;
  if (state === 'ok') {
    if (!t.goalies.includes(pid)) {
      if (!t.lines.some((l) => l.includes(pid))) fail('Spelaren är inte med i laget.');
      // Byter med den obekräftade målvakt som har lägst id, så att samma regel ger samma svar överallt
      const old = t.goalies.filter((g) => !t.goalieOk.includes(g)).sort()[0] || null;
      t.lines = t.lines.map((l) => (old ? l.map((x) => (x === pid ? old : x)) : l.filter((x) => x !== pid))).filter((l) => l.length);
      t.goalies = old ? t.goalies.map((g) => (g === old ? pid : g)) : [...t.goalies, pid];
      if (old) r.locks = r.locks.map((l) => (l.pid === old && l.key === key ? { ...l, role: 'S' } : l));
      swapped = old;
    }
    if (!t.goalieOk.includes(pid)) t.goalieOk.push(pid);
    delete t.goalieNone;
    r.locks = [...r.locks.filter((l) => !(l.pid === pid && l.key === key)), { pid, key, role: 'G' }];
  } else if (state === 'unok') {
    t.goalieOk = t.goalieOk.filter((x) => x !== pid);
  } else if (state === 'none') {
    t.goalieOk = [];
    t.goalieNone = { by: me.name || '', at: now };
  } else if (state === 'clear') {
    delete t.goalieNone;
  } else fail('Okänt val.');
  return { round: r, swapped };
}

export function goalieText(state, name, label, swappedName) {
  if (state === 'ok') return `${name} har accepterat att stå i mål i ${label}${swappedName ? ` (byter plats med ${swappedName}, som blir utespelare)` : ''}`;
  if (state === 'unok') return `${name} är inte längre bekräftad som målvakt i ${label}`;
  if (state === 'none') return `ingen har accepterat att stå i mål i ${label}`;
  return `tog bort ”ingen målvakt” i ${label}`;
}
