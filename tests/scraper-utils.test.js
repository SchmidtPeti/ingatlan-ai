'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  detectBlockType,
  extractListingCardsFromHtml,
  parseCardContentText,
} = require('../scraper-utils');

test('detectBlockType classifies 429 challenge as blocked', () => {
  const blockType = detectBlockType({
    status: 429,
    url: 'https://ingatlan.com/12345678?__cf_chl_rt_tk=abc',
    title: 'Csak egy gyors ellenőrzés - ingatlan.com',
    bodyText: 'Kérjük, pipáld be a dobozt...',
  });

  assert.notEqual(blockType, 'ok');
  assert.ok(['bot_check', 'rate_limited'].includes(blockType));
});

test('detectBlockType returns ok for normal page signal', () => {
  const blockType = detectBlockType({
    status: 200,
    url: 'https://ingatlan.com/12345678',
    title: 'Budapest XIII. kerület',
    bodyText: 'Kiadó lakás részletei',
  });

  assert.equal(blockType, 'ok');
});

test('parseCardContentText parses price, area and rooms', () => {
  const parsed = parseCardContentText(
    '170 000 Ft/hó Budapest XIII. kerület, Kassák Lajos utca Alapterület 25 m2 Szobák 1'
  );

  assert.equal(parsed.price_huf_monthly, 170000);
  assert.equal(parsed.area_sqm, 25);
  assert.equal(parsed.rooms, 1);
});

test('parseCardContentText ignores small badge prefix before price', () => {
  const parsed = parseCardContentText(
    '14 170 000 Ft/hó Budapest XIII. kerület, Kassák Lajos utca Alapterület 25 m2 Szobák 1'
  );

  assert.equal(parsed.price_huf_monthly, 170000);
  assert.equal(parsed.area_sqm, 25);
  assert.equal(parsed.rooms, 1);
});

test('parseCardContentText also parses unaccented card labels', () => {
  const parsed = parseCardContentText(
    '185 000 Ft/ho Budapest XIII. kerulet, Kassak Lajos utca Alapterulet 35 m2 Szobak 1,5'
  );

  assert.equal(parsed.price_huf_monthly, 185000);
  assert.equal(parsed.area_sqm, 35);
  assert.equal(parsed.rooms, 1.5);
});

test('fixture html produces non-empty parsed card list', () => {
  const fixturePath = path.join(__dirname, '..', 'ingatlan_lista_oldal.html');
  const html = fs.readFileSync(fixturePath, 'utf8');

  const cards = extractListingCardsFromHtml(html, 'https://ingatlan.com');
  assert.ok(cards.length > 0, 'expected cards in fixture');

  const parsedCount = cards
    .map(card => parseCardContentText(card.content_text))
    .filter(item => item.price_huf_monthly && item.area_sqm && item.rooms)
    .length;

  assert.ok(parsedCount > 0, 'expected at least one fully parsed card');
});
