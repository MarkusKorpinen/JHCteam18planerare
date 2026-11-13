// Kopplingen till Supabase (inloggning + databas) via deras REST-gränssnitt. Inga externa bibliotek.
const SESSION_KEY = 'jhc-planerare-session';

export class AppError extends Error { constructor(msg, extra = {}) { super(msg); Object.assign(this, extra); } }

const AUTH_MESSAGES = [
  [/invalid login credentials|invalid_grant/i, 'Fel e-post eller lösenord.'],
  [/database error saving new user/i, 'Inbjudan är ogiltig eller har gått ut. Be en administratör om en ny länk.'],
  [/already registered/i, 'Det finns redan ett konto med den adressen. Be om en ny inloggningslänk.'],
  [/password should be at least/i, 'Lösenordet är för kort.'],
  [/rate limit|too many/i, 'För många försök. Vänta en stund.'],
  [/signups not allowed/i, 'Nya konton är avstängda i Supabase. Slå på ”Allow new users to sign up” (se guiden).'],
  [/email not confirmed/i, 'E-postbekräftelse är påslagen i Supabase. Stäng av ”Confirm email” (se guiden).'],
];

export function createSupabaseBackend({ url, anonKey }) {
  url = url.replace(/\/$/, '');
  let session = null;
  try { session = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch {}
  const saveSession = (s) => {
    session = s ? { access_token: s.access_token, refresh_token: s.refresh_token, expires_at: s.expires_at || Math.floor(Date.now() / 1000) + (s.expires_in || 3600), user: s.user } : null;
    try { s ? localStorage.setItem(SESSION_KEY, JSON.stringify(session)) : localStorage.removeItem(SESSION_KEY); } catch {}
  };

  async function authCall(path, body, token) {
    let res;
    try {
      res = await fetch(`${url}/auth/v1/${path}`, {
        method: 'POST', headers: { apikey: anonKey, 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body || {}),
      });
    } catch { throw new AppError('Kunde inte nå Supabase. Kontrollera nätverket.'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const raw = data.error_description || data.msg || data.message || data.error || `Fel ${res.status}`;
      const hit = AUTH_MESSAGES.find(([rx]) => rx.test(raw) || rx.test(data.error_code || ''));
      throw new AppError(hit ? hit[1] : raw, { status: res.status });
    }
    return data;
  }
  async function token() {
    if (!session) throw new AppError('Logga in först.', { status: 401 });
    if (session.expires_at - 60 < Date.now() / 1000) {
      try { saveSession(await authCall('token?grant_type=refresh_token', { refresh_token: session.refresh_token })); }
      catch { saveSession(null); throw new AppError('Inloggningen har gått ut. Logga in igen.', { status: 401 }); }
    }
    return session.access_token;
  }
  async function rest(method, path, body, prefer, anon = false) {
    const headers = { apikey: anonKey, 'content-type': 'application/json' };
    // Inloggad: användarens token. Annars bara apikey (en ny "publishable key" är ingen JWT och får inte skickas som Bearer).
    if (session && !anon) headers.authorization = `Bearer ${await token()}`;
    else if (anonKey.startsWith('eyJ')) headers.authorization = `Bearer ${anonKey}`;
    if (prefer) headers.prefer = prefer;
    let res;
    try { res = await fetch(`${url}/rest/v1/${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }); }
    catch { throw new AppError('Kunde inte nå Supabase. Kontrollera nätverket.'); }
    if (res.status === 204) return null;
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      if (data?.message === 'conflict') {
        let d = {}; try { d = JSON.parse(data.details || '{}'); } catch {}
        throw new AppError('Någon annan har ändrat utkastet.', { conflict: d, status: 409 });
      }
      if (res.status === 401 || data?.code === 'PGRST301') throw new AppError('Inloggningen har gått ut. Logga in igen.', { status: 401 });
      throw new AppError(data?.message || `Fel ${res.status}`, { status: res.status });
    }
    return data;
  }
  const rpc = (fn, args) => rest('POST', `rpc/${fn}`, args || {});
  const uid = () => session?.user?.id;

  const mapPlayer = (p) => ({ id: p.id, name: p.name, level: p.level || null, canGoalie: p.can_goalie, active: p.active, squad: p.squad || 'ordinarie' });
  const mapRound = (r) => ({
    ...(r.data || {}), id: r.id, name: r.name, status: r.status, version: r.version,
    createdAt: r.created_at, createdByName: r.created_by_name, updatedAt: r.updated_at, updatedBy: r.updated_by,
    updatedByName: r.updated_by_name, confirmedAt: r.confirmed_at, confirmedBy: r.confirmed_by_name,
  });
  const roundData = (r) => ({ keys: r.keys, settings: r.settings, teams: r.teams, locks: r.locks, coachLocks: r.coachLocks || [], log: r.log, lastSeed: r.lastSeed });

  return {
    mode: 'supabase',
    async me() {
      if (!session) return null;
      await token();
      const rows = await rest('GET', `leaders?select=user_id,email,name,role,planner,teamlead&user_id=eq.${uid()}`);
      if (!rows?.length) throw new AppError('Ditt konto saknar åtkomst. Be en administratör om en ny inbjudan.', { noAccess: true });
      const l = rows[0];
      const admin = l.role === 'admin';
      return { id: l.user_id, email: l.email, name: l.name || l.email, role: l.role, admin, planner: admin || !!l.planner, teamlead: admin || !!l.teamlead };
    },
    async login(email, password) {
      saveSession(await authCall('token?grant_type=password', { email: email.trim().toLowerCase(), password }));
      return this.me();
    },
    async logout() {
      if (session) await authCall('logout', {}, session.access_token).catch(() => {});
      saveSession(null);
    },
    async inviteStatus(email, code) { return rest('POST', 'rpc/invite_status', { p_email: email, p_code: code }, null, true); },
    async acceptInvite({ email, code, name, password }) {
      if (password.length < 10) throw new AppError('Lösenordet måste ha minst 10 tecken.');
      const st = await this.inviteStatus(email, code);
      if (st.existing) {
        await rest('POST', 'rpc/reset_password_with_invite', { p_email: email, p_code: code, p_password: password, p_name: name }, null, true);
        return this.login(email, password);
      }
      if (!st.valid && !st.first_admin) throw new AppError('Inbjudan är ogiltig eller har gått ut. Be en administratör om en ny länk.');
      const res = await authCall('signup', { email: email.trim().toLowerCase(), password, data: { invite_code: code, name } });
      if (!res.access_token) throw new AppError('Kontot skapades men ”Confirm email” är påslaget i Supabase. Stäng av det (se guiden) och logga in.');
      saveSession(res);
      return this.me();
    },
    async loadState(opts = {}) {
      // Ledare som inte planerar får omgångarna via leader_rounds: även utkast, men utan kedjor och logg.
      const roundsQ = opts.planner
        ? rest('GET', 'rounds?select=id,name,status,version,created_at,updated_at,updated_by_name,confirmed_at,keys:data->keys&order=created_at.desc')
        : rpc('leader_rounds', { p_id: null }).catch(() => rest('GET', 'rounds?select=id,name,status,version,created_at,updated_at,updated_by_name,confirmed_at,keys:data->keys&order=created_at.desc'));
      const [settings, players, avail, schedule, changes, rounds, history, coaches, cavail, levels, teamColors, clubs, homeEvents, invitations, routines, categories, customEvents, seen] = await Promise.all([
        rest('GET', 'settings?select=data&id=eq.1'),
        rest('GET', 'players?select=*&order=name'),
        rest('GET', 'availability?select=uppdrag_key,player_id'),
        rest('GET', 'schedule?select=*&id=eq.1'),
        rest('GET', 'schedule_changes?select=*&order=at.desc&limit=300'),
        roundsQ,
        rest('GET', 'history?select=*&order=confirmed_at'),
        rest('GET', 'coaches?select=id,name,active,squad,children&order=name'),
        rest('GET', 'coach_availability?select=uppdrag_key,coach_id'),
        rest('GET', 'player_levels?select=player_id,level'),
        rest('GET', 'team_colors?select=*'),
        rest('GET', 'clubs?select=*'),
        rest('GET', 'home_events?select=*&order=date'),
        rest('GET', 'invitations?select=*'),
        rest('GET', 'routines?select=id,title,category_id,status,version,created_by,created_by_name,updated_at,updated_by_name,published_at,deleted_at,deleted_by_name&order=title'),
        rest('GET', 'routine_categories?select=*&order=sort,name'),
        rest('GET', 'custom_events?select=*&order=date').catch(() => []),
        rest('GET', 'notice_seen?select=seen_at').catch(() => null),
      ]);
      const levelOf = new Map(levels.map((l) => [l.player_id, l.level]));
      const coachAvailability = {};
      for (const a of cavail) (coachAvailability[a.uppdrag_key] ||= {})[a.coach_id] = false;
      const availability = {};
      for (const a of avail) (availability[a.uppdrag_key] ||= {})[a.player_id] = false;
      return {
        settings: settings[0]?.data, players: players.map((p) => mapPlayer({ ...p, level: levelOf.get(p.id) })), availability, coachAvailability,
        teamColors: Object.fromEntries(teamColors.map((t) => [t.team, { home: t.home, away: t.away, source: t.source }])),
        clubs: Object.fromEntries(clubs.map((c) => [c.name, { logo: c.logo }])),
        homeEvents: homeEvents.map((e) => ({ key: e.key, date: e.date, venue: e.venue, data: e.data, fetchedAt: e.fetched_at })),
        invitations: Object.fromEntries(invitations.map((i) => [i.event_key, { ...i.data, updatedAt: i.updated_at, updatedByName: i.updated_by_name }])),
        routines: routines.map((r) => ({ id: r.id, title: r.title, categoryId: r.category_id, status: r.status, version: r.version, createdBy: r.created_by, createdByName: r.created_by_name, updatedAt: r.updated_at, updatedByName: r.updated_by_name, publishedAt: r.published_at, deletedAt: r.deleted_at, deletedByName: r.deleted_by_name })),
        routineCategories: categories,
        customEvents: customEvents.map((e) => ({ id: e.id, date: e.date, venue: e.venue, title: e.title, data: e.data || {}, updatedAt: e.updated_at, updatedByName: e.updated_by_name })),
        coaches: coaches.map((c) => ({ id: c.id, name: c.name, active: c.active, squad: c.squad || 'ordinarie', children: c.children || [] })),
        schedule: schedule[0] || { uppdrag: {} }, changes, noticesSeenAt: seen ? (seen[0]?.seen_at || null) : undefined,
        rounds: rounds.map((r) => ({ id: r.id, name: r.name, status: r.status, keys: r.keys || [], createdAt: r.created_at, updatedAt: r.updated_at, updatedByName: r.updated_by_name, confirmedAt: r.confirmed_at })),
        history: history.map((h) => ({ roundId: h.round_id, roundName: h.round_name, confirmedAt: h.confirmed_at, teams: h.data.teams || [] })),
      };
    },
    async addPlayer(p) {
      const [row] = await rest('POST', 'players', { name: p.name, can_goalie: !!p.canGoalie, squad: p.squad === 'reserv' ? 'reserv' : 'ordinarie' }, 'return=representation');
      if (p.level) await rest('POST', 'player_levels?on_conflict=player_id', { player_id: row.id, level: p.level }, 'resolution=merge-duplicates');
      return mapPlayer({ ...row, level: p.level });
    },
    async updatePlayer(id, patch) {
      const body = { updated_at: new Date().toISOString() };
      if (patch.name !== undefined) body.name = patch.name;
      if (patch.level !== undefined) await rest('POST', 'player_levels?on_conflict=player_id', { player_id: id, level: patch.level }, 'resolution=merge-duplicates');
      if (patch.canGoalie !== undefined) body.can_goalie = patch.canGoalie;
      if (patch.active !== undefined) body.active = patch.active;
      if (patch.squad !== undefined) body.squad = patch.squad === 'reserv' ? 'reserv' : 'ordinarie';
      await rest('PATCH', `players?id=eq.${id}`, body);
    },
    async importPlayers({ add, update, archive }) {
      if (add.length) {
        const rows = await rest('POST', 'players', add.map((p) => ({ name: p.name, can_goalie: p.canGoalie, squad: p.squad === 'reserv' ? 'reserv' : 'ordinarie' })), 'return=representation');
        const byName = new Map(add.map((p) => [p.name.toLowerCase(), p.level]));
        const lv = rows.map((r) => ({ player_id: r.id, level: byName.get(r.name.toLowerCase()) })).filter((x) => x.level);
        if (lv.length) await rest('POST', 'player_levels?on_conflict=player_id', lv, 'resolution=merge-duplicates');
      }
      for (const p of update) await this.updatePlayer(p.id, { level: p.level, canGoalie: p.canGoalie, active: true, ...(p.squad ? { squad: p.squad } : {}) });
      if (archive.length) await rest('PATCH', `players?id=in.(${archive.map((a) => a.id).join(',')})`, { active: false });
    },
    async addCoach(name) { const [row] = await rest('POST', 'coaches', { name }, 'return=representation'); return row; },
    updateCoach: (id, patch) => rest('PATCH', `coaches?id=eq.${id}`, patch),
    async setCoachAvailability(key, cid, available) {
      if (available) await rest('DELETE', `coach_availability?uppdrag_key=eq.${encodeURIComponent(key)}&coach_id=eq.${cid}`);
      else await rest('POST', 'coach_availability', { uppdrag_key: key, coach_id: cid }, 'resolution=ignore-duplicates');
    },
    async setAvailability(key, pid, available) {
      if (available) await rest('DELETE', `availability?uppdrag_key=eq.${encodeURIComponent(key)}&player_id=eq.${pid}`);
      else await rest('POST', 'availability', { uppdrag_key: key, player_id: pid }, 'resolution=ignore-duplicates');
    },
    // för runSync
    async getSchedule() { return (await rest('GET', 'schedule?select=uppdrag,last_success&id=eq.1'))[0] || { uppdrag: {} }; },
    applySync: (expected, uppdrag, changes, source, trigger) => rpc('apply_sync', { p_expected: expected, p_uppdrag: uppdrag, p_changes: changes, p_source: source, p_trigger: trigger }),
    syncFailed: (error, trigger) => rpc('sync_failed', { p_error: error, p_trigger: trigger }),
    ackChanges: (key) => rpc('ack_changes', { p_key: key }),
    markNoticesSeen: () => rpc('mark_notices_seen', {}),

    async createRound(r) {
      const [row] = await rest('POST', 'rounds', { name: r.name, data: roundData(r) }, 'return=representation');
      return mapRound(row);
    },
    async getLeaderRound(id) {
      let rows;
      try { rows = await rpc('leader_rounds', { p_id: id }); }
      catch { const r = await this.getRound(id); return { ...r, teams: Object.fromEntries(Object.entries(r.teams || {}).map(([k, t]) => [k, { goalies: t.goalies || [], goalieOk: t.goalieOk || [], skaters: (t.lines || []).flat(), coaches: t.coaches || [] }])) }; }
      if (!rows?.length) throw new AppError('Omgången finns inte.');
      const r = rows[0];
      return { id: r.id, name: r.name, status: r.status, version: r.version, keys: r.keys || [], teams: r.teams || {},
        updatedAt: r.updated_at, updatedByName: r.updated_by_name, confirmedAt: r.confirmed_at, confirmedBy: r.confirmed_by_name };
    },
    async getRound(id) {
      const [rows, comments] = await Promise.all([
        rest('GET', `rounds?select=*&id=eq.${id}`),
        rest('GET', `comments?select=*&round_id=eq.${id}&order=at`),
      ]);
      if (!rows.length) throw new AppError('Omgången finns inte.');
      return { ...mapRound(rows[0]), comments: comments.map((c) => ({ id: c.id, key: c.uppdrag_key, userId: c.user_id, name: c.name, text: c.text, at: c.at })) };
    },
    async getRoundVersion(id) {
      const [r] = await rest('GET', `rounds?select=version,updated_at,updated_by,updated_by_name,last:data->log->0&id=eq.${id}`);
      return r ? { version: r.version, updatedAt: r.updated_at, updatedBy: r.updated_by, updatedByName: r.updated_by_name, last: r.last } : null;
    },
    async saveRound(r, baseVersion, { force = false, history = null } = {}) {
      const row = await rpc('save_round', { p_id: r.id, p_base: baseVersion, p_name: r.name, p_status: r.status, p_data: roundData(r), p_force: force, p_history: history });
      return mapRound(row);
    },
    deleteRound: (id) => rpc('delete_round', { p_id: id }),
    addComment: (roundId, key, text) => rest('POST', 'comments', { round_id: roundId, uppdrag_key: key, text }),
    deleteComment: (id) => rest('DELETE', `comments?id=eq.${id}`),


    // rutinbank
    async getRoutine(id) {
      const [r] = await rest('GET', `routines?select=*&id=eq.${id}`);
      if (!r) throw new AppError('Rutinen finns inte eller är inte publicerad.');
      return { id: r.id, title: r.title, categoryId: r.category_id, status: r.status, content: r.content || {}, version: r.version, createdBy: r.created_by, createdByName: r.created_by_name, updatedAt: r.updated_at, updatedByName: r.updated_by_name, publishedAt: r.published_at, publishedByName: r.published_by_name, deletedAt: r.deleted_at, deletedByName: r.deleted_by_name };
    },
    async saveRoutine(r) {
      const body = { title: r.title, category_id: r.categoryId || null, content: r.content || {} };
      const rows = r.id ? await rest('PATCH', `routines?id=eq.${r.id}`, body, 'return=representation') : await rest('POST', 'routines', body, 'return=representation');
      if (!rows?.length) throw new AppError('Rutinen kunde inte sparas.');
      return rows[0].id;
    },
    deleteRoutine: (id) => rpc('trash_routine', { p_id: id }),
    restoreRoutine: (id) => rpc('restore_routine', { p_id: id }),
    purgeRoutine: (id) => rest('DELETE', `routines?id=eq.${id}`),
    async getRoutineVersions(id) {
      const rows = await rest('GET', `routine_versions?select=version,title,saved_at,saved_by_name&routine_id=eq.${id}&order=version.desc`);
      return rows.map((v) => ({ version: v.version, title: v.title, savedAt: v.saved_at, savedByName: v.saved_by_name }));
    },
    addCategory: (name, sort) => rest('POST', 'routine_categories', { name, sort: sort || 0 }),
    updateCategory: (id, patch) => rest('PATCH', `routine_categories?id=eq.${id}`, patch),
    deleteCategory: (id) => rest('DELETE', `routine_categories?id=eq.${id}`),

    // egna poolspel
    async saveCustomEvent(ev) {
      const body = { date: ev.date, venue: ev.venue, title: ev.title || null, data: ev.data };
      const rows = ev.id ? await rest('PATCH', `custom_events?id=eq.${ev.id}`, body, 'return=representation') : await rest('POST', 'custom_events', body, 'return=representation');
      if (!rows?.length) throw new AppError('Poolspelet kunde inte sparas. Bara lagledare och lagplanerare kan ändra egna poolspel.');
      return rows[0].id;
    },
    deleteCustomEvent: (id) => rest('DELETE', `custom_events?id=eq.${id}`),

    // matchinbjudan
    saveTeamColor: (team, home, away) => rest('POST', 'team_colors?on_conflict=team', { team, home, away, source: 'manual', updated_at: new Date().toISOString() }, 'resolution=merge-duplicates'),
    saveClubLogo: (name, logo) => rest('POST', 'clubs?on_conflict=name', { name, logo, updated_at: new Date().toISOString() }, 'resolution=merge-duplicates'),
    saveInvitation: (key, data) => rest('POST', 'invitations?on_conflict=event_key', { event_key: key, data }, 'resolution=merge-duplicates'),

    async listLeaders() {
      const [users, invites] = await Promise.all([
        rest('GET', 'leaders?select=user_id,email,name,role,planner,teamlead&order=name'),
        rest('GET', `invites?select=id,email,role,planner,teamlead,expires_at&expires_at=gt.${new Date().toISOString()}&order=created_at.desc`),
      ]);
      return { users: users.map((u) => ({ id: u.user_id, email: u.email, name: u.name || u.email, role: u.role, planner: u.planner, teamlead: u.teamlead })), invites: invites.map((i) => ({ id: i.id, email: i.email, role: i.role, planner: i.planner, teamlead: i.teamlead, expires: i.expires_at })) };
    },
    async createInvite(email, roles = {}) {
      email = String(email || '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AppError('Ange en giltig e-postadress.');
      const bytes = crypto.getRandomValues(new Uint8Array(24));
      const code = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code)))].map((b) => b.toString(16).padStart(2, '0')).join('');
      await rest('DELETE', `invites?email=eq.${encodeURIComponent(email)}`);
      const [row] = await rest('POST', 'invites', { email, code_hash: hash, role: roles.admin ? 'admin' : 'leader', planner: !!roles.planner, teamlead: !!roles.teamlead, created_by: uid() }, 'return=representation');
      return { email, expires: row.expires_at, link: `${location.origin}${location.pathname}#/inbjudan/${code}/${encodeURIComponent(email)}` };
    },
    deleteInvite: (id) => rest('DELETE', `invites?id=eq.${id}`),
    setRoles: (userId, r) => rpc('set_leader_roles', { p_user: userId, p_admin: !!r.admin, p_planner: !!r.planner, p_teamlead: !!r.teamlead }),
    removeLeader: (userId) => rpc('remove_leader', { p_user: userId }),
    setMyName: (name) => rpc('set_my_name', { p_name: name }),
    saveSettings: (data, rename) => rpc('save_settings', { p_data: data, p_rename: rename || {} }),
    async exportAll() {
      const tables = ['settings', 'players', 'player_levels', 'coaches', 'coach_availability', 'availability', 'schedule', 'schedule_changes', 'rounds', 'history', 'comments', 'routine_categories', 'routines', 'routine_versions', 'team_colors', 'clubs', 'home_events', 'custom_events', 'invitations', 'leaders'];
      const out = { exportedAt: new Date().toISOString() };
      for (const t of tables) out[t] = await rest('GET', `${t}?select=*`).catch(() => null);
      return out;
    },
  };
}
