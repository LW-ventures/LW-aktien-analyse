// Holt Kurse und Kennzahlen von Yahoo Finance und schreibt sie als JSON (Klartext!).
// Nutzung: node scripts/fetch-data.mjs --watchlist "AAPL:Apple,SAP.DE:SAP" --picks AMD,NVO --out /tmp/aktien/raw.json
// Die Watchlist steht bewusst nicht im (öffentlichen) Repo, sondern kommt aus dem Routine-Auftrag.
// Die Ausgabe gehört NICHT ins Repo – nur build-report.mjs schreibt verschlüsselt ins Repo.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i].startsWith('--')) args[process.argv[i].slice(2)] = process.argv[i + 1] ?? '';
}
if (!args.out || !args.watchlist) { console.error('Fehlt: --watchlist "TICKER:Name,..." und --out <datei>'); process.exit(1); }

const config = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
config.watchlist = args.watchlist.split(',').map((e) => e.trim()).filter(Boolean).map((e) => {
  const [ticker, ...name] = e.split(':');
  return { ticker: ticker.trim(), name: name.join(':').trim() || null };
});
const picks = (args.picks || '').split(',').map((t) => t.trim()).filter(Boolean).map((ticker) => ({ ticker, name: null }));
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36' };

async function getJson(url, headers = {}) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = await fetch(url, { headers: { ...UA, ...headers } });
    if (r.ok) return r.json();
    if (attempt === 3) throw new Error(`${r.status} bei ${url}`);
    await new Promise((res) => setTimeout(res, 1500 * attempt));
  }
}

async function getCrumb() {
  try {
    const r = await fetch('https://fc.yahoo.com', { headers: UA, redirect: 'manual' });
    const cookie = r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    const c = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', { headers: { ...UA, Cookie: cookie } });
    return c.ok ? { cookie, crumb: await c.text() } : null;
  } catch { return null; }
}

const raw = (v) => (v && typeof v === 'object' ? (v.raw ?? null) : (v ?? null));
const round = (v, d = 2) => (v == null || !isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);
const pct = (a, b) => (a == null || b == null || b === 0 ? null : round((a / b - 1) * 100, 2));
const sma = (arr, n) => (arr.length < n ? null : arr.slice(-n).reduce((s, x) => s + x, 0) / n);

function rsi(closes, n = 14) {
  if (closes.length <= n) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= n; i++) { const d = closes[i] - closes[i - 1]; d > 0 ? (gain += d) : (loss -= d); }
  gain /= n; loss /= n;
  for (let i = n + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (n - 1) + Math.max(d, 0)) / n;
    loss = (loss * (n - 1) + Math.max(-d, 0)) / n;
  }
  return loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
}

async function chart(ticker) {
  const j = await getJson(`https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=1y&interval=1d`);
  const res = j.chart.result[0];
  const q = res.indicators.quote[0];
  const rows = res.timestamp.map((t, i) => [new Date(t * 1000).toISOString().slice(0, 10), q.close[i]]).filter((r) => r[1] != null);
  const closes = rows.map((r) => r[1]);
  const last = res.meta.regularMarketPrice ?? closes.at(-1);
  const prev = closes.length > 1 ? closes.at(-2) : null;
  const year = rows.at(-1)[0].slice(0, 4);
  const ytdBase = rows.findLast((r) => r[0] < `${year}-01-01`)?.[1] ?? rows[0][1];
  return {
    meta: res.meta, rows, closes,
    data: {
      price: round(last), currency: res.meta.currency, last_date: rows.at(-1)[0],
      chg_1d: pct(last, prev), chg_1w: pct(last, closes.at(-6)), chg_1m: pct(last, closes.at(-22)),
      chg_3m: pct(last, closes.at(-64)), chg_ytd: pct(last, ytdBase),
      high52: round(res.meta.fiftyTwoWeekHigh ?? Math.max(...closes)), low52: round(res.meta.fiftyTwoWeekLow ?? Math.min(...closes)),
    },
  };
}

async function summary(ticker, auth) {
  if (!auth) return {};
  const mods = 'price,summaryDetail,defaultKeyStatistics,financialData,calendarEvents,recommendationTrend';
  try {
    const j = await getJson(`https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=${mods}&crumb=${encodeURIComponent(auth.crumb)}`, { Cookie: auth.cookie });
    const q = j.quoteSummary.result[0];
    const fd = q.financialData || {}, sd = q.summaryDetail || {}, ks = q.defaultKeyStatistics || {}, ce = q.calendarEvents || {};
    const trend = (q.recommendationTrend?.trend || []).find((t) => t.period === '0m');
    const ed = (ce.earnings?.earningsDate || []).map((d) => raw(d)).filter(Boolean)[0];
    return {
      name: q.price?.longName || q.price?.shortName,
      market_cap: raw(q.price?.marketCap),
      pe: round(raw(sd.trailingPE), 1), fwd_pe: round(raw(sd.forwardPE) ?? raw(ks.forwardPE), 1),
      peg: round(raw(ks.pegRatio), 2), dividend_yield: round(raw(sd.dividendYield) * 100, 2),
      revenue_growth: round(raw(fd.revenueGrowth) * 100, 1), gross_margin: round(raw(fd.grossMargins) * 100, 1),
      operating_margin: round(raw(fd.operatingMargins) * 100, 1),
      target_mean: round(raw(fd.targetMeanPrice)), target_low: round(raw(fd.targetLowPrice)), target_high: round(raw(fd.targetHighPrice)),
      analyst_count: raw(fd.numberOfAnalystOpinions), rec_key: fd.recommendationKey ?? null,
      rec_trend: trend ? { strong_buy: trend.strongBuy, buy: trend.buy, hold: trend.hold, sell: trend.sell, strong_sell: trend.strongSell } : null,
      next_earnings: ed ? new Date(ed * 1000).toISOString().slice(0, 10) : null,
    };
  } catch (e) {
    console.warn(`  Kennzahlen für ${ticker} fehlen: ${e.message}`);
    return {};
  }
}

const auth = await getCrumb();
if (!auth) console.warn('Kein Yahoo-Crumb – Kennzahlen (KGV, Kursziele) fehlen, Kurse kommen trotzdem.');

const out = { fetched_at: new Date().toISOString(), indices: [], stocks: [], errors: [] };
for (const ix of config.indices) {
  try {
    const c = await chart(ix.ticker);
    out.indices.push({ ticker: ix.ticker, name: ix.name, price: c.data.price, chg_1d: c.data.chg_1d, chg_1w: c.data.chg_1w, last_date: c.data.last_date });
  } catch (e) { out.errors.push(`${ix.ticker}: ${e.message}`); }
}
for (const s of [...config.watchlist.map((w) => ({ ...w, type: 'core' })), ...picks.map((p) => ({ ...p, type: 'pick' }))]) {
  process.stdout.write(`${s.ticker} … `);
  try {
    const c = await chart(s.ticker);
    const sum = await summary(s.ticker, auth);
    const closes = c.closes;
    const sma50 = sma(closes, 50), sma200 = sma(closes, 200);
    // 6 Monate Schlusskurse + gleitender 50-Tage-Schnitt für die Diagramme
    const series = c.rows.slice(-126).map(([d, v], i, arr) => {
      const idx = c.rows.length - arr.length + i;
      const s50 = idx >= 49 ? sma(closes.slice(0, idx + 1), 50) : null;
      return [d, round(v), round(s50)];
    });
    out.stocks.push({
      ticker: s.ticker, type: s.type,
      ...c.data, ...sum,
      name: s.name || sum.name || c.meta.longName || s.ticker, name_full: sum.name || c.meta.longName,
      sma50: round(sma50), sma200: round(sma200), rsi14: round(rsi(closes), 1),
      vs_sma50: pct(c.data.price, sma50), vs_sma200: pct(c.data.price, sma200),
      target_upside: pct(sum.target_mean, c.data.price),
      series,
    });
    console.log('ok');
  } catch (e) {
    console.log('FEHLER');
    out.errors.push(`${s.ticker}: ${e.message}`);
  }
}

fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
fs.writeFileSync(args.out, JSON.stringify(out, null, 1));
console.log(`\n${out.stocks.length} Aktien, ${out.indices.length} Indizes -> ${args.out}`);
if (out.errors.length) { console.log('Fehler:', out.errors.join(' | ')); process.exitCode = 2; }
