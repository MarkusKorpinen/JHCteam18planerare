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

  const mapPlayer = (p) => ({ id: p.id, name: p.name, level: p.level, canGoalie: p.can_goalie, active: p.active, squad: p.squad || 'ordinarie' });
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
      const rows = await rest('GET', `leaders?select=user_id,email,name,role&user_id=eq.${uid()}`);
      if (!rows?.length) throw new AppError('Ditt konto saknar åtkomst. Be en administratör om en ny inbjudan.', { noAccess: true });
      const l = rows[0];
      return { id: l.user_id, email: l.email, name: l.name || l.email, role: l.role };
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
    async loadState() {
      const [settings, players, avail, schedule, changes, rounds, history, coaches, cavail] = await Promise.all([
        rest('GET', 'settings?select=data&id=eq.1'),
        rest('GET', 'players?select=*&order=name'),
        rest('GET', 'availability?select=uppdrag_key,player_id'),
        rest('GET', 'schedule?select=*&id=eq.1'),
        rest('GET', 'schedule_changes?select=*&order=at.desc&limit=300'),
        rest('GET', 'rounds?select=id,name,status,version,created_at,updated_at,updated_by_name,confirmed_at,keys:data->keys&order=created_at.desc'),
        rest('GET', 'history?select=*&order=confirmed_at'),
        rest('GET', 'coaches?select=id,name,active,squad,children&order=name'),
        rest('GET', 'coach_availability?select=uppdrag_key,coach_id'),
      ]);
      const coachAvailability = {};
      for (const a of cavail) (coachAvailability[a.uppdrag_key] ||= {})[a.coach_id] = false;
      const availability = {};
      for (const a of avail) (availability[a.uppdrag_key] ||= {})[a.player_id] = false;
      return {
        settings: settings[0]?.data, players: players.map(mapPlayer), availability, coachAvailability,
        coaches: coaches.map((c) => ({ id: c.id, name: c.name, active: c.active, squad: c.squad || 'ordinarie', children: c.children || [] })),
        schedule: schedule[0] || { uppdrag: {} }, changes,
        rounds: rounds.map((r) => ({ id: r.id, name: r.name, status: r.status, keys: r.keys || [], createdAt: r.created_at, updatedAt: r.updated_at, updatedByName: r.updated_by_name, confirmedAt: r.confirmed_at })),
        history: history.map((h) => ({ roundId: h.round_id, roundName: h.round_name, confirmedAt: h.confirmed_at, teams: h.data.teams || [] })),
      };
    },
    async addPlayer(p) {
      const [row] = await rest('POST', 'players', { name: p.name, level: p.level, can_goalie: !!p.canGoalie, squad: p.squad === 'reserv' ? 'reserv' : 'ordinarie' }, 'return=representation');
      return mapPlayer(row);
    },
    async updatePlayer(id, patch) {
      const body = { updated_at: new Date().toISOString() };
      if (patch.name !== undefined) body.name = patch.name;
      if (patch.level !== undefined) body.level = patch.level;
      if (patch.canGoalie !== undefined) body.can_goalie = patch.canGoalie;
      if (patch.active !== undefined) body.active = patch.active;
      if (patch.squad !== undefined) body.squad = patch.squad === 'reserv' ? 'reserv' : 'ordinarie';
      await rest('PATCH', `players?id=eq.${id}`, body);
    },
    async importPlayers({ add, update, archive }) {
      if (add.length) await rest('POST', 'players', add.map((p) => ({ name: p.name, level: p.level, can_goalie: p.canGoalie, squad: p.squad === 'reserv' ? 'reserv' : 'ordinarie' })));
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

    async createRound(r) {
      const [row] = await rest('POST', 'rounds', { name: r.name, data: roundData(r) }, 'return=representation');
      return mapRound(row);
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

    async listLeaders() {
      const [users, invites] = await Promise.all([
        rest('GET', 'leaders?select=user_id,email,name,role&order=name'),
        rest('GET', `invites?select=id,email,role,expires_at&expires_at=gt.${new Date().toISOString()}&order=created_at.desc`),
      ]);
      return { users: users.map((u) => ({ id: u.user_id, email: u.email, name: u.name || u.email, role: u.role })), invites: invites.map((i) => ({ id: i.id, email: i.email, role: i.role, expires: i.expires_at })) };
    },
    async createInvite(email, role) {
      email = String(email || '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AppError('Ange en giltig e-postadress.');
      const bytes = crypto.getRandomValues(new Uint8Array(24));
      const code = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code)))].map((b) => b.toString(16).padStart(2, '0')).join('');
      await rest('DELETE', `invites?email=eq.${encodeURIComponent(email)}`);
      const [row] = await rest('POST', 'invites', { email, code_hash: hash, role: role === 'admin' ? 'admin' : 'leader', created_by: uid() }, 'return=representation');
      return { email, expires: row.expires_at, link: `${location.origin}${location.pathname}#/inbjudan/${code}/${encodeURIComponent(email)}` };
    },
    deleteInvite: (id) => rest('DELETE', `invites?id=eq.${id}`),
    setRole: (userId, role) => rpc('set_leader_role', { p_user: userId, p_role: role }),
    removeLeader: (userId) => rpc('remove_leader', { p_user: userId }),
    setMyName: (name) => rpc('set_my_name', { p_name: name }),
    saveSettings: (data, rename) => rpc('save_settings', { p_data: data, p_rename: rename || {} }),
    async exportAll() {
      const tables = ['settings', 'players', 'coaches', 'coach_availability', 'availability', 'schedule', 'schedule_changes', 'rounds', 'history', 'comments', 'leaders'];
      const out = { exportedAt: new Date().toISOString() };
      for (const t of tables) out[t] = await rest('GET', `${t}?select=*`);
      return out;
    },
  };
}
