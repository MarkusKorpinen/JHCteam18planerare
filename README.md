# JHC U9 – lagplanerare (GitHub Pages + Supabase)

Ett privat, mobilvänligt verktyg där inbjudna ledare fördelar Järfälla HC U9:s spelare på lagen blå, gul, röd, svart och vit inför varje omgång. Det behövs ingen egen server:

| Del | Var | Kostnad |
|---|---|---|
| Sidan (HTML/JS) | GitHub Pages, eget repo | gratis |
| Inloggning och data | Supabase, gratisnivå, region Stockholm | gratis |
| Daglig schemasynk | GitHub Actions i samma repo | gratis |

**Integritet.** Sidans kod innehåller inga spelaruppgifter. Namn, nivågrupper, tillgänglighet, kommentarer och historik finns bara i Supabase. Där släpper databasens åtkomstregler bara fram inloggade ledare. Repot kan därför vara offentligt (GitHub Pages kräver det på gratisplanen). Lägg aldrig in spelaruppgifter eller Supabase-nyckeln `service_role`/`secret` i repot.

**Matchschemat** hämtas från matchöversiktens publika datafil `https://markuskorpinen.github.io/JHCmatcher/data/schedule.json`. JHCmatcher behöver inte ändras.

---

## Prova först (2 minuter)

Öppna sidan och tryck **Prova demoläget**. Demon har 42 påhittade spelare, tre fastställda omgångar och ett utkast för 28 november. Allt sparas bara i din webbläsare. Lokalt: `npm run preview` och öppna http://localhost:8080.

---

## Sätta upp den riktiga versionen (engångsjobb, ca 30–40 min)

### 1. Supabase-projekt
1. Skapa ett gratiskonto på supabase.com och välj **New project**. Välj regionen **Stockholm (eu-north-1)** och ett starkt databaslösenord (det behövs inte i vardagen).
2. Gå till **SQL Editor → New query**. Öppna `supabase/schema.sql`, byt `DIN@EPOST.SE` längst ned mot din e-post och klistra in hela filen. Tryck **Run**. Du ska få ”Success”.
3. Gå till **Authentication → Sign In / Providers → Email**:
   * **Confirm email: AV.** Verktyget skickar inga mejl. Åtkomsten styrs av inbjudningskoder i stället.
   * **Allow new users to sign up: PÅ** (standard). Ett konto kan ändå bara skapas med en giltig inbjudan. Databasen stoppar alla andra.
4. Gå till **Project Settings → API (API Keys)** och kopiera:
   * **Project URL**, t.ex. `https://abcdefgh.supabase.co`.
   * **anon public**-nyckeln (eller **publishable key**), för sidan.
   * **service_role**-nyckeln (eller **secret key**), bara för GitHub i steg 3. Den ska aldrig in i någon fil.

### 2. GitHub-repo och GitHub Pages
1. Skapa ett nytt repo, t.ex. `jhc-lagplanerare`. Använd **inte** JHCmatcher-repot.
2. Öppna `docs/config.js` och fyll i `supabaseUrl` och `supabaseAnonKey`.
3. Ladda upp alla filer, även den dolda mappen `.github` och filen `docs/.nojekyll`.
4. Gå till **Settings → Pages → Build and deployment**, välj **Deploy from a branch**, sedan `main` och `/docs`. Spara. Efter någon minut visas adressen, t.ex. `https://DITTNAMN.github.io/jhc-lagplanerare/`.

### 3. Daglig synk (GitHub Actions)
1. Gå till **Settings → Secrets and variables → Actions → New repository secret** och lägg in:
   * `SUPABASE_URL` med Project URL.
   * `SUPABASE_SERVICE_ROLE_KEY` med service_role- eller secret-nyckeln.
2. Gå till **Actions**, slå på arbetsflöden om GitHub frågar, välj **Synka matchschema** och tryck **Run workflow**. Efter cirka en minut ska körningen få en grön bock.

Synken går sedan automatiskt varje morgon. Dessutom synkar sidan själv när en ledare öppnar den och det har gått mer än ett dygn sedan förra hämtningen. Knappen **Schema → Hämta nu** fungerar alltid.

### 4. Ditt administratörskonto
Öppna sidan och klicka **skapa ditt konto** under inloggningsrutan. Använd samma e-post som du skrev i `schema.sql`. Det fungerar bara för den adressen, och bara en gång.

---

## Bjuda in ledare
1. **Ledare → Bjud in ledare**: skriv ledarens e-post och tryck **Skapa inbjudningslänk**.
2. Kopiera länken och skicka den själv via sms eller mejl. Ledaren väljer namn och lösenord (minst 10 tecken).
3. Länken gäller i 7 dagar och kan bara användas en gång.
4. **Glömt lösenord:** tryck **ny inloggningslänk** vid ledaren. Samma steg igen, och ledaren väljer ett nytt lösenord.
5. **Ta bort** raderar kontot direkt. Om det skulle misslyckas: ta bort användaren under Authentication → Users i Supabase.

## Importera den riktiga spelarlistan
1. Skapa ett kalkylblad med rubrikraden `Namn;Nivågrupp;Kan stå i mål`. Se `sample/spelare-exempel.csv`.
2. Nivågruppen ska vara ett av de tre interna namnen. Standard är **Grön, Orange, Lila**. Använder ni andra namn, ändra dem först under **Ledare → Inställningar**. Ordningen avgör vilka som räknas som ”liknande nivå”.
3. Målkolumnen är `ja` eller `nej`.
4. Spara som CSV. Semikolon, komma och tabb fungerar. Gå till **Spelare → Importera CSV → Förhandsgranska**, rätta de rader som visas och tryck **Importera**. Filen läses i webbläsaren och laddas aldrig upp någonstans som fil.
5. Spelare matchas på namn. **Ersätt listan** arkiverar spelare som saknas i filen, och deras historik sparas.

## Så används den
1. **Omgångar → Ny omgång**: välj poolspelen. Ett förslag skapas direkt. Samma trupp gäller för lagets alla matcher i ett poolspel.
2. Ställ in antal utespelare, målvakter, kedjestorlek och max poolspel per spelare.
3. Markera vem som **inte kan** under **Tillgänglighet**, eller tryck på en spelare.
4. Flytta och lås spelare, och skriv kommentarer. **Skapa nytt förslag** behåller låsta placeringar.
5. **Fastställ** sparar lagen i historiken. Historiken används för att rotera målvakter och variera kedjor.
6. **Kopiera laglista** (per lag eller hela omgången) ger bara lagnamn och spelarnamn under *Målvakt* och *Utespelare*.

Om någon annan har ändrat utkastet sedan du öppnade det visas en varning, och din ändring sparas inte förrän du väljer att ladda om eller att göra den ändå.

Ändrar arrangören tid, hall eller datum, eller försvinner en match ur källan, märks lagkortet **Granska**. Laguttagningen ligger kvar.

## Bra att veta om gratisnivåerna
* **Supabase pausar** gratisprojekt som inte används på en vecka. Den dagliga synken håller normalt projektet vaket. Pausas det ändå: logga in på supabase.com och tryck **Resume project**. Data finns kvar.
* **Supabase tar inga säkerhetskopior** på gratisnivån. Tryck **Ledare → Ladda ner säkerhetskopia** ibland och spara filen på ett säkert ställe. Filen innehåller spelaruppgifter.
* **GitHub stänger av** schemalagda körningar i offentliga repon efter 60 dagar utan ändringar i repot. Sidan synkar ändå när någon öppnar den. Vill du återstarta: **Actions → Synka matchschema → Enable workflow**.

## Utveckling och tester
```
npm test          # förslagsregler, synk, omgångar, Supabase-klienten
npm run test:sql  # åtkomstregler och funktioner mot en lokal Postgres (PGHOST/PGPORT/PGUSER)
npm run preview   # http://localhost:8080 (demoläget fungerar utan Supabase)
```

## Filer
```
docs/                 sidan (GitHub Pages)
  config.js           Supabase-adress och publik nyckel
  app.js              gränssnittet
  backend-supabase.js inloggning och databas
  backend-demo.js     demoläge med påhittade spelare
  lib/planner.js      regler för lagförslag och kontroller
  lib/rounds.js       ändringar på en omgång
  lib/schedule.js     läser och jämför matchschemat
  lib/csv.js          CSV-import
  demo/schedule.json  kopia av offentlig matchdata för demon
supabase/schema.sql   databas, åtkomstregler och funktioner
scripts/sync.mjs      daglig synk (körs av GitHub Actions)
.github/workflows/    schemaläggningen
```
