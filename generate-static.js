'use strict';

const fs = require('fs');
const path = require('path');

const ANALYSIS_PATH = 'data/analysis/latest-analysis.json';
const DIST_DIR = 'dist';
const OUT_PATH = path.join(DIST_DIR, 'index.html');

// ─── Load data ──────────────────────────────────────────────────────────────
if (!fs.existsSync(ANALYSIS_PATH)) {
  console.error(`[generate] Nincs elemzési fájl: ${ANALYSIS_PATH}`);
  process.exit(1);
}

const analysis = JSON.parse(fs.readFileSync(ANALYSIS_PATH, 'utf8'));
const topListings = analysis.topListings || [];
const allAnnotated = analysis.allListingsAnnotated || analysis.allPreselected || [];
const rejectedListings = allAnnotated.filter(l => l && l.rejection_reason);
const analyzedAt = analysis.analyzed_at ? new Date(analysis.analyzed_at) : new Date();

// ─── Helpers ─────────────────────────────────────────────────────────────────
function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtPrice(n) {
  if (!n) return '—';
  return n.toLocaleString('hu-HU') + ' Ft';
}

function fmtDate(d) {
  return d.toLocaleDateString('hu-HU', {
    year: 'numeric', month: 'long', day: 'numeric',
  });
}

function scoreLabel(score) {
  const n = parseFloat(score) || 0;
  if (n >= 7.5) return 'verdict-high';
  if (n >= 5) return 'verdict-mid';
  return 'verdict-low';
}

function recClass(rec) {
  const r = (rec || '').toUpperCase();
  if (r.includes('NEM')) return 'rec-no';
  if (r.includes('AJÁNLOTT')) return 'rec-yes';
  return 'rec-maybe';
}

function recLabel(rec) {
  const r = (rec || '').toUpperCase();
  if (r.includes('NEM AJÁNLOTT')) return 'NEM AJÁNLOTT';
  if (r.includes('AJÁNLOTT')) return 'AJÁNLOTT';
  return 'MEGFONTOLHATÓ';
}

// ─── Top listing card ─────────────────────────────────────────────────────────
function renderVerdictCard(l, rank) {
  const v = l.verdict || {};
  const score = v.overall_score != null ? v.overall_score : '—';
  const scoreClass = scoreLabel(v.overall_score);
  const rc = recClass(v.recommendation);
  const rl = recLabel(v.recommendation);

  const district = esc(l.district || 'Ismeretlen kerület');
  const price = fmtPrice(l.price_huf_monthly);
  const totalCost = v.estimated_total_monthly_cost ? fmtPrice(v.estimated_total_monthly_cost) : null;

  const prosHtml = (v.pros || []).map(p =>
    `<li><span class="bullet-yes">+</span>${esc(p)}</li>`
  ).join('');

  const consHtml = (v.cons || []).map(c =>
    `<li><span class="bullet-no">–</span>${esc(c)}</li>`
  ).join('');

  const redFlagsHtml = (v.red_flags || []).filter(Boolean).map(r =>
    `<li>${esc(r)}</li>`
  ).join('');

  const tipsHtml = (v.practical_tips || []).map(t =>
    `<li>${esc(t)}</li>`
  ).join('');

  const imgUrl = (l.image_urls || [])[0] || '';

  return `
<article class="verdict-card" id="listing-${rank}">
  <div class="card-rank">#${rank}</div>

  <div class="card-inner">
    ${imgUrl ? `<div class="card-image" style="background-image:url('${esc(imgUrl)}')"></div>` : ''}

    <div class="card-header">
      <div class="card-meta-row">
        <span class="district-label">${district}</span>
        <span class="rec-badge ${rc}">${rl}</span>
      </div>
      <div class="card-price-row">
        <span class="price-main">${price}<span class="price-period">/hó</span></span>
        ${totalCost ? `<span class="price-total">≈ ${totalCost} rezsivel</span>` : ''}
      </div>
      <div class="card-specs">
        ${l.area_sqm ? `<span class="spec">${l.area_sqm} m²</span>` : ''}
        ${l.rooms ? `<span class="spec">${l.rooms} szoba</span>` : ''}
        ${l.floor ? `<span class="spec">${esc(l.floor)}</span>` : ''}
        ${l.has_elevator === true ? `<span class="spec spec-yes">lift</span>` : l.has_elevator === false ? `<span class="spec spec-no">lift nincs</span>` : ''}
      </div>
    </div>

    <div class="score-block ${scoreClass}">
      <div class="score-number">${score}</div>
      <div class="score-label">/ 10</div>
    </div>

    ${v.summary ? `<blockquote class="verdict-summary">${esc(v.summary)}</blockquote>` : ''}

    <div class="analysis-grid">
      ${v.price_analysis ? `
      <div class="analysis-block">
        <h4 class="analysis-title">Árítélet</h4>
        <p>${esc(v.price_analysis)}</p>
      </div>` : ''}
      ${v.location_analysis ? `
      <div class="analysis-block">
        <h4 class="analysis-title">Helyszínelemzés</h4>
        <p>${esc(v.location_analysis)}</p>
      </div>` : ''}
    </div>

    <div class="pros-cons-grid">
      ${prosHtml ? `
      <div class="pros-block">
        <h4 class="list-title list-title-yes">Előnyök</h4>
        <ul class="verdict-list">${prosHtml}</ul>
      </div>` : ''}
      ${consHtml ? `
      <div class="cons-block">
        <h4 class="list-title list-title-no">Hátrányok</h4>
        <ul class="verdict-list">${consHtml}</ul>
      </div>` : ''}
    </div>

    ${redFlagsHtml ? `
    <div class="red-flags-block">
      <h4 class="list-title list-title-danger">Piros zászlók</h4>
      <ul class="verdict-list verdict-list-danger">${redFlagsHtml}</ul>
    </div>` : ''}

    ${tipsHtml ? `
    <div class="tips-block">
      <h4 class="list-title">Kővári tippjei a megtekintéshez</h4>
      <ul class="verdict-list verdict-list-tips">${tipsHtml}</ul>
    </div>` : ''}

    <a href="${esc(l.url)}" target="_blank" rel="noopener" class="listing-link">
      Hirdetés megtekintése &rarr;
    </a>
  </div>
</article>`;
}

// ─── Rejected listing card ────────────────────────────────────────────────────
function renderRejectedCard(l) {
  const district = esc(l.district || 'Ismeretlen');
  const price = fmtPrice(l.price_huf_monthly);
  const reason = esc(l.rejection_reason || '');
  return `
<div class="rejected-card">
  <div class="rejected-district">${district}</div>
  <div class="rejected-price">${price}/hó</div>
  <div class="rejected-specs">
    ${l.area_sqm ? `${l.area_sqm} m²` : ''}${l.rooms ? ` · ${l.rooms} szoba` : ''}${l.floor ? ` · ${esc(l.floor)}` : ''}
  </div>
  <div class="rejected-reason">"${reason}"</div>
  <a href="${esc(l.url)}" target="_blank" rel="noopener" class="rejected-link">&#8599;</a>
</div>`;
}

// ─── Full HTML ────────────────────────────────────────────────────────────────
function buildHtml() {
  const verdictCards = topListings.map((l, i) => renderVerdictCard(l, i + 1)).join('\n');
  const rejectedCards = rejectedListings.map(l => renderRejectedCard(l)).join('\n');

  const dateStr = fmtDate(analyzedAt);
  const totalScraped = analysis.total_scraped || 0;
  const topCount = topListings.length;
  const rejectedCount = rejectedListings.length;

  return `<!DOCTYPE html>
<html lang="hu">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Kővári Béla Verdikt-Szemléje — ${dateStr}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,600;0,700;1,300;1,400&family=JetBrains+Mono:wght@400;500&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    /* ── Reset ── */
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html { scroll-behavior: smooth; }

    /* ── Tokens ── */
    :root {
      --bg:          #09090b;
      --surface:     #111113;
      --surface-2:   #18181b;
      --border:      #27272a;
      --border-2:    #3f3f46;
      --gold:        #c8a05a;
      --gold-dim:    rgba(200,160,90,0.12);
      --gold-border: rgba(200,160,90,0.3);
      --text:        #e8e0d0;
      --text-muted:  #71717a;
      --text-dim:    #a1a1aa;
      --green:       #22c55e;
      --green-dim:   rgba(34,197,94,0.1);
      --red:         #ef4444;
      --red-dim:     rgba(239,68,68,0.1);
      --amber:       #f59e0b;
      --amber-dim:   rgba(245,158,11,0.1);
      --radius:      4px;
      --radius-lg:   8px;
    }

    /* ── Base ── */
    body {
      background: var(--bg);
      color: var(--text);
      font-family: 'Inter', system-ui, sans-serif;
      font-size: 15px;
      line-height: 1.65;
      min-height: 100vh;
    }

    a { color: var(--gold); text-decoration: none; }
    a:hover { text-decoration: underline; }

    /* ── Masthead ── */
    .masthead {
      border-bottom: 1px solid var(--border);
      padding: 0 clamp(20px, 5vw, 80px);
      position: relative;
      overflow: hidden;
    }

    .masthead::before {
      content: 'VERDIKT';
      position: absolute;
      top: -20px;
      left: -10px;
      font-family: 'Cormorant Garamond', serif;
      font-size: clamp(100px, 20vw, 260px);
      font-weight: 700;
      color: rgba(200,160,90,0.04);
      line-height: 1;
      pointer-events: none;
      user-select: none;
      white-space: nowrap;
    }

    .masthead-inner {
      position: relative;
      z-index: 1;
      max-width: 1100px;
      margin: 0 auto;
      padding: 48px 0 40px;
    }

    .masthead-eyebrow {
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px;
      letter-spacing: 0.15em;
      text-transform: uppercase;
      color: var(--gold);
      margin-bottom: 16px;
    }

    .masthead-title {
      font-family: 'Cormorant Garamond', serif;
      font-size: clamp(38px, 7vw, 80px);
      font-weight: 300;
      line-height: 1.05;
      letter-spacing: -0.01em;
      color: var(--text);
      margin-bottom: 8px;
    }

    .masthead-title em {
      font-style: italic;
      color: var(--gold);
    }

    .masthead-subtitle {
      font-family: 'Cormorant Garamond', serif;
      font-size: clamp(16px, 2.5vw, 22px);
      font-weight: 300;
      font-style: italic;
      color: var(--text-muted);
      margin-bottom: 32px;
    }

    .masthead-stats {
      display: flex;
      flex-wrap: wrap;
      gap: 24px;
      padding-top: 24px;
      border-top: 1px solid var(--border);
    }

    .stat-item {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .stat-value {
      font-family: 'JetBrains Mono', monospace;
      font-size: 28px;
      font-weight: 500;
      color: var(--gold);
      line-height: 1;
    }

    .stat-label {
      font-size: 11px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--text-muted);
    }

    .masthead-date {
      margin-left: auto;
      text-align: right;
      align-self: flex-end;
    }

    .date-value {
      font-family: 'Cormorant Garamond', serif;
      font-size: 16px;
      font-style: italic;
      color: var(--text-dim);
    }

    /* ── Main Layout ── */
    .site-main {
      max-width: 1100px;
      margin: 0 auto;
      padding: 0 clamp(20px, 5vw, 80px) 80px;
    }

    /* ── Section Headers ── */
    .section-header {
      display: flex;
      align-items: baseline;
      gap: 16px;
      margin: 64px 0 32px;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--border);
    }

    .section-title {
      font-family: 'Cormorant Garamond', serif;
      font-size: clamp(24px, 4vw, 40px);
      font-weight: 600;
      color: var(--text);
      letter-spacing: -0.02em;
    }

    .section-count {
      font-family: 'JetBrains Mono', monospace;
      font-size: 12px;
      color: var(--text-muted);
      border: 1px solid var(--border);
      padding: 2px 8px;
      border-radius: 20px;
    }

    /* ── Verdict Cards ── */
    .verdict-cards {
      display: flex;
      flex-direction: column;
      gap: 48px;
    }

    .verdict-card {
      position: relative;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      overflow: hidden;
      transition: border-color 0.2s;
    }

    .verdict-card:hover {
      border-color: var(--gold-border);
    }

    .card-rank {
      position: absolute;
      top: 0;
      left: 0;
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px;
      letter-spacing: 0.1em;
      color: var(--gold);
      background: var(--gold-dim);
      border-right: 1px solid var(--gold-border);
      border-bottom: 1px solid var(--gold-border);
      padding: 6px 12px;
      border-bottom-right-radius: var(--radius);
    }

    .card-image {
      width: 100%;
      height: 240px;
      background-size: cover;
      background-position: center;
      background-color: var(--surface-2);
      border-bottom: 1px solid var(--border);
    }

    .card-inner {
      padding: 32px 32px 28px;
      position: relative;
    }

    .card-header {
      margin-bottom: 24px;
      padding-right: 100px;
    }

    .card-meta-row {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 10px;
      flex-wrap: wrap;
    }

    .district-label {
      font-family: 'JetBrains Mono', monospace;
      font-size: 12px;
      letter-spacing: 0.05em;
      color: var(--text-dim);
      text-transform: uppercase;
    }

    .rec-badge {
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      padding: 3px 10px;
      border-radius: 2px;
    }

    .rec-yes  { background: var(--green-dim); color: var(--green); border: 1px solid rgba(34,197,94,0.25); }
    .rec-no   { background: var(--red-dim); color: var(--red); border: 1px solid rgba(239,68,68,0.25); }
    .rec-maybe { background: var(--amber-dim); color: var(--amber); border: 1px solid rgba(245,158,11,0.25); }

    .card-price-row {
      display: flex;
      align-items: baseline;
      gap: 16px;
      flex-wrap: wrap;
      margin-bottom: 12px;
    }

    .price-main {
      font-family: 'Cormorant Garamond', serif;
      font-size: 36px;
      font-weight: 600;
      color: var(--text);
      line-height: 1;
    }

    .price-period {
      font-size: 16px;
      font-weight: 300;
      color: var(--text-muted);
    }

    .price-total {
      font-size: 13px;
      color: var(--text-muted);
      font-style: italic;
    }

    .card-specs {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }

    .spec {
      font-family: 'JetBrains Mono', monospace;
      font-size: 12px;
      color: var(--text-muted);
      background: var(--surface-2);
      border: 1px solid var(--border);
      padding: 3px 10px;
      border-radius: var(--radius);
    }

    .spec-yes { color: var(--green); border-color: rgba(34,197,94,0.2); background: var(--green-dim); }
    .spec-no  { color: var(--red); border-color: rgba(239,68,68,0.2); background: var(--red-dim); }

    .score-block {
      position: absolute;
      top: 28px;
      right: 28px;
      display: flex;
      align-items: baseline;
      gap: 2px;
      padding: 12px 16px;
      border-radius: var(--radius);
      border: 1px solid;
    }

    .verdict-high { background: var(--green-dim); border-color: rgba(34,197,94,0.3); }
    .verdict-mid  { background: var(--amber-dim); border-color: rgba(245,158,11,0.3); }
    .verdict-low  { background: var(--red-dim); border-color: rgba(239,68,68,0.3); }

    .score-number {
      font-family: 'Cormorant Garamond', serif;
      font-size: 40px;
      font-weight: 700;
      line-height: 1;
      color: var(--text);
    }

    .verdict-high .score-number { color: var(--green); }
    .verdict-mid .score-number  { color: var(--amber); }
    .verdict-low .score-number  { color: var(--red); }

    .score-label {
      font-family: 'JetBrains Mono', monospace;
      font-size: 13px;
      color: var(--text-muted);
      align-self: flex-end;
      padding-bottom: 4px;
    }

    .verdict-summary {
      font-family: 'Cormorant Garamond', serif;
      font-size: clamp(17px, 2vw, 20px);
      font-style: italic;
      font-weight: 300;
      line-height: 1.55;
      color: var(--text);
      border-left: 2px solid var(--gold);
      padding-left: 20px;
      margin: 0 0 28px;
    }

    .analysis-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 20px;
      margin-bottom: 24px;
    }

    @media (max-width: 640px) {
      .analysis-grid { grid-template-columns: 1fr; }
    }

    .analysis-block {
      background: var(--surface-2);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 16px 18px;
    }

    .analysis-title {
      font-family: 'JetBrains Mono', monospace;
      font-size: 10px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--gold);
      margin-bottom: 8px;
    }

    .analysis-block p {
      font-size: 13px;
      line-height: 1.6;
      color: var(--text-dim);
    }

    .pros-cons-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 20px;
      margin-bottom: 20px;
    }

    @media (max-width: 640px) {
      .pros-cons-grid { grid-template-columns: 1fr; }
    }

    .list-title {
      font-family: 'JetBrains Mono', monospace;
      font-size: 10px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      margin-bottom: 10px;
      color: var(--text-muted);
    }

    .list-title-yes    { color: var(--green); }
    .list-title-no     { color: var(--red); }
    .list-title-danger { color: var(--red); }

    .verdict-list {
      list-style: none;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .verdict-list li {
      font-size: 13px;
      line-height: 1.5;
      color: var(--text-dim);
      display: flex;
      gap: 8px;
    }

    .bullet-yes { color: var(--green); flex-shrink: 0; font-weight: 700; }
    .bullet-no  { color: var(--red);   flex-shrink: 0; font-weight: 700; }

    .verdict-list-danger li { color: var(--red); }
    .verdict-list-danger li::before { content: '!'; color: var(--red); margin-right: 8px; font-weight: 700; flex-shrink: 0; }

    .verdict-list-tips li { color: var(--text-muted); }
    .verdict-list-tips li::before { content: '>'; color: var(--gold); margin-right: 8px; flex-shrink: 0; }

    .red-flags-block,
    .tips-block {
      background: var(--surface-2);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 16px 18px;
      margin-bottom: 20px;
    }

    .red-flags-block { border-color: rgba(239,68,68,0.2); background: var(--red-dim); }

    .listing-link {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      font-family: 'JetBrains Mono', monospace;
      font-size: 12px;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--gold);
      border: 1px solid var(--gold-border);
      padding: 8px 18px;
      border-radius: var(--radius);
      margin-top: 8px;
      transition: background 0.15s;
    }

    .listing-link:hover {
      background: var(--gold-dim);
      text-decoration: none;
    }

    /* ── Rejected Section ── */
    .hall-of-shame-intro {
      font-family: 'Cormorant Garamond', serif;
      font-size: clamp(15px, 2vw, 18px);
      font-style: italic;
      color: var(--text-muted);
      margin-bottom: 28px;
      max-width: 700px;
      line-height: 1.6;
    }

    .rejected-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
      gap: 16px;
    }

    .rejected-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 16px;
      position: relative;
      transition: border-color 0.15s;
    }

    .rejected-card:hover { border-color: var(--border-2); }

    .rejected-district {
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      color: var(--text-muted);
      margin-bottom: 4px;
      padding-right: 28px;
    }

    .rejected-price {
      font-family: 'Cormorant Garamond', serif;
      font-size: 22px;
      font-weight: 600;
      color: var(--text-dim);
      margin-bottom: 4px;
    }

    .rejected-specs {
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px;
      color: var(--text-muted);
      margin-bottom: 10px;
    }

    .rejected-reason {
      font-family: 'Cormorant Garamond', serif;
      font-size: 14px;
      font-style: italic;
      color: var(--red);
      line-height: 1.4;
      border-top: 1px solid rgba(239,68,68,0.15);
      padding-top: 10px;
    }

    .rejected-link {
      position: absolute;
      top: 12px;
      right: 12px;
      font-size: 14px;
      color: var(--text-muted);
      opacity: 0.5;
      transition: opacity 0.15s;
    }

    .rejected-link:hover { opacity: 1; }

    /* ── Footer ── */
    .site-footer {
      border-top: 1px solid var(--border);
      padding: 32px clamp(20px, 5vw, 80px);
      margin-top: 80px;
    }

    .footer-inner {
      max-width: 1100px;
      margin: 0 auto;
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 16px;
    }

    .footer-sig {
      font-family: 'Cormorant Garamond', serif;
      font-size: 15px;
      font-style: italic;
      color: var(--text-muted);
    }

    .footer-sig strong {
      color: var(--gold);
      font-style: normal;
      font-weight: 600;
    }

    .footer-disclaimer {
      font-family: 'JetBrains Mono', monospace;
      font-size: 10px;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--text-muted);
      opacity: 0.5;
    }

    /* ── No data state ── */
    .empty-state {
      text-align: center;
      padding: 80px 20px;
      font-family: 'Cormorant Garamond', serif;
      font-size: 22px;
      font-style: italic;
      color: var(--text-muted);
    }

    /* ── Scrollbar ── */
    ::-webkit-scrollbar { width: 6px; height: 6px; }
    ::-webkit-scrollbar-track { background: var(--bg); }
    ::-webkit-scrollbar-thumb { background: var(--border-2); border-radius: 3px; }
  </style>
</head>
<body>

<header class="masthead">
  <div class="masthead-inner">
    <p class="masthead-eyebrow">Budapest · Bérlakás-piac · AI-elemzés</p>
    <h1 class="masthead-title">Kővári Béla<br><em>Verdikt-Szemléje</em></h1>
    <p class="masthead-subtitle">Harminc év, ezer lakás, száz összetört illúzió — napi ítélet a budapesti bérlakás-piacon</p>
    <div class="masthead-stats">
      <div class="stat-item">
        <span class="stat-value">${totalScraped}</span>
        <span class="stat-label">megvizsgálva</span>
      </div>
      <div class="stat-item">
        <span class="stat-value">${topCount}</span>
        <span class="stat-label">top verdikt</span>
      </div>
      ${rejectedCount > 0 ? `
      <div class="stat-item">
        <span class="stat-value">${rejectedCount}</span>
        <span class="stat-label">elutasítva</span>
      </div>` : ''}
      <div class="stat-item masthead-date">
        <span class="date-value">${dateStr}</span>
        <span class="stat-label" style="text-align:right">napi kiadás</span>
      </div>
    </div>
  </div>
</header>

<main class="site-main">

  <div class="section-header">
    <h2 class="section-title">Napi verdiktek</h2>
    <span class="section-count">${topCount} db</span>
  </div>

  ${topListings.length > 0 ? `
  <div class="verdict-cards">
    ${verdictCards}
  </div>` : `<div class="empty-state">Nincs elemzett hirdetés erre a napra.</div>`}

  ${rejectedListings.length > 0 ? `
  <div class="section-header">
    <h2 class="section-title">Az elutasítottak csarnoka</h2>
    <span class="section-count">${rejectedCount} db</span>
  </div>
  <p class="hall-of-shame-intro">
    Ezek az ingatlanok nem érdemelték meg Kővári Béla idejét. Ítélet gyors, indoklás tömör — ahogy a piac megköveteli.
  </p>
  <div class="rejected-grid">
    ${rejectedCards}
  </div>` : ''}

</main>

<footer class="site-footer">
  <div class="footer-inner">
    <p class="footer-sig">
      Összeállította <strong>Kővári Béla</strong> — Gemini AI által vezérelve, emberi szarkazmussal tálalva.
    </p>
    <p class="footer-disclaimer">Nem minősül befektetési vagy bérlési tanácsadásnak. Kővári Béla nem vállal felelősséget.</p>
  </div>
</footer>

</body>
</html>`;
}

// ─── Write output ─────────────────────────────────────────────────────────────
fs.mkdirSync(DIST_DIR, { recursive: true });
const html = buildHtml();
fs.writeFileSync(OUT_PATH, html, 'utf8');

console.log(`[generate] OK → ${OUT_PATH} (${Math.round(html.length / 1024)} KB)`);
console.log(`[generate] ${topListings.length} verdikt, ${rejectedListings.length} elutasított`);
