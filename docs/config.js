// Fyll i från Supabase → Project Settings → API (se guiden i README).
// Båda värdena är gjorda för att ligga i webbläsaren; skyddet sköts av åtkomstreglerna i databasen.
// Lägg ALDRIG in "service_role"-nyckeln här.
export const CONFIG = {
  supabaseUrl: 'https://qjkellcpwrxtkkmtvhxc.supabase.co',      // t.ex. 'https://abcdefghijkl.supabase.co'
  supabaseAnonKey: 'sb_publishable_PJqJgRInqV4CCPYhXr-SUQ_FbKkGcWs',  // den långa "anon public"-nyckeln (eller "publishable key")
  scheduleSource: 'https://markuskorpinen.github.io/JHCmatcher/data/schedule.json',
};
