// Daglig synk av matchschemat, körs av GitHub Actions (.github/workflows/sync.yml).
// Kräver hemligheterna SUPABASE_URL och SUPABASE_SERVICE_ROLE_KEY. Läser och skriver bara schemat, aldrig spelare.
import { runSync, DEFAULT_SOURCE } from '../docs/lib/schedule.js';

const url = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
if (!url || !key) { console.error('SUPABASE_URL och SUPABASE_SERVICE_ROLE_KEY måste vara satta som hemligheter i GitHub.'); process.exit(1); }

async function rest(method, path, body) {
  const res = await fetch(`${url}/rest/v1/${path}`, {
    method, headers: { apikey: key, 'content-type': 'application/json', ...(key.startsWith('eyJ') ? { authorization: `Bearer ${key}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new Error(`Supabase svarade ${res.status}: ${data?.message || ''}`);
  return data;
}
const backend = {
  getSchedule: async () => (await rest('GET', 'schedule?select=uppdrag,last_success&id=eq.1'))[0] || { uppdrag: {} },
  applySync: (expected, uppdrag, changes, source, trigger) => rest('POST', 'rpc/apply_sync', { p_expected: expected, p_uppdrag: uppdrag, p_changes: changes, p_source: source, p_trigger: trigger }),
  syncFailed: (error, trigger) => rest('POST', 'rpc/sync_failed', { p_error: error, p_trigger: trigger }),
};

const r = await runSync(backend, { source: process.env.SCHEDULE_SOURCE || DEFAULT_SOURCE, trigger: 'cron' });
if (r.ok) console.log(`Synk klar: ${r.changes} ändringar${r.skipped ? ' (någon annan synkade samtidigt)' : ''}.`);
else { console.error(`Synken misslyckades: ${r.error}`); process.exit(1); }
