// Järfälla HC Team 2018 – gränssnitt. Koden innehåller ingen spelardata; den hämtas efter inloggning.
import { CONFIG } from './config.js';
import { createSupabaseBackend } from './backend-supabase.js';
import { createDemoBackend } from './backend-demo.js';
import { RULES, isReserve } from './lib/planner.js';
import { playersFromCsv } from './lib/csv.js';
import { runSync } from './lib/schedule.js';
import { ACTIONS, ALLOWED_WHEN_CONFIRMED, newRound, addLog, snapshot, view, pendingReview } from './lib/rounds.js';
import { ARENAS, DEFAULT_TEXTS, arenaFor, buildMatches, assignJerseys, resolveColors, clubOf, isOurs, colorLabel, colorHex, rinkSvg } from './lib/invite.js';
import { DEMO_ROLES } from './backend-demo.js';

const $ = (s, el = document) => el.querySelector(s);
const app = $('#app');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const TEAM_COLORS = { blå: '#1f5fbf', gul: '#f2c200', röd: '#d7263d', svart: '#1d1d1f', vit: '#ffffff', grön: '#2e9e5b' };
const configured = !!(CONFIG.supabaseUrl && CONFIG.supabaseAnonKey);
const S = { me: null, state: null, round: null, view: null, pending: null, poll: null, newRoundSel: new Set(), importPreview: null, syncing: false };
let B = null;

function pickBackend() {
  const demo = sessionStorage.getItem('jhc-demo') === '1' || !configured && location.hash.startsWith('#/demo');
  B = demo ? createDemoBackend() : configured ? createSupabaseBackend({ url: CONFIG.supabaseUrl, anonKey: CONFIG.supabaseAnonKey }) : null;
}

// ---------- hjälpare ----------
function toast(msg, bad) {
  const t = $('#toast');
  t.textContent = msg; t.className = 'show' + (bad ? ' bad' : '');
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.className = ''), 3500);
}
const stockholmToday = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm' }).format(new Date());
const dFmt = new Intl.DateTimeFormat('sv-SE', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Europe/Stockholm' });
const dtFmt = new Intl.DateTimeFormat('sv-SE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Stockholm' });
const fDate = (d) => (d ? dFmt.format(new Date(d + 'T12:00:00')) : 'okänt datum');
const fDT = (iso) => (iso ? dtFmt.format(new Date(iso)) : '–');
const U = (key) => S.state.schedule.uppdrag?.[key];
const P = (id) => S.state.players.find((p) => p.id === id);
const levelNames = () => S.state.settings.levels.map((l) => l.name);
const levelColor = (name) => S.state.settings.levels.find((l) => l.name === name)?.color || '#999';
const teamColor = (u) => TEAM_COLORS[u?.color] || '#667';
const res = (p) => (isReserve(p) ? 1 : 0);
const isAvail = (key, pid) => S.state.availability?.[key]?.[pid] !== false;
const opponent = (u, m) => (m.home === u?.teamName ? m.away : m.home);
const ctx = () => ({
  uppdrag: S.state.schedule.uppdrag || {}, players: S.state.players, availability: S.state.availability,
  levels: levelNames(), history: S.state.history, teamPrefix: S.state.settings.teamPrefix, me: S.me, changes: S.state.changes,
  coaches: S.state.coaches || [], coachAvailability: S.state.coachAvailability || {},
});
const coachAvail = (key, cid) => S.state.coachAvailability?.[key]?.[cid] !== false;
const parentsOf = (pid) => (S.state.coaches || []).filter((c) => c.active !== false && (c.children || []).includes(pid));
const C = (id) => (S.state.coaches || []).find((c) => c.id === id);
const teamFullName = (key) => `${S.state.settings.teamPrefix || ''} ${U(key)?.label || ''}`.trim();

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.append(ta); ta.select(); document.execCommand('copy'); ta.remove();
  }
}
function download(name, data) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' }));
  a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}


// Egna dialogrutor i stället för webbläsarens prompt/confirm, som vissa mobiler och appar blockerar
function ask(html, init) {
  return new Promise((resolve) => {
    const d = $('#ask');
    d.innerHTML = html;
    d.onclose = () => resolve(d.returnValue);
    d.showModal();
    init?.(d);
  });
}
async function askConfirm(text) {
  const v = await ask(`<form method="dialog" class="stack"><p>${esc(text)}</p><div class="row"><button class="btn primary" value="ok">OK</button><button class="btn" value="cancel" formnovalidate>Avbryt</button></div></form>`);
  return v === 'ok';
}
async function askText(title, value = '', { multiline = false, ok = 'Spara' } = {}) {
  let out = null;
  const v = await ask(`<form method="dialog" class="stack"><label><strong>${esc(title)}</strong>
    ${multiline ? `<textarea name="t" rows="4" maxlength="1000">${esc(value)}</textarea>` : `<input name="t" value="${esc(value)}" maxlength="120">`}</label>
    <div class="row"><button class="btn primary" value="ok">${esc(ok)}</button><button class="btn" value="cancel" formnovalidate>Avbryt</button></div></form>`,
    (d) => { const f = d.querySelector('[name=t]'); f.focus(); d.querySelector('form').onsubmit = () => { out = f.value; }; });
  return v === 'ok' ? out : null;
}

// ---------- start och routning ----------
async function boot() {
  pickBackend();
  if (B) {
    try { S.me = await B.me(); }
    catch (e) { S.me = null; if (e.noAccess) { showNoAccess(e.message); return; } }
  }
  route();
}
window.addEventListener('hashchange', route);

async function route() {
  clearInterval(S.poll);
  let h = location.hash.replace(/^#/, '') || '/';
  if (h === '/demo') {
    sessionStorage.setItem('jhc-demo', '1');
    history.replaceState(null, '', location.pathname + '#/');
    if (B?.mode !== 'demo') return boot();
    h = '/';
  }
  const inv = h.match(/^\/inbjudan\/([\w-]+)\/(.+)$/);
  if (inv && B?.mode === 'supabase') return viewInvite(inv[1], decodeURIComponent(inv[2]));
  if (h === '/forsta-admin' && B?.mode === 'supabase') return viewInvite('', '');
  if (!S.me) return viewLogin();
  $('#top').hidden = false;
  $('#demobar').hidden = B.mode !== 'demo';
  if (B.mode === 'demo') $('#demobar').innerHTML = `Demoläge med påhittade spelare. Visa som: <select data-act="demorole" aria-label="Visa som roll">${Object.entries(DEMO_ROLES).map(([k, v]) => `<option value="${k}" ${S.me.demoRole === k ? 'selected' : ''}>${v}</option>`).join('')}</select>`;
  const planner = !!S.me.planner;
  document.querySelectorAll('#tabs a').forEach((a) => { a.hidden = !planner && (a.dataset.tab === 'spelare' || a.dataset.tab === 'historik'); });
  $('#tabs a[data-tab=omgangar]').textContent = planner ? 'Omgångar' : 'Lag';
  $('#who').innerHTML = `${esc(S.me.name)} · <button class="linkbtn" data-act="logout">${B.mode === 'demo' ? 'Avsluta demo' : 'Logga ut'}</button>`;
  try {
    if (!S.state || route.reload) { await refreshState(); route.reload = false; maybeAutoSync(); }
    const pr = h.match(/^\/utskrift\/([\w-]+)(?:\/(.+))?$/);
    if (pr) return await viewPrint(pr[1], pr[2] ? decodeURIComponent(pr[2]) : null);
    document.body.classList.remove('printmode');
    const m = h.match(/^\/omgang\/([\w-]+)/);
    const rt = h.match(/^\/rutin\/([\w-]+)(?:\/(redigera|utskrift))?$/);
    const mi = h.match(/^\/matchinbjudan\/(.+?)(\/utskrift)?$/);
    let tab = m ? 'omgangar' : rt ? 'rutiner' : mi ? 'schema' : (h.slice(1) || 'omgangar');
    if (!planner && (tab === 'spelare' || tab === 'historik')) tab = 'omgangar';
    document.querySelectorAll('#tabs a').forEach((a) => a.classList.toggle('on', a.dataset.tab === tab));
    window.scrollTo(0, 0);
    if (m) return await viewRound(m[1]);
    if (rt) return await (rt[1] === 'ny' ? editRoutine(null) : rt[2] === 'redigera' ? editRoutine(rt[1]) : rt[2] === 'utskrift' ? printRoutine(rt[1]) : viewRoutine(rt[1]));
    if (mi) return await viewInvitation(decodeURIComponent(mi[1]), !!mi[2]);
    await ({ omgangar: viewRounds, spelare: viewPlayers, schema: viewSchedule, historik: viewHistory, ledare: viewLeaders, rutiner: viewRoutines }[tab] || viewRounds)();
  } catch (e) {
    if (e.status === 401) { S.me = null; return viewLogin(e.message); }
    app.innerHTML = `<div class="alert error">${esc(e.message)}</div>`;
  }
}
async function refreshState() {
  S.state = await B.loadState();
  S.state.today = stockholmToday();
}
async function maybeAutoSync() {
  const sch = S.state.schedule;
  const hours = S.state.settings.syncHours || 24;
  const last = sch.last_attempt ? Date.parse(sch.last_attempt) : 0;
  const due = !sch.last_success || Date.now() - last > (sch.last_error ? 1 : hours) * 3600e3;
  if (!due || S.syncing) return;
  const r = await doSync('auto');
  if (r.ok && r.changes && !r.skipped && sch.last_success) toast(`Matchschemat uppdaterades: ${r.changes} ändringar.`);
}
async function doSync(trigger) {
  S.syncing = true;
  try {
    const r = await runSync(B, { source: B.mode === 'demo' ? 'demo/schedule.json' : CONFIG.scheduleSource, trigger });
    await refreshState();
    return r;
  } finally { S.syncing = false; }
}
function showNoAccess(msg) {
  $('#top').hidden = true;
  app.innerHTML = `<section class="auth"><h1>Ingen åtkomst</h1><div class="alert warn">${esc(msg)}</div><button class="btn" data-act="logout">Logga ut</button></section>`;
}

// ---------- inloggning ----------
function viewLogin(msg) {
  $('#top').hidden = true;
  app.innerHTML = `
  <section class="auth">
    <h1>Järfälla HC Team 2018</h1>
    ${configured ? `
    <p class="muted">Endast för inbjudna ledare.</p>
    ${msg ? `<div class="alert warn">${esc(msg)}</div>` : ''}
    <form id="login" class="stack">
      <label>E-post<input type="email" name="email" autocomplete="username" required></label>
      <label>Lösenord<input type="password" name="password" autocomplete="current-password" required></label>
      <button class="btn primary">Logga in</button>
      <p class="err" id="err"></p>
    </form>
    <p class="small muted">Glömt lösenordet? Be en administratör om en ny inloggningslänk.</p>
    <p class="small muted">Administratör som loggar in första gången: <a href="#/forsta-admin">skapa ditt konto</a>.</p>`
    : '<div class="alert warn">Planeraren är inte kopplad till någon databas ännu. Fyll i <code>docs/config.js</code> enligt guiden.</div>'}
    <p class="small"><a href="#/demo">Prova demoläget</a> med påhittade spelare. Inget sparas utanför din webbläsare.</p>
  </section>`;
  const f = $('#login');
  if (f) f.onsubmit = async (e) => {
    e.preventDefault();
    const btn = f.querySelector('button'); btn.disabled = true;
    try { S.me = await B.login(f.email.value, f.password.value); route.reload = true; location.hash = '#/'; route(); }
    catch (err) { $('#err').textContent = err.message; btn.disabled = false; }
  };
}
async function viewInvite(code, email) {
  $('#top').hidden = true;
  const first = !code;
  let info = { valid: false, existing: false };
  if (!first) {
    try { info = await B.inviteStatus(email, code); } catch (e) { info.error = e.message; }
    if (!info.valid) {
      app.innerHTML = `<section class="auth"><h1>Inbjudan</h1><div class="alert error">${esc(info.error || 'Inbjudan är ogiltig, redan använd eller har gått ut. Be en administratör om en ny länk.')}</div><a href="#/" class="btn">Till inloggningen</a></section>`;
      return;
    }
  }
  app.innerHTML = `
  <section class="auth">
    <h1>${first ? 'Skapa administratörskontot' : info.existing ? 'Välj nytt lösenord' : 'Välkommen som ledare'}</h1>
    ${first ? '<p class="small">Fungerar bara för den e-post som står i databasinställningen, och bara en gång.</p>' : `<p>Kontot gäller <strong>${esc(email)}</strong>.</p>`}
    <form id="acc" class="stack">
      ${first ? '<label>E-post<input type="email" name="email" required autocomplete="username"></label>' : ''}
      <label>Ditt namn (visas för andra ledare)<input name="name" required maxlength="60" autocomplete="name"></label>
      <label>Lösenord, minst 10 tecken<input type="password" name="password" autocomplete="new-password" minlength="10" required></label>
      <button class="btn primary">Spara och logga in</button>
      <p class="err" id="err"></p>
    </form>
  </section>`;
  $('#acc').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target; const btn = f.querySelector('button'); btn.disabled = true;
    try {
      S.me = await B.acceptInvite({ email: first ? f.email.value : email, code, name: f.name.value.trim(), password: f.password.value });
      route.reload = true; history.replaceState(null, '', location.pathname + '#/'); route();
    } catch (err) { $('#err').textContent = err.message; btn.disabled = false; }
  };
}

// ---------- omgångar ----------
function upcomingByDate() {
  const list = Object.values(S.state.schedule.uppdrag || {}).filter((u) => u.date >= S.state.today).sort((a, b) => a.date.localeCompare(b.date) || a.label.localeCompare(b.label));
  const g = new Map();
  for (const u of list) { if (!g.has(u.date)) g.set(u.date, []); g.get(u.date).push(u); }
  return g;
}
const needsReview = (r) => r.keys.some((k) => pendingReview(r, k, S.state.changes).length);
function viewTeams() {
  // Ledare och lagledare: bara fastställda lag, utan färger
  const rs = S.state.rounds.filter((r) => r.status === 'fastställt');
  app.innerHTML = `
  ${syncBanner()}
  <section class="panel">
    <h2>Fastställda lag</h2>
    <p class="small muted">Lagen visas här när lagplanerarna har fastställt dem. Matcher och tider finns under Schema.</p>
    ${rs.length ? `<ul class="rounds">${rs.map((r) => `
      <li><a href="#/omgang/${r.id}">
        <span class="rname">${esc(r.name)}</span>
        <span class="small muted block">${r.keys.map((k) => esc(U(k)?.label || '?') + ' ' + fDate(U(k)?.date)).join(' · ')}</span>
        <span class="small muted block">Fastställt ${fDT(r.confirmedAt)}</span>
      </a></li>`).join('')}</ul>` : '<p class="muted">Inga fastställda lag ännu.</p>'}
  </section>`;
}
function viewRounds() {
  if (!S.me.planner) return viewTeams();
  const rs = S.state.rounds;
  const inRound = new Map();
  for (const r of rs) for (const k of r.keys) inRound.set(k, r.name);
  const groups = upcomingByDate();
  app.innerHTML = `
  ${syncBanner()}
  <section class="panel">
    <h2>Omgångar</h2>
    ${rs.length ? `<ul class="rounds">${rs.map((r) => `
      <li><a href="#/omgang/${r.id}">
        <span class="rname">${esc(r.name)}</span>
        <span class="badge ${r.status === 'fastställt' ? 'ok' : 'draft'}">${r.status === 'fastställt' ? 'Fastställt' : 'Utkast'}</span>
        ${needsReview(r) ? '<span class="badge review">Granska</span>' : ''}
        <span class="small muted block">${r.keys.map((k) => esc(U(k)?.label || '?') + ' ' + fDate(U(k)?.date)).join(' · ')}</span>
        <span class="small muted block">Senast ändrad ${fDT(r.updatedAt)} av ${esc(r.updatedByName || '')}</span>
      </a></li>`).join('')}</ul>` : '<p class="muted">Inga omgångar ännu. Skapa den första nedan.</p>'}
  </section>
  <section class="panel">
    <h2>Ny omgång</h2>
    <p class="small muted">Välj de poolspel som ska planeras tillsammans. Samma trupp gäller för alla lagets matcher i ett poolspel.</p>
    <form id="newround" class="stack">
      ${[...groups].map(([d, us]) => `
        <fieldset class="dategroup"><legend>${fDate(d)} <button type="button" class="linkbtn" data-act="selday" data-date="${d}">välj alla</button></legend>
        ${us.map((u) => `<label class="pick">
            <input type="checkbox" name="k" value="${esc(u.key)}" ${S.newRoundSel.has(u.key) ? 'checked' : ''}>
            <span class="tdot" style="--c:${teamColor(u)}"></span>
            <span><strong>${esc(u.label)}</strong> · ${esc(u.venue)} · ${u.matches.filter((m) => !m.missing).map((m) => m.start || '?').join(', ')}
            ${u.missing ? '<span class="badge bad">Saknas i källan</span>' : ''}
            ${inRound.has(u.key) ? `<span class="small muted block">Ingår redan i ${esc(inRound.get(u.key))}</span>` : ''}</span>
          </label>`).join('')}
        </fieldset>`).join('') || '<p class="muted">Inga kommande poolspel i schemat.</p>'}
      <label>Namn på omgången<input name="name" placeholder="t.ex. Omgång 28 nov"></label>
      <button class="btn primary">Skapa omgång med förslag</button>
    </form>
  </section>`;
  const form = $('#newround');
  form.onchange = (e) => { if (e.target.name === 'k') e.target.checked ? S.newRoundSel.add(e.target.value) : S.newRoundSel.delete(e.target.value); };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const keys = [...S.newRoundSel].filter((k) => U(k));
    if (!keys.length) return toast('Välj minst ett poolspel.', true);
    let name = form.name.value.trim();
    if (!name) { const ds = [...new Set(keys.map((k) => U(k).date))].sort(); name = 'Omgång ' + ds.map(fDate).join(' + '); }
    try {
      const round = await B.createRound(newRound(name, keys, S.state.settings.roundDefaults, ctx()));
      S.newRoundSel.clear(); await refreshState(); location.hash = `#/omgang/${round.id}`;
    } catch (err) { toast(err.message, true); }
  };
}

// ---------- en omgång ----------
async function viewRound(id) {
  S.round = await B.getRound(id);
  if (!S.me.planner) return renderRoundReadOnly();
  renderRound();
  S.poll = setInterval(checkVersion, 20000);
}
async function checkVersion() {
  if (!S.round || document.hidden) return;
  try {
    const v = await B.getRoundVersion(S.round.id);
    if (v && v.version !== S.round.version) showConflict(v, false);
  } catch {}
}
function showConflict(v, blocked) {
  const el = $('#conflict');
  if (!el) return;
  const who = v.updatedByName || 'En annan ledare';
  el.innerHTML = `<div class="alert warn">
    <strong>${esc(who)} har ändrat utkastet ${v.updatedAt ? fDT(v.updatedAt) : ''}</strong> sedan du öppnade det.
    ${v.last ? `<div class="small">Senaste ändring: ${esc(v.last.by)} ${esc(v.last.text)}</div>` : ''}
    ${blocked ? '<div class="small">Din ändring sparades inte.</div>' : ''}
    <div class="row"><button class="btn primary" data-act="reload">Ladda om utkastet</button>
    ${blocked ? '<button class="btn" data-act="force">Gör min ändring ändå</button>' : ''}</div></div>`;
  el.scrollIntoView({ block: 'nearest' });
}
async function act(type, extra = {}, opts = {}) {
  if (S.round.status === 'fastställt' && !ALLOWED_WHEN_CONFIRMED.has(type)) { toast('Omgången är fastställd. Öppna den som utkast för att ändra.', true); return false; }
  try {
    const r = structuredClone(S.round);
    const comments = r.comments; delete r.comments;
    const text = ACTIONS[type](r, extra, ctx());
    addLog(r, S.me, text);
    const history = r.status === 'fastställt' ? snapshot(r, ctx()) : null;
    const saved = await B.saveRound(r, S.round.version, { force: !!opts.force, history });
    S.round = { ...saved, comments }; S.pending = null;
    if (type === 'confirm' || type === 'reopen' || type === 'rename') await refreshState();
    renderRound(true);
    return true;
  } catch (e) {
    if (e.conflict) { S.pending = { type, extra }; showConflict(e.conflict, true); }
    else if (e.status === 401) { S.me = null; viewLogin(e.message); }
    else toast(e.message, true);
    return false;
  }
}
function placementOf(pid) {
  const out = [];
  for (const k of S.round.keys) {
    const t = S.round.teams[k];
    if (t.goalies.includes(pid)) out.push({ key: k, role: 'G' });
    t.lines.forEach((l, i) => l.includes(pid) && out.push({ key: k, role: 'S', line: i }));
  }
  return out;
}
const isLocked = (pid, key) => S.round.locks.some((l) => l.pid === pid && l.key === key);

function chip(pid, key) {
  const p = P(pid);
  if (!p) return '<span class="pl gone">Okänd spelare</span>';
  const bad = key && !isAvail(key, pid);
  return `<button class="pl${bad ? ' bad' : ''}" data-act="player" data-pid="${pid}" data-key="${esc(key || '')}" title="${esc(p.level)}${p.canGoalie ? ', kan stå i mål' : ''}">
    <span class="ldot" style="--c:${levelColor(p.level)}"></span>${esc(p.name)}${p.canGoalie ? '<span class="mv">MV</span>' : ''}${isReserve(p) ? '<span class="res" title="Reserv">R</span>' : ''}${parentsOf(pid).length ? `<span class="lk" title="Ledarbarn: ${esc(parentsOf(pid).map((c) => c.name).join(', '))}">L</span>` : ''}${key && isLocked(pid, key) ? '<span class="lock" aria-label="låst">🔒</span>' : ''}</button>`;
}

function teamCard(key) {
  const r = S.round, u = U(key), t = r.teams[key] || { goalies: [], lines: [] };
  const v = S.view.validation.perTeam[key] || [];
  const skaters = t.lines.flat();
  const s = r.settings;
  const dist = S.view.validation.levelDist[key] || {};
  const errors = v.filter((x) => x.level === 'error').length;
  const review = pendingReview(r, key, S.state.changes);
  const status = review.length ? '<span class="badge review">Granska</span>' : errors ? '<span class="badge bad">Saknas</span>' : '<span class="badge ok">Klart</span>';
  return `
  <article class="card" style="--c:${teamColor(u)}">
    <header class="cardhead ${u?.color === 'vit' || u?.color === 'gul' ? 'light' : ''}">
      <div><h3>${esc(u?.label || 'Okänt lag')}</h3><div class="small">${fDate(u?.date)}</div></div>
      ${status}
    </header>
    <div class="cardbody">
      <div class="pool small">
        <div><strong>${esc(u?.venue || '')}</strong>${u?.host ? ` · arrangör ${esc(u.host)}` : ''}</div>
        <ul class="matches">${(u?.matches || []).map((m) => `<li class="${m.missing ? 'missing' : ''}">
          <span class="time">${esc(m.start || 'tid ej satt')}</span> mot ${esc(opponent(u, m))}${m.missing ? ' <span class="badge bad">saknas i källan</span>' : ''}</li>`).join('')}</ul>
      </div>
      ${review.map((x) => `<div class="alert review small"><strong>Schemat ändrades ${fDT(x.at)}:</strong> ${x.items.map(esc).join('; ')}</div>`).join('')}
      ${review.length ? `<button class="btn small" data-act="ack" data-key="${esc(key)}">Markera som granskad</button>` : ''}
      <div class="counts">
        <span class="${t.goalies.length < s.goalies ? 'neg' : ''}">Målvakt ${t.goalies.length}/${s.goalies}</span>
        <span class="${skaters.length < s.skaters ? 'neg' : ''}">Utespelare ${skaters.length}/${s.skaters}</span>
        ${(() => { const n = [...t.goalies, ...skaters].filter((id) => isReserve(P(id))).length; return n ? `<span class="resn">${n} reserv${n > 1 ? 'er' : ''}</span>` : ''; })()}
        <span class="dist">${Object.entries(dist).map(([l, n]) => `<span title="${esc(l)}"><span class="ldot" style="--c:${levelColor(l)}"></span>${n}</span>`).join('')}</span>
      </div>
      ${v.filter((x) => x.level !== 'review').map((x) => `<div class="warnline ${x.level}">${esc(x.text)}</div>`).join('')}
      <h4>Målvakt</h4>
      <div class="chips drop" data-drop-key="${esc(key)}" data-drop-role="G">${t.goalies.map((id) => chip(id, key)).join('') || '<span class="empty">Ingen målvakt</span>'}</div>
      ${t.lines.map((l, i) => `<h4>Kedja ${i + 1} <span class="muted small">(${l.length})</span></h4><div class="chips drop" data-drop-key="${esc(key)}" data-drop-role="S" data-drop-line="${i}">${l.map((id) => chip(id, key)).join('')}</div>`).join('') || '<h4>Utespelare</h4><span class="empty">Inga utespelare</span>'}
      ${r.status !== 'fastställt' ? `<div class="chips drop newline" data-drop-key="${esc(key)}" data-drop-role="S" data-drop-line="new">Släpp här för ny kedja</div>` : ''}
      <h4>Tränare</h4>
      <div class="chips">${(t.coaches || []).map((id) => `<span class="coach${!coachAvail(key, id) ? ' bad' : ''}">${esc(C(id)?.name || 'Okänd tränare')}${isReserve(C(id)) ? '<span class="res">R</span>' : ''}${(r.coachLocks || []).some((l) => l.cid === id && l.key === key) ? '<span class="lock">🔒</span>' : ''}</span>`).join('') || '<span class="empty">Ingen ledare</span>'}</div>
      <div class="row cardactions">
        ${r.status !== 'fastställt' ? `<button class="btn small" data-act="addreserve" data-key="${esc(key)}">+ Lägg till spelare</button>` : ''}
        <button class="btn small" data-act="coaches" data-key="${esc(key)}">Välj tränare</button>
      </div>
      <div class="row cardactions">
        <button class="btn" data-act="copyteam" data-key="${esc(key)}">Kopiera laglista</button>
        <a class="btn" href="#/utskrift/${r.id}/${encodeURIComponent(key)}">Laglista som PDF</a>
      </div>

    </div>
  </article>`;
}

function renderRoundReadOnly() {
  const r = S.round;
  const name = (id) => esc(P(id)?.name || '');
  app.innerHTML = `
  <a href="#/" class="back">← Lag</a>
  <section class="roundhead">
    <h1>${esc(r.name)}</h1>
    <p class="small muted">Fastställt ${fDT(r.confirmedAt)} av ${esc(r.confirmedBy || '')}</p>
    <div class="row">
      <button class="btn" data-act="copyall">Kopiera laglista för hela omgången</button>
      <a class="btn" href="#/utskrift/${r.id}">PDF för hela omgången</a>
    </div>
  </section>
  <div class="cards">${r.keys.map((key) => {
    const u = U(key), t = r.teams[key] || { goalies: [], lines: [] };
    return `<article class="card" style="--c:${teamColor(u)}">
      <header class="cardhead ${u?.color === 'vit' || u?.color === 'gul' ? 'light' : ''}"><div><h3>${esc(u?.label || '')}</h3><div class="small">${fDate(u?.date)}</div></div></header>
      <div class="cardbody">
        <div class="pool small"><div><strong>${esc(u?.venue || '')}</strong>${u?.host ? ` · arrangör ${esc(u.host)}` : ''}</div>
        <ul class="matches">${(u?.matches || []).map((m) => `<li class="${m.missing ? 'missing' : ''}"><span class="time">${esc(m.start || 'tid ej satt')}</span> mot ${esc(opponent(u, m))}</li>`).join('')}</ul></div>
        <h4>Målvakt</h4><div class="namelist">${t.goalies.map((id) => `<div>${name(id)}</div>`).join('') || '<div class="muted">–</div>'}</div>
        <h4>Utespelare</h4><div class="namelist">${t.lines.flat().map((id) => `<div>${name(id)}</div>`).join('') || '<div class="muted">–</div>'}</div>
        <h4>Tränare</h4><div class="namelist">${(t.coaches || []).map((id) => `<div>${esc(C(id)?.name || '')}</div>`).join('') || '<div class="muted">–</div>'}</div>
        <div class="row cardactions"><button class="btn" data-act="copyteam" data-key="${esc(key)}">Kopiera laglista</button><a class="btn" href="#/utskrift/${r.id}/${encodeURIComponent(key)}">Laglista som PDF</a></div>
      </div></article>`;
  }).join('')}</div>`;
  S.view = view(r, ctx());
}

function renderRound(keepScroll) {
  const r = S.round, s = r.settings;
  S.view = view(r, ctx());
  const y = window.scrollY;
  const confirmed = r.status === 'fastställt';
  const players = S.state.players.filter((p) => p.active !== false).sort((a, b) => res(a) - res(b) || a.name.localeCompare(b.name, 'sv'));
  app.innerHTML = `
  <a href="#/" class="back">← Omgångar</a>
  <div id="conflict"></div>
  <section class="roundhead">
    <h1 class="editable" data-act="rename" title="Byt namn">${esc(r.name)}</h1>
    <ol class="steps"><li class="${!confirmed ? 'on' : 'done'}">1 Utkast</li><li class="${confirmed ? 'on' : ''}">2 Fastställt</li></ol>
    <p class="small muted">Version ${r.version} · senast ändrad ${fDT(r.updatedAt)} av ${esc(r.updatedByName || '')}${confirmed ? ` · fastställd ${fDT(r.confirmedAt)} av ${esc(r.confirmedBy || '')}` : ''}</p>
    <div class="row">
      ${!confirmed ? '<button class="btn primary" data-act="propose">Skapa nytt förslag</button>' : ''}
      <button class="btn" data-act="copyall">Kopiera laglista för hela omgången</button>
      <a class="btn" href="#/utskrift/${r.id}">PDF för hela omgången</a>
      ${!confirmed ? '<button class="btn ok" data-act="confirm">Fastställ</button>' : '<button class="btn" data-act="reopen">Öppna som utkast</button>'}
    </div>
    ${!confirmed ? '<p class="small muted">Dra spelare mellan lag och kedjor, eller tryck på en spelare för fler val. Nytt förslag behåller låsta placeringar (🔒) och fördelar om alla andra.</p>' : ''}
  </section>
  ${S.view.validation.global.map((x) => `<div class="alert warn">${esc(x.text)}</div>`).join('')}
  <details class="panel">
    <summary><strong>Inställningar för förslaget</strong> <span class="small muted">${s.skaters} utespelare · ${s.goalies} målvakt · kedja ${s.lineSize}</span></summary>
    <form id="rset" class="grid4">
      <label>Utespelare per lag<input type="number" name="skaters" min="1" max="20" value="${s.skaters}"></label>
      <label>Målvakter per lag<input type="number" name="goalies" min="0" max="3" value="${s.goalies}"></label>
      <label>Spelare per kedja<input type="number" name="lineSize" min="1" max="10" value="${s.lineSize}"></label>
      <button class="btn" ${confirmed ? 'disabled' : ''}>Spara inställningar</button>
    </form>
    <p class="small muted">Ändrade inställningar används nästa gång du skapar ett förslag.</p>
  </details>
  <div class="cards">${r.keys.map(teamCard).join('')}</div>
  <section class="panel">
    <h2>Ej uttagna <span class="small muted">(tillgängliga för minst ett poolspel)</span></h2>
    ${(() => {
      const un = S.view.validation.unplaced.map(P).filter(Boolean);
      const ord = un.filter((p) => !isReserve(p)), rs = un.filter(isReserve);
      return `<p class="small muted">Dra en spelare hit för att ta bort hen från laget.</p><h4>Ordinarie</h4><div class="chips drop" data-drop-bench="1">${ord.map((p) => chip(p.id, '')).join('') || '<span class="muted small">Alla ordinarie som kan är uttagna.</span>'}</div>
      <h4>Reserver</h4><div class="chips drop" data-drop-bench="1">${rs.map((p) => chip(p.id, '')).join('') || '<span class="muted small">Inga lediga reserver.</span>'}</div>`;
    })()}
  </section>
  <details class="panel" id="avail">
    <summary><strong>Tillgänglighet</strong> <span class="small muted">markera vilka som inte kan</span></summary>
    <div class="tablewrap"><table class="avail">
      <thead><tr><th>Spelare</th>${r.keys.map((k) => `<th><span class="tdot" style="--c:${teamColor(U(k))}"></span>${esc((U(k)?.label || '').replace('U9 ', ''))}<br><span class="small">${fDate(U(k)?.date)}</span></th>`).join('')}</tr></thead>
      <tbody>${players.map((p) => `<tr><th><span class="ldot" style="--c:${levelColor(p.level)}"></span>${esc(p.name)}${p.canGoalie ? ' <span class="mv">MV</span>' : ''}${isReserve(p) ? '<span class="res">R</span>' : ''}</th>
        ${r.keys.map((k) => `<td><label class="tog"><input type="checkbox" data-act="avail" data-key="${esc(k)}" data-pid="${p.id}" ${isAvail(k, p.id) ? 'checked' : ''}><span>${isAvail(k, p.id) ? 'Kan' : 'Kan inte'}</span></label></td>`).join('')}</tr>`).join('')}
      <tr><th colspan="${r.keys.length + 1}" class="subhead">Tränare</th></tr>
      ${(S.state.coaches || []).filter((c) => c.active !== false).sort((a, b) => res(a) - res(b) || a.name.localeCompare(b.name, 'sv')).map((c) => `<tr><th>${esc(c.name)}${isReserve(c) ? '<span class="res">R</span>' : ''}</th>
        ${r.keys.map((k) => `<td><label class="tog"><input type="checkbox" data-act="cavail" data-key="${esc(k)}" data-cid="${c.id}" ${coachAvail(k, c.id) ? 'checked' : ''}><span>${coachAvail(k, c.id) ? 'Kan' : 'Kan inte'}</span></label></td>`).join('')}</tr>`).join('')}</tbody>
    </table></div>
  </details>
  <details class="panel">
    <summary><strong>Så skapas förslaget</strong></summary>
    <ol class="rules">${RULES.map((x) => `<li>${esc(x)}</li>`).join('')}</ol>
  </details>
  <details class="panel">
    <summary><strong>Ändringslogg</strong></summary>
    <ul class="log">${(r.log || []).map((l) => `<li><span class="small muted">${fDT(l.at)}</span> ${esc(l.by)} ${esc(l.text)}</li>`).join('')}</ul>
  </details>
  ${!confirmed ? '<p><button class="linkbtn danger" data-act="delround">Ta bort omgången</button></p>' : ''}`;
  if (keepScroll) window.scrollTo(0, y);

  $('#rset').onsubmit = (e) => {
    e.preventDefault();
    const f = Object.fromEntries([...new FormData(e.target)].map(([k, v]) => [k, parseInt(v, 10)]));
    act('settings', { settings: f }).then((ok) => ok && toast('Inställningarna är sparade.'));
  };
}

function playerDialog(pid, fromKey) {
  const p = P(pid), r = S.round;
  const confirmed = r.status === 'fastställt';
  const places = placementOf(pid);
  const cur = fromKey ? places.find((x) => x.key === fromKey) : null;
  const curVal = cur ? `${cur.key}::${cur.role}::${cur.line ?? ''}` : '';
  const opts = r.keys.map((k) => {
    const t = r.teams[k], u = U(k), lbl = `${esc(u?.label)} ${fDate(u?.date)}`;
    const o = [`<option value="${esc(k)}::G::">${lbl} – Målvakt</option>`];
    t.lines.forEach((_, i) => o.push(`<option value="${esc(k)}::S::${i}">${lbl} – Kedja ${i + 1}</option>`));
    o.push(`<option value="${esc(k)}::S::new">${lbl} – Ny kedja</option>`);
    return `<optgroup label="${lbl}">${o.join('')}</optgroup>`;
  }).join('');
  const dlg = $('#dlg');
  dlg.innerHTML = `
  <form method="dialog" class="stack" id="pform">
    <h2>${esc(p.name)}</h2>
    <p class="small"><span class="ldot" style="--c:${levelColor(p.level)}"></span>${esc(p.level)} · ${p.canGoalie ? 'kan stå i mål' : 'utespelare'} · ${isReserve(p) ? 'reserv' : 'ordinarie'}</p>
    <p class="small muted">${places.length ? 'Uttagen: ' + places.map((x) => `${esc(U(x.key)?.label)} ${fDate(U(x.key)?.date)} (${x.role === 'G' ? 'målvakt' : 'kedja ' + (x.line + 1)})`).join(', ') : 'Inte uttagen i omgången.'}</p>
    ${confirmed ? '<p class="alert warn small">Omgången är fastställd. Öppna den som utkast för att flytta spelare.</p>' : `
    <label>Placering
      <select name="to"><option value="">${fromKey ? 'Ej uttagen (ta bort från laget)' : 'Ej uttagen'}</option>${opts}</select>
    </label>
    <label class="check"><input type="checkbox" name="locked" ${fromKey && isLocked(pid, fromKey) ? 'checked' : ''}> Lås placeringen när nytt förslag skapas</label>`}
    ${fromKey ? `<label class="check"><input type="checkbox" name="unavail" ${!isAvail(fromKey, pid) ? 'checked' : ''}> Kan inte ${esc(U(fromKey)?.label)} ${fDate(U(fromKey)?.date)}</label>` : ''}
    <div class="row"><button class="btn primary" value="save">Spara</button><button class="btn" value="cancel" formnovalidate>Avbryt</button></div>
  </form>`;
  const sel = dlg.querySelector('select[name=to]');
  if (sel) sel.value = curVal;
  dlg.showModal();
  dlg.onclose = async () => {
    if (dlg.returnValue !== 'save') return;
    const f = dlg.querySelector('form');
    if (fromKey && f.unavail) {
      const want = !f.unavail.checked;
      if (want !== isAvail(fromKey, pid)) {
        await setAvail(fromKey, pid, want, false);
        if (!want && !confirmed && placementOf(pid).some((x) => x.key === fromKey)) { renderRound(true); replacementDialog(pid, fromKey); return; }
      }
    }
    if (!confirmed && sel) {
      const v = sel.value;
      const lockWanted = !!f.locked?.checked;
      if (v !== curVal) {
        const [toKey, role, line] = v ? v.split('::') : [null, null, null];
        await act('move', { pid, fromKey: fromKey || null, toKey: toKey || null, role, line: line === 'new' || line === '' || line == null ? null : Number(line), lock: lockWanted && !!toKey });
        return;
      }
      if (fromKey && lockWanted !== isLocked(pid, fromKey)) { await act('lock', { pid, key: fromKey, locked: lockWanted }); return; }
    }
    renderRound(true);
  };
}
async function setAvail(key, pid, available, rerender = true) {
  try {
    await B.setAvailability(key, pid, available);
    S.state.availability[key] ||= {};
    if (available) delete S.state.availability[key][pid]; else S.state.availability[key][pid] = false;
    if (rerender) renderRound(true);
  } catch (e) { toast(e.message, true); }
}
async function reloadRound() {
  const comments = await B.getRound(S.round.id);
  S.round = comments; renderRound(true);
}

// ---------- spelare ----------
function viewPlayers() {
  const lv = S.state.settings.levels;
  const ps = [...S.state.players].sort((a, b) => (a.active === false) - (b.active === false) || res(a) - res(b) || a.name.localeCompare(b.name, 'sv'));
  const active = ps.filter((p) => p.active !== false);
  const pv = S.importPreview;
  app.innerHTML = `
  <section class="panel">
    <h2>Spelare <span class="small muted">${active.filter((p) => !isReserve(p)).length} ordinarie · ${active.filter(isReserve).length} reserver · ${active.filter((p) => p.canGoalie).length} kan stå i mål</span></h2>
    <p class="small dist">${lv.map((l) => `<span><span class="ldot" style="--c:${l.color}"></span>${esc(l.name)} ${active.filter((p) => p.level === l.name).length}</span>`).join(' ')}</p>
    <p class="small muted">Nivågruppen är intern och syns bara för inloggade ledare. Den har inget med lagens färger i matchschemat att göra. <strong>Ordinarie</strong> tas ut först i förslagen, <strong>reserver</strong> fyller på när ordinarie inte räcker. Byt grupp när som helst; det påverkar bara kommande förslag.</p>
    <div class="tablewrap"><table class="players">
      <thead><tr><th>Namn</th><th>Grupp</th><th>Nivågrupp</th><th>Mål</th><th></th></tr></thead>
      <tbody>${ps.map((p) => `<tr class="${p.active === false ? 'archived' : ''}">
        <td>${esc(p.name)}</td>
        <td><select data-act="psquad" data-pid="${p.id}" class="${isReserve(p) ? 'isres' : ''}" aria-label="Grupp för ${esc(p.name)}"><option value="ordinarie" ${!isReserve(p) ? 'selected' : ''}>Ordinarie</option><option value="reserv" ${isReserve(p) ? 'selected' : ''}>Reserv</option></select></td>
        <td><select data-act="plevel" data-pid="${p.id}" aria-label="Nivågrupp för ${esc(p.name)}">${lv.map((l) => `<option ${l.name === p.level ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select></td>
        <td><input type="checkbox" data-act="pgoalie" data-pid="${p.id}" ${p.canGoalie ? 'checked' : ''} aria-label="${esc(p.name)} kan stå i mål"></td>
        <td><button class="linkbtn" data-act="parchive" data-pid="${p.id}" data-on="${p.active === false ? 1 : 0}">${p.active === false ? 'Återställ' : 'Arkivera'}</button></td>
      </tr>`).join('')}</tbody>
    </table></div>
    <form id="addp" class="row wrapform">
      <input name="name" placeholder="Namn" required maxlength="60">
      <select name="squad" aria-label="Grupp"><option value="ordinarie">Ordinarie</option><option value="reserv">Reserv</option></select>
      <select name="level" aria-label="Nivågrupp">${lv.map((l) => `<option>${esc(l.name)}</option>`).join('')}</select>
      <label class="check"><input type="checkbox" name="canGoalie"> Kan stå i mål</label>
      <button class="btn">Lägg till</button>
    </form>
  </section>
  <section class="panel">
    <h2>Tränare</h2>
    <p class="small muted">Koppla varje tränare till sitt barn. Förslagen sprider ledarbarnen så att varje lag får minst en ledare, och ordinarie ledare följer med sitt barn. Reservledare väljs manuellt på lagkortet.</p>
    <ul class="users">${[...(S.state.coaches || [])].sort((a, b) => (a.active === false) - (b.active === false) || res(a) - res(b) || a.name.localeCompare(b.name, 'sv')).map((c) => `<li class="${c.active === false ? 'archived' : ''}"><strong>${esc(c.name)}</strong>
      <select data-act="csquad" data-id="${c.id}" class="${isReserve(c) ? 'isres' : ''}" aria-label="Grupp för ${esc(c.name)}"><option value="ordinarie" ${!isReserve(c) ? 'selected' : ''}>Ordinarie</option><option value="reserv" ${isReserve(c) ? 'selected' : ''}>Reserv</option></select>
      <span class="small">Barn: ${(c.children || []).map((id) => esc(P(id)?.name || '?')).join(', ') || '<span class="muted">inget kopplat</span>'}</span>
      <button class="linkbtn" data-act="coachkids" data-id="${c.id}">välj barn</button>
      <button class="linkbtn" data-act="coachrename" data-id="${c.id}">byt namn</button>
      <button class="linkbtn" data-act="coacharchive" data-id="${c.id}" data-on="${c.active === false ? 1 : 0}">${c.active === false ? 'återställ' : 'arkivera'}</button></li>`).join('') || '<li class="muted">Inga tränare ännu.</li>'}</ul>
    <div class="row wrapform"><input id="newcoach" placeholder="Tränarens namn" maxlength="60"><button class="btn" data-act="addcoach">Lägg till tränare</button></div>
  </section>
  <section class="panel">
    <h2>Importera CSV</h2>
    <p class="small">Kolumner med rubrikrad: <code>Namn;Nivågrupp;Kan stå i mål;Grupp</code>. Grupp är <code>ordinarie</code> eller <code>reserv</code> och kan utelämnas (då blir nya spelare ordinarie och befintliga behåller sin grupp). Nivågrupp är ${lv.map((l) => `<code>${esc(l.name)}</code>`).join(', ')}. Mål är <code>ja</code> eller <code>nej</code>. Semikolon, komma och tabb fungerar, så det går bra att spara direkt från Excel. Filen läses i din webbläsare och bara spelarna sparas.</p>
    <form id="imp" class="stack">
      <input type="file" name="file" accept=".csv,.txt,text/csv">
      <textarea name="csv" rows="5" placeholder="…eller klistra in här">${esc(pv?.csv || '')}</textarea>
      <fieldset class="row"><label class="check"><input type="radio" name="mode" value="merge" ${pv?.mode !== 'replace' ? 'checked' : ''}> Lägg till och uppdatera</label>
      <label class="check"><input type="radio" name="mode" value="replace" ${pv?.mode === 'replace' ? 'checked' : ''}> Ersätt listan (arkivera spelare som saknas i filen)</label></fieldset>
      <button class="btn">Förhandsgranska</button>
    </form>
    <div id="impres">${pv ? importPreviewHtml(pv) : ''}</div>
  </section>`;
  $('#addp').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target, name = f.name.value.trim();
    if (S.state.players.some((p) => p.active !== false && p.name.toLowerCase() === name.toLowerCase())) return toast('Det finns redan en spelare med det namnet.', true);
    try { await B.addPlayer({ name, level: f.level.value, canGoalie: f.canGoalie.checked, squad: f.squad.value }); await refreshState(); viewPlayers(); toast('Spelaren är tillagd.'); }
    catch (err) { toast(err.message, true); }
  };
  const imp = $('#imp');
  imp.file.onchange = async () => { const fl = imp.file.files[0]; if (fl) imp.csv.value = await fl.text(); };
  imp.onsubmit = (e) => {
    e.preventDefault();
    S.importPreview = previewImport(imp.csv.value, imp.mode.value);
    $('#impres').innerHTML = importPreviewHtml(S.importPreview);
  };
}
function previewImport(csv, mode) {
  const { players, errors } = playersFromCsv(csv, levelNames());
  const existing = new Map(S.state.players.map((p) => [p.name.toLowerCase(), p]));
  const add = [], update = [], archive = [];
  for (const p of players) {
    const e = existing.get(p.name.toLowerCase());
    if (!e) add.push(p);
    else if (e.level !== p.level || e.canGoalie !== p.canGoalie || e.active === false || (p.squad && p.squad !== (e.squad || 'ordinarie'))) update.push({ ...p, id: e.id, from: { level: e.level, canGoalie: e.canGoalie, squad: e.squad || 'ordinarie' } });
  }
  if (mode === 'replace') {
    const names = new Set(players.map((p) => p.name.toLowerCase()));
    for (const e of S.state.players) if (e.active !== false && !names.has(e.name.toLowerCase())) archive.push({ id: e.id, name: e.name });
  }
  return { csv, mode, add, update, archive, errors, total: players.length };
}
function importPreviewHtml(pv) {
  return `<div class="preview">
    ${pv.errors.length ? `<div class="alert error"><strong>${pv.errors.length} rader behöver rättas</strong><ul>${pv.errors.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
    <p><strong>${pv.total}</strong> spelare i filen: ${pv.add.length} nya, ${pv.update.length} ändrade${pv.archive.length ? `, ${pv.archive.length} arkiveras` : ''}.</p>
    ${pv.add.length ? `<p class="small">Nya: ${pv.add.map((p) => esc(p.name)).join(', ')}</p>` : ''}
    ${pv.update.length ? `<p class="small">Ändras: ${pv.update.map((p) => `${esc(p.name)} (${esc(p.from.level)} → ${esc(p.level)}${p.from.canGoalie !== p.canGoalie ? ', mål ' + (p.canGoalie ? 'ja' : 'nej') : ''}${p.squad && p.squad !== p.from.squad ? ', ' + p.squad : ''})`).join(', ')}</p>` : ''}
    ${pv.archive.length ? `<p class="small">Arkiveras: ${pv.archive.map((p) => esc(p.name)).join(', ')}</p>` : ''}
    ${!pv.errors.length && (pv.add.length || pv.update.length || pv.archive.length) ? '<button class="btn primary" data-act="doimport">Importera</button>' : ''}
  </div>`;
}

// ---------- schema ----------
function syncBanner() {
  const sch = S.state.schedule;
  if (sch.last_error) return `<div class="alert error">Senaste hämtningen av matchschemat misslyckades (${fDT(sch.last_attempt)}): ${esc(sch.last_error)} ${sch.last_success ? `Schemat från ${fDT(sch.last_success)} visas.` : ''}</div>`;
  if (!sch.last_success) return `<div class="alert warn">Matchschemat har inte hämtats ännu. ${S.syncing ? 'Hämtar…' : 'Gå till Schema och tryck ”Hämta nu”.'}</div>`;
  if (Date.now() - Date.parse(sch.last_success) > 3 * 864e5) return `<div class="alert warn">Matchschemat hämtades senast ${fDT(sch.last_success)}.</div>`;
  return '';
}
function viewSchedule() {
  const sch = S.state.schedule;
  const groups = upcomingByDate();
  const byKey = new Map();
  for (const c of S.state.changes) if (!c.is_new && Date.now() - Date.parse(c.at) < 14 * 864e5) { if (!byKey.has(c.uppdrag_key)) byKey.set(c.uppdrag_key, []); byKey.get(c.uppdrag_key).push(c); }
  const hours = S.state.settings.syncHours || 24;
  const trig = { auto: 'när en ledare öppnade sidan', cron: 'schemalagd (GitHub)', manual: 'Hämta nu', demo: 'demo' };
  app.innerHTML = `
  ${syncBanner()}
  <section class="panel">
    <h2>Matchschema U9</h2>
    <dl class="kv">
      <dt>Senaste lyckade synk</dt><dd>${fDT(sch.last_success)}</dd>
      <dt>Senaste försök</dt><dd>${fDT(sch.last_attempt)} ${sch.last_trigger ? `<span class="small muted">(${esc(trig[sch.last_trigger] || sch.last_trigger)})</span>` : ''} ${sch.last_error ? '<span class="badge bad">misslyckades</span>' : ''}</dd>
      <dt>Nästa automatiska synk</dt><dd>${sch.last_attempt ? 'tidigast ' + fDT(new Date(Date.parse(sch.last_attempt) + hours * 3600e3).toISOString()) : 'snart'} (en gång per ${hours === 24 ? 'dygn' : hours + ' timmar'})</dd>
      <dt>Källan kontrollerade swehockey</dt><dd>${fDT(sch.source?.lastSuccess)}${sch.source && sch.source.lastAttemptOk === false ? ' <span class="badge bad">källans senaste kontroll misslyckades</span>' : ''}</dd>
    </dl>
    <button class="btn primary" data-act="sync">Hämta nu</button>
    <p class="small muted">Källa: den offentliga matchöversikten (JHCmatcher), som i sin tur läser stats.swehockey.se.</p>
  </section>
  <section class="panel">
    <h2>Hemmapoolspel – matchinbjudan</h2>
    ${(() => {
      const evs = (S.state.homeEvents || []).filter((e) => e.date >= S.state.today);
      if (!evs.length) return '<p class="small muted">Inga kommande hemmapoolspel hämtade ännu. Hela spelschemat för hemmapoolspel hämtas av den dagliga synken i GitHub.</p>';
      return `<ul class="rounds">${evs.map((e) => `<li><a href="#/matchinbjudan/${encodeURIComponent(e.key)}">
        <span class="rname">${esc(fDate(e.date))} · ${esc(e.venue)}</span>
        ${S.state.invitations?.[e.key] ? '<span class="badge ok">Inbjudan klar</span>' : '<span class="badge draft">Ej granskad</span>'}
        <span class="small muted block">${[...new Set(e.data.blocks.flatMap((b) => b.matches.flatMap((m) => [m.home, m.away])))].length} lag · ${e.data.blocks.reduce((n, b) => n + b.matches.length, 0)} matcher</span>
      </a></li>`).join('')}</ul>`;
    })()}
  </section>
  <section class="panel">
    <h2>Kommande poolspel</h2>

    ${[...groups].map(([d, us]) => `<h3 class="date">${fDate(d)}</h3>${us.map((u) => `
      <div class="sched ${u.missing ? 'missing' : ''}">
        <div><span class="tdot" style="--c:${teamColor(u)}"></span><strong>${esc(u.label)}</strong> · ${esc(u.venue)}${u.host ? ` · ${esc(u.host)}` : ''}
          ${u.missing ? '<span class="badge bad">Saknas i källan</span>' : ''}${byKey.has(u.key) ? '<span class="badge review">Ändrad</span>' : ''}</div>
        <div class="small">${u.matches.map((m) => `<span class="${m.missing ? 'strike' : ''}">${esc(m.start || '?')} ${esc(opponent(u, m))}</span>`).join(' · ')}</div>
        ${(byKey.get(u.key) || []).map((c) => `<div class="small changed">${fDT(c.at)}: ${c.items.map(esc).join('; ')}</div>`).join('')}
      </div>`).join('')}`).join('') || '<p class="muted">Inga kommande poolspel.</p>'}
  </section>
  <section class="panel">
    <h2>Upptäckta ändringar</h2>
    <ul class="log">${S.state.changes.slice(0, 100).map((c) => `<li><span class="small muted">${fDT(c.at)}</span> <strong>${esc(c.label || '')} ${fDate(c.date)}</strong>: ${c.items.map(esc).join('; ')}${c.ack_at ? ` <span class="small muted">(granskad av ${esc(c.ack_by_name)})</span>` : ''}</li>`).join('') || '<li class="muted">Inga ändringar sedan första hämtningen.</li>'}</ul>
  </section>`;
}

// ---------- historik ----------
function viewHistory() {
  const h = S.state.history;
  const stat = new Map();
  const get = (id) => stat.get(id) || (stat.set(id, { pool: 0, goalie: 0, mates: new Map() }), stat.get(id));
  for (const r of h) for (const t of r.teams) {
    for (const g of t.goalies) { get(g).pool++; get(g).goalie++; }
    for (const l of t.lines) for (const a of l) { get(a).pool++; for (const b of l) if (a !== b) get(a).mates.set(b, (get(a).mates.get(b) || 0) + 1); }
  }
  const ps = S.state.players.filter((p) => p.active !== false).sort((a, b) => a.name.localeCompare(b.name, 'sv'));
  app.innerHTML = `
  <section class="panel">
    <h2>Speltid och kedjekamrater</h2>
    <p class="small muted">Bygger på fastställda omgångar. Förslagen använder detta för att rotera målvakter och variera kedjor.</p>
    <div class="tablewrap"><table class="players">
      <thead><tr><th>Spelare</th><th>Poolspel</th><th>I mål</th><th>Oftast i kedja med</th></tr></thead>
      <tbody>${ps.map((p) => { const s = stat.get(p.id) || { pool: 0, goalie: 0, mates: new Map() };
        const top = [...s.mates].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([id, n]) => `${esc(P(id)?.name || '?')} ${n}`).join(', ');
        return `<tr><td><span class="ldot" style="--c:${levelColor(p.level)}"></span>${esc(p.name)}</td><td>${s.pool}</td><td>${s.goalie}</td><td class="small">${top || '–'}</td></tr>`; }).join('')}</tbody>
    </table></div>
  </section>
  <section class="panel">
    <h2>Fastställda omgångar</h2>
    ${[...h].reverse().map((r) => `<details><summary><strong>${esc(r.roundName)}</strong> <span class="small muted">fastställd ${fDT(r.confirmedAt)}</span></summary>
      ${r.teams.map((t) => `<p class="small"><strong>${esc(t.label)} ${fDate(t.date)}</strong>: MV ${t.goalies.map((id) => esc(P(id)?.name)).join(', ') || '–'} · ${t.lines.map((l, i) => `K${i + 1} ${l.map((id) => esc(P(id)?.name)).join(', ')}`).join(' · ')}</p>`).join('')}
      <a href="#/omgang/${r.roundId}" class="small">Öppna omgången</a></details>`).join('') || '<p class="muted">Inga fastställda omgångar ännu.</p>'}
  </section>`;
}

// ---------- ledare och inställningar ----------
async function viewLeaders() {
  const admin = S.me.role === 'admin';
  const data = admin ? await B.listLeaders() : { users: [], invites: [] };
  const st = S.state.settings;
  app.innerHTML = `
  <section class="panel">
    <h2>Ledare</h2>
    <form id="myname" class="row wrapform"><label>Ditt namn<input name="name" value="${esc(S.me.name)}" maxlength="60"></label><button class="btn">Spara namn</button></form>
    <p class="small">Dina roller: <strong>${esc(roleText(S.me))}</strong></p>
    ${admin ? `
    <p class="small muted"><strong>Lagplanerare</strong> ser nivåfärger och gör lagen. <strong>Lagledare</strong> ändrar matchinbjudningar och kan återställa borttagna rutiner. <strong>Ledare</strong> ser matcher och fastställda lag, och skriver rutiner. <strong>Administratör</strong> har allt och bjuder in.</p>
    <ul class="users">${data.users.map((u) => `<li><strong>${esc(u.name)}</strong> <span class="small muted">${esc(u.email)}</span>${u.id === S.me.id ? ' <span class="small muted">(du)</span>' : ''}
      <span class="rolechecks">
        <label class="check"><input type="checkbox" data-act="setroles" data-id="${u.id}" data-r="admin" ${u.role === 'admin' ? 'checked' : ''} ${u.id === S.me.id ? 'disabled' : ''}> Admin</label>
        <label class="check"><input type="checkbox" data-act="setroles" data-id="${u.id}" data-r="planner" ${u.planner || u.role === 'admin' ? 'checked' : ''}> Lagplanerare</label>
        <label class="check"><input type="checkbox" data-act="setroles" data-id="${u.id}" data-r="teamlead" ${u.teamlead || u.role === 'admin' ? 'checked' : ''}> Lagledare</label>
      </span>
      ${u.id !== S.me.id ? `<button class="linkbtn" data-act="newlink" data-email="${esc(u.email)}">ny inloggningslänk</button>
      <button class="linkbtn danger" data-act="deluser" data-id="${u.id}">ta bort</button>` : ''}</li>`).join('')}</ul>
    ${data.invites.length ? `<h3>Väntande inbjudningar</h3><ul class="users">${data.invites.map((i) => `<li>${esc(i.email)} <span class="small muted">gäller till ${fDT(i.expires)}</span> <button class="linkbtn danger" data-act="delinvite" data-id="${i.id}">dra tillbaka</button></li>`).join('')}</ul>` : ''}
    <h3>Bjud in ledare</h3>
    <form id="inv" class="row wrapform">
      <input type="email" name="email" placeholder="ledarens e-post" required>
      <label class="check"><input type="checkbox" name="planner"> Lagplanerare</label>
      <label class="check"><input type="checkbox" name="teamlead"> Lagledare</label>
      <label class="check"><input type="checkbox" name="admin"> Admin</label>
      <button class="btn primary">Skapa inbjudningslänk</button>
    </form>
    <div id="invlink"></div>
    <p class="small muted">Länken gäller i 7 dagar och kan bara användas en gång. Skicka den själv, t.ex. via sms eller mejl. Samma knapp används om någon har glömt sitt lösenord.</p>` : '<p class="small muted">Endast administratörer kan bjuda in ledare.</p>'}
  </section>
  ${admin ? `<section class="panel">
    <h2>Inställningar</h2>
    <form id="sets" class="stack">
      <fieldset><legend>Nivågrupper (intern, tre färger)</legend>
        ${st.levels.map((l, i) => `<div class="row"><input name="ln${i}" value="${esc(l.name)}" maxlength="20" aria-label="Nivå ${i + 1}"><input type="color" name="lc${i}" value="${esc(l.color)}" aria-label="Färg nivå ${i + 1}"></div>`).join('')}
        <p class="small muted">Ordningen avgör vilka som räknas som ”liknande nivå” i kedjorna. Byter du namn uppdateras alla spelare.</p>
      </fieldset>
      <fieldset><legend>Ersättare i andra hand</legend>
        <p class="small muted">När en spelare inte kan föreslås först spelare i samma nivågrupp, sedan de här (i ordning, skilj med komma).</p>
        ${st.levels.map((l, i) => `<label class="small">${esc(l.name)}<input name="sub${i}" value="${esc(subsFor(l.name).join(', '))}"></label>`).join('')}
      </fieldset>
      <label>Lagnamn i laglistan (före t.ex. ”U9 blå”)<input name="teamPrefix" value="${esc(st.teamPrefix)}"></label>
      <label>Automatisk synk när någon öppnar sidan, högst var … timme<input type="number" name="syncHours" min="1" max="168" value="${st.syncHours}"></label>
      <fieldset><legend>Startvärden för nya omgångar</legend><div class="grid4">
        <label>Utespelare<input type="number" name="skaters" min="1" max="20" value="${st.roundDefaults.skaters}"></label>
        <label>Målvakter<input type="number" name="goalies" min="0" max="3" value="${st.roundDefaults.goalies}"></label>
        <label>Kedjestorlek<input type="number" name="lineSize" min="1" max="10" value="${st.roundDefaults.lineSize}"></label>
</div></fieldset>
      <button class="btn">Spara inställningar</button>
    </form>
  </section>
  <section class="panel">
    <h2>Logga för laglistor</h2>
    <img src="${esc(st.logo || 'logo.png')}" alt="Nuvarande logga" class="logopreview">
    <p class="small muted">${st.logo ? 'En egen uppladdad logga används.' : 'Järfälla HC:s logga används som standard.'}</p>
    <div class="row wrapform"><input type="file" id="logofile" accept="image/png,image/jpeg,image/svg+xml,image/webp">
    ${st.logo ? '<button class="linkbtn danger" data-act="logoremove">ta bort loggan</button>' : ''}</div>
    <p class="small muted">Vill ni byta logga kan ni ladda upp en annan fil (PNG eller SVG). Ta bort den uppladdade för att gå tillbaka till standardloggan.</p>
  </section>
  <section class="panel">
    <h2>Säkerhetskopia</h2>
    <p class="small">Gratisnivån i Supabase tar inga säkerhetskopior. Ladda ner en kopia ibland, till exempel efter varje fastställd omgång, och spara den på ett säkert ställe. Filen innehåller spelaruppgifter.</p>
    <button class="btn" data-act="backup">Ladda ner säkerhetskopia</button>
    ${B.mode === 'demo' ? '<button class="btn" data-act="demoreset">Börja om demon</button>' : ''}
  </section>` : ''}`;
  $('#myname').onsubmit = async (e) => {
    e.preventDefault();
    try { await B.setMyName(e.target.name.value); S.me.name = e.target.name.value.trim(); route(); toast('Namnet är sparat.'); } catch (err) { toast(err.message, true); }
  };
  if (!admin) return;
  $('#inv').onsubmit = async (e) => { e.preventDefault(); const f = e.target; await makeInvite(f.email.value, { planner: f.planner.checked, teamlead: f.teamlead.checked, admin: f.admin.checked }); };
  $('#logofile').onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const logo = await readLogo(f);
      await B.saveSettings({ ...S.state.settings, logo }, {});
      await refreshState(); toast('Loggan är sparad.'); viewLeaders();
    } catch (err) { toast(err.message, true); }
  };
  $('#sets').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    const levels = [0, 1, 2].map((i) => ({ name: f[`ln${i}`].value.trim(), color: f[`lc${i}`].value }));
    if (levels.some((l) => !l.name) || new Set(levels.map((l) => l.name.toLowerCase())).size !== 3) return toast('Ange tre olika nivånamn.', true);
    const hours = Number(f.syncHours.value);
    if (!(hours >= 1 && hours <= 168)) return toast('Synkintervallet ska vara 1–168 timmar.', true);
    const rename = {};
    st.levels.forEach((l, i) => { if (l.name !== levels[i].name) rename[l.name] = levels[i].name; });
    const rd = { ...Object.fromEntries(['skaters', 'goalies', 'lineSize'].map((k) => [k, parseInt(f[k].value, 10) || 0])), maxPerPlayer: 1 };
    const substitutes = Object.fromEntries(levels.map((l, i) => [l.name, f[`sub${i}`].value.split(',').map((x) => x.trim()).map((x) => rename[x] || x).filter(Boolean)]));
    try { await B.saveSettings({ ...st, levels, substitutes, teamPrefix: f.teamPrefix.value.trim(), syncHours: hours, roundDefaults: rd }, rename); await refreshState(); toast('Inställningarna är sparade.'); viewLeaders(); }
    catch (err) { toast(err.message, true); }
  };
}
async function readLogo(file) {
  const dataUrl = await new Promise((ok, bad) => { const fr = new FileReader(); fr.onload = () => ok(fr.result); fr.onerror = () => bad(new Error('Kunde inte läsa filen.')); fr.readAsDataURL(file); });
  if (file.type === 'image/svg+xml') { if (dataUrl.length > 300000) throw new Error('SVG-filen är för stor (max ca 200 kB).'); return dataUrl; }
  const img = await new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => bad(new Error('Filen är ingen bild som går att läsa.')); i.src = dataUrl; });
  const scale = Math.min(1, 500 / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  const out = c.toDataURL('image/png');
  if (out.length > 400000) throw new Error('Bilden är för stor. Prova en mindre fil.');
  return out;
}
const roleText = (u) => (u.role === 'admin' || u.admin ? 'Administratör' : [u.planner && 'Lagplanerare', u.teamlead && 'Lagledare'].filter(Boolean).join(', ') || 'Ledare');
async function makeInvite(email, roles = {}) {
  try {
    const r = await B.createInvite(email, roles);
    $('#invlink').innerHTML = `<div class="alert ok"><div>Inbjudningslänk för <strong>${esc(r.email)}</strong>, gäller till ${fDT(r.expires)}:</div><input readonly value="${esc(r.link)}" class="mono" id="linkfield"><button class="btn" data-act="copylink">Kopiera länken</button></div>`;
  } catch (e) { toast(e.message, true); }
}

// ---------- reserver och tränare ----------
function historyApps() {
  const n = new Map();
  for (const h of S.state.history) for (const t of h.teams) for (const id of [...t.goalies, ...t.lines.flat()]) n.set(id, (n.get(id) || 0) + 1);
  return n;
}
function busyOnDate(pid, date) {
  return S.round.keys.find((k) => U(k)?.date === date && [...S.round.teams[k].goalies, ...S.round.teams[k].lines.flat()].includes(pid));
}
function reserveDialog(key) {
  const u = U(key), apps = historyApps();
  const list = S.state.players.filter((p) => p.active !== false && isReserve(p) && isAvail(key, p.id) && !busyOnDate(p.id, u?.date))
    .sort((a, b) => (apps.get(a.id) || 0) - (apps.get(b.id) || 0) || a.name.localeCompare(b.name, 'sv'));
  const t = S.round.teams[key];
  const inTeam = new Set([...t.goalies, ...t.lines.flat()]);
  const placedSomewhere = (pid) => S.round.keys.some((k) => [...S.round.teams[k].goalies, ...S.round.teams[k].lines.flat()].includes(pid));
  const extras = S.state.players.filter((p) => p.active !== false && !isReserve(p) && !inTeam.has(p.id) && placedSomewhere(p.id) && isAvail(key, p.id))
    .sort((a, b) => a.name.localeCompare(b.name, 'sv'));
  const where = (pid) => S.round.keys.filter((k) => [...S.round.teams[k].goalies, ...S.round.teams[k].lines.flat()].includes(pid)).map((k) => `${U(k)?.label.replace('U9 ', '')}${U(k)?.date === u?.date ? ', samma dag!' : ''}`).join('; ');
  const freeOrd = S.state.players.filter((p) => p.active !== false && !isReserve(p) && !placedSomewhere(p.id) && isAvail(key, p.id)).sort((a, b) => a.name.localeCompare(b.name, 'sv'));
  const opt = (p, extra) => `<option value="${p.id}" data-extra="${extra ? 1 : 0}">${esc(p.name)}${p.canGoalie ? ' (MV)' : ''}${extra ? ` – spelar redan i ${esc(where(p.id))}` : ` – ${apps.get(p.id) || 0} poolspel`}</option>`;
  const any = list.length || extras.length || freeOrd.length;
  const dlg = $('#dlg');
  dlg.innerHTML = `
  <form method="dialog" class="stack">
    <h2>Lägg till spelare</h2>
    <p class="small">${esc(u?.label)} · ${fDate(u?.date)}</p>
    ${any ? `
    <label>Spelare
      <select name="pid">
        ${list.length ? `<optgroup label="Reserver (färst spelade poolspel överst)">${list.map((p) => opt(p, false)).join('')}</optgroup>` : ''}
        ${freeOrd.length ? `<optgroup label="Ordinarie som inte är uttagna">${freeOrd.map((p) => opt(p, false)).join('')}</optgroup>` : ''}
        ${extras.length ? `<optgroup label="Ordinarie som redan spelar i ett annat lag (spelar två gånger)">${extras.map((p) => opt(p, true)).join('')}</optgroup>` : ''}
      </select>
    </label>
    <label>Roll
      <select name="role"><option value="S">Utespelare${t.lines.length ? ` (kedja ${t.lines.length})` : ''}</option><option value="SN">Utespelare, ny kedja</option><option value="G">Målvakt</option></select>
    </label>
    <p class="small muted">Spelaren låses i laget så att den ligger kvar om ni skapar ett nytt förslag. Väljer du en ordinarie som redan spelar i ett annat lag blir hen kvar där också.</p>` : '<p>Det finns ingen ledig spelare som kan det här poolspelet. Kontrollera tillgängligheten eller markera fler spelare som reserv.</p>'}
    <div class="row">${any ? '<button class="btn primary" value="save">Lägg till</button>' : ''}<button class="btn" value="cancel" formnovalidate>Avbryt</button></div>
  </form>`;
  dlg.showModal();
  dlg.onclose = async () => {
    if (dlg.returnValue !== 'save') return;
    const f = dlg.querySelector('form');
    const role = f.role.value;
    const extra = f.pid.selectedOptions[0]?.dataset.extra === '1';
    const args = { pid: f.pid.value, toKey: key, role: role === 'G' ? 'G' : 'S', line: role === 'S' && t.lines.length ? t.lines.length - 1 : null };
    await act(extra ? 'addExtra' : 'move', extra ? args : { ...args, fromKey: null, lock: true });
  };
}
function coachDialog(key) {
  const u = U(key), t = S.round.teams[key];
  const chosen = new Set(t.coaches || []);
  const elsewhere = (cid) => S.round.keys.filter((k) => k !== key && U(k)?.date === u?.date && (S.round.teams[k].coaches || []).includes(cid)).map((k) => U(k)?.label);
  const kids = new Set([...t.goalies, ...t.lines.flat()]);
  const list = (S.state.coaches || []).filter((c) => c.active !== false || chosen.has(c.id)).sort((a, b) => res(a) - res(b) || a.name.localeCompare(b.name, 'sv'));
  const notes = (c) => [isReserve(c) ? 'reserv' : '', !coachAvail(key, c.id) ? 'kan inte' : '', (c.children || []).some((id) => kids.has(id)) ? 'barn i laget' : ''].filter(Boolean);
  const dlg = $('#dlg');
  dlg.innerHTML = `
  <form method="dialog" class="stack">
    <h2>Tränare</h2>
    <p class="small">${esc(u?.label)} · ${fDate(u?.date)}</p>
    <p class="small muted">Valda tränare låses i laget och ligger kvar om ni skapar ett nytt förslag.</p>
    ${list.length ? list.map((c) => { const o = elsewhere(c.id); const n = notes(c); return `<label class="check"><input type="checkbox" name="c" value="${c.id}" ${chosen.has(c.id) ? 'checked' : ''}> ${esc(c.name)}${n.length ? ` <span class="small muted">(${esc(n.join(', '))})</span>` : ''}${o.length ? ` <span class="small muted">(vald i ${esc(o.join(', '))} samma dag)</span>` : ''}</label>`; }).join('')
      : '<p>Inga tränare finns ännu. Lägg till dem under <strong>Spelare → Tränare</strong>.</p>'}
    <div class="row">${list.length ? '<button class="btn primary" value="save">Spara</button>' : ''}<button class="btn" value="cancel" formnovalidate>Avbryt</button></div>
  </form>`;
  dlg.showModal();
  dlg.onclose = async () => {
    if (dlg.returnValue !== 'save') return;
    const ids = [...dlg.querySelectorAll('input[name=c]:checked')].map((x) => x.value);
    if (S.round.status === 'fastställt') { toast('Öppna omgången som utkast för att ändra tränare.', true); return; }
    await act('setCoaches', { key, ids });
  };
}

function kidsDialog(cid) {
  const c = C(cid);
  const chosen = new Set(c.children || []);
  const ps = S.state.players.filter((p) => p.active !== false || chosen.has(p.id)).sort((a, b) => a.name.localeCompare(b.name, 'sv'));
  const dlg = $('#dlg');
  dlg.innerHTML = `
  <form method="dialog" class="stack">
    <h2>Barn till ${esc(c.name)}</h2>
    <input type="search" placeholder="Sök spelare" id="kidsearch">
    <div class="kidlist">${ps.map((p) => `<label class="check" data-name="${esc(p.name.toLowerCase())}"><input type="checkbox" name="k" value="${p.id}" ${chosen.has(p.id) ? 'checked' : ''}> ${esc(p.name)}</label>`).join('')}</div>
    <div class="row"><button class="btn primary" value="save">Spara</button><button class="btn" value="cancel" formnovalidate>Avbryt</button></div>
  </form>`;
  dlg.showModal();
  $('#kidsearch').oninput = (e) => { const q = e.target.value.toLowerCase(); dlg.querySelectorAll('.kidlist label').forEach((l) => { l.hidden = q && !l.dataset.name.includes(q); }); };
  dlg.onclose = async () => {
    if (dlg.returnValue !== 'save') return;
    const children = [...dlg.querySelectorAll('input[name=k]:checked')].map((x) => x.value);
    try { await B.updateCoach(cid, { children }); await refreshState(); viewPlayers(); toast('Kopplingen är sparad.'); } catch (e) { toast(e.message, true); }
  };
}

// ---------- utskrift / PDF ----------
async function viewPrint(roundId, onlyKey) {
  const r = await B.getRound(roundId);
  const keys = onlyKey ? [onlyKey] : r.keys;
  const showInfo = localStorage.getItem('jhc-print-info') !== '0';
  const logo = S.state.settings.logo || 'logo.png'; // klubbens logga följer med sidan; en uppladdad logga går före
  const name = (id) => esc(P(id)?.name || '');
  document.body.classList.add('printmode');
  $('#top').hidden = true;
  app.innerHTML = `
  <div class="noprint printbar">
    <a href="#/omgang/${r.id}" class="btn">← Tillbaka</a>
    <button class="btn primary" data-act="print">Skriv ut / Spara som PDF</button>
    <label class="check"><input type="checkbox" id="pinfo" ${showInfo ? 'checked' : ''}> Visa datum, hall och matchtider</label>
    <p class="small muted">Välj <strong>Spara som PDF</strong> som skrivare i utskriftsrutan. På mobilen: Dela → Skriv ut, och nyp ut förhandsvisningen för att spara som PDF.</p>
    ${r.status !== 'fastställt' ? '<p class="alert warn small">Omgången är inte fastställd ännu.</p>' : ''}
  </div>
  ${keys.map((k) => {
    const t = r.teams[k] || { goalies: [], lines: [] }, u = U(k);
    const sk = t.lines.flat();
    return `<section class="sheet">
      <header class="sheethead">
        ${logo ? `<img src="${esc(logo)}" alt="Järfälla HC" class="logo">` : ''}
        <div><h1>${esc(teamFullName(k))}</h1>
        ${showInfo && u ? `<p class="sub">${esc(fDate(u.date))} · ${esc(u.venue)}${u.matches?.length ? ' · ' + u.matches.filter((m) => !m.missing).map((m) => esc(m.start || '')).filter(Boolean).join(', ') : ''}</p>` : ''}</div>
      </header>
      <h2>Målvakt</h2>
      <ol>${t.goalies.map((id) => `<li>${name(id)}</li>`).join('') || '<li class="none">–</li>'}</ol>
      <h2>Utespelare</h2>
      <ol>${sk.map((id) => `<li>${name(id)}</li>`).join('') || '<li class="none">–</li>'}</ol>
      <h2>Tränare</h2>
      <ul>${(t.coaches || []).map((id) => `<li>${esc(C(id)?.name || '')}</li>`).join('') || '<li class="none">–</li>'}</ul>
    </section>`;
  }).join('')}`;
  $('#pinfo').onchange = (e) => { localStorage.setItem('jhc-print-info', e.target.checked ? '1' : '0'); viewPrint(roundId, onlyKey); };
}

// ---------- rutinbank ----------
const catName = (id) => (S.state.routineCategories || []).find((c) => c.id === id)?.name || '';
const canRestore = () => S.me.teamlead || S.me.planner;
function viewRoutines() {
  const all = S.state.routines || [];
  const cats = [...(S.state.routineCategories || [])].sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name, 'sv'));
  const q = (S.routineQuery || '').toLowerCase();
  const live = all.filter((r) => !r.deletedAt && (!q || r.title.toLowerCase().includes(q)));
  const trash = all.filter((r) => r.deletedAt);
  const item = (r) => `<li><a href="#/rutin/${r.id}"><span class="rname">${esc(r.title)}</span>
    <span class="small muted block">Uppdaterad ${fDT(r.updatedAt)} av ${esc(r.updatedByName || '')}</span></a></li>`;
  const uncategorized = live.filter((r) => !cats.some((c) => c.id === r.categoryId));
  const purgeDate = (r) => fDate(new Date(Date.parse(r.deletedAt) + 30 * 864e5).toISOString().slice(0, 10));
  app.innerHTML = `
  <section class="panel">
    <div class="row"><h2 style="flex:1;margin:0">Rutinbank</h2><a class="btn primary" href="#/rutin/ny">+ Ny rutin</a></div>
    <label class="small">Sök<input type="search" id="rsearch" value="${esc(S.routineQuery || '')}" placeholder="t.ex. kiosk, sekretariat"></label>
    ${cats.map((c) => { const list = live.filter((r) => r.categoryId === c.id); return `<h3>${esc(c.name)}</h3><ul class="rounds">${list.map(item).join('') || '<li class="muted small">Inga rutiner i kategorin.</li>'}</ul>`; }).join('')}
    ${uncategorized.length ? `<h3>Utan kategori</h3><ul class="rounds">${uncategorized.map(item).join('')}</ul>` : ''}
    ${!live.length && !cats.length ? '<p class="muted">Inga rutiner ännu. Skapa den första!</p>' : ''}
  </section>
  <section class="panel"><h2>Kategorier</h2>
    <ul class="users">${cats.map((c) => `<li>${esc(c.name)} <button class="linkbtn" data-act="catrename" data-id="${c.id}">byt namn</button>${canRestore() ? ` <button class="linkbtn danger" data-act="catdelete" data-id="${c.id}">ta bort</button>` : ''}</li>`).join('') || '<li class="muted">Inga kategorier ännu.</li>'}</ul>
    <div class="row wrapform"><input id="newcat" placeholder="Ny kategori, t.ex. Hemmapoolspel" maxlength="40"><button class="btn" data-act="catadd">Lägg till</button></div>
  </section>
  ${canRestore() ? `<section class="panel"><h2>Borttagna rutiner <span class="small muted">syns bara för lagledare och lagplanerare, raderas för gott efter 30 dagar</span></h2>
    <ul class="users">${trash.map((r) => `<li><strong>${esc(r.title)}</strong> <span class="small muted">borttagen ${fDT(r.deletedAt)} av ${esc(r.deletedByName || '')} · raderas ${esc(purgeDate(r))}</span>
      <button class="linkbtn" data-act="routinerestore" data-id="${r.id}">återställ</button> <button class="linkbtn danger" data-act="routinepurge" data-id="${r.id}">radera nu</button></li>`).join('') || '<li class="muted">Papperskorgen är tom.</li>'}</ul>
  </section>` : ''}`;
  $('#rsearch').oninput = (e) => { S.routineQuery = e.target.value; const pos = e.target.selectionStart; viewRoutines(); const el = $('#rsearch'); el.focus(); el.setSelectionRange(pos, pos); };
}
function routineBody(r) {
  const c = r.content || {};
  const list = (items) => (items || []).filter(Boolean).map((x) => `<li>${esc(x)}</li>`).join('');
  const sec = (title, items) => (items || []).filter(Boolean).length ? `<section class="rsec"><h2>${title}</h2><ul class="checklist">${list(items)}</ul></section>` : '';
  return `
    ${c.purpose ? `<section class="rsec"><h2>Syfte</h2><p>${esc(c.purpose)}</p></section>` : ''}
    ${sec('Före', c.before)}${sec('Under', c.during)}${sec('Efter', c.after)}
    ${c.problem ? `<section class="rsec problem"><h2>Vid problem</h2><p>${esc(c.problem)}</p></section>` : ''}`;
}
const routineMeta = (r) => `<dl class="rmeta">
  <div><dt>Ansvarig</dt><dd>${esc(r.content?.responsible || '–')}</dd></div>
  <div><dt>Gäller för</dt><dd>${esc(r.content?.appliesTo || '–')}</dd></div>
  <div><dt>Version</dt><dd>${r.version} · ${esc(fDT(r.updatedAt))}</dd></div>
  <div><dt>Senast ändrad av</dt><dd>${esc(r.updatedByName || '')}</dd></div></dl>`;
async function viewRoutine(id) {
  const r = await B.getRoutine(id);
  const versions = canRestore() ? await B.getRoutineVersions(id).catch(() => []) : [];
  app.innerHTML = `
  ${r.deletedAt ? `<div class="alert warn">Rutinen togs bort ${fDT(r.deletedAt)} av ${esc(r.deletedByName || '')}. <button class="btn small" data-act="routinerestore" data-id="${r.id}">Återställ</button></div>` : ''}
  <div class="row noprint"><a href="#/rutiner" class="back" style="flex:1">← Rutinbank</a>
    <a class="btn" href="#/rutin/${r.id}/utskrift">Skriv ut / PDF</a>
    ${r.deletedAt ? '' : `<a class="btn primary" href="#/rutin/${r.id}/redigera">Redigera</a>`}</div>
  <article class="routine">
    <header class="rhead"><img src="${esc(S.state.settings.logo || 'logo.png')}" alt="Järfälla HC"><div><span class="rkicker">Rutin${r.categoryId ? ' · ' + esc(catName(r.categoryId)) : ''}</span><h1>${esc(r.title)}</h1></div></header>
    ${routineMeta(r)}
    <div class="rbody">${routineBody(r)}</div>
  </article>
  ${versions.length ? `<details class="panel noprint"><summary><strong>Ändringshistorik</strong> <span class="small muted">${versions.length} tidigare versioner</span></summary>
    <ul class="log">${versions.map((v) => `<li><span class="small muted">${fDT(v.savedAt)}</span> version ${v.version} av ${esc(v.savedByName || '')}${v.title !== r.title ? ` (rubrik: ${esc(v.title)})` : ''}</li>`).join('')}</ul></details>` : ''}
  ${r.deletedAt ? '' : `<p class="noprint"><button class="linkbtn danger" data-act="routinedelete" data-id="${r.id}">Ta bort rutinen</button></p>`}`;
}
async function printRoutine(id) {
  const r = await B.getRoutine(id);
  document.body.classList.add('printmode'); $('#top').hidden = true;
  app.innerHTML = `
  <div class="noprint printbar"><a href="#/rutin/${r.id}" class="btn">← Tillbaka</a><button class="btn primary" data-act="print">Skriv ut / Spara som PDF</button></div>
  <section class="sheet routine-sheet">
    <header class="sheethead"><img src="${esc(S.state.settings.logo || 'logo.png')}" alt="Järfälla HC" class="logo"><div><p class="kicker">Järfälla Hockey Club · Rutin${r.categoryId ? ' · ' + esc(catName(r.categoryId)) : ''}</p><h1>${esc(r.title)}</h1></div></header>
    ${routineMeta(r)}
    <div class="rbody">${routineBody(r)}</div>
    <footer class="sheetfoot"><span>Järfälla HC U9 · Rutinbanken</span><span>Utskriven ${esc(fDate(stockholmToday()))} · version ${r.version}</span></footer>
  </section>`;
}
async function editRoutine(id) {
  const r = id ? await B.getRoutine(id) : { title: '', categoryId: null, content: { before: [''], during: [''], after: [''] } };
  const c = r.content || {};
  const cats = S.state.routineCategories || [];
  const listField = (name, label, items) => `<fieldset class="rfield"><legend>${label}</legend>
    <div class="items" data-list="${name}">${(items && items.length ? items : ['']).map((x) => `<input name="${name}" value="${esc(x)}" placeholder="En punkt per rad">`).join('')}</div>
    <button type="button" class="linkbtn" data-act="additem" data-list="${name}">+ Lägg till punkt</button></fieldset>`;
  app.innerHTML = `
  <a href="${id ? `#/rutin/${id}` : '#/rutiner'}" class="back">← Avbryt</a>
  <section class="panel">
    <h2>${id ? 'Redigera rutin' : 'Ny rutin'}</h2>
    <p class="small muted">Du skriver bara innehållet. Logga, färger och upplägg kommer från klubbens mall. Rutinen syns för alla ledare så fort du sparar.</p>
    <form id="rform" class="stack">
      <label>Rubrik<input name="title" value="${esc(r.title)}" required maxlength="120"></label>
      <div class="grid4">
        <label>Kategori<select name="categoryId"><option value="">Ingen kategori</option>${cats.map((k) => `<option value="${k.id}" ${r.categoryId === k.id ? 'selected' : ''}>${esc(k.name)}</option>`).join('')}<option value="__new">+ Ny kategori…</option></select></label>
        <label class="newcatfield" hidden>Ny kategori<input name="newcat" maxlength="40" placeholder="t.ex. Hemmapoolspel"></label>
        <label>Ansvarig<input name="responsible" value="${esc(c.responsible || '')}" maxlength="80"></label>
        <label>Gäller för<input name="appliesTo" value="${esc(c.appliesTo || '')}" maxlength="80"></label>
      </div>
      <label>Syfte <span class="small muted">Varför finns rutinen? 1–2 meningar.</span><textarea name="purpose" rows="3">${esc(c.purpose || '')}</textarea></label>
      ${listField('before', 'Före', c.before)}${listField('during', 'Under', c.during)}${listField('after', 'Efter', c.after)}
      <label>Vid problem<input name="problem" value="${esc(c.problem || '')}" placeholder="Vem ringer man?"></label>
      <div class="row"><button class="btn primary">Spara</button></div>
    </form>
  </section>`;
  const f = $('#rform');
  f.categoryId.onchange = () => { f.querySelector('.newcatfield').hidden = f.categoryId.value !== '__new'; if (f.categoryId.value === '__new') f.newcat.focus(); };
  f.onsubmit = async (e) => {
    e.preventDefault();
    const items = (n) => [...f.querySelectorAll(`input[name=${n}]`)].map((x) => x.value.trim()).filter(Boolean);
    try {
      let categoryId = f.categoryId.value || null;
      if (categoryId === '__new') {
        const name = f.newcat.value.trim();
        if (!name) { toast('Skriv ett namn på den nya kategorin.', true); return; }
        await B.addCategory(name.slice(0, 40), cats.length + 1);
        await refreshState();
        categoryId = (S.state.routineCategories || []).find((k) => k.name === name.slice(0, 40))?.id || null;
      }
      const nid = await B.saveRoutine({
        id: r.id, title: f.title.value.trim(), categoryId,
        content: { responsible: f.responsible.value.trim(), appliesTo: f.appliesTo.value.trim(), purpose: f.purpose.value.trim(), before: items('before'), during: items('during'), after: items('after'), problem: f.problem.value.trim() },
      });
      await refreshState(); toast('Rutinen är sparad.'); location.hash = `#/rutin/${nid}`;
    } catch (err) { toast(err.message, true); }
  };
}

// ---------- ersättare ----------
const DEFAULT_SUBS = { Grön: ['Lila'], Orange: ['Lila'], Lila: ['Orange', 'Grön'] };
const subsFor = (level) => S.state.settings.substitutes?.[level] ?? DEFAULT_SUBS[level] ?? [];
function suggestReplacements(pid, key) {
  const p = P(pid), u = U(key), apps = historyApps();
  const t = S.round.teams[key];
  const isGoalie = t.goalies.includes(pid);
  const subs = subsFor(p.level);
  const tier = (q) => (q.level === p.level ? 0 : subs.includes(q.level) ? 1 + subs.indexOf(q.level) : 9);
  return S.state.players
    .filter((q) => q.active !== false && q.id !== pid && isAvail(key, q.id) && !busyOnDate(q.id, u?.date))
    .map((q) => ({ q, tier: tier(q), apps: apps.get(q.id) || 0 }))
    .sort((a, b) => a.tier - b.tier || (isGoalie ? b.q.canGoalie - a.q.canGoalie : 0) || a.apps - b.apps || a.q.name.localeCompare(b.q.name, 'sv'));
}
function replacementDialog(pid, key) {
  const p = P(pid), u = U(key);
  const all = suggestReplacements(pid, key);
  const groups = [['Samma nivågrupp', all.filter((x) => x.tier === 0).slice(0, 4)], ...subsFor(p.level).map((lv, i) => [`I andra hand: ${lv}`, all.filter((x) => x.tier === i + 1).slice(0, 3)])];
  const rest = all.filter((x) => x.tier === 9);
  const row = (x) => `<li><span><span class="ldot" style="--c:${levelColor(x.q.level)}"></span><strong>${esc(x.q.name)}</strong>${x.q.canGoalie ? '<span class="mv">MV</span>' : ''}${isReserve(x.q) ? '<span class="res">R</span>' : ''}
      <span class="small muted block">${x.apps} poolspel hittills</span></span>
      <button class="btn small primary" value="${x.q.id}">Kalla in</button></li>`;
  const dlg = $('#dlg');
  dlg.innerHTML = `
  <form method="dialog" class="stack">
    <h2>Ersättare för ${esc(p.name)}</h2>
    <p class="small">${esc(u?.label)} · ${fDate(u?.date)} · ${esc(p.level || '')}${S.round.teams[key].goalies.includes(pid) ? ' · målvakt' : ''}</p>
    <p class="small muted">Förslag bland spelare som kan och inte redan spelar den dagen. De som spelat minst antal poolspel står först.</p>
    ${groups.filter(([, l]) => l.length).map(([h, l]) => `<h4>${esc(h)}</h4><ul class="sublist">${l.map(row).join('')}</ul>`).join('') || '<p>Inga lediga spelare i samma eller närliggande nivågrupp.</p>'}
    ${rest.length ? `<details><summary class="small">Övriga lediga (${rest.length})</summary><ul class="sublist">${rest.slice(0, 10).map(row).join('')}</ul></details>` : ''}
    <div class="row"><button class="btn" value="cancel" formnovalidate>Inte nu</button></div>
  </form>`;
  dlg.showModal();
  dlg.onclose = async () => {
    const v = dlg.returnValue;
    if (!v || v === 'cancel') return;
    if (await act('replace', { outPid: pid, inPid: v, key })) toast(`${P(v)?.name} är inkallad.`);
  };
}

// ---------- dra och släpp ----------
const DRAG = { el: null, ghost: null, start: null, timer: null, active: false, suppressClick: false, over: null };
function startDrag(x, y) {
  if (!DRAG.el) return;
  DRAG.active = true;
  const g = DRAG.el.cloneNode(true);
  g.classList.add('ghost');
  document.body.append(g);
  DRAG.ghost = g;
  DRAG.el.classList.add('dragging-src');
  document.body.classList.add('dragging');
  moveGhost(x, y);
}
function dropZoneAt(x, y) {
  if (DRAG.ghost) DRAG.ghost.style.display = 'none';
  const el = document.elementFromPoint(x, y);
  if (DRAG.ghost) DRAG.ghost.style.display = '';
  return el?.closest('[data-drop-key],[data-drop-bench]') || null;
}
function moveGhost(x, y) {
  DRAG.ghost.style.transform = `translate(${x - 20}px, ${y - 18}px)`;
  const z = dropZoneAt(x, y);
  if (z !== DRAG.over) { DRAG.over?.classList.remove('dragover'); z?.classList.add('dragover'); DRAG.over = z; }
}
function endDrag() {
  clearTimeout(DRAG.timer);
  DRAG.ghost?.remove();
  DRAG.el?.classList.remove('dragging-src');
  DRAG.over?.classList.remove('dragover');
  document.body.classList.remove('dragging');
  Object.assign(DRAG, { el: null, ghost: null, active: false, over: null });
}
document.addEventListener('pointerdown', (e) => {
  const c = e.target.closest('button.pl[data-act=player]');
  if (!c || !S.round || S.round.status === 'fastställt' || !S.me?.planner || e.button > 0 || !c.closest('#app')) return;
  Object.assign(DRAG, { el: c, start: { x: e.clientX, y: e.clientY }, type: e.pointerType, active: false, pid: c.dataset.pid, fromKey: c.dataset.key || null });
  clearTimeout(DRAG.timer);
  if (e.pointerType !== 'mouse') DRAG.timer = setTimeout(() => startDrag(DRAG.start.x, DRAG.start.y), 300);
});
document.addEventListener('pointermove', (e) => {
  if (!DRAG.el) return;
  if (!DRAG.active) {
    const dist = Math.hypot(e.clientX - DRAG.start.x, e.clientY - DRAG.start.y);
    if (DRAG.type === 'mouse' && dist > 6) startDrag(e.clientX, e.clientY);
    else if (DRAG.type !== 'mouse' && dist > 10) endDrag(); // fingret skrollar
    return;
  }
  moveGhost(e.clientX, e.clientY);
});
document.addEventListener('touchmove', (e) => { if (DRAG.active) e.preventDefault(); }, { passive: false });
document.addEventListener('contextmenu', (e) => { if (DRAG.active || DRAG.el) e.preventDefault(); });
document.addEventListener('pointercancel', () => endDrag());
document.addEventListener('pointerup', async (e) => {
  if (!DRAG.el) return;
  if (!DRAG.active) { endDrag(); return; }
  const z = dropZoneAt(e.clientX, e.clientY);
  const { pid, fromKey } = DRAG;
  endDrag();
  DRAG.suppressClick = true; setTimeout(() => { DRAG.suppressClick = false; }, 80);
  if (!z) return;
  if (z.dataset.dropBench) { if (fromKey) await act('move', { pid, fromKey, toKey: null }); return; }
  const toKey = z.dataset.dropKey, role = z.dataset.dropRole, line = z.dataset.dropLine;
  const cur = fromKey ? placementOf(pid).find((x) => x.key === fromKey) : null;
  if (cur && fromKey === toKey && cur.role === role && (role === 'G' || String(cur.line) === line)) return;
  await act('move', { pid, fromKey, toKey, role, line: line === undefined || line === 'new' ? null : Number(line) });
});

// ---------- matchinbjudan ----------
function eventView(key) {
  const ev = (S.state.homeEvents || []).find((e) => e.key === key);
  if (!ev) return null;
  const data = S.state.invitations?.[key] || {};
  const arenaId = data.arena || arenaFor(ev.venue);
  const arena = { ...ARENAS[arenaId], address: data.address || ARENAS[arenaId].address };
  const matches = buildMatches(ev, data);
  const teams = [...new Set(matches.flatMap((m) => [m.home, m.away]))].sort((a, b) => (isOurs(b) - isOurs(a)) || a.localeCompare(b, 'sv'));
  const colors = resolveColors(teams, S.state.teamColors || {});
  const jer = assignJerseys(matches, colors, data.kits || {});
  // Texter som inte ändrats följer hallvalet
  const pick = (field, def) => (data[field] !== undefined && data[`${field}Arena`] === arenaId ? data[field] : def);
  const texts = {
    rooms: pick('rooms', DEFAULT_TEXTS.rooms[arenaId]), important: pick('important', DEFAULT_TEXTS.important[arenaId]),
    parking: pick('parking', DEFAULT_TEXTS.parking[arenaId]), kiosk: data.kiosk ?? DEFAULT_TEXTS.kiosk, other: data.other || '',
  };
  return { ev, data, arenaId, arena, matches, jer, teams, texts, colors };
}
const logoOf = (team) => (isOurs(team) ? (S.state.settings.logo || 'logo.png') : S.state.clubs?.[clubOf(team)]?.logo || null);
const teamLogo = (team, cls = 'tlogo') => { const l = logoOf(team); return l ? `<img src="${esc(l)}" alt="" class="${cls}">` : `<span class="${cls} noimg" aria-hidden="true">${esc(clubOf(team).split(/\s+/).map((w) => w[0]).join('').slice(0, 3))}</span>`; };
const longDate = (d) => new Intl.DateTimeFormat('sv-SE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Stockholm' }).format(new Date(d + 'T12:00:00'));

function invitationSheet(v) {
  const { ev, arena, matches, jer, teams, texts } = v;
  const colorFor = (team, kit) => (v.colors[team] || {})[kit];
  const side = (m, which) => {
    const team = m[which], c = colorFor(team, jer.kits[m.id]?.[which] || 'home');
    return `<span class="gteam"><span class="gname">${esc(team)}</span><span class="gkit"><span class="sw${c ? '' : ' unknown'}" style="--c:${colorHex(c)}"></span>${c ? esc(colorLabel(c)) : 'Färg saknas'}</span></span>`;
  };
  const slots = [...new Set(matches.map((m) => m.start))];
  const plans = Math.max(1, ...matches.map((m) => m.plan));
  const cell = (start, plan) => matches.filter((m) => m.start === start && m.plan === plan)
    .map((m) => `${side(m, 'home')}<span class="gvs">mot</span>${side(m, 'away')}`).join('<hr>');
  return `
  <section class="sheet invite one">
    <header class="sheethead"><img src="${esc(S.state.settings.logo || 'logo.png')}" alt="Järfälla HC" class="logo">
      <div><h1>Järfälla HC U9 bjuder in till poolspel</h1>
      <p class="sub"><strong>${esc(longDate(ev.date).replace(/^./, (c) => c.toUpperCase()))}</strong> · ${esc(arena.name)}, ${esc(arena.address)}</p></div>
    </header>
    <h2>Deltagande lag</h2>
    <div class="teamrow" style="--n:${Math.min(8, teams.length)}">${teams.map((t) => `<div class="tcell">${teamLogo(t)}<span>${esc(t)}</span></div>`).join('')}</div>
    <div class="h2row"><h2>Spelschema och tröjfärger</h2><span>Färgen under varje lag är tröjan laget spelar i.</span></div>
    <div class="ggrid" style="--plans:${plans}">
      <div class="gh">Tid</div>${Array.from({ length: plans }, (_, i) => `<div class="gh">Plan ${i + 1}</div>`).join('')}
      ${slots.map((t, i) => `<div class="gt${i % 2 ? ' alt' : ''}">${esc(t || '–')}</div>${Array.from({ length: plans }, (_, p) => `<div class="gc${i % 2 ? ' alt' : ''}">${cell(t, p + 1)}</div>`).join('')}`).join('')}
    </div>
    <div class="bottom">
      <div><h2>Planindelning</h2><div class="rink">${rinkSvg({ standsTop: arena.standsTop, logo: S.state.settings.logo || 'logo.png' })}</div></div>
      <div class="info"><h2>Bra att veta</h2>
        ${texts.rooms ? `<div><strong>Omklädningsrum</strong><br><span class="pre">${esc(texts.rooms)}</span></div>` : ''}
        ${texts.important ? `<div class="important pre">${esc(texts.important)}</div>` : ''}
        ${texts.parking ? `<div><strong>Parkering</strong><br><span class="pre">${esc(texts.parking)}</span></div>` : ''}
        ${texts.kiosk ? `<div><strong>Kiosk</strong><br><span class="pre">${esc(texts.kiosk)}</span></div>` : ''}
        ${texts.other ? `<div><strong>Övrigt</strong><br><span class="pre">${esc(texts.other)}</span></div>` : ''}
      </div>
    </div>
    <footer class="sheetfoot"><span>Järfälla HC Team U9</span><span>Varmt välkomna!</span></footer>
  </section>`;
}
async function viewInvitation(key, printOnly) {
  const v = eventView(key);
  if (!v) { app.innerHTML = '<div class="alert warn">Poolspelet finns inte bland hämtade hemmapoolspel.</div><a href="#/schema">← Schema</a>'; return; }
  const canEdit = S.me.teamlead || S.me.planner;
  document.body.classList.toggle('printmode', printOnly);
  $('#top').hidden = printOnly;
  const colors = v.colors;
  app.innerHTML = `
  <div class="noprint printbar">
    <a href="${printOnly ? `#/matchinbjudan/${encodeURIComponent(key)}` : '#/schema'}" class="btn">← ${printOnly ? 'Tillbaka' : 'Schema'}</a>
    ${printOnly ? '<button class="btn primary" data-act="print">Skriv ut / Spara som PDF</button>' : `<a class="btn primary" href="#/matchinbjudan/${encodeURIComponent(key)}/utskrift">Skriv ut / PDF</a>`}
    ${v.data.updatedAt ? `<p class="small muted">Senast ändrad ${fDT(v.data.updatedAt)} av ${esc(v.data.updatedByName || '')}</p>` : ''}
    ${v.jer.warnings.map((w) => `<p class="alert warn small">${esc(w)}</p>`).join('')}
  </div>
  ${canEdit && !printOnly ? `<details class="panel noprint" ${v.data.updatedAt ? '' : 'open'}>
    <summary><strong>Ändra inbjudan</strong> <span class="small muted">hall, planer, tröjor, texter</span></summary>
    <form id="invform" class="stack">
      <div class="grid4">
        <label>Ishall<select name="arena">${Object.values(ARENAS).map((a) => `<option value="${a.id}" ${v.arenaId === a.id ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select></label>
        <label>Adress<input name="address" value="${esc(v.arena.address)}"></label>
      </div>
      <fieldset><legend>Planer</legend><div class="plangrid">${v.matches.map((m) => `<label class="small">${esc(m.start)} ${esc(m.home)} – ${esc(m.away)}
        <select name="plan" data-id="${esc(m.id)}">${[1, 2, 3, 4].map((n) => `<option ${m.plan === n ? 'selected' : ''}>${n}</option>`).join('')}</select></label>`).join('')}</div></fieldset>
      <fieldset><legend>Tröjor och logotyper</legend>
        <p class="small muted">Färgerna hämtas från swehockey. Ändrar du en färg här sparas den för laget. ”Automatiskt” väljer så att så få lag som möjligt byter, och Järfälla byter först.</p>
        <div class="kitgrid">${v.teams.map((t) => `<div class="kitrow">
          <span class="kt">${teamLogo(t, 'tlogo small')} ${esc(t)}</span>
          <label class="small">Hemma<input name="home" data-team="${esc(t)}" value="${esc(colors[t]?.home || '')}" placeholder="t.ex. Red"></label>
          <label class="small">Borta<input name="away" data-team="${esc(t)}" value="${esc(colors[t]?.away || '')}" placeholder="t.ex. White"></label>
          <label class="small">Tröja<select name="kit" data-team="${esc(t)}"><option value="">Automatiskt</option><option value="home" ${v.data.kits?.[t] === 'home' ? 'selected' : ''}>Alltid hemma</option><option value="away" ${v.data.kits?.[t] === 'away' ? 'selected' : ''}>Alltid borta</option></select></label>
          ${isOurs(t) ? '' : `<label class="small">Logotyp<input type="file" accept="image/png,image/jpeg,image/svg+xml,image/webp" data-act="clublogo" data-club="${esc(clubOf(t))}"></label>`}
        </div>`).join('')}</div>
      </fieldset>
      <p class="small muted">Omklädningsrum, viktigt och parkering har olika standardtexter för hallarna och byts när du byter hall.</p>
      <label>Omklädningsrum<textarea name="rooms" rows="4">${esc(v.texts.rooms)}</textarea></label>
      <label>Viktigt (visas med röd markering)<textarea name="important" rows="2">${esc(v.texts.important)}</textarea></label>
      <label>Parkering<textarea name="parking" rows="2">${esc(v.texts.parking)}</textarea></label>
      <label>Kiosk<textarea name="kiosk" rows="2">${esc(v.texts.kiosk)}</textarea></label>
      <label>Övrigt <span class="small muted">t.ex. samlingstid</span><textarea name="other" rows="2">${esc(v.texts.other)}</textarea></label>
      <div class="row"><button class="btn primary">Spara inbjudan</button></div>
    </form>
  </details>` : ''}
  ${invitationSheet(v)}`;
  const f = $('#invform');
  if (f) {
    f.arena.onchange = () => { const id = f.arena.value; f.address.value = ARENAS[id].address; f.rooms.value = DEFAULT_TEXTS.rooms[id]; f.important.value = DEFAULT_TEXTS.important[id]; f.parking.value = DEFAULT_TEXTS.parking[id]; };
    f.onsubmit = async (e) => {
      e.preventDefault();
      const plans = {}, kits = {};
      f.querySelectorAll('select[name=plan]').forEach((x) => { const m = v.matches.find((y) => y.id === x.dataset.id); if (Number(x.value) !== m.autoPlan) plans[x.dataset.id] = Number(x.value); });
      f.querySelectorAll('select[name=kit]').forEach((x) => { if (x.value) kits[x.dataset.team] = x.value; });
      try {
        for (const t of v.teams) {
          const h = f.querySelector(`input[name=home][data-team="${CSS.escape(t)}"]`).value.trim();
          const a = f.querySelector(`input[name=away][data-team="${CSS.escape(t)}"]`).value.trim();
          if (h !== (colors[t]?.home || '') || a !== (colors[t]?.away || '')) await B.saveTeamColor(t, h || null, a || null);
        }
        const arena = f.arena.value;
        await B.saveInvitation(key, { arena, address: f.address.value.trim(), plans, kits, rooms: f.rooms.value, roomsArena: arena, important: f.important.value, importantArena: arena, parking: f.parking.value, parkingArena: arena, kiosk: f.kiosk.value, other: f.other.value });
        await refreshState(); toast('Inbjudan är sparad.'); viewInvitation(key, false);
      } catch (err) { toast(err.message, true); }
    };
  }
}

// ---------- klick ----------
document.addEventListener('click', async (e) => {
  if (DRAG.suppressClick) { e.preventDefault(); e.stopPropagation(); return; }
  const b = e.target.closest('[data-act]');
  if (!b || b.tagName === 'INPUT' || b.tagName === 'SELECT') return;
  const d = b.dataset;
  try {
    switch (d.act) {
      case 'logout': await B?.logout(); sessionStorage.removeItem('jhc-demo'); S.me = null; S.state = null; location.hash = '#/'; boot(); break;
      case 'selday': {
        const boxes = [...document.querySelectorAll('#newround input[name=k]')].filter((x) => U(x.value)?.date === d.date);
        const all = boxes.every((x) => x.checked);
        boxes.forEach((x) => { x.checked = !all; all ? S.newRoundSel.delete(x.value) : S.newRoundSel.add(x.value); });
        break;
      }
      case 'player': playerDialog(d.pid, d.key || null); break;
      case 'propose':
        if (!await askConfirm('Skapa nytt förslag? Placeringar som inte är låsta fördelas om.')) return;
        if (await act('propose')) toast('Nytt förslag skapat.');
        break;
      case 'confirm': {
        const errs = Object.values(S.view.validation.perTeam).flat().filter((x) => x.level === 'error' || x.level === 'review').length;
        if (!await askConfirm(errs ? `Det finns ${errs} varningar. Fastställa ändå?` : 'Fastställa omgången? Lagen sparas i historiken.')) return;
        if (await act('confirm')) toast('Omgången är fastställd.');
        break;
      }
      case 'reopen': if (await act('reopen')) toast('Omgången är ett utkast igen.'); break;
      case 'rename': { const n = await askText('Nytt namn på omgången', S.round.name); if (n) await act('rename', { name: n }); break; }
      case 'ack': await B.ackChanges(d.key); await refreshState(); renderRound(true); break;
      case 'copyteam': {
        const t = S.round.teams[d.key];
        await copyText(S.view.copy[d.key]);
        toast(t.goalies.length ? 'Laglistan är kopierad.' : 'Laglistan är kopierad, men målvakt saknas.', !t.goalies.length);
        break;
      }
      case 'addreserve': reserveDialog(d.key); break;
      case 'catadd': { const n = $('#newcat').value.trim(); if (!n) return; await B.addCategory(n.slice(0, 40), (S.state.routineCategories || []).length + 1); await refreshState(); viewRoutines(); break; }
      case 'catrename': { const c = S.state.routineCategories.find((x) => x.id === d.id); const n = await askText('Nytt namn', c?.name); if (n?.trim()) { await B.updateCategory(d.id, { name: n.trim().slice(0, 40) }); await refreshState(); viewRoutines(); } break; }
      case 'catdelete': if (await askConfirm('Ta bort kategorin? Rutinerna i den blir kvar utan kategori.')) { await B.deleteCategory(d.id); await refreshState(); viewRoutines(); } break;
      case 'routinedelete': if (await askConfirm('Ta bort rutinen? Lagledare och lagplanerare kan återställa den i 30 dagar.')) { await B.deleteRoutine(d.id); await refreshState(); toast('Rutinen är borttagen.'); location.hash = '#/rutiner'; } break;
      case 'routinerestore': await B.restoreRoutine(d.id); await refreshState(); toast('Rutinen är återställd.'); if (location.hash === '#/rutiner') viewRoutines(); else viewRoutine(d.id); break;
      case 'routinepurge': if (await askConfirm('Radera rutinen för gott? Det går inte att ångra.')) { await B.purgeRoutine(d.id); await refreshState(); viewRoutines(); } break;
      case 'additem': { const box = document.querySelector(`.items[data-list="${d.list}"]`); const i = document.createElement('input'); i.name = d.list; i.placeholder = 'En punkt per rad'; box.append(i); i.focus(); break; }
      case 'coaches': coachDialog(d.key); break;
      case 'coachkids': kidsDialog(d.id); break;
      case 'print': window.print(); break;
      case 'addcoach': {
        const inp = $('#newcoach'); const name = inp.value.trim();
        if (!name) return;
        await B.addCoach(name); await refreshState(); viewPlayers(); toast('Tränaren är tillagd.'); break;
      }
      case 'coacharchive': await B.updateCoach(d.id, { active: d.on === '1' }); await refreshState(); viewPlayers(); break;
      case 'coachrename': { const n = await askText('Nytt namn', C(d.id)?.name); if (n?.trim()) { await B.updateCoach(d.id, { name: n.trim().slice(0, 60) }); await refreshState(); viewPlayers(); } break; }
      case 'logoremove': if (await askConfirm('Ta bort loggan?')) { await B.saveSettings({ ...S.state.settings, logo: null }, {}); await refreshState(); viewLeaders(); } break;
      case 'copyall': await copyText(S.view.copy.all); toast('Laglistor för hela omgången är kopierade.'); break;
      case 'reload': $('#conflict').innerHTML = ''; S.pending = null; await refreshState(); await reloadRound(); break;
      case 'force': if (S.pending) { $('#conflict').innerHTML = ''; await act(S.pending.type, S.pending.extra, { force: true }); } break;
      case 'delround':
        if (!await askConfirm('Ta bort omgången? Det går inte att ångra.')) return;
        await B.deleteRound(S.round.id); await refreshState(); location.hash = '#/'; break;
      case 'sync': {
        b.disabled = true; b.textContent = 'Hämtar…';
        const r = await doSync('manual');
        viewSchedule();
        toast(r.ok ? (r.changes ? `Klart. ${r.changes} ändringar upptäcktes.` : 'Klart. Inga ändringar.') : `Hämtningen misslyckades: ${r.error}`, !r.ok);
        break;
      }
      case 'parchive': await B.updatePlayer(d.pid, { active: d.on === '1' }); await refreshState(); viewPlayers(); break;
      case 'doimport': {
        const pv = S.importPreview;
        await B.importPlayers(pv);
        S.importPreview = null; await refreshState(); viewPlayers();
        toast(`Importerat: ${pv.add.length} nya, ${pv.update.length} ändrade${pv.archive.length ? `, ${pv.archive.length} arkiverade` : ''}.`);
        break;
      }
      case 'copylink': await copyText($('#linkfield').value); toast('Länken är kopierad.'); break;
      case 'newlink': await makeInvite(d.email); break;

      case 'deluser': if (await askConfirm('Ta bort ledaren? Kontot raderas och personen förlorar åtkomst direkt.')) { await B.removeLeader(d.id); viewLeaders(); } break;
      case 'delinvite': await B.deleteInvite(d.id); viewLeaders(); break;
      case 'backup': download(`jhc-lagplanerare-${stockholmToday()}.json`, await B.exportAll()); break;
      case 'demoreset': if (await askConfirm('Börja om demon med nya påhittade spelare?')) { await B.reset(); S.state = null; route.reload = true; location.hash = '#/'; route(); } break;
    }
  } catch (err) {
    if (err.status === 401) { S.me = null; viewLogin(err.message); } else toast(err.message, true);
  }
});
document.addEventListener('change', async (e) => {
  const t = e.target, d = t.dataset;
  try {
    if (d.act === 'avail') {
      await setAvail(d.key, d.pid, t.checked);
      if (!t.checked && S.round?.status !== 'fastställt' && placementOf(d.pid).some((x) => x.key === d.key)) replacementDialog(d.pid, d.key);
    }
    if (d.act === 'demorole') { S.me = await B.setDemoRole(t.value); S.state = null; route.reload = true; location.hash = '#/'; route(); }
    if (d.act === 'setroles') {
      const boxes = [...document.querySelectorAll(`input[data-act=setroles][data-id="${d.id}"]`)];
      const r = Object.fromEntries(boxes.map((b) => [b.dataset.r, b.checked]));
      await B.setRoles(d.id, r); toast('Rollerna är sparade.');
    }
    if (d.act === 'clublogo' && t.files[0]) {
      const logo = await readLogo(t.files[0]);
      await B.saveClubLogo(d.club, logo); await refreshState(); toast(`Logotypen för ${d.club} är sparad.`);
      const m = location.hash.match(/^#\/matchinbjudan\/(.+)$/); if (m) viewInvitation(decodeURIComponent(m[1]), false);
    }
    if (d.act === 'cavail') {
      await B.setCoachAvailability(d.key, d.cid, t.checked);
      const a = (S.state.coachAvailability ||= {})[d.key] ||= {};
      if (t.checked) delete a[d.cid]; else a[d.cid] = false;
      renderRound(true);
    }
    if (d.act === 'csquad') { await B.updateCoach(d.id, { squad: t.value }); await refreshState(); viewPlayers(); toast(t.value === 'reserv' ? 'Tränaren är nu reserv.' : 'Tränaren är nu ordinarie.'); }
    if (d.act === 'plevel') { await B.updatePlayer(d.pid, { level: t.value }); await refreshState(); toast('Nivågruppen är ändrad.'); }
    if (d.act === 'psquad') { await B.updatePlayer(d.pid, { squad: t.value }); await refreshState(); t.classList.toggle('isres', t.value === 'reserv'); toast(t.value === 'reserv' ? 'Spelaren är nu reserv.' : 'Spelaren är nu ordinarie.'); viewPlayers(); }
    if (d.act === 'pgoalie') { await B.updatePlayer(d.pid, { canGoalie: t.checked }); await refreshState(); }
  } catch (err) { toast(err.message, true); }
});

boot();
