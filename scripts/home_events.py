#!/usr/bin/env python3
"""Hämtar hela poolspelsschemat (alla lag) för Järfälla HC:s hemmapoolspel och
lagens tröjfärger från stats.swehockey.se, och sparar dem i Supabase.

Körs av GitHub Actions (.github/workflows/sync.yml). Använder matchsidans
(JHCmatcher) färdiga swehockey-läsare, som checkas ut bredvid i ./jhcmatcher.

Miljövariabler: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
Valfritt: JHCMATCHER_DIR (standard ./jhcmatcher), SWEHOCKEY_FIXTURES (testfiler),
          DRY_RUN=1 (skriv ut i stället för att spara)
"""
from __future__ import annotations

import json
import os
import re
import sys
import urllib.request
from datetime import date, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
JM = os.environ.get("JHCMATCHER_DIR") or os.path.join(os.path.dirname(HERE), "jhcmatcher")
sys.path.insert(0, os.path.join(JM, "scripts"))
from swehockey import Fetcher, FetchError, parse_schedule  # noqa: E402

CLUB = "Järfälla HC"
DRY = os.environ.get("DRY_RUN") == "1"


def group_ids() -> list[int]:
    """U9-grupper där Järfälla HC arrangerar minst ett poolspel (från matchsidans data)."""
    with open(os.path.join(JM, "docs", "data", "schedule.json"), encoding="utf-8") as f:
        data = json.load(f)
    ids = {m["group_id"] for m in data.get("matches", [])
           if m.get("age") == "U9" and not m.get("girls") and m.get("group_id")}
    return sorted(ids)


def home_blocks(html: str, gid: int, today: str) -> list[dict]:
    _, games = parse_schedule(html, gid)
    prev = None
    for g in games:  # parallella matcher saknar egen tid: samma som raden ovanför
        if g["start"] is None and prev and prev["block"] == g["block"] and prev["start"] and (prev["venue"] or "") == (g["venue"] or ""):
            g["start"] = prev["start"]
        prev = g
    blocks: dict[str, dict] = {}
    for g in games:
        if g["format"] != "sammandrag" or not g["date"] or g["date"] < today:
            continue
        b = blocks.setdefault(g["block"], {"block": g["block"], "group_id": gid, "date": g["date"],
                                           "venue": g["venue"], "host": None, "matches": []})
        b["host"] = b["host"] or g.get("host")
        b["matches"].append({"start": g["start"], "home": g["home"], "away": g["away"], "status": g["status"]})
    return [b for b in blocks.values() if b["host"] and CLUB in b["host"]]


COLOR_WORDS = r"(?:Black|White|Red|Blue|Green|Yellow|Orange|Purple|Grey|Gray|Navy|Maroon|Pink|Brown|Gold|Silver|Turquoise|Light blue|Dark blue|Svart|Vit|Röd|Blå|Grön|Gul)"


def team_colors(html: str, teams: list[str]) -> dict[str, dict]:
    """Läser 'Home: X  Away: Y' efter varje lagnamn på kontaktsidan."""
    from bs4 import BeautifulSoup
    text = BeautifulSoup(html, "html.parser").get_text("\n")
    text = re.sub(r"[ \t\r\f\v]+", " ", text)
    pos = sorted(((text.find(t), t) for t in teams if text.find(t) >= 0))
    out = {}
    for i, (p, t) in enumerate(pos):
        end = pos[i + 1][0] if i + 1 < len(pos) else len(text)
        chunk = text[p:end]
        h = re.search(r"Home:\s*(" + COLOR_WORDS + r"[\w /-]*)", chunk, re.I)
        a = re.search(r"Away:\s*(" + COLOR_WORDS + r"[\w /-]*)", chunk, re.I)
        if h or a:
            out[t] = {"home": h.group(1).strip() if h else None, "away": a.group(1).strip() if a else None}
    return out


def supabase(method: str, path: str, body=None, prefer: str | None = None):
    url = os.environ["SUPABASE_URL"].rstrip("/") + "/rest/v1/" + path
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    headers = {"apikey": key, "Content-Type": "application/json"}
    if key.startswith("eyJ"):
        headers["Authorization"] = f"Bearer {key}"
    if prefer:
        headers["Prefer"] = prefer
    req = urllib.request.Request(url, data=json.dumps(body).encode() if body is not None else None, method=method, headers=headers)
    with urllib.request.urlopen(req, timeout=30) as r:
        raw = r.read()
        return json.loads(raw) if raw else None


def main() -> int:
    today = (date.today() - timedelta(days=1)).isoformat()
    fetcher = Fetcher(delay=2.0)
    events: dict[str, dict] = {}
    all_teams: set[str] = set()
    colors: dict[str, dict] = {}
    errors = []
    for gid in group_ids():
        try:
            html = fetcher.get(f"/ScheduleAndResults/Schedule/{gid}")
        except FetchError as e:
            errors.append(str(e)); continue
        _, games = parse_schedule(html, gid)
        teams = sorted({t for g in games for t in (g["home"], g["away"]) if t})
        all_teams.update(teams)
        for b in home_blocks(html, gid, today):
            key = f"{b['date']}|{b['venue']}"
            ev = events.setdefault(key, {"key": key, "date": b["date"], "venue": b["venue"], "data": {"blocks": []}})
            ev["data"]["blocks"].append({"block": b["block"], "group_id": gid, "matches": b["matches"]})
        try:
            colors.update(team_colors(fetcher.get(f"/Teams/Info/Contacts/{gid}"), teams))
        except FetchError as e:
            errors.append(str(e))
    rows = list(events.values())
    color_rows = [{"team": t, "home": c["home"], "away": c["away"], "source": "swehockey"} for t, c in sorted(colors.items())]
    if DRY:
        print(json.dumps({"events": rows, "colors": color_rows, "errors": errors}, ensure_ascii=False, indent=1))
        return 0
    if rows:
        supabase("POST", "home_events?on_conflict=key", rows, "resolution=merge-duplicates")
    if color_rows:
        manual = {r["team"] for r in (supabase("GET", "team_colors?select=team&source=eq.manual") or [])}
        keep = [r for r in color_rows if r["team"] not in manual]  # handinlagda färger skrivs inte över
        if keep:
            supabase("POST", "team_colors?on_conflict=team", keep, "resolution=merge-duplicates")
    print(f"Hemmapoolspel: {len(rows)}, tröjfärger: {len(color_rows)}, fel: {len(errors)}")
    for e in errors:
        print("  ", e)
    return 0


if __name__ == "__main__":
    sys.exit(main())
