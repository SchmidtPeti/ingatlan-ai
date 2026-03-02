'use strict';

require('dotenv').config();
const { GoogleGenAI } = require('@google/genai');
const fs = require('fs');

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const TOP_N_PRESELECT = parseInt(process.env.TOP_N_PRESELECT) || 15;
const TOP_N_FINAL = parseInt(process.env.TOP_N_FINAL) || 3;
const AI_MODEL = process.env.AI_MODEL || 'gemini-2.5-flash-preview-04-17';
const PREFERENCES = process.env.PREFERENCES || '';

// --- JSON Extraction Helpers ---
function extractJsonArray(text) {
  try {
    const trimmed = text.trim();
    if (trimmed.startsWith('[')) return JSON.parse(trimmed);
  } catch (e) { /* continue */ }

  const codeBlock = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlock) {
    try { return JSON.parse(codeBlock[1].trim()); } catch (e) { /* continue */ }
  }

  const match = text.match(/\[[\s\S]*\]/);
  if (match) {
    try { return JSON.parse(match[0]); } catch (e) { /* continue */ }
  }

  console.error('[analyzer] Could not extract JSON array from:', text.substring(0, 300));
  return [];
}

function extractJsonObject(text) {
  try {
    const trimmed = text.trim();
    if (trimmed.startsWith('{')) return JSON.parse(trimmed);
  } catch (e) { /* continue */ }

  const codeBlock = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlock) {
    try { return JSON.parse(codeBlock[1].trim()); } catch (e) { /* continue */ }
  }

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try { return JSON.parse(text.substring(start, end + 1)); } catch (e) { /* continue */ }
  }

  console.error('[analyzer] Could not extract JSON object from:', text.substring(0, 300));
  return null;
}

async function callGemini(prompt, maxOutputTokens) {
  const response = await ai.models.generateContent({
    model: AI_MODEL,
    contents: prompt,
    config: { maxOutputTokens },
  });
  return response.text;
}

// --- Step 1: Preselection + Rejection Reasons ---
async function preselect(listings) {
  console.log(`[analyzer] Pre-selecting top ${TOP_N_PRESELECT} from ${listings.length} listings...`);

  const summaries = listings.map((l, i) => {
    const price = l.price_huf_monthly ? `${l.price_huf_monthly.toLocaleString('hu-HU')} Ft/hó` : 'ár ismeretlen';
    const area = l.area_sqm ? `${l.area_sqm} m²` : '? m²';
    const rooms = l.rooms ? `${l.rooms} szoba` : '? szoba';
    const floor = l.floor || '? em.';
    const elevator = l.has_elevator === true ? 'lift: igen' : l.has_elevator === false ? 'lift: nem' : 'lift: ?';
    const furnished = l.furnished || '?';
    const district = l.district || 'ismeretlen kerület';
    const desc = l.description ? l.description.substring(0, 150) : '';
    return `[${i}] ${district} | ${price} | ${area} | ${rooms} | ${floor} | ${elevator} | bútor: ${furnished}${desc ? ` | "${desc}"` : ''}`;
  }).join('\n');

  const prompt = `Te Kővári Béla vagy – Budapestnek az a legendás ingatlanközvetítője, aki az anyatejjel szívta magába a piacot. Harminc év, ezer lakás megtekintve, száz illúzió összeomlása. New Yorkban, Bécsben, Prágában is láttál ingatlanpiacot – Budapest csak egy szintet feljebb lép, ha éppen hinni akar magának. Nem ismersz köntörfalazást, metaforáid emlékezetesek, intelligenciád félelmetes, szarkazmusod pedig legendás.

A felhasználó preferenciái: ${PREFERENCES || 'nincs megadva'}

Az alábbi ${listings.length} db bérleti hirdetés adatait látod. A feladatod:
1. Válaszd ki a legjobb ${TOP_N_PRESELECT} hirdetést (ezek mennek részletes elemzésre)
2. A TÖBBI hirdetésnél adj EGY rövid, max 15 szavas, tömör és szarkasztikus okot, hogy miért esett ki

Fontossági sorrend:
- Ár/érték arány (nem fizet a bérlő azért, hogy a tulajdonos Balin nyaraljon)
- Kerület és elhelyezkedés (nem minden "központi" az, aminek hirdeti magát)
- Emelet, lift, állapot, felszereltség
- Rugalmasság és feltételek

Hirdetések (index | kerület | ár | terület | szobák | emelet | lift | bútorozottság | leírás):
${summaries}

Válaszolj KIZÁRÓLAG az alábbi JSON struktúrában, semmi magyarázatot ne adj mellé:
{
  "selected": [2, 7, 14, ...],
  "rejected": {
    "0": "Rövid szarkasztikus ok max 15 szóban",
    "1": "Másik rövid szarkasztikus ok",
    ...
  }
}`;

  const text = await callGemini(prompt, 2000);
  console.log('[analyzer] Pre-selection response (first 400 chars):', text.substring(0, 400));

  const result = extractJsonObject(text);
  if (!result || !Array.isArray(result.selected)) {
    console.warn('[analyzer] Pre-selection JSON parse failed, falling back');
    return { selected: [], rejected: {} };
  }

  return {
    selected: result.selected.filter(i => typeof i === 'number' && i >= 0 && i < listings.length),
    rejected: result.rejected || {},
  };
}

// --- Step 2: Detailed Analysis of Top 3 in One Shot ---
async function getDetailedVerdicts(listings, originalIndices) {
  console.log(`[analyzer] Generating detailed verdicts for top ${listings.length} listings in one request...`);

  const formatPrice = (n) => n ? `${n.toLocaleString('hu-HU')} Ft` : 'ismeretlen';

  const listingBlocks = listings.map((l, pos) => {
    const idx = originalIndices[pos];
    return `=== HIRDETÉS #${pos + 1} (eredeti index: ${idx}) ===
- Cím/Title: ${l.title || 'N/A'}
- Kerület: ${l.district || 'N/A'}
- Cím: ${l.address || 'N/A'}
- Havi bérleti díj: ${formatPrice(l.price_huf_monthly)}
- Kaució: ${formatPrice(l.deposit_huf)}
- Rezsi benne: ${l.utilities_included === true ? 'igen' : l.utilities_included === false ? 'nem' : 'ismeretlen'}
- Alapterület: ${l.area_sqm ? `${l.area_sqm} m²` : 'N/A'}
- Szobák: ${l.rooms || 'N/A'}
- Emelet: ${l.floor || 'N/A'}
- Lift: ${l.has_elevator === true ? 'van' : l.has_elevator === false ? 'nincs' : 'N/A'}
- Erkély: ${l.has_balcony === true ? 'van' : l.has_balcony === false ? 'nincs' : 'N/A'}
- Parkoló: ${l.has_parking === true ? 'van' : l.has_parking === false ? 'nincs' : 'N/A'}
- Bútorozottság: ${l.furnished || 'N/A'}
- Fűtés: ${l.heating_type || 'N/A'}
- Kisállat: ${l.pet_friendly === true ? 'igen' : l.pet_friendly === false ? 'nem' : 'N/A'}
- Beköltözés: ${l.available_from || 'N/A'}
- Min. bérleti idő: ${l.min_rental_period || 'N/A'}
- Állapot: ${l.condition || 'N/A'}
- Típus: ${l.property_type || 'N/A'}
- Leírás: ${l.description ? l.description.substring(0, 600) : 'N/A'}
- URL: ${l.url}`;
  }).join('\n\n');

  const prompt = `Te Kővári Béla vagy – Budapestnek az a legendás ingatlanközvetítője, aki az anyatejjel szívta magába a piacot. Harminc év, ezer lakás, száz szétesett illúzió. New Yorkban, Bécsben, Prágában is láttál piacot. Intellektuális, világjárt, kemény és emlékezetes hasonlatokon élő szakértő – de ha valami szemét, azt ki is mondod, köntörfalazás nélkül.

A felhasználó preferenciái: ${PREFERENCES || 'nincs megadva'}

Az előszűrésből kijött ${listings.length} legjobb hirdetés adatai következnek. Elemezd MINDEGYIKET részletesen, egyenként, őszintén és konkrétan. Használj piaci összehasonlítást, számokat, emlékezetes megjegyzéseket. Ne légy túlzottan pozitív – a problémákat is emeld ki.

${listingBlocks}

Válaszolj KIZÁRÓLAG az alábbi JSON tömb formátumban (${listings.length} objektum), semmi mást ne írj:
[
  {
    "listing_index": 0,
    "overall_score": 7.5,
    "recommendation": "AJÁNLOTT",
    "summary": "2-3 mondatos, karizmatikus és emlékezetes összefoglaló a hirdetésről",
    "pros": ["előny 1", "előny 2", "előny 3"],
    "cons": ["hátrány 1", "hátrány 2"],
    "price_analysis": "Az ár értékelése piaci viszonyok alapján, konkrét számokkal",
    "location_analysis": "Kerület és helyszín értékelése, közlekedés, szomszédság",
    "practical_tips": ["megtekintési tipp 1", "tipp 2"],
    "red_flags": ["piros zászló ha van"],
    "estimated_total_monthly_cost": 175000
  }
]

Szabályok:
- recommendation értéke csak: AJÁNLOTT, MEGFONTOLHATÓ, NEM AJÁNLOTT
- overall_score: 1-10 közötti szám (lehet tizedes, pl. 7.5)
- listing_index: az eredeti lista indexe (${originalIndices.join(', ')})
- estimated_total_monthly_cost: becsült teljes havi kiadás Ft-ban (bérleti díj + rezsi + egyéb)`;

  const text = await callGemini(prompt, 10000);
  console.log('[analyzer] Detailed verdicts response (first 400 chars):', text.substring(0, 400));

  const verdicts = extractJsonArray(text);
  return verdicts;
}

// --- Save Results ---
async function saveAnalysis(result) {
  const today = new Date().toISOString().split('T')[0];
  fs.mkdirSync('data/analysis', { recursive: true });
  fs.writeFileSync(`data/analysis/${today}-analysis.json`, JSON.stringify(result, null, 2));
  fs.writeFileSync('data/analysis/latest-analysis.json', JSON.stringify(result, null, 2));
  console.log(`[analyzer] Saved analysis to data/analysis/${today}-analysis.json`);
}

// --- Main Run ---
async function run(progressCallback = () => {}) {
  const cb = (event, data = {}) => {
    console.log(`[analyzer] ${event}:`, JSON.stringify(data).substring(0, 100));
    progressCallback(event, data);
  };

  cb('analyzing', { message: 'Scrape eredmény betöltése...' });

  if (!fs.existsSync('data/latest.json')) {
    throw new Error('Nincs scrape eredmény. Először futtasd le a scraper-t!');
  }

  const raw = JSON.parse(fs.readFileSync('data/latest.json', 'utf8'));
  const listings = raw.listings || [];

  if (listings.length === 0) {
    throw new Error('A scrape eredmény üres. Nincsenek hirdetések feldolgozásra.');
  }

  console.log(`[analyzer] Loaded ${listings.length} listings from data/latest.json`);

  cb('analyzing', { message: `Kővári Béla előszűrése: ${listings.length} hirdetésből válogat...`, step: 'preselection' });

  // Step 1: Preselect + get rejection reasons
  const { selected: selectedIndices, rejected: rejectedReasons } = await preselect(listings);

  let finalIndices = selectedIndices;
  if (finalIndices.length === 0) {
    console.warn('[analyzer] Pre-selection returned no results, using first listings as fallback');
    finalIndices = Array.from({ length: Math.min(TOP_N_PRESELECT, listings.length) }, (_, i) => i);
  }

  // Build allPreselected with rejection reasons for non-selected listings
  const selectedSet = new Set(finalIndices.slice(0, TOP_N_PRESELECT));
  const allPreselected = finalIndices
    .slice(0, TOP_N_PRESELECT)
    .map(i => listings[i])
    .filter(Boolean);

  // Attach rejection reasons to all listings for frontend display
  const allListingsAnnotated = listings.map((l, i) => {
    if (selectedSet.has(i)) return l;
    const reason = rejectedReasons[String(i)] || null;
    return reason ? { ...l, rejection_reason: reason } : l;
  });

  cb('analyzing', {
    message: `${allPreselected.length} hirdetés átment – most jön a kemény rész: részletes elemzés...`,
    preselected_count: allPreselected.length,
  });

  // Step 2: Detailed verdicts for top N_FINAL — all in ONE request
  const toAnalyze = allPreselected.slice(0, TOP_N_FINAL);
  const toAnalyzeIndices = finalIndices.slice(0, TOP_N_FINAL);

  cb('analyzing', {
    message: `Kővári Béla bonckés alá veszi a top ${toAnalyze.length} lakást...`,
    step: 'verdict',
    progress: 0,
  });

  let verdicts = [];
  try {
    verdicts = await getDetailedVerdicts(toAnalyze, toAnalyzeIndices);
  } catch (err) {
    console.error(`[analyzer] Detailed verdict batch failed: ${err.message}`);
  }

  // Match verdicts back to listings
  const topListings = toAnalyze.map((listing, pos) => {
    const verdict = verdicts.find(v => v.listing_index === toAnalyzeIndices[pos]) || verdicts[pos] || null;
    if (!verdict) {
      return {
        ...listing,
        verdict: {
          overall_score: null,
          recommendation: 'MEGFONTOLHATÓ',
          summary: 'Az AI elemzés nem sikerült ehhez a hirdetéshez.',
          pros: [], cons: [], price_analysis: '', location_analysis: '',
          practical_tips: [], red_flags: [], estimated_total_monthly_cost: null,
        },
      };
    }
    return { ...listing, verdict };
  });

  const result = {
    analyzed_at: new Date().toISOString(),
    total_scraped: listings.length,
    preselected_count: allPreselected.length,
    final_count: topListings.length,
    topListings,
    allPreselected,
    allListingsAnnotated,
  };

  await saveAnalysis(result);
  cb('done', { analyzed_at: result.analyzed_at, count: topListings.length });

  return result;
}

module.exports = { run };
