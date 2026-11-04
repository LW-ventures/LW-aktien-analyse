'use strict';
// Entschlüsselt und zeigt die täglichen Berichte. Ablauf:
// Passwort -> (PBKDF2) entpackt privaten RSA-Schlüssel aus keys.json -> bleibt als nicht
// exportierbarer CryptoKey in IndexedDB -> entschlüsselt reports/<datum>.enc im Browser.

const $ = (s, el = document) => el.querySelector(s);
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const RSA = { name: 'RSA-OAEP', hash: 'SHA-256' };
const subtle = window.crypto && window.crypto.subtle;
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);
let keys, privKey, index;

/* ---------- Speicher für den Schlüssel (IndexedDB, fällt still auf "nur diese Sitzung" zurück) ---------- */
function idb(mode, fn) {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open('lw-aktien', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('k');
      req.onerror = () => resolve(null);
      req.onsuccess = () => {
        try {
          const tx = req.result.transaction('k', mode);
          const r = fn(tx.objectStore('k'));
          tx.oncomplete = () => resolve(r && 'result' in r ? r.result : null);
          tx.onerror = () => resolve(null);
        } catch { resolve(null); }
      };
    } catch { resolve(null); }
  });
}
const keyTag = () => keys.publicKey.slice(-40);
const loadStored = () => idb('readonly', (s) => s.get('key'));
const store = (key) => idb('readwrite', (s) => s.put({ key, tag: keyTag() }, 'key'));
const forget = () => idb('readwrite', (s) => s.delete('key'));

/* ---------- Krypto ---------- */
async function unlock(password) {
  const pw = new TextEncoder().encode(password);
  const base = await subtle.importKey('raw', pw, 'PBKDF2', false, ['deriveKey']);
  for (const w of keys.wraps) {
    try {
      const k = await subtle.deriveKey({ name: 'PBKDF2', salt: unb64(w.salt), iterations: w.iterations, hash: 'SHA-256' },
        base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
      const pkcs8 = await subtle.decrypt({ name: 'AES-GCM', iv: unb64(w.iv) }, k, unb64(w.data));
      return await subtle.importKey('pkcs8', pkcs8, RSA, false, ['decrypt']);
    } catch { /* nächstes Passwort-Fach probieren */ }
  }
  return null;
}

async function decryptReport(enc) {
  const raw = await subtle.decrypt(RSA, privKey, unb64(enc.key));
  const aes = await subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
  const plain = await subtle.decrypt({ name: 'AES-GCM', iv: unb64(enc.iv) }, aes, unb64(enc.data));
  return JSON.parse(new TextDecoder().decode(plain));
}

const getJson = async (url) => {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
};

/* ---------- Start ---------- */
function loadingMsg(text, skeleton = false) {
  $('#loading').hidden = false;
  $('#loading .msg-line').textContent = text;
  $('#loading').querySelectorAll('.sk').forEach((el) => { el.hidden = !skeleton; });
}

async function init() {
  if (!subtle) return loadingMsg('Dieser Browser unterstützt die Verschlüsselung nicht (HTTPS nötig).');
  try { keys = await getJson('keys.json'); } catch { return loadingMsg('Schlüsseldatei fehlt.'); }
  const stored = await loadStored();
  if (stored && stored.key && stored.tag === keyTag()) { privKey = stored.key; return showApp(); }
  showLogin();
}

function showLogin(message = '') {
  $('#loading').hidden = true; $('#app').hidden = true; $('#login').hidden = false;
  $('#login-msg').textContent = message;
  $('#pw').focus();
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#login-btn');
  btn.disabled = true; btn.textContent = 'Prüfe …'; $('#login-msg').textContent = '';
  const key = await unlock($('#pw').value);
  btn.disabled = false; btn.textContent = 'Entsperren';
  if (!key) { $('#login-msg').textContent = 'Passwort falsch.'; $('#pw').select(); return; }
  privKey = key;
  await store(key);
  $('#pw').value = '';
  showApp();
});

$('#logout').addEventListener('click', async () => { await forget(); privKey = null; history.replaceState(null, '', location.pathname); showLogin('Abgemeldet.'); });

async function showApp() {
  $('#login').hidden = true;
  loadingMsg('Entschlüssele Bericht …', true);
  try { index = await getJson('reports/index.json'); } catch { index = { dates: [] }; }
  if (!index.dates.length) return loadingMsg('Noch kein Bericht vorhanden.');
  const sel = $('#archive');
  sel.innerHTML = index.dates.map((d) => `<option value="${d}">${fmtDate(d, 'short')}</option>`).join('');
  sel.onchange = () => { location.hash = sel.value; };
  window.onhashchange = () => { const h = location.hash.slice(1); if (isDate(h)) openDate(h); };
  openDate(location.hash.slice(1));
}

async function openDate(date) {
  if (!index.dates.includes(date)) date = index.dates[0];
  $('#archive').value = date;
  let report;
  try { report = await decryptReport(await getJson(`reports/${date}.enc`)); } catch (err) {
    if (err instanceof DOMException) { await forget(); return showLogin('Der Zugang hat sich geändert. Bitte neu anmelden.'); }
    return loadingMsg('Bericht konnte nicht geladen werden.');
  }
  $('#loading').hidden = true; $('#app').hidden = false;
  render(report);
  window.scrollTo(0, 0);
}

/* ---------- Formatierung ---------- */
const nf = (d) => new Intl.NumberFormat('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d });
const num = (v, d = 2) => (v == null ? '-' : nf(d).format(v));
const sym = (c) => (c === 'EUR' ? '€' : c === 'USD' ? '$' : c || '');
const cur = (v, c) => (v == null ? '-' : `${num(v, v >= 1000 ? 0 : 2)} ${sym(c)}`.trim());
const signed = (v, d = 1) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${num(Math.abs(v), d)} %`;
const chg = (v, d = 1, pill = false) => (v == null ? '<span class="faint">-</span>'
  : `<span class="chg ${pill ? 'pill ' : ''}${v > 0 ? 'up' : v < 0 ? 'down' : ''}">${signed(v, d)}</span>`);
const big = (v) => (v == null ? '-' : v >= 1e12 ? `${num(v / 1e12, 2)} Bio.` : `${num(v / 1e9, 0)} Mrd.`);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeUrl = (u) => (/^https?:\/\//.test(u || '') ? esc(u) : '#');
const day = (d) => new Date(d + 'T12:00:00');
function fmtDate(d, style) {
  const opts = { short: { weekday: 'short', day: '2-digit', month: '2-digit' }, dm: { day: '2-digit', month: '2-digit' },
    long: { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }, full: { day: '2-digit', month: '2-digit', year: 'numeric' } };
  return day(d).toLocaleDateString('de-DE', opts[style] || opts.long);
}
const SIG = {
  sehr_positiv: ['Sehr positiv', '▲▲'], positiv: ['Positiv', '▲'], gemischt: ['Gemischt', '◆'],
  neutral: ['Neutral', '●'], negativ: ['Negativ', '▼'], sehr_negativ: ['Sehr negativ', '▼▼'],
};
const sig = (s, why) => `<span class="sig ${esc(s)}"${why ? ` title="${esc(why)}"` : ''}><i aria-hidden="true">${SIG[s]?.[1] || ''}</i>${SIG[s]?.[0] || esc(s)}</span>`;
const REC = { strong_buy: 'Stark kaufen', buy: 'Kaufen', hold: 'Halten', underperform: 'Untergewichten', sell: 'Verkaufen' };
const SERIES = ['--s1', '--s2', '--s3', '--s4', '--s5', '--s6', '--s7'];
const exch = (t) => (t.endsWith('.DE') ? 'Xetra' : 'US');
const slug = (t) => 'a-' + t.replace(/[^a-z0-9]/gi, '');
const nameOf = (s) => s.short_name || s.name;
const tickerOf = (s) => s.ticker.replace(/\.DE$/, '');

/* ---------- Rendern ---------- */
function splitLead(m) {
  if (m.headline) return [m.headline, m.summary];
  const i = m.summary.search(/[.:!?]\s/);
  return i > 20 && i < 180 ? [m.summary.slice(0, i + 1), m.summary.slice(i + 2)] : ['Marktlage', m.summary];
}

function render(r) {
  const asOf = new Date(r.data_as_of);
  $('#data-note').textContent = `Kursdaten: Yahoo Finance, Stand ${asOf.toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' })}. Nachrichten und Analystenstimmen: verlinkte Quellen.`;
  const core = r.stocks.filter((s) => s.type === 'core');
  const picks = r.stocks.filter((s) => s.type === 'pick');
  core.forEach((s, i) => { s.color = SERIES[i % SERIES.length]; });
  const [head, lead] = splitLead(r.market);
  let i = 0;
  const rv = () => `reveal" style="--i:${i++}`;

  $('#jump').innerHTML = [...core, ...picks].map((s) =>
    `<a href="#${slug(s.ticker)}" class="tap" data-t="${esc(s.ticker)}">${esc(nameOf(s))} ${chg(s.chg_1d)}</a>`).join('');

  $('#report').innerHTML = `
    <section class="intro intro-grid clamped ${rv()}">
      <div>
        <p class="date">${fmtDate(r.date)}</p>
        <h1>${esc(head)}</h1>
        ${lead ? `<p class="lead">${esc(lead)}</p>` : ''}
        ${r.market.drivers?.length ? `<ul class="drivers">${r.market.drivers.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>` : ''}
        <button type="button" class="more" id="more" aria-expanded="false">Weiterlesen</button>
      </div>
      <div class="indices">${r.indices.map((x) => `<div class="idx"><div class="n">${esc(x.name)}</div>
        <div class="v">${num(x.price, x.price < 10 ? 4 : x.price < 100 ? 2 : 0)}</div><div class="c">${chg(x.chg_1d)}</div></div>`).join('')}</div>
    </section>

    <section class="panel ${rv()}">
      <h2>Auf einen Blick</h2>
      <ul class="glance">${[...core, ...picks].map(glanceItem).join('')}</ul>
      <table class="glance-table">
        <thead><tr><th>Aktie</th><th>Kurs</th><th>Heute</th><th>1 Woche</th><th>1 Monat</th><th>Seit 1.1.</th><th>Ø Kursziel</th><th>Lage</th></tr></thead>
        <tbody>${[...core, ...picks].map(rowHtml).join('')}</tbody>
      </table>
    </section>

    <div class="two-col">
      <section class="panel ${rv()}">
        <h2>Letzte 3 Monate im Vergleich</h2>
        <p class="group-sub">Startwert jeder Aktie = 100. Tippe auf einen Namen, um ihn hervorzuheben.</p>
        <div class="legend" id="legend"></div>
        <div class="chart" id="compare"></div>
      </section>
      ${eventsHtml(r, rv())}
    </div>

    <h2 class="group-title">Deine Aktien</h2>
    ${core.map((s) => stockHtml(s, r.date)).join('')}

    ${picks.length ? `<h2 class="group-title">Heute aufgefallen</h2>
      <p class="group-sub">Zwei Werte außerhalb deiner Liste, die heute einen konkreten Anlass haben.</p>
      ${picks.map((s) => stockHtml(s, r.date)).join('')}` : ''}
  `;

  $('#more').addEventListener('click', (e) => {
    const intro = e.target.closest('.intro');
    const open = intro.classList.toggle('clamped') === false;
    e.target.textContent = open ? 'Weniger' : 'Weiterlesen';
    e.target.setAttribute('aria-expanded', open);
  });
  const go = (t) => document.getElementById(slug(t))?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  $('#report').querySelectorAll('tbody tr[data-t]').forEach((tr) => tr.addEventListener('click', () => go(tr.dataset.t)));
  document.querySelectorAll('#jump a, .glance a').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); go(a.dataset.t); }));

  const draw = () => { compareChart(core); r.stocks.forEach((s) => priceChart(s)); };
  draw();
  // Diagramme bei geänderter Breite (Handy drehen, iPad Split View) neu zeichnen
  let lastW = innerWidth, t;
  window.onresize = () => { clearTimeout(t); t = setTimeout(() => { if (innerWidth !== lastW) { lastW = innerWidth; draw(); } }, 200); };
}

function glanceItem(s) {
  return `<li><a href="#${slug(s.ticker)}" class="tap" data-t="${esc(s.ticker)}">
    <span class="nm"><span>${esc(nameOf(s))}</span>${s.type === 'pick' ? '<span class="tag">Neu</span>' : ''}</span>
    <span class="px">${cur(s.price, s.currency)}</span>
    <span class="sub"><span class="tk">${esc(tickerOf(s))}</span>${sig(s.signal, s.signal_reason)}</span>
    <span class="sub2">${chg(s.chg_1d, 1, true)}</span>
  </a></li>`;
}

function rowHtml(s) {
  return `<tr data-t="${esc(s.ticker)}">
    <td><strong>${esc(nameOf(s))}</strong> <span class="tk">${esc(tickerOf(s))}</span>${s.type === 'pick' ? ' <span class="tag">Neu</span>' : ''}</td>
    <td class="num">${cur(s.price, s.currency)}</td>
    <td>${chg(s.chg_1d)}</td><td>${chg(s.chg_1w)}</td><td>${chg(s.chg_1m)}</td><td>${chg(s.chg_ytd)}</td>
    <td>${s.target_mean ? `<span class="num">${cur(s.target_mean, s.currency)}</span> <span class="faint small">(${signed(s.target_upside, 0)})</span>` : '-'}</td>
    <td>${sig(s.signal, s.signal_reason)}</td></tr>`;
}

function eventsHtml(r, cls) {
  const today = r.date;
  const until = new Date(day(today).getTime() + 35 * 864e5).toISOString().slice(0, 10);
  const soon = new Date(day(today).getTime() + 7 * 864e5).toISOString().slice(0, 10);
  const list = (r.calendar || []).map((e) => ({ ...e, who: '' }));
  for (const s of r.stocks) {
    for (const e of s.events || []) list.push({ ...e, who: nameOf(s) });
    if (s.next_earnings > today && !(s.events || []).some((e) => e.date === s.next_earnings)) list.push({ date: s.next_earnings, label: 'Quartalszahlen', who: nameOf(s) });
  }
  const seen = new Set();
  const items = list.filter((e) => e.date >= today && e.date <= until)
    .filter((e) => { const k = e.date + e.who + e.label; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => a.date.localeCompare(b.date));
  return `<section class="panel ${cls}"><h2>Termine</h2>${items.length ? `<ul class="events">${items.map((e) => `
    <li class="${e.date <= soon ? 'soon' : ''}"><span class="d">${fmtDate(e.date, 'short')}</span>
    <span>${e.who ? `<strong>${esc(e.who)}</strong> ` : ''}<span class="muted">${esc(e.label)}</span></span></li>`).join('')}</ul>`
    : '<p class="empty">Keine Termine in den nächsten fünf Wochen.</p>'}</section>`;
}

function rangeBar(lo, hi, marks, labels) {
  if (lo == null || hi == null || hi <= lo) return '';
  const pos = (v) => Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100));
  return `<div class="range">${marks.map((m) => `<span class="mk ${m.cls || ''}" style="left:${pos(m.v)}%" title="${esc(m.title)}"></span>`).join('')}</div>
    <div class="range-l"><span>${labels[0]}</span><span>${labels[1]}</span></div>`;
}

function metricsHtml(s, date) {
  const rsiNote = s.rsi14 == null ? '' : s.rsi14 >= 70 ? 'überkauft' : s.rsi14 <= 30 ? 'überverkauft' : 'neutral';
  const earnLabel = s.next_earnings && s.next_earnings < date ? 'Letzte Zahlen' : 'Nächste Zahlen';
  const pct = (v) => (v == null ? '-' : `${num(v, 1)} %`);
  const m = [
    ['KGV', num(s.pe, 1), s.fwd_pe ? `erwartet ${num(s.fwd_pe, 1)}` : ''],
    ['Börsenwert', big(s.market_cap), sym(s.currency)],
    ['Umsatzwachstum', pct(s.revenue_growth), 'zum Vorjahr'],
    ['Operative Marge', pct(s.operating_margin), s.gross_margin ? `brutto ${num(s.gross_margin, 0)} %` : ''],
    ['RSI 14 Tage', num(s.rsi14, 0), rsiNote],
    ['Zum 200-Tage-Schnitt', s.vs_sma200 == null ? '-' : signed(s.vs_sma200), s.vs_sma50 == null ? '' : `50 Tage: ${signed(s.vs_sma50)}`],
    ['Dividende', s.dividend_yield ? `${num(s.dividend_yield, 2)} %` : '-', 'Rendite'],
    [earnLabel, s.next_earnings ? fmtDate(s.next_earnings, 'full') : '-', ''],
  ];
  const cell = ([l, v, h]) => `<div class="metric"><div class="l">${l}</div><div class="v">${v}${h ? `<span class="h">${esc(h)}</span>` : ''}</div></div>`;
  const wk = `<div class="metric wide"><div class="l">52-Wochen-Spanne</div>
    ${rangeBar(s.low52, s.high52, [{ v: s.price, title: 'Aktueller Kurs' }], [cur(s.low52, s.currency), cur(s.high52, s.currency)])}</div>`;
  let an = '';
  if (s.target_mean) {
    const lo = Math.min(s.target_low ?? s.price, s.price), hi = Math.max(s.target_high ?? s.price, s.price);
    const rt = s.rec_trend, total = rt ? rt.strong_buy + rt.buy + rt.hold + rt.sell + rt.strong_sell : 0;
    an = `<div class="metric wide"><div class="l">Analysten (${s.analyst_count ?? '?'})${REC[s.rec_key] ? `, Konsens <strong>${REC[s.rec_key]}</strong>` : ''}</div>
      ${total ? `<div class="h" style="margin-top:4px">${rt.strong_buy + rt.buy}× Kaufen, ${rt.hold}× Halten, ${rt.sell + rt.strong_sell}× Verkaufen</div>` : ''}
      ${rangeBar(lo, hi, [{ v: s.price, title: 'Aktueller Kurs' }, { v: s.target_mean, cls: 't', title: 'Ø Kursziel' }], [`tief ${cur(s.target_low, s.currency)}`, `hoch ${cur(s.target_high, s.currency)}`])}
      <div class="h" style="margin-top:4px">Ø Kursziel <strong class="num">${cur(s.target_mean, s.currency)}</strong> (${signed(s.target_upside, 0)}). Blau = Ziel, dunkel = Kurs.</div></div>`;
  }
  return `<div class="metrics">${m.map(cell).join('')}${wk}${an}</div>`;
}

function stockHtml(s, date) {
  const news = (s.news || []).map((n) => `<li>
      <div class="t"><a href="${safeUrl(n.url)}" target="_blank" rel="noopener noreferrer">${esc(n.title)}</a></div>
      <div class="meta">${esc(n.source)}${n.date ? `, ${fmtDate(n.date, 'dm')}` : ''}</div>
      ${n.note ? `<div class="note">${esc(n.note)}</div>` : ''}</li>`).join('');
  const analysts = (s.analysts || []).length ? `<details class="analysts"><summary>Analystenstimmen (${s.analysts.length})</summary>
      <ul class="an-list">${s.analysts.map((a) => `<li>
        <span class="f">${a.url ? `<a href="${safeUrl(a.url)}" target="_blank" rel="noopener noreferrer">${esc(a.firm)}</a>` : esc(a.firm)}</span>
        <span class="tg">${esc(a.target || '')}</span>
        <span class="a">${esc(a.action || '')}</span><span class="dt">${a.date ? fmtDate(a.date, 'dm') : ''}</span></li>`).join('')}</ul></details>` : '';
  return `<article class="panel stock reveal" id="${slug(s.ticker)}">
    <div class="stock-head">
      <div><h3>${esc(nameOf(s))}</h3>
        <div class="meta"><span class="tk">${esc(tickerOf(s))} · ${exch(s.ticker)}</span>${sig(s.signal)}</div></div>
      <div class="price"><div class="p">${cur(s.price, s.currency)}</div><div>${chg(s.chg_1d, 1, true)}</div></div>
    </div>
    ${s.signal_reason ? `<p class="sig-reason ${esc(s.signal)}"><strong>Lage:</strong> ${esc(s.signal_reason)}</p>` : ''}
    ${s.pick_reason ? `<p class="pick-reason"><strong>Warum heute?</strong> ${esc(s.pick_reason)}</p>` : ''}
    <p class="headline">${esc(s.headline)}</p>
    <p class="meaning">${esc(s.meaning)}</p>
    <div class="stock-body">
      <div><div class="chart" id="pc-${slug(s.ticker)}"></div>
        <div class="chart-key"><span><i></i>Kurs 6 Monate</span><span><i class="k-sma"></i>50-Tage-Schnitt</span><span class="k-tgt-wrap"></span></div></div>
      ${metricsHtml(s, date)}
    </div>
    <div class="cr">
      <div><h4 class="sub-h"><span class="ico p" aria-hidden="true">+</span>Chancen</h4><ul>${(s.chances || []).map((c) => `<li>${esc(c)}</li>`).join('')}</ul></div>
      <div><h4 class="sub-h"><span class="ico m" aria-hidden="true">−</span>Risiken</h4><ul>${(s.risks || []).map((c) => `<li>${esc(c)}</li>`).join('')}</ul></div>
    </div>
    <div class="news-block"><h4 class="sub-h">Nachrichten</h4>${news ? `<ul class="news">${news}</ul>` : '<p class="empty">Keine wichtigen Meldungen.</p>'}</div>
    ${analysts}
  </article>`;
}

/* ---------- Diagramme (eigenes SVG, keine Fremdbibliothek) ---------- */
function niceTicks(min, max, count = 4) {
  const span = max - min || 1;
  const step0 = span / count, mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0);
  const ticks = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) ticks.push(v);
  return ticks;
}

function baseChart(el, { width, height, xs, yMin, yMax, yFmt }) {
  const pad = { l: 8, r: 46, t: 10, b: 24 };  // Achse rechts: lässt auf dem Handy mehr Breite für die Linie
  const W = width, H = height;
  const x = (i) => pad.l + (i / Math.max(1, xs.length - 1)) * (W - pad.l - pad.r);
  const y = (v) => pad.t + (1 - (v - yMin) / (yMax - yMin || 1)) * (H - pad.t - pad.b);
  let g = '';
  for (const t of niceTicks(yMin, yMax)) g += `<line class="gridline" x1="${pad.l}" x2="${W - pad.r}" y1="${y(t)}" y2="${y(t)}"/><text class="axis" x="${W - pad.r + 6}" y="${y(t) + 4}">${yFmt(t)}</text>`;
  const months = [];
  xs.forEach((d, i) => { if (i > 0 && d.slice(5, 7) !== xs[i - 1].slice(5, 7)) months.push(i); });
  for (const i of months) g += `<text class="axis" x="${x(i)}" y="${H - 6}" text-anchor="middle">${day(xs[i]).toLocaleDateString('de-DE', { month: 'short' }).replace('.', '')}</text>`;
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img">${g}<g class="plot"></g><g class="hover"></g></svg>`;
  return { svg: el.querySelector('svg'), plot: el.querySelector('.plot'), hover: el.querySelector('.hover'), x, y, pad, W, H };
}
const pathOf = (pts) => pts.map(([px, py], i) => `${i ? 'L' : 'M'}${px.toFixed(1)},${py.toFixed(1)}`).join('');

function attachHover(el, c, xs, onIndex) {
  const tip = document.createElement('div'); tip.className = 'tip'; tip.hidden = true; el.appendChild(tip);
  const move = (ev) => {
    const rect = c.svg.getBoundingClientRect();
    const px = ((ev.touches ? ev.touches[0].clientX : ev.clientX) - rect.left) * (c.W / rect.width);
    const i = Math.round(((px - c.pad.l) / (c.W - c.pad.l - c.pad.r)) * (xs.length - 1));
    if (i < 0 || i >= xs.length) return leave();
    const { marks, html } = onIndex(i);
    c.hover.innerHTML = `<line class="cross" x1="${c.x(i)}" x2="${c.x(i)}" y1="${c.pad.t}" y2="${c.H - c.pad.b}"/>` +
      marks.map((m) => `<circle class="dot" cx="${c.x(i)}" cy="${m.y}" r="4.5" fill="${m.color}"/>`).join('');
    tip.innerHTML = html; tip.hidden = false;
    const left = (c.x(i) / c.W) * rect.width;
    const want = left > rect.width / 2 ? left - tip.offsetWidth - 14 : left + 14;
    tip.style.left = `${Math.max(0, Math.min(rect.width - tip.offsetWidth, want))}px`;
    tip.style.top = '0px';
  };
  const leave = () => { tip.hidden = true; c.hover.innerHTML = ''; };
  c.svg.addEventListener('pointermove', move);
  c.svg.addEventListener('pointerdown', move);
  c.svg.addEventListener('pointerleave', leave);
  c.svg.addEventListener('touchmove', move, { passive: true });
}

function compareChart(core) {
  const el = $('#compare');
  const xs = core[0].series.slice(-64).map((p) => p[0]);
  const lines = core.map((s) => {
    const map = new Map(s.series.map((p) => [p[0], p[1]]));
    let last = null;
    const vals = xs.map((d) => (map.has(d) ? (last = map.get(d)) : last)); // Feiertage (Xetra/US) überbrücken
    const first = vals.find((v) => v != null);
    return { s, vals: vals.map((v) => (v == null ? null : (v / first) * 100)) };
  });
  const on = new Set(core.map((s) => s.ticker));
  const draw = () => {
    const vis = lines.filter((l) => on.has(l.s.ticker));
    const all = (vis.length ? vis : lines).flatMap((l) => l.vals).filter((v) => v != null);
    const pad = (Math.max(...all) - Math.min(...all)) * 0.06;
    const w = Math.max(300, Math.min(760, el.clientWidth || 700));
    const c = baseChart(el, { width: w, height: Math.round(Math.max(230, w * 0.5)), xs, yMin: Math.min(...all) - pad, yMax: Math.max(...all) + pad, yFmt: (v) => num(v, 0) });
    c.plot.innerHTML = `<line class="target" x1="${c.pad.l}" x2="${c.W - c.pad.r}" y1="${c.y(100)}" y2="${c.y(100)}"/>` +
      lines.map((l) => `<path class="ln ${on.has(l.s.ticker) ? '' : 'dim'}" stroke="var(${l.s.color})" d="${pathOf(l.vals.map((v, i) => [c.x(i), c.y(v ?? 100)]))}"/>`).join('');
    attachHover(el, c, xs, (i) => {
      const rows = vis.map((l) => ({ l, v: l.vals[i] })).filter((r) => r.v != null).sort((a, b) => b.v - a.v);
      return {
        marks: rows.map((r) => ({ y: c.y(r.v), color: `var(${r.l.s.color})` })),
        html: `<div class="faint" style="margin-bottom:2px">${fmtDate(xs[i], 'full')}</div>` +
          rows.map((r) => `<div class="row"><span><i class="sw" style="background:var(${r.l.s.color})"></i>${esc(nameOf(r.l.s))}</span>${chg(r.v - 100)}</div>`).join(''),
      };
    });
  };
  $('#legend').innerHTML = core.map((s) => `<button type="button" aria-pressed="true" data-t="${esc(s.ticker)}"><i class="sw" style="background:var(${s.color})"></i>${esc(nameOf(s))}</button>`).join('');
  $('#legend').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    const t = b.dataset.t;
    if (on.size === core.length) { on.clear(); on.add(t); } // erster Tipp: nur diese Aktie hervorheben
    else if (on.has(t)) { on.delete(t); if (!on.size) core.forEach((s) => on.add(s.ticker)); }
    else on.add(t);
    $('#legend').querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', on.has(x.dataset.t)));
    draw();
  }));
  draw();
}

function priceChart(s) {
  const el = document.getElementById('pc-' + slug(s.ticker));
  if (!el || !s.series?.length) return;
  const xs = s.series.map((p) => p[0]);
  const vals = s.series.map((p) => p[1]);
  const smas = s.series.map((p) => p[2]);
  const base = [...vals, ...smas.filter((v) => v != null)];
  // Kursziel nur einzeichnen, wenn es die Kurslinie nicht platt drückt
  const showTarget = s.target_mean && s.target_mean < Math.max(...base) * 1.3 && s.target_mean > Math.min(...base) * 0.7;
  const pool = showTarget ? [...base, s.target_mean] : base;
  const pad = (Math.max(...pool) - Math.min(...pool)) * 0.08;
  const w = Math.max(300, Math.min(600, el.clientWidth || 520));
  const c = baseChart(el, { width: w, height: Math.round(Math.max(180, w * 0.48)), xs, yMin: Math.min(...pool) - pad, yMax: Math.max(...pool) + pad, yFmt: (v) => num(v, v >= 100 ? 0 : 1) });
  const pts = vals.map((v, i) => [c.x(i), c.y(v)]);
  const smaPts = smas.map((v, i) => [i, v]).filter(([, v]) => v != null).map(([i, v]) => [c.x(i), c.y(v)]);
  const gid = 'g' + slug(s.ticker);
  c.plot.innerHTML = `<defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--price)" stop-opacity=".16"/><stop offset="1" stop-color="var(--price)" stop-opacity="0"/></linearGradient></defs>` +
    `<path class="area" fill="url(#${gid})" d="${pathOf(pts)}L${pts.at(-1)[0]},${c.H - c.pad.b}L${pts[0][0]},${c.H - c.pad.b}Z"/>` +
    (showTarget ? `<line class="target" x1="${c.pad.l}" x2="${c.W - c.pad.r}" y1="${c.y(s.target_mean)}" y2="${c.y(s.target_mean)}"/>` : '') +
    (smaPts.length ? `<path class="sma" d="${pathOf(smaPts)}"/>` : '') +
    `<path class="ln" stroke="var(--price)" d="${pathOf(pts)}"/>`;
  const key = el.parentElement.querySelector('.k-tgt-wrap');
  if (key) key.innerHTML = !s.target_mean ? '' : showTarget ? '<i class="k-tgt"></i>Ø Kursziel' : `Ø Kursziel ${cur(s.target_mean, s.currency)} liegt oberhalb`;
  attachHover(el, c, xs, (i) => ({
    marks: [{ y: c.y(vals[i]), color: 'var(--price)' }],
    html: `<div class="faint">${fmtDate(xs[i], 'full')}</div><div class="row"><span>Kurs</span><strong class="num">${cur(vals[i], s.currency)}</strong></div>` +
      (smas[i] != null ? `<div class="row"><span>50 Tage</span><span class="num">${cur(smas[i], s.currency)}</span></div>` : ''),
  }));
}

init();
