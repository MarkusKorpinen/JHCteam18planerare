// JHC U9 lagplanerare – gränssnitt. Koden innehåller ingen spelardata; den hämtas efter inloggning.
import { CONFIG } from './config.js';
import { createSupabaseBackend } from './backend-supabase.js';
import { createDemoBackend } from './backend-demo.js';
import { RULES, isReserve } from './lib/planner.js';
import { playersFromCsv } from './lib/csv.js';
import { runSync } from './lib/schedule.js';
import { ACTIONS, ALLOWED_WHEN_CONFIRMED, newRound, addLog, snapshot, view, pendingReview } from './lib/rounds.js';

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
  $('#who').innerHTML = `${esc(S.me.name)} · <button class="linkbtn" data-act="logout">${B.mode === 'demo' ? 'Avsluta demo' : 'Logga ut'}</button>`;
  try {
    if (!S.state || route.reload) { await refreshState(); route.reload = false; maybeAutoSync(); }
    const pr = h.match(/^\/utskrift\/([\w-]+)(?:\/(.+))?$/);
    if (pr) return await viewPrint(pr[1], pr[2] ? decodeURIComponent(pr[2]) : null);
    document.body.classList.remove('printmode');
    const m = h.match(/^\/omgang\/([\w-]+)/);
    const tab = m ? 'omgangar' : (h.slice(1) || 'omgangar');
    document.querySelectorAll('#tabs a').forEach((a) => a.classList.toggle('on', a.dataset.tab === tab));
    window.scrollTo(0, 0);
    if (m) return await viewRound(m[1]);
    await ({ omgangar: viewRounds, spelare: viewPlayers, schema: viewSchedule, historik: viewHistory, ledare: viewLeaders }[tab] || viewRounds)();
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
    <h1>JHC U9 lagplanerare</h1>
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
function viewRounds() {
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
  const comments = (r.comments || []).filter((c) => c.key === key);
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
      <div class="chips">${t.goalies.map((id) => chip(id, key)).join('') || '<span class="empty">Ingen målvakt</span>'}</div>
      ${t.lines.map((l, i) => `<h4>Kedja ${i + 1} <span class="muted small">(${l.length})</span></h4><div class="chips">${l.map((id) => chip(id, key)).join('')}</div>`).join('') || '<h4>Utespelare</h4><span class="empty">Inga utespelare</span>'}
      <h4>Tränare</h4>
      <div class="chips">${(t.coaches || []).map((id) => `<span class="coach${!coachAvail(key, id) ? ' bad' : ''}">${esc(C(id)?.name || 'Okänd tränare')}${isReserve(C(id)) ? '<span class="res">R</span>' : ''}${(r.coachLocks || []).some((l) => l.cid === id && l.key === key) ? '<span class="lock">🔒</span>' : ''}</span>`).join('') || '<span class="empty">Ingen ledare</span>'}</div>
      <div class="row cardactions">
        ${r.status !== 'fastställt' ? `<button class="btn small" data-act="addreserve" data-key="${esc(key)}">+ Lägg till reserv</button>` : ''}
        <button class="btn small" data-act="coaches" data-key="${esc(key)}">Välj tränare</button>
      </div>
      <div class="row cardactions">
        <button class="btn" data-act="copyteam" data-key="${esc(key)}">Kopiera laglista</button>
        <a class="btn" href="#/utskrift/${r.id}/${encodeURIComponent(key)}">Laglista som PDF</a>
      </div>
      <details class="comments" ${comments.length ? 'open' : ''}>
        <summary>Kommentarer (${comments.length})</summary>
        ${comments.map((c) => `<div class="comment"><div class="small muted">${esc(c.name)} · ${fDT(c.at)} ${c.userId === S.me.id || S.me.role === 'admin' ? `<button class="linkbtn" data-act="delcomment" data-id="${c.id}">ta bort</button>` : ''}</div>${esc(c.text)}</div>`).join('')}
        <form class="commentform" data-key="${esc(key)}"><input name="text" placeholder="Skriv en kommentar till ledarna" maxlength="1000"><button class="btn small">Skicka</button></form>
      </details>
    </div>
  </article>`;
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
    ${!confirmed ? '<p class="small muted">Nytt förslag behåller låsta placeringar (🔒) och fördelar om alla andra.</p>' : ''}
  </section>
  ${S.view.validation.global.map((x) => `<div class="alert warn">${esc(x.text)}</div>`).join('')}
  <details class="panel">
    <summary><strong>Inställningar för förslaget</strong> <span class="small muted">${s.skaters} utespelare · ${s.goalies} målvakt · kedja ${s.lineSize} · max ${s.maxPerPlayer} poolspel/spelare</span></summary>
    <form id="rset" class="grid4">
      <label>Utespelare per lag<input type="number" name="skaters" min="1" max="20" value="${s.skaters}"></label>
      <label>Målvakter per lag<input type="number" name="goalies" min="0" max="3" value="${s.goalies}"></label>
      <label>Spelare per kedja<input type="number" name="lineSize" min="1" max="10" value="${s.lineSize}"></label>
      <label>Max poolspel per spelare i omgången<input type="number" name="maxPerPlayer" min="1" max="10" value="${s.maxPerPlayer}"></label>
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
      return `<h4>Ordinarie</h4><div class="chips">${ord.map((p) => chip(p.id, '')).join('') || '<span class="muted small">Alla ordinarie som kan är uttagna.</span>'}</div>
      <h4>Reserver</h4><div class="chips">${rs.map((p) => chip(p.id, '')).join('') || '<span class="muted small">Inga lediga reserver.</span>'}</div>`;
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
  app.querySelectorAll('.commentform').forEach((f) => (f.onsubmit = async (e) => {
    e.preventDefault();
    const text = f.text.value.trim();
    if (!text) return;
    try { await B.addComment(S.round.id, f.dataset.key, text); await reloadRound(); } catch (err) { toast(err.message, true); }
  }));
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
      if (want !== isAvail(fromKey, pid)) await setAvail(fromKey, pid, want, false);
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
    ${admin ? `
    <ul class="users">${data.users.map((u) => `<li><strong>${esc(u.name)}</strong> <span class="small muted">${esc(u.email)}</span>
      <span class="badge ${u.role === 'admin' ? 'ok' : ''}">${u.role === 'admin' ? 'Administratör' : 'Ledare'}</span>
      ${u.id !== S.me.id ? `<button class="linkbtn" data-act="role" data-id="${u.id}" data-role="${u.role === 'admin' ? 'leader' : 'admin'}">${u.role === 'admin' ? 'gör till ledare' : 'gör till admin'}</button>
      <button class="linkbtn" data-act="newlink" data-email="${esc(u.email)}">ny inloggningslänk</button>
      <button class="linkbtn danger" data-act="deluser" data-id="${u.id}">ta bort</button>` : '<span class="small muted">(du)</span>'}</li>`).join('')}</ul>
    ${data.invites.length ? `<h3>Väntande inbjudningar</h3><ul class="users">${data.invites.map((i) => `<li>${esc(i.email)} <span class="small muted">gäller till ${fDT(i.expires)}</span> <button class="linkbtn danger" data-act="delinvite" data-id="${i.id}">dra tillbaka</button></li>`).join('')}</ul>` : ''}
    <h3>Bjud in ledare</h3>
    <form id="inv" class="row wrapform">
      <input type="email" name="email" placeholder="ledarens e-post" required>
      <select name="role"><option value="leader">Ledare</option><option value="admin">Administratör</option></select>
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
      <label>Lagnamn i laglistan (före t.ex. ”U9 blå”)<input name="teamPrefix" value="${esc(st.teamPrefix)}"></label>
      <label>Automatisk synk när någon öppnar sidan, högst var … timme<input type="number" name="syncHours" min="1" max="168" value="${st.syncHours}"></label>
      <fieldset><legend>Startvärden för nya omgångar</legend><div class="grid4">
        <label>Utespelare<input type="number" name="skaters" min="1" max="20" value="${st.roundDefaults.skaters}"></label>
        <label>Målvakter<input type="number" name="goalies" min="0" max="3" value="${st.roundDefaults.goalies}"></label>
        <label>Kedjestorlek<input type="number" name="lineSize" min="1" max="10" value="${st.roundDefaults.lineSize}"></label>
        <label>Max poolspel/spelare<input type="number" name="maxPerPlayer" min="1" max="10" value="${st.roundDefaults.maxPerPlayer}"></label></div></fieldset>
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
  $('#inv').onsubmit = async (e) => { e.preventDefault(); await makeInvite(e.target.email.value, e.target.role.value); };
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
    const rd = Object.fromEntries(['skaters', 'goalies', 'lineSize', 'maxPerPlayer'].map((k) => [k, parseInt(f[k].value, 10) || 0]));
    try { await B.saveSettings({ ...st, levels, teamPrefix: f.teamPrefix.value.trim(), syncHours: hours, roundDefaults: rd }, rename); await refreshState(); toast('Inställningarna är sparade.'); viewLeaders(); }
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
async function makeInvite(email, role = 'leader') {
  try {
    const r = await B.createInvite(email, role);
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
  const dlg = $('#dlg');
  dlg.innerHTML = `
  <form method="dialog" class="stack">
    <h2>Lägg till reserv</h2>
    <p class="small">${esc(u?.label)} · ${fDate(u?.date)}</p>
    ${list.length ? `
    <label>Reserv <span class="small muted">(färst spelade poolspel överst)</span>
      <select name="pid">${list.map((p) => `<option value="${p.id}">${esc(p.name)}${p.canGoalie ? ' (MV)' : ''} – ${apps.get(p.id) || 0} poolspel</option>`).join('')}</select>
    </label>
    <label>Roll
      <select name="role"><option value="S">Utespelare${t.lines.length ? ` (kedja ${t.lines.length})` : ''}</option><option value="SN">Utespelare, ny kedja</option><option value="G">Målvakt</option></select>
    </label>
    <p class="small muted">Reserven låses i laget så att den ligger kvar om ni skapar ett nytt förslag.</p>` : '<p>Det finns ingen ledig reserv som kan det här poolspelet. Markera spelare som reserv under Spelare, eller kontrollera tillgängligheten.</p>'}
    <div class="row">${list.length ? '<button class="btn primary" value="save">Lägg till</button>' : ''}<button class="btn" value="cancel" formnovalidate>Avbryt</button></div>
  </form>`;
  dlg.showModal();
  dlg.onclose = async () => {
    if (dlg.returnValue !== 'save') return;
    const f = dlg.querySelector('form');
    const role = f.role.value;
    await act('move', { pid: f.pid.value, fromKey: null, toKey: key, role: role === 'G' ? 'G' : 'S', line: role === 'S' && t.lines.length ? t.lines.length - 1 : null, lock: true });
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

// ---------- klick ----------
document.addEventListener('click', async (e) => {
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
        if (!confirm('Skapa nytt förslag? Placeringar som inte är låsta fördelas om.')) return;
        if (await act('propose')) toast('Nytt förslag skapat.');
        break;
      case 'confirm': {
        const errs = Object.values(S.view.validation.perTeam).flat().filter((x) => x.level === 'error' || x.level === 'review').length;
        if (!confirm(errs ? `Det finns ${errs} varningar. Fastställa ändå?` : 'Fastställa omgången? Lagen sparas i historiken.')) return;
        if (await act('confirm')) toast('Omgången är fastställd.');
        break;
      }
      case 'reopen': if (await act('reopen')) toast('Omgången är ett utkast igen.'); break;
      case 'rename': { const n = prompt('Nytt namn på omgången', S.round.name); if (n) await act('rename', { name: n }); break; }
      case 'ack': await B.ackChanges(d.key); await refreshState(); renderRound(true); break;
      case 'delcomment': if (confirm('Ta bort kommentaren?')) { await B.deleteComment(d.id); await reloadRound(); } break;
      case 'copyteam': {
        const t = S.round.teams[d.key];
        await copyText(S.view.copy[d.key]);
        toast(t.goalies.length ? 'Laglistan är kopierad.' : 'Laglistan är kopierad, men målvakt saknas.', !t.goalies.length);
        break;
      }
      case 'addreserve': reserveDialog(d.key); break;
      case 'coaches': coachDialog(d.key); break;
      case 'coachkids': kidsDialog(d.id); break;
      case 'print': window.print(); break;
      case 'addcoach': {
        const inp = $('#newcoach'); const name = inp.value.trim();
        if (!name) return;
        await B.addCoach(name); await refreshState(); viewPlayers(); toast('Tränaren är tillagd.'); break;
      }
      case 'coacharchive': await B.updateCoach(d.id, { active: d.on === '1' }); await refreshState(); viewPlayers(); break;
      case 'coachrename': { const n = prompt('Nytt namn', C(d.id)?.name); if (n?.trim()) { await B.updateCoach(d.id, { name: n.trim().slice(0, 60) }); await refreshState(); viewPlayers(); } break; }
      case 'logoremove': if (confirm('Ta bort loggan?')) { await B.saveSettings({ ...S.state.settings, logo: null }, {}); await refreshState(); viewLeaders(); } break;
      case 'copyall': await copyText(S.view.copy.all); toast('Laglistor för hela omgången är kopierade.'); break;
      case 'reload': $('#conflict').innerHTML = ''; S.pending = null; await refreshState(); await reloadRound(); break;
      case 'force': if (S.pending) { $('#conflict').innerHTML = ''; await act(S.pending.type, S.pending.extra, { force: true }); } break;
      case 'delround':
        if (!confirm('Ta bort omgången? Det går inte att ångra.')) return;
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
      case 'role': await B.setRole(d.id, d.role); viewLeaders(); break;
      case 'deluser': if (confirm('Ta bort ledaren? Kontot raderas och personen förlorar åtkomst direkt.')) { await B.removeLeader(d.id); viewLeaders(); } break;
      case 'delinvite': await B.deleteInvite(d.id); viewLeaders(); break;
      case 'backup': download(`jhc-lagplanerare-${stockholmToday()}.json`, await B.exportAll()); break;
      case 'demoreset': if (confirm('Börja om demon med nya påhittade spelare?')) { await B.reset(); S.state = null; route.reload = true; location.hash = '#/'; route(); } break;
    }
  } catch (err) {
    if (err.status === 401) { S.me = null; viewLogin(err.message); } else toast(err.message, true);
  }
});
document.addEventListener('change', async (e) => {
  const t = e.target, d = t.dataset;
  try {
    if (d.act === 'avail') await setAvail(d.key, d.pid, t.checked);
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
