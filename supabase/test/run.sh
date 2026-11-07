#!/bin/sh
# Kör databastesterna mot en lokal Postgres (PGHOST/PGPORT/PGUSER styr anslutningen).
set -e
cd "$(dirname "$0")"
dropdb --if-exists jhc_test 2>/dev/null || true
for r in anon authenticated service_role; do psql -q -d postgres -c "drop role if exists $r" 2>/dev/null || true; done
createdb jhc_test
psql -q -v ON_ERROR_STOP=1 -d jhc_test -f mock-supabase.sql
psql -q -v ON_ERROR_STOP=1 -d jhc_test -f ../schema.sql
psql -q -v ON_ERROR_STOP=1 -d jhc_test -f ../schema.sql   # ska gå att köra två gånger
psql -q -v ON_ERROR_STOP=1 -d jhc_test -f test-schema.sql
