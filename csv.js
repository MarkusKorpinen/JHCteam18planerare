// CSV-import av spelare: namn, nivågrupp, kan stå i mål.
export function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const first = text.split(/\r?\n/).find((l) => l.trim()) || '';
  const delim = [';', '\t', ','].map((d) => [d, first.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.map((r) => r.map((x) => x.trim())).filter((r) => r.some(Boolean));
}

const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z]/g, '');
const YES = new Set(['ja', 'j', 'x', '1', 'true', 'yes', 'y', 'malvakt', 'mv', 'kan']);
const NO = new Set(['nej', 'n', '0', 'false', 'no', '', 'utespelare', '-']);

export function playersFromCsv(text, levelNames) {
  const rows = parseCsv(text);
  const errors = [], players = [];
  if (!rows.length) return { players, errors: ['Filen är tom.'] };
  let idx = { name: 0, level: 1, goalie: 2, squad: 3 };
  let start = 0;
  const h = rows[0].map(norm);
  if (h.some((x) => ['namn', 'name', 'spelare'].includes(x))) {
    const find = (...keys) => h.findIndex((x) => keys.some((k) => x.includes(k)));
    let squadIdx = find('ordinarie', 'reserv', 'trupp', 'roll', 'status');
    if (squadIdx < 0) squadIdx = h.findIndex((x) => x === 'grupp' || x === 'spelargrupp');
    idx = { name: find('namn', 'name', 'spelare'), level: find('niva', 'level', 'nivagrupp'), goalie: find('mal', 'goal', 'mv'), squad: squadIdx };
    if (idx.level < 0) idx.level = h.findIndex((x, i) => x.includes('grupp') && i !== squadIdx);
    start = 1;
    if (idx.name < 0 || idx.level < 0) return { players, errors: ['Hittar inte kolumnerna för namn och nivågrupp i rubrikraden.'] };
  }
  const lv = new Map(levelNames.map((l) => [norm(l), l]));
  const seen = new Set();
  for (let i = start; i < rows.length; i++) {
    const r = rows[i], line = i + 1;
    const name = (r[idx.name] || '').replace(/\s+/g, ' ');
    if (!name) { errors.push(`Rad ${line}: namn saknas.`); continue; }
    const level = lv.get(norm(r[idx.level] || ''));
    if (!level) { errors.push(`Rad ${line} (${name}): okänd nivågrupp ”${r[idx.level] || ''}”. Tillåtna: ${levelNames.join(', ')}.`); continue; }
    const g = idx.goalie >= 0 ? norm(r[idx.goalie] || '') : '';
    if (!YES.has(g) && !NO.has(g)) { errors.push(`Rad ${line} (${name}): förstår inte målvaktsvärdet ”${r[idx.goalie]}”. Använd ja eller nej.`); continue; }
    const k = name.toLowerCase();
    if (seen.has(k)) { errors.push(`Rad ${line}: ${name} finns redan i filen.`); continue; }
    seen.add(k);
    const sq = idx.squad >= 0 ? norm(r[idx.squad] || '') : '';
    if (sq && !['ordinarie', 'ord', 'o', 'reserv', 'r', 'res'].includes(sq)) { errors.push(`Rad ${line} (${name}): förstår inte gruppen ”${r[idx.squad]}”. Använd ordinarie eller reserv.`); continue; }
    const p = { name, level, canGoalie: YES.has(g) };
    if (idx.squad >= 0 && r.length > idx.squad) p.squad = ['reserv', 'r', 'res'].includes(sq) ? 'reserv' : 'ordinarie';
    players.push(p);
  }
  return { players, errors };
}
