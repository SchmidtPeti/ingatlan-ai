'use strict';

function normalizeWhitespace(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractListingId(value) {
  const text = String(value || '');
  const match = text.match(/\/(\d{6,})(?:[/?#]|$)/) || text.match(/(\d{6,})/);
  return match ? match[1] : null;
}

function toAbsoluteIngatlanUrl(href, baseUrl = 'https://ingatlan.com') {
  if (!href) return null;
  try {
    return new URL(href, baseUrl).toString();
  } catch (err) {
    return null;
  }
}

function parsePriceHuf(rawValue) {
  const cleaned = String(rawValue || '').trim();
  if (!cleaned) return null;

  const tokens = cleaned
    .split(/\s+/)
    .map(token => token.replace(/[^\d]/g, ''))
    .filter(Boolean);

  if (tokens.length === 0) return null;

  let numeric = Number(tokens.join(''));

  // Some cards contain a short leading badge number before the price.
  // Example: "14 170 000 Ft/hó" should become 170000 for monthly rent context.
  if (tokens.length >= 3 && numeric > 2000000 && tokens[0].length <= 2) {
    numeric = Number(tokens.slice(1).join(''));
  }

  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function parseCardContentText(contentText) {
  const text = normalizeWhitespace(contentText);
  if (!text) {
    return {
      title: null,
      district: null,
      address: null,
      price_huf_monthly: null,
      area_sqm: null,
      rooms: null,
    };
  }

  const priceMatch = text.match(/([\d\s]+)\s*Ft\/h(?:ó|o)/i);
  const areaMatch = text.match(/Alapter(?:ület|ulet)\s*([0-9]+(?:[.,][0-9]+)?)\s*m\s*(?:2|²)/i);
  const roomsMatch = text.match(/Szob(?:ák|ak)\s*([0-9]+(?:[.,][0-9]+)?)/i);
  const districtMatch = text.match(/Budapest\s+[IVXLCDM]+\.?\s+ker(?:ület|ulet).*?(?=\s+Alapter(?:ület|ulet)|\s+Szob(?:ák|ak)|$)/i);

  const priceHuf = priceMatch ? parsePriceHuf(priceMatch[1]) : null;
  const areaValue = areaMatch ? Number.parseFloat(areaMatch[1].replace(',', '.')) : null;
  const roomsValue = roomsMatch ? Number.parseFloat(roomsMatch[1].replace(',', '.')) : null;
  const district = districtMatch ? normalizeWhitespace(districtMatch[0]) : null;

  return {
    title: district,
    district,
    address: district,
    price_huf_monthly: Number.isFinite(priceHuf) ? priceHuf : null,
    area_sqm: Number.isFinite(areaValue) ? areaValue : null,
    rooms: Number.isFinite(roomsValue) ? roomsValue : null,
  };
}

function decodeEntities(text) {
  return String(text || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function stripTags(html) {
  return decodeEntities(String(html || '').replace(/<[^>]*>/g, ' '));
}

function extractListingCardsFromHtml(html, baseUrl = 'https://ingatlan.com') {
  const cards = [];
  const cardRegex = /<a\b[^>]*class="[^"]*\blisting-card[^"]*"[^>]*>[\s\S]*?<\/a>/gi;
  let match;

  while ((match = cardRegex.exec(String(html || ''))) !== null) {
    const cardHtml = match[0];
    const hrefMatch = cardHtml.match(/\shref="([^"]+)"/i);
    const listingIdMatch = cardHtml.match(/data-listing-id="(\d+)"/i);
    const imageMatch = cardHtml.match(/<img[^>]*class="[^"]*listing-card-image[^"]*"[^>]*src="([^"]+)"/i)
      || cardHtml.match(/<img[^>]*src="([^"]+)"[^>]*class="[^"]*listing-card-image[^"]*"/i);
    const contentMatch = cardHtml.match(/<div[^>]*class="[^"]*listing-card-content[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i);

    const href = hrefMatch ? hrefMatch[1] : null;
    const absoluteUrl = toAbsoluteIngatlanUrl(href, baseUrl);
    const id = listingIdMatch ? listingIdMatch[1] : extractListingId(absoluteUrl);
    if (!id || !absoluteUrl) continue;

    const contentText = normalizeWhitespace(stripTags(contentMatch ? contentMatch[1] : cardHtml));
    cards.push({
      id,
      href: absoluteUrl,
      content_text: contentText,
      image_url: imageMatch ? toAbsoluteIngatlanUrl(imageMatch[1], baseUrl) : null,
    });
  }

  return cards;
}

function detectBlockType({ status = null, url = '', title = '', bodyText = '' } = {}) {
  const normalizedUrl = String(url || '').toLowerCase();
  const normalizedTitle = String(title || '').toLowerCase();
  const normalizedBody = String(bodyText || '').toLowerCase();
  const combined = `${normalizedTitle}\n${normalizedBody}`;

  const challengeDetected =
    normalizedUrl.includes('__cf_chl') ||
    normalizedUrl.includes('/cdn-cgi/challenge-platform') ||
    combined.includes('csak egy gyors ellenőrzés') ||
    combined.includes('csak egy gyors ellenörzés') ||
    combined.includes('just a quick check') ||
    combined.includes('valódi személy') ||
    combined.includes('verify you are human');

  if (combined.includes('captcha') || normalizedUrl.includes('captcha')) {
    return 'captcha';
  }

  if (status === 403 || combined.includes('403 forbidden') || combined.includes('access denied')) {
    return 'forbidden';
  }

  if (status === 429 || combined.includes('too many requests')) {
    return challengeDetected ? 'bot_check' : 'rate_limited';
  }

  if (challengeDetected || combined.includes('robot check') || combined.includes('ellenőrzés') || combined.includes('ellenörzés')) {
    return 'bot_check';
  }

  return 'ok';
}

module.exports = {
  detectBlockType,
  extractListingCardsFromHtml,
  extractListingId,
  normalizeWhitespace,
  parseCardContentText,
  parsePriceHuf,
  toAbsoluteIngatlanUrl,
};
