'use strict';

require('dotenv').config();
const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const {
  detectBlockType,
  extractListingCardsFromHtml,
  extractListingId,
  normalizeWhitespace,
  parseCardContentText,
  toAbsoluteIngatlanUrl,
} = require('./scraper-utils');

chromium.use(StealthPlugin());

// --- Config ---
const SEARCH_URL = process.env.SEARCH_URL || 'https://ingatlan.com/lista/kiado+lakas+havi-100-180-ezer-Ft+budapest';
const MAX_PAGES = parseInt(process.env.MAX_PAGES, 10) || 5;
const MAX_LISTINGS = parseInt(process.env.MAX_LISTINGS, 10) || 60;
const SCRAPE_DELAY_MS = parseInt(process.env.SCRAPE_DELAY_MS, 10) || 2000;
const BLOCK_CONSECUTIVE_THRESHOLD = parseInt(process.env.BLOCK_CONSECUTIVE_THRESHOLD, 10) || 3;
const BLOCK_RATE_THRESHOLD = Number.parseFloat(process.env.BLOCK_RATE_THRESHOLD || '0.40');
const BLOCK_RATE_MIN_ATTEMPTS = parseInt(process.env.BLOCK_RATE_MIN_ATTEMPTS, 10) || 10;
const HITL_ENABLED = String(process.env.HITL_ENABLED || 'true').toLowerCase() !== 'false';
const HITL_HEADFUL = String(process.env.HITL_HEADFUL || 'true').toLowerCase() !== 'false';
const HITL_PAUSE_TIMEOUT_SEC = parseInt(process.env.HITL_PAUSE_TIMEOUT_SEC, 10) || 900;
const HITL_MAX_PAUSES_PER_RUN = parseInt(process.env.HITL_MAX_PAUSES_PER_RUN, 10) || 2;
const HITL_RESUME_RECHECK_WAIT_MS = parseInt(process.env.HITL_RESUME_RECHECK_WAIT_MS, 10) || 1200;
const MANUAL_RESUME_RETRIES_PER_LISTING = parseInt(process.env.MANUAL_RESUME_RETRIES_PER_LISTING, 10) || 1;
const SIMULATE_DETAIL_BLOCK = String(process.env.SIMULATE_DETAIL_BLOCK || 'false').toLowerCase() === 'true';
const COOKIEBOT_WARNING_CODE = 'COOKIEBOT_OVERLAY_INTERCEPTED';
const cookieGuardInstalledPages = new WeakSet();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function randomDelay(baseMs = SCRAPE_DELAY_MS) {
  const jitter = Math.random() * baseMs * 0.5;
  await sleep(baseMs + jitter);
}

async function withRetry(fn, maxAttempts = 3, baseDelayMs = 1000) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt === maxAttempts) break;
      const delay = baseDelayMs * Math.pow(2, attempt - 1) + Math.random() * 500;
      console.warn(`[scraper] Attempt ${attempt} failed: ${err.message}. Retrying in ${Math.round(delay)}ms...`);
      await sleep(delay);
    }
  }
  throw lastError;
}

function createEmptyListingBase() {
  return {
    title: null,
    description: null,
    price_huf_monthly: null,
    deposit_huf: null,
    utilities_huf: null,
    common_cost_huf: null,
    area_sqm: null,
    rooms: null,
    half_rooms: null,
    floor: null,
    has_elevator: null,
    has_balcony: null,
    balcony_size: null,
    has_parking: null,
    parking_type: null,
    district: null,
    address: null,
    lat: null,
    lng: null,
    property_type: null,
    condition: null,
    build_year: null,
    comfort: null,
    heating_type: null,
    has_ac: null,
    ceiling_height: null,
    insulation: null,
    energy_certificate: null,
    furnished: null,
    equipped: null,
    pet_friendly: null,
    smoking_allowed: null,
    accessible: null,
    bathroom_config: null,
    orientation: null,
    view: null,
    has_garden_access: null,
    has_attic: null,
    available_from: null,
    min_rental_period: null,
    agent_name: null,
    agent_type: null,
    listing_date: null,
    image_urls: [],
    raw_params: {},
    source: 'detail',
    data_quality: 'full',
  };
}

function buildBasicListingFromCard(row) {
  const absoluteUrl = toAbsoluteIngatlanUrl(row.href, 'https://ingatlan.com');
  const id = row.id || extractListingId(absoluteUrl);
  if (!absoluteUrl || !id) return null;

  const parsed = parseCardContentText(row.content_text || row.contentText || row.fallback_text || row.fallbackText || '');
  const district = parsed.district || normalizeWhitespace(row.district_text || row.districtText || '') || null;
  const nowIso = new Date().toISOString();

  return {
    id,
    url: absoluteUrl,
    scraped_at: nowIso,
    ...createEmptyListingBase(),
    title: parsed.title || district,
    district,
    address: district,
    price_huf_monthly: parsed.price_huf_monthly,
    area_sqm: parsed.area_sqm,
    rooms: parsed.rooms,
    image_urls: row.image_url ? [row.image_url] : row.imageUrl ? [row.imageUrl] : [],
    source: 'list_card',
    data_quality: 'basic',
  };
}

function mergeListings(detailListings, fallbackById, orderedUrls) {
  const detailMap = new Map(detailListings.map(item => [item.id, item]));
  const merged = [];
  const added = new Set();

  for (const url of orderedUrls) {
    const id = extractListingId(url);
    if (!id || added.has(id)) continue;

    const detail = detailMap.get(id);
    if (detail) {
      merged.push(detail);
      added.add(id);
      continue;
    }

    const fallback = fallbackById.get(id);
    if (fallback) {
      merged.push(fallback);
      added.add(id);
    }
  }

  for (const item of detailListings) {
    if (!added.has(item.id)) {
      merged.push(item);
      added.add(item.id);
    }
  }

  return merged.slice(0, MAX_LISTINGS);
}

function isBlockingType(type) {
  return type === 'bot_check' || type === 'captcha' || type === 'rate_limited' || type === 'forbidden';
}

function getFallbackReason(meta) {
  const attempted = meta.detail_attempted;
  const blocked = meta.detail_blocked;
  const blockRate = attempted > 0 ? blocked / attempted : 0;

  if (meta.consecutive_blocked >= BLOCK_CONSECUTIVE_THRESHOLD) {
    return 'consecutive';
  }

  if (attempted >= BLOCK_RATE_MIN_ATTEMPTS && blockRate >= BLOCK_RATE_THRESHOLD) {
    return 'rate';
  }

  return null;
}

function normalizeManualAction(action) {
  const value = String(action || '').trim().toLowerCase();
  if (value === 'resume') return 'resume';
  if (value === 'fallback') return 'fallback';
  if (value === 'cancel') return 'cancel';
  return null;
}

function shouldForceFallbackAfterResumeRetry({ runSource, hitlEnabled, manualResumeRetriesForListing }) {
  return (
    runSource === 'manual'
    && hitlEnabled
    && manualResumeRetriesForListing >= MANUAL_RESUME_RETRIES_PER_LISTING
  );
}

function addWarning(meta, cb, code, message, extra = {}) {
  if (!meta.warnings.includes(code)) {
    meta.warnings.push(code);
    cb('warning', {
      code,
      message,
      ...extra,
    });
  }
}

// --- Browser Setup ---
async function launchBrowser({ headless = true } = {}) {
  return await chromium.launch({
    headless,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
      '--window-size=1920,1080',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--disable-gpu',
    ],
    ignoreDefaultArgs: ['--enable-automation'],
  });
}

async function createContext(browser) {
  return await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    locale: 'hu-HU',
    timezoneId: 'Europe/Budapest',
    extraHTTPHeaders: {
      'Accept-Language': 'hu-HU,hu;q=0.9,en-US;q=0.8,en;q=0.7',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
    },
  });
}

// --- Selector Discovery ---
async function discoverSelectors(page) {
  console.log('[scraper] Discovering selectors...');

  const selectorCandidates = {
    listingCard: [
      'a.listing-card',
      'a[data-listing-id]',
      '[data-testid="listing-card"]',
      '.property-card',
      'article.card',
      '.card--listing',
      '.listing__item',
      '.search-result-item',
      'li.listing',
    ],
    cardLink: [
      'a.listing-card[href]',
      'a[data-listing-id][href]',
      '[data-testid="listing-card"][href]',
    ],
    nextPage: [
      '[aria-label="Következő oldal"]',
      'a[rel="next"]',
      '.pagination__next',
      '.next-page',
      '[aria-label="Next page"]',
      '.pagination a:last-child',
      'button[aria-label*="next"]',
      '.pager__next',
    ],
  };

  const discovered = {};

  for (const [key, candidates] of Object.entries(selectorCandidates)) {
    for (const selector of candidates) {
      try {
        const count = await page.locator(selector).count();
        if (count > 0) {
          discovered[key] = selector;
          console.log(`[scraper] Selector "${key}": ${selector} (${count} matches)`);
          break;
        }
      } catch (err) {
        // invalid selector syntax, skip
      }
    }

    if (!discovered[key]) {
      discovered[key] = null;
      console.warn(`[scraper] No selector found for "${key}"`);
    }
  }

  return discovered;
}

// --- Block Detection ---
async function detectBlocking(page, responseStatus = null) {
  const url = page.url();
  const title = await page.title().catch(() => '');
  const bodyText = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
  return detectBlockType({
    status: responseStatus,
    url,
    title,
    bodyText: bodyText.slice(0, 4000),
  });
}

// --- Cookie Consent ---
async function installCookiebotGuard(page) {
  if (cookieGuardInstalledPages.has(page)) return;

  try {
    await page.addInitScript(() => {
      if (window.__ingatlanCookieGuardInstalled) return;
      window.__ingatlanCookieGuardInstalled = true;

      const overlaySelectors = [
        '#CybotCookiebotDialog',
        '#CybotCookiebotDialogBodyUnderlay',
        '#CybotCookiebotDialogBodyOverlay',
        '#CybotCookiebotDialogNav',
        '[id*="CybotCookiebotDialog"]',
        '[class*="CybotCookiebotDialog"]',
        '.CookiebotWidget',
        '#CookiebotWidget',
      ];
      const iframeSelectors = [
        'iframe[id*="Cybot"]',
        'iframe[src*="cookiebot"]',
      ];
      const unlockScroll = () => {
        const html = document.documentElement;
        const body = document.body;
        if (html) {
          html.style.setProperty('overflow', 'auto', 'important');
          html.style.setProperty('position', 'static', 'important');
        }
        if (body) {
          body.style.setProperty('overflow', 'auto', 'important');
          body.style.setProperty('position', 'static', 'important');
          body.style.setProperty('padding-right', '0px', 'important');
        }
      };
      const neutralize = () => {
        overlaySelectors.forEach(selector => {
          document.querySelectorAll(selector).forEach(node => {
            if (!node || !node.style) return;
            node.style.setProperty('display', 'none', 'important');
            node.style.setProperty('visibility', 'hidden', 'important');
            node.style.setProperty('opacity', '0', 'important');
            node.style.setProperty('pointer-events', 'none', 'important');
            node.style.setProperty('z-index', '-1', 'important');
            node.setAttribute('aria-hidden', 'true');
          });
        });
        iframeSelectors.forEach(selector => {
          document.querySelectorAll(selector).forEach(node => {
            if (!node || !node.style) return;
            node.style.setProperty('display', 'none', 'important');
            node.style.setProperty('pointer-events', 'none', 'important');
          });
        });
        unlockScroll();
      };

      neutralize();
      const observer = new MutationObserver(() => neutralize());
      observer.observe(document.documentElement || document, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['style', 'class'],
      });
    });
  } catch (err) {
    console.warn('[scraper] Cookie guard init script failed:', err.message);
  }

  cookieGuardInstalledPages.add(page);
}

async function neutralizeCookieOverlays(page) {
  try {
    return await page.evaluate(() => {
      const overlaySelectors = [
        '#CybotCookiebotDialog',
        '#CybotCookiebotDialogBodyUnderlay',
        '#CybotCookiebotDialogBodyOverlay',
        '#CybotCookiebotDialogNav',
        '[id*="CybotCookiebotDialog"]',
        '[class*="CybotCookiebotDialog"]',
        '.CookiebotWidget',
        '#CookiebotWidget',
      ];
      const iframeSelectors = [
        'iframe[id*="Cybot"]',
        'iframe[src*="cookiebot"]',
      ];
      const actions = new Set();

      const hideNode = (node, actionName) => {
        if (!node || !node.style) return;
        const style = node.style;
        const before = `${style.display}|${style.visibility}|${style.pointerEvents}|${style.opacity}|${style.zIndex}`;
        style.setProperty('display', 'none', 'important');
        style.setProperty('visibility', 'hidden', 'important');
        style.setProperty('pointer-events', 'none', 'important');
        style.setProperty('opacity', '0', 'important');
        style.setProperty('z-index', '-1', 'important');
        node.setAttribute('aria-hidden', 'true');
        const after = `${style.display}|${style.visibility}|${style.pointerEvents}|${style.opacity}|${style.zIndex}`;
        if (before !== after) {
          actions.add(actionName);
        }
      };

      overlaySelectors.forEach(selector => {
        document.querySelectorAll(selector).forEach(node => hideNode(node, 'overlay_removed'));
      });

      iframeSelectors.forEach(selector => {
        document.querySelectorAll(selector).forEach(node => hideNode(node, 'iframe_hidden'));
      });

      const html = document.documentElement;
      const body = document.body;
      if (html) {
        const before = `${html.style.overflow}|${html.style.position}`;
        html.style.setProperty('overflow', 'auto', 'important');
        html.style.setProperty('position', 'static', 'important');
        const after = `${html.style.overflow}|${html.style.position}`;
        if (before !== after) actions.add('scroll_unlock');
      }
      if (body) {
        const before = `${body.style.overflow}|${body.style.position}|${body.style.paddingRight}`;
        body.style.setProperty('overflow', 'auto', 'important');
        body.style.setProperty('position', 'static', 'important');
        body.style.setProperty('padding-right', '0px', 'important');
        const after = `${body.style.overflow}|${body.style.position}|${body.style.paddingRight}`;
        if (before !== after) actions.add('scroll_unlock');
      }

      return {
        intervened: actions.size > 0,
        actions: Array.from(actions),
        url: location.href,
      };
    });
  } catch (err) {
    return {
      intervened: false,
      actions: [],
      url: page.url(),
      error: err.message,
    };
  }
}

async function acceptCookies(page) {
  await installCookiebotGuard(page);

  const selectors = [
    '#CybotCookiebotDialogBodyButtonAccept',
    '#CybotCookiebotDialogBodyLevelButtonAccept',
    '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
    'button[id*="CybotCookiebotDialogBodyButtonAccept"]',
    'button[data-cookieconsent="accept"]',
    'button[aria-label*="cookie" i]',
    '#CookiebotDialogAcceptButton',
  ];

  let accepted = false;
  const actions = new Set();

  for (const selector of selectors) {
    const button = page.locator(selector).first();
    const visible = await button.isVisible({ timeout: 600 }).catch(() => false);
    if (!visible) continue;

    try {
      await button.click({ timeout: 1500, force: true });
      accepted = true;
      actions.add('accept_click');
      break;
    } catch (err) {
      // try fallback click strategies
    }

    try {
      await button.dispatchEvent('click');
      accepted = true;
      actions.add('accept_dispatch');
      break;
    } catch (err) {
      // try evaluate click strategy
    }

    const evalClicked = await page.evaluate(sel => {
      const node = document.querySelector(sel);
      if (!node || typeof node.click !== 'function') return false;
      node.click();
      return true;
    }, selector).catch(() => false);
    if (evalClicked) {
      accepted = true;
      actions.add('accept_eval');
      break;
    }
  }

  if (accepted) {
    console.log('[scraper] Cookie consent handled');
    await sleep(250);
  }

  const neutralized = await neutralizeCookieOverlays(page);
  for (const action of neutralized.actions || []) {
    actions.add(action);
  }

  return {
    intervened: accepted || neutralized.intervened,
    accepted,
    actions: Array.from(actions),
    url: neutralized.url || page.url(),
  };
}

function dedupeCardRows(rows) {
  const deduped = [];
  const seen = new Set();

  for (const row of rows) {
    const url = toAbsoluteIngatlanUrl(row.href, 'https://ingatlan.com');
    const id = row.listingId || extractListingId(url);
    if (!url || !id) continue;

    const key = `${id}:${url}`;
    if (seen.has(key)) continue;
    seen.add(key);

    deduped.push({
      id,
      href: url,
      content_text: row.contentText || row.fallbackText || '',
      fallback_text: row.fallbackText || '',
      district_text: row.districtText || '',
      image_url: toAbsoluteIngatlanUrl(row.imageUrl, 'https://ingatlan.com'),
    });
  }

  return deduped;
}

async function extractCardRowsFromPage(page, cardSelector) {
  if (!cardSelector) return [];

  try {
    const rows = await page.locator(cardSelector).evaluateAll(nodes => {
      return nodes.map(node => {
        const content = node.querySelector('.listing-card-content') || node;
        const districtNode = content.querySelector('.text-gray-900');
        const image = node.querySelector('img.listing-card-image, img[src*="ingatlancdn.com"]');
        return {
          href: node.getAttribute('href') || '',
          listingId: node.getAttribute('data-listing-id') || '',
          contentText: (content.innerText || '').replace(/\s+/g, ' ').trim(),
          fallbackText: (node.innerText || '').replace(/\s+/g, ' ').trim(),
          districtText: (districtNode ? districtNode.innerText : '').replace(/\s+/g, ' ').trim(),
          imageUrl: image ? (image.getAttribute('src') || '') : '',
        };
      });
    });

    return dedupeCardRows(rows);
  } catch (err) {
    console.warn('[scraper] Failed to extract listing cards from page, trying html fallback:', err.message);
  }

  try {
    const html = await page.content();
    return extractListingCardsFromHtml(html, page.url());
  } catch (err) {
    console.warn('[scraper] HTML fallback parsing failed:', err.message);
    return [];
  }
}

function buildNextPageUrl(currentUrl, nextPageNumber) {
  if (currentUrl.includes('?page=')) {
    return currentUrl.replace(/\?page=\d+/, `?page=${nextPageNumber}`);
  }
  if (currentUrl.includes('&page=')) {
    return currentUrl.replace(/&page=\d+/, `&page=${nextPageNumber}`);
  }
  return `${currentUrl}${currentUrl.includes('?') ? '&' : '?'}page=${nextPageNumber}`;
}

// --- URL Collection ---
async function collectListingUrls(page, selectors, onCookieIntervention = () => {}) {
  const urls = [];
  const urlSet = new Set();
  const fallbackById = new Map();
  let currentPage = 1;

  while (currentPage <= MAX_PAGES) {
    console.log(`[scraper] Collecting URLs from page ${currentPage}/${MAX_PAGES}...`);

    await page.waitForLoadState('domcontentloaded');
    const listCookieResult = await acceptCookies(page);
    onCookieIntervention(listCookieResult, {
      phase: 'list_collect',
      page_number: currentPage,
      url: page.url(),
    });
    await sleep(600);

    const cardRows = await extractCardRowsFromPage(page, selectors.cardLink || selectors.listingCard || 'a.listing-card[href]');

    for (const row of cardRows) {
      const url = row.href;
      if (url && !urlSet.has(url)) {
        urlSet.add(url);
        urls.push(url);
      }

      const basic = buildBasicListingFromCard(row);
      if (basic && !fallbackById.has(basic.id)) {
        fallbackById.set(basic.id, basic);
      }

      if (urls.length >= MAX_LISTINGS) break;
    }

    console.log(`[scraper] Page ${currentPage}: found ${cardRows.length} links, total unique: ${urls.length}`);

    if (urls.length >= MAX_LISTINGS || currentPage >= MAX_PAGES) {
      break;
    }

    let navigatedNext = false;

    // First choice: href-based navigation (resistant to cookie overlay click interception)
    if (selectors.nextPage) {
      try {
        const nextButton = page.locator(selectors.nextPage).first();
        if (await nextButton.count() > 0) {
          const nextHref = await nextButton.getAttribute('href');
          if (nextHref) {
            const nextUrl = toAbsoluteIngatlanUrl(nextHref, page.url());
            if (nextUrl && nextUrl !== page.url()) {
              await page.goto(nextUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
              navigatedNext = true;
            }
          }
        }
      } catch (err) {
        console.warn('[scraper] Next page href navigation failed:', err.message);
      }
    }

    // Fallback click only if href-based navigation is unavailable
    if (!navigatedNext && selectors.nextPage) {
      try {
        const nextButton = page.locator(selectors.nextPage).first();
        if (await nextButton.count() > 0) {
          const clickCookieResult = await acceptCookies(page);
          onCookieIntervention(clickCookieResult, {
            phase: 'pagination_click',
            page_number: currentPage,
            url: page.url(),
          });
          await nextButton.click({ timeout: 7000 });
          await page.waitForLoadState('domcontentloaded', { timeout: 15000 });
          navigatedNext = true;
        }
      } catch (err) {
        console.warn('[scraper] Next page click fallback failed:', err.message);
      }
    }

    // Final fallback: force URL pagination parameter
    if (!navigatedNext) {
      const nextUrl = buildNextPageUrl(page.url(), currentPage + 1);
      try {
        await page.goto(nextUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        navigatedNext = true;
      } catch (err) {
        console.warn('[scraper] URL pagination fallback failed:', err.message);
      }
    }

    if (!navigatedNext) {
      break;
    }

    await randomDelay(1200);
    currentPage++;
  }

  return {
    urls: urls.slice(0, MAX_LISTINGS),
    fallbackById,
  };
}

// --- Detail Page Scraping ---
async function scrapeDetailPage(page, url, options = {}) {
  const onCookieIntervention = typeof options.onCookieIntervention === 'function'
    ? options.onCookieIntervention
    : () => {};

  try {
    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
      referer: SEARCH_URL,
    });

    if (response && (response.status() === 404 || response.status() === 410)) {
      console.log(`[scraper] Listing gone (${response.status()}): ${url}`);
      return { listing: null, blockType: null, challengeUrl: null };
    }

    await page.waitForLoadState('domcontentloaded');
    await sleep(400);
    const detailCookieResult = await acceptCookies(page);
    onCookieIntervention(detailCookieResult, {
      phase: 'detail_page',
      url: page.url(),
    });

    const blockType = await detectBlocking(page, response ? response.status() : null);
    if (blockType !== 'ok') {
      return {
        listing: null,
        blockType,
        challengeUrl: page.url ? page.url() : url,
      };
    }

    const data = await page.evaluate(() => {
      const getText = (...selectors) => {
        for (const selector of selectors) {
          try {
            const element = document.querySelector(selector);
            if (element && element.innerText.trim()) return element.innerText.trim();
          } catch (err) {
            // skip invalid selector
          }
        }
        return null;
      };

      const getMeta = name => {
        const element = document.querySelector(`meta[name="${name}"], meta[property="${name}"]`);
        return element ? element.getAttribute('content') : null;
      };

      const getAllImages = () => {
        const images = [];
        document.querySelectorAll('img').forEach(img => {
          const src = img.src || img.dataset.src || img.getAttribute('data-lazy') || '';
          if (
            src &&
            src.startsWith('http') &&
            !src.includes('logo') &&
            !src.includes('icon') &&
            !src.includes('avatar')
          ) {
            images.push(src);
          }
        });
        return [...new Set(images)].slice(0, 5);
      };

      const getListingProperty = labelText => {
        let result = null;
        document.querySelectorAll('div.listing-property').forEach(el => {
          const label = el.querySelector('span.text-gray-500');
          if (label && label.innerText.trim() === labelText) {
            const val = el.querySelector('span.fw-bold');
            if (val) result = val.innerText.trim();
          }
        });
        return result;
      };

      const params = {};
      document.querySelectorAll('tr').forEach(tr => {
        const tds = tr.querySelectorAll('td, th');
        if (tds.length >= 2) {
          const key = tds[0].innerText.trim().toLowerCase();
          const val = tds[1].innerText.trim();
          if (key && val) params[key] = val;
        }
      });

      document.querySelectorAll('dl, .parameters, .listing-parameters').forEach(dl => {
        const dts = dl.querySelectorAll('dt, .label');
        const dds = dl.querySelectorAll('dd, .value');
        dts.forEach((dt, i) => {
          const key = dt.innerText.trim().toLowerCase();
          const val = dds[i] ? dds[i].innerText.trim() : null;
          if (key && val) params[key] = val;
        });
      });

      const findParam = (...keys) => {
        for (const key of keys) {
          for (const [paramKey, paramValue] of Object.entries(params)) {
            if (paramKey.includes(key)) return paramValue;
          }
        }
        return null;
      };

      const parseBoolean = text => {
        if (!text) return null;
        const lower = text.toLowerCase().trim();
        if (lower === 'nincs megadva') return null;
        if (lower.includes('van') || lower.includes('igen') || lower === 'yes') return true;
        if (lower === 'nincs' || lower.includes('nem') || lower === 'no') return false;
        return null;
      };

      const parsePrice = text => {
        if (!text) return null;
        const cleaned = text.replace(/[^0-9]/g, '');
        return cleaned ? parseInt(cleaned, 10) : null;
      };

      const titleEl = document.querySelector('span.card-title.fw-bold, span.fw-bold.card-title');
      const title = titleEl ? titleEl.innerText.trim() : getText('h1', '.listing-title', '.property-title');

      const priceRaw =
        getListingProperty('Ár havonta') ||
        getListingProperty('Ar havonta') ||
        getText('.price', '[data-testid="price"]', '.listing-price', '.card__price', '.price-value') ||
        findParam('ár', 'ar', 'price', 'díj', 'berleti');
      const price = parsePrice(priceRaw);

      const areaRaw =
        getListingProperty('Alapterület') ||
        getListingProperty('Alapterulet') ||
        getText('[data-testid="area"]', '.listing-area', '.property-area') ||
        findParam('alapterület', 'alapterulet', 'terület', 'terulet', 'méret', 'meret');
      const area = areaRaw ? parseInt(areaRaw.match(/\d+/)?.[0], 10) || null : null;

      const roomsRaw =
        getListingProperty('Szobák') ||
        getListingProperty('Szobak') ||
        getText('[data-testid="rooms"]', '.listing-rooms') ||
        findParam('szoba', 'room');
      const rooms = roomsRaw ? parseFloat(roomsRaw.match(/[\d,.]+/)?.[0].replace(',', '.') || '') || null : null;

      const floor = findParam('emelet', 'floor') || getText('[data-testid="floor"]', '.floor');
      const district =
        title ||
        getText('.address', '[class*="location"]', '[class*="district"]') ||
        findParam('kerület', 'kerulet', 'district', 'cím', 'cim');
      const description = getText('#listing-description', '.description', '.listing-description', '.property-description', '.about');

      const elevatorText = findParam('lift', 'elevator') || getText('[data-testid="elevator"]');
      const hasElevator = parseBoolean(elevatorText);

      const balconyText = findParam('erkély', 'erkely', 'balcon', 'terasz');
      const hasBalcony = parseBoolean(balconyText);

      const furnishedText =
        findParam('bútorozottság', 'butorozottsag', 'bútorozott', 'butorozott', 'bútor', 'butor') ||
        getText('[data-testid="furnished"]');

      const heatingText = findParam('fűtés', 'futes', 'heating');
      const parkingText = findParam('parkoló', 'parkolo', 'parking', 'garázs', 'garazs');
      const hasParking = parkingText ? parseBoolean(parkingText) : null;

      const petText = findParam('kisállat', 'kisallat', 'pet', 'állat', 'allat');
      const petFriendly = parseBoolean(petText);

      const availableFrom = findParam('költözhető', 'koltozheto', 'beköltözhető', 'bekoltozheto', 'available', 'foglalható', 'foglalhato');
      const minRental = findParam('min. bérleti', 'min. berleti', 'bérleti idő', 'berleti ido', 'minimum bérleti', 'minimum berleti');
      const agentName = getText('.agent-name', '.advertiser-name', '[class*="agent"]', '[class*="advertiser"]');

      const depositText = findParam('kaució', 'kaucio', 'deposit', 'óvadék', 'ovadek');
      const deposit = parsePrice(depositText);

      const listingDate = getText('[class*="date"]', '.listing-date', 'time') || getMeta('article:published_time');
      const utilitiesHuf = parsePrice(findParam('rezsiköltség', 'rezsikoltseg', 'rezsi'));
      const commonCostHuf = parsePrice(findParam('közös költség', 'kozos koltseg'));

      const insulation = findParam('szigetelés', 'szigeteles');
      const energyCertificate = findParam('energetikai tanúsítvány', 'energetikai tanusitvany', 'energetikai');
      const buildYear = findParam('építés éve', 'epites eve', 'építési év', 'epitesi ev');
      const comfort = findParam('komfort');
      const ceilingHeight = findParam('belmagasság', 'belmagassag');
      const hasAc = parseBoolean(findParam('légkondicionáló', 'legkondicionalo', 'légkondi', 'legkondi'));
      const accessible = parseBoolean(findParam('akadálymentesített', 'akadalymentesitett', 'akadály', 'akadaly'));
      const bathroomConfig = findParam('fürdő és wc', 'furdo es wc', 'fürdőszoba', 'furdoszoba');
      const orientation = findParam('tájolás', 'tajolas');
      const propertyView = findParam('kilátás', 'kilatas');
      const balconySize = findParam('erkély mérete', 'erkely merete', 'erkély', 'erkely');
      const hasGardenAccess = parseBoolean(findParam('kertkapcsolatos'));
      const hasAttic = parseBoolean(findParam('tetőtér', 'tetoter'));
      const equipped = parseBoolean(findParam('gépesített', 'gepesitett'));
      const smokingAllowed = parseBoolean(findParam('dohányzás', 'dohanyzas', 'dohányzó', 'dohanyzo'));

      return {
        title,
        description: description ? description.substring(0, 2000) : null,
        price_huf_monthly: price,
        deposit_huf: deposit,
        utilities_huf: utilitiesHuf || null,
        common_cost_huf: commonCostHuf || null,
        area_sqm: area,
        rooms,
        half_rooms: null,
        floor,
        has_elevator: hasElevator,
        has_balcony: hasBalcony,
        balcony_size: balconySize || null,
        has_parking: hasParking,
        parking_type: parkingText || null,
        district,
        address: district,
        lat: null,
        lng: null,
        property_type: findParam('típus', 'tipus', 'jelleg', 'épület', 'epulet') || null,
        condition: findParam('ingatlan állapota', 'ingatlan allapota', 'állapot', 'allapot', 'condition') || null,
        build_year: buildYear || null,
        comfort: comfort || null,
        heating_type: heatingText || null,
        has_ac: hasAc,
        ceiling_height: ceilingHeight || null,
        insulation: insulation || null,
        energy_certificate: energyCertificate || null,
        furnished: furnishedText || null,
        equipped,
        pet_friendly: petFriendly,
        smoking_allowed: smokingAllowed,
        accessible,
        bathroom_config: bathroomConfig || null,
        orientation: orientation || null,
        view: propertyView || null,
        has_garden_access: hasGardenAccess,
        has_attic: hasAttic,
        available_from: availableFrom || null,
        min_rental_period: minRental || null,
        agent_name: agentName || null,
        agent_type: null,
        listing_date: listingDate || null,
        image_urls: getAllImages(),
        raw_params: params,
      };
    });

    if (data.title && /gyors ellenőrzés/i.test(data.title)) {
      return {
        listing: null,
        blockType: 'bot_check',
        challengeUrl: page.url ? page.url() : url,
      };
    }

    const id = extractListingId(url) || url;
    const listing = {
      id,
      url,
      scraped_at: new Date().toISOString(),
      ...createEmptyListingBase(),
      ...data,
      source: 'detail',
      data_quality: 'full',
    };

    return { listing, blockType: 'ok', challengeUrl: null };
  } catch (err) {
    if (err.message.includes('404') || err.message.includes('net::ERR')) {
      console.log(`[scraper] Skip (${err.message.substring(0, 50)}): ${url}`);
      return { listing: null, blockType: null, challengeUrl: null };
    }
    throw err;
  }
}

// --- Save Results ---
async function saveResults(listings, scrapeMeta) {
  const today = new Date().toISOString().split('T')[0];

  fs.mkdirSync('data/history', { recursive: true });

  const data = {
    scraped_at: new Date().toISOString(),
    search_url: SEARCH_URL,
    total_found: listings.length,
    scrape_meta: {
      mode: scrapeMeta.mode,
      detail_attempted: scrapeMeta.detail_attempted,
      detail_success: scrapeMeta.detail_success,
      detail_blocked: scrapeMeta.detail_blocked,
      fallback_used: scrapeMeta.fallback_used,
      warnings: scrapeMeta.warnings,
      pause_count: scrapeMeta.pause_count,
      manual_resume_count: scrapeMeta.manual_resume_count,
      manual_fallback_triggered: scrapeMeta.manual_fallback_triggered,
      run_source: scrapeMeta.run_source,
      cookie_interventions: scrapeMeta.cookie_interventions,
    },
    listings,
  };

  fs.writeFileSync('data/latest.json', JSON.stringify(data, null, 2));
  fs.writeFileSync(`data/history/${today}.json`, JSON.stringify(data, null, 2));
  console.log(`[scraper] Saved ${listings.length} listings to data/latest.json and data/history/${today}.json`);
}

// --- Main Run ---
async function run(progressCallback = () => {}, options = {}) {
  const cb = (event, data = {}) => {
    console.log(`[scraper] ${event}:`, JSON.stringify(data).substring(0, 200));
    progressCallback(event, data);
  };

  const runSource = options.runSource === 'cron' ? 'cron' : 'manual';
  const awaitManualAction = typeof options.awaitManualAction === 'function' ? options.awaitManualAction : null;
  const isCancelled = typeof options.isCancelled === 'function' ? options.isCancelled : () => false;
  const hitlEnabled = runSource === 'manual' && (options.hitlEnabled !== undefined ? !!options.hitlEnabled : HITL_ENABLED);
  const hitlHeadful = hitlEnabled && HITL_HEADFUL;
  const pauseTimeoutMs = Math.max(1000, HITL_PAUSE_TIMEOUT_SEC * 1000);

  const scrapeMeta = {
    mode: 'detail_only',
    detail_attempted: 0,
    detail_success: 0,
    detail_blocked: 0,
    fallback_used: false,
    warnings: [],
    consecutive_blocked: 0,
    pause_count: 0,
    manual_resume_count: 0,
    manual_fallback_triggered: false,
    run_source: runSource,
    cookie_interventions: 0,
  };

  const activateFallback = (message, extra = {}, code = 'DETAIL_BLOCK_FALLBACK_ACTIVE') => {
    addWarning(
      scrapeMeta,
      cb,
      code,
      message,
      {
        detail_attempted: scrapeMeta.detail_attempted,
        detail_blocked: scrapeMeta.detail_blocked,
        run_source: runSource,
        ...extra,
      }
    );
    scrapeMeta.fallback_used = true;
  };

  const reportCookieIntervention = (result, context = {}) => {
    if (!result || !result.intervened) return;

    scrapeMeta.cookie_interventions++;
    if (!scrapeMeta.warnings.includes(COOKIEBOT_WARNING_CODE)) {
      scrapeMeta.warnings.push(COOKIEBOT_WARNING_CODE);
    }

    cb('warning', {
      code: COOKIEBOT_WARNING_CODE,
      message: 'Cookiebot overlay semlegesítve a stabil futás érdekében.',
      actions: result.actions || [],
      accepted: !!result.accepted,
      url: context.url || result.url || null,
      ...context,
    });
  };

  cb('scraping', { message: 'Böngésző indítása...' });

  const browser = await launchBrowser({ headless: !hitlHeadful });
  let finalListings = [];

  try {
    const context = await createContext(browser);
    const listPage = await context.newPage();
    await installCookiebotGuard(listPage);

    cb('scraping', { message: 'Ingatlan.com megnyitása...' });
    await listPage.goto('https://ingatlan.com', { waitUntil: 'domcontentloaded', timeout: 25000 });
    reportCookieIntervention(await acceptCookies(listPage), {
      phase: 'landing_page',
      url: listPage.url(),
    });
    await randomDelay(1200);

    cb('scraping', { message: 'Keresési oldal betöltése...' });
    await listPage.goto(SEARCH_URL, { waitUntil: 'domcontentloaded', timeout: 35000 });
    reportCookieIntervention(await acceptCookies(listPage), {
      phase: 'search_page',
      url: listPage.url(),
    });
    await randomDelay(800);

    const listBlockStatus = await detectBlocking(listPage, null);
    if (listBlockStatus === 'captcha' || listBlockStatus === 'forbidden') {
      throw new Error(`Bot-védelem detektálva a listázó oldalon: ${listBlockStatus}`);
    }

    cb('scraping', { message: 'Oldal struktúra feltérképezése...' });
    const selectors = await discoverSelectors(listPage);

    cb('scraping', { message: 'Hirdetések gyűjtése...' });
    const { urls: listingUrls, fallbackById } = await collectListingUrls(listPage, selectors, reportCookieIntervention);

    if (listingUrls.length === 0) {
      throw new Error('Nem találhatók hirdetések az oldalon. A selectorok valószínűleg megváltoztak.');
    }

    cb('scraping', {
      message: `${listingUrls.length} hirdetés URL összegyűjtve`,
      total: listingUrls.length,
    });

    const total = Math.min(listingUrls.length, MAX_LISTINGS);
    const detailListings = [];
    const detailPage = await context.newPage();
    await installCookiebotGuard(detailPage);

    for (let i = 0; i < total; i++) {
      const url = listingUrls[i];

      if (isCancelled()) {
        throw new Error('Run cancelled by user');
      }

      cb('scraping', {
        message: `Hirdetés betöltése: ${i + 1}/${total}`,
        current: i + 1,
        total,
        progress: (i + 1) / total,
      });

      let retryCurrentListing = false;
      let manualResumeRetriesForListing = 0;

      do {
        retryCurrentListing = false;
        try {
          let outcome = await withRetry(
            () => scrapeDetailPage(detailPage, url, { onCookieIntervention: reportCookieIntervention }),
            2,
            800
          );
          if (SIMULATE_DETAIL_BLOCK) {
            outcome = {
              listing: null,
              blockType: 'bot_check',
              challengeUrl: `${url}?__cf_chl_tk=simulated`,
            };
          }

          scrapeMeta.detail_attempted++;

          if (outcome && outcome.listing) {
            detailListings.push(outcome.listing);
            scrapeMeta.detail_success++;
            scrapeMeta.consecutive_blocked = 0;
            break;
          }

          const blockType = outcome ? outcome.blockType : null;
          const challengeUrl = outcome && outcome.challengeUrl ? outcome.challengeUrl : url;

          if (isBlockingType(blockType)) {
            scrapeMeta.detail_blocked++;
            scrapeMeta.consecutive_blocked++;

            const fallbackReason = getFallbackReason(scrapeMeta);
            if (fallbackReason) {
              if (fallbackReason === 'rate') {
                addWarning(
                  scrapeMeta,
                  cb,
                  'DETAIL_BLOCK_HIGH_RATE',
                  `Magas detail blokkolási arány (${scrapeMeta.detail_blocked}/${scrapeMeta.detail_attempted}), fallback aktiválva.`,
                  {
                    detail_attempted: scrapeMeta.detail_attempted,
                    detail_blocked: scrapeMeta.detail_blocked,
                    run_source: runSource,
                  }
                );
              }

              activateFallback('Detail bot-check miatt listakártya fallback aktiválva.', { trigger: fallbackReason });
              break;
            }

            if (shouldForceFallbackAfterResumeRetry({
              runSource,
              hitlEnabled,
              manualResumeRetriesForListing,
            })) {
              activateFallback(
                'A challenge a kezi folytatas utan is aktiv maradt, automatikus fallback aktivalva.',
                {
                  trigger: 'post_resume_still_blocked',
                  challenge_url: challengeUrl,
                }
              );
              break;
            }

            if (runSource === 'cron' || !hitlEnabled || !awaitManualAction) {
              activateFallback('Cron/non-interactive futás: challenge észlelve, automatikus fallback aktiválva.', {
                trigger: 'auto_non_interactive',
                challenge_url: challengeUrl,
              });
              break;
            }

            if (scrapeMeta.pause_count >= HITL_MAX_PAUSES_PER_RUN) {
              activateFallback('Elértük a maximális pause számot, automatikus fallback aktiválva.', {
                trigger: 'max_pauses',
                challenge_url: challengeUrl,
              });
              break;
            }

            scrapeMeta.pause_count++;
            const pauseTimeoutAt = new Date(Date.now() + pauseTimeoutMs).toISOString();
            cb('paused', {
              reason: blockType,
              message: 'Challenge detektálva. Oldd meg a böngészőablakban, majd kattints a Folytatásra.',
              detail_attempted: scrapeMeta.detail_attempted,
              detail_blocked: scrapeMeta.detail_blocked,
              pause_timeout_at: pauseTimeoutAt,
              challenge_url: challengeUrl,
            });

            let action = null;
            let actionOrigin = 'manual';
            try {
              const manualAction = await Promise.race([
                Promise.resolve(awaitManualAction({
                  reason: blockType,
                  message: 'Challenge detektálva',
                  detail_attempted: scrapeMeta.detail_attempted,
                  detail_blocked: scrapeMeta.detail_blocked,
                  pause_timeout_at: pauseTimeoutAt,
                  challenge_url: challengeUrl,
                })),
                sleep(pauseTimeoutMs).then(() => '__timeout__'),
              ]);

              if (manualAction === '__timeout__') {
                action = 'fallback';
                actionOrigin = 'timeout';
                addWarning(
                  scrapeMeta,
                  cb,
                  'DETAIL_BLOCK_FALLBACK_ACTIVE',
                  'Pause timeout lejárt, automatikus fallback aktiválva.',
                  {
                    trigger: 'pause_timeout',
                    detail_attempted: scrapeMeta.detail_attempted,
                    detail_blocked: scrapeMeta.detail_blocked,
                    run_source: runSource,
                  }
                );
              } else {
                action = normalizeManualAction(manualAction) || 'fallback';
              }
            } catch (err) {
              console.warn('[scraper] Manual action wait failed, forcing fallback:', err.message);
              action = 'fallback';
              actionOrigin = 'error';
            }

            if (action === 'cancel') {
              throw new Error('Run cancelled by user');
            }

            if (action === 'fallback') {
              if (actionOrigin === 'manual') {
                scrapeMeta.manual_fallback_triggered = true;
              }
              const message = actionOrigin === 'manual'
                ? 'Kézi fallback aktiválva a felhasználó kérésére.'
                : 'Automatikus fallback aktiválva challenge kezelés közben.';
              activateFallback(message, {
                trigger: actionOrigin === 'manual' ? 'manual_fallback' : `auto_${actionOrigin}`,
                challenge_url: challengeUrl,
              });
              break;
            }

            if (action === 'resume') {
              manualResumeRetriesForListing++;
              scrapeMeta.manual_resume_count++;
              cb('resumed', { message: 'Folyamat folytatása kézi jóváhagyással...' });
              reportCookieIntervention(await acceptCookies(detailPage), {
                phase: 'resume_precheck',
                url: detailPage.url(),
              });
              await sleep(Math.max(0, HITL_RESUME_RECHECK_WAIT_MS));
              retryCurrentListing = true;
            }
          } else {
            scrapeMeta.consecutive_blocked = 0;
          }
        } catch (err) {
          if (err.message === 'Run cancelled by user') {
            throw err;
          }
          console.error(`[scraper] Failed detail scrape: ${url} - ${err.message}`);
        }
      } while (retryCurrentListing);

      if (scrapeMeta.fallback_used) {
        break;
      }

      await randomDelay();
    }

    if (!scrapeMeta.fallback_used && scrapeMeta.detail_attempted > 0 && scrapeMeta.detail_success === 0 && fallbackById.size > 0) {
      scrapeMeta.fallback_used = true;
      addWarning(
        scrapeMeta,
        cb,
        'DETAIL_BLOCK_FALLBACK_ACTIVE',
        'Detail oldalakból nem jött használható adat, listakártya fallback aktiválva.',
        {
          detail_attempted: scrapeMeta.detail_attempted,
          detail_blocked: scrapeMeta.detail_blocked,
          run_source: runSource,
        }
      );
    }

    finalListings = mergeListings(detailListings, fallbackById, listingUrls.slice(0, total));

    if (scrapeMeta.fallback_used) {
      scrapeMeta.mode = scrapeMeta.detail_success > 0 ? 'hybrid_fallback' : 'list_only';
    } else {
      scrapeMeta.mode = 'detail_only';
    }

    if (finalListings.length === 0) {
      throw new Error('A scrape eredmény üres maradt (detail és fallback is sikertelen).');
    }
  } finally {
    await browser.close();
  }

  delete scrapeMeta.consecutive_blocked;

  await saveResults(finalListings, scrapeMeta);
  cb('scraping_done', {
    total: finalListings.length,
    scrape_meta: scrapeMeta,
  });

  return {
    listings: finalListings,
    scrape_meta: scrapeMeta,
  };
}

module.exports = {
  run,
  __test: {
    shouldForceFallbackAfterResumeRetry,
  },
};
