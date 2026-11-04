// Fügt Kursdaten (fetch-data.mjs) und die geschriebene Analyse zusammen, prüft sie
// und legt den Bericht VERSCHLÜSSELT unter reports/<datum>.enc ab.
// Nutzung: node scripts/build-report.mjs --raw /tmp/aktien/raw.json --analysis /tmp/aktien/analysis.json
//          [--check]   nur prüfen, nichts schreiben
//          [--dir <ordner>]  anderer Seitenordner (keys.json + reports/), z. B. für lokale Tests
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encryptReport } from './lib-crypto.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i].startsWith('--')) args[process.argv[i].slice(2)] = process.argv[i + 1]?.startsWith('--') ? true : (process.argv[i + 1] ?? true);
}
if (!args.raw || !args.analysis) { console.error('Fehlt: --raw <datei> --analysis <datei>'); process.exit(1); }

const raw = JSON.parse(fs.readFileSync(args.raw, 'utf8'));
const analysis = JSON.parse(fs.readFileSync(args.analysis, 'utf8'));
const site = typeof args.dir === 'string' ? path.resolve(args.dir) : root;
const keys = JSON.parse(fs.readFileSync(path.join(site, 'keys.json'), 'utf8'));

const problems = [];
const need = (cond, msg) => { if (!cond) problems.push(msg); };
// Nachrichtenlage, von stark positiv bis stark negativ. "gemischt" = Gutes und Schlechtes, "neutral" = kaum Neuigkeiten.
const SIGNALS = ['sehr_positiv', 'positiv', 'gemischt', 'neutral', 'negativ', 'sehr_negativ'];
const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '');
const isUrl = (u) => /^https?:\/\//.test(u || '');

need(isDate(analysis.date), 'analysis.date fehlt oder ist kein JJJJ-MM-TT');
need(analysis.market?.summary?.length > 40, 'market.summary fehlt oder ist zu kurz');

const stocks = raw.stocks.map((s) => {
  const a = analysis.stocks?.[s.ticker];
  if (!a) { problems.push(`Analyse für ${s.ticker} fehlt`); return s; }
  const p = `${s.ticker}:`;
  if (typeof a.signal === 'string') a.signal = a.signal.trim().toLowerCase().replace(/\s+/g, '_');
  need(SIGNALS.includes(a.signal), `${p} signal muss eines von ${SIGNALS.join('/')} sein`);
  need(a.signal_reason?.length >= 10 && a.signal_reason.length <= 160, `${p} signal_reason fehlt (ein Satz, warum diese Einstufung)`);
  need(a.headline?.length > 10, `${p} headline fehlt`);
  need(a.meaning?.length > 80, `${p} meaning (Einordnung) fehlt oder ist zu kurz`);
  need(Array.isArray(a.news) && a.news.length >= 2, `${p} mindestens 2 Nachrichten nötig`);
  (a.news || []).forEach((n, i) => need(n.title && isUrl(n.url) && n.source, `${p} news[${i}] braucht title, source, url`));
  (a.analysts || []).forEach((n, i) => need(n.firm && (n.action || n.target), `${p} analysts[${i}] braucht firm und action oder target`));
  need(Array.isArray(a.chances) && a.chances.length >= 3, `${p} genau 3 chances nötig`);
  need(Array.isArray(a.risks) && a.risks.length >= 3, `${p} genau 3 risks nötig`);
  (a.events || []).forEach((e, i) => need(isDate(e.date) && e.label, `${p} events[${i}] braucht date (JJJJ-MM-TT) und label`));
  if (s.type === 'pick') need(a.pick_reason?.length > 40, `${p} pick_reason fehlt (warum diese Aktie?)`);
  return { ...s, ...a };
});
const extra = Object.keys(analysis.stocks || {}).filter((t) => !raw.stocks.some((s) => s.ticker === t));
need(!extra.length, `Analyse für Ticker ohne Kursdaten: ${extra.join(', ')} – fetch-data.mjs mit --picks erneut laufen lassen`);
need(raw.stocks.filter((s) => s.type === 'pick').length >= 1, 'keine Zusatz-Aktien (--picks) in den Kursdaten');

if (problems.length) {
  console.error('Bericht unvollständig:\n - ' + problems.join('\n - '));
  process.exit(1);
}

const report = {
  date: analysis.date,
  generated_at: new Date().toISOString(),
  data_as_of: raw.fetched_at,
  market: analysis.market,
  calendar: analysis.calendar || [],
  indices: raw.indices,
  stocks,
};

if (args.check) { console.log(`OK – ${stocks.length} Aktien geprüft, nichts geschrieben.`); process.exit(0); }

const enc = await encryptReport(keys.publicKey, report);
fs.mkdirSync(path.join(site, 'reports'), { recursive: true });
fs.writeFileSync(path.join(site, 'reports', `${report.date}.enc`), JSON.stringify(enc));

const idxFile = path.join(site, 'reports', 'index.json');
const idx = fs.existsSync(idxFile) ? JSON.parse(fs.readFileSync(idxFile, 'utf8')) : { dates: [] };
idx.dates = [...new Set([report.date, ...idx.dates])].sort().reverse();
idx.updated = report.generated_at;
fs.writeFileSync(idxFile, JSON.stringify(idx, null, 1));
console.log(`Verschlüsselt: reports/${report.date}.enc (${stocks.length} Aktien). Archiv: ${idx.dates.length} Tage.`);
