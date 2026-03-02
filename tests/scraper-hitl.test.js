'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { __test } = require('../scraper');

test('manual + hitl + one resume retry triggers fallback', () => {
  assert.equal(__test.shouldForceFallbackAfterResumeRetry({
    runSource: 'manual',
    hitlEnabled: true,
    manualResumeRetriesForListing: 1,
  }), true);
});

test('manual + hitl + zero resume retry does not trigger fallback', () => {
  assert.equal(__test.shouldForceFallbackAfterResumeRetry({
    runSource: 'manual',
    hitlEnabled: true,
    manualResumeRetriesForListing: 0,
  }), false);
});

test('cron never triggers listing-level resume fallback guard', () => {
  assert.equal(__test.shouldForceFallbackAfterResumeRetry({
    runSource: 'cron',
    hitlEnabled: true,
    manualResumeRetriesForListing: 5,
  }), false);
});
