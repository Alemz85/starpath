/**
 * location-identity.test.mjs — place tokens for the multi-city (company, role) dedup.
 *
 * Run: node --test scripts/lib/location-identity.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ANY_LOCATION, placeTokens, locationTokens, recordLocations, isNewLocation } from './location-identity.mjs';

const tokens = (...s) => [...locationTokens(s)].sort();

test('placeTokens: case, accents, "City, Country", work-mode markers and local spellings fold to one city', () => {
  for (const s of ['Lyon', 'LYON', 'Lyon, France', 'Lyon (Hybrid)', 'Hybrid - Lyon', 'Remote - Lyon', 'Lyon, FR', 'Greater Lyon Area', 'Lyon Office']) {
    assert.deepEqual(placeTokens(s), ['lyon'], s);
  }
  assert.deepEqual(placeTokens('Zürich'), ['zurich']);
  assert.deepEqual(placeTokens('München, Germany'), ['munich']);
  assert.deepEqual(placeTokens('Lisboa'), ['lisbon']);
  assert.deepEqual(placeTokens('Austin, TX'), ['austin']);
});

test('placeTokens: nothing city-level → null', () => {
  for (const s of ['', 'Remote', 'Fully Remote', 'France', 'Remote, Portugal', 'EMEA', 'Europe (Remote)', '2 Locations', 'Multiple Locations', 'US']) {
    assert.equal(placeTokens(s), null, JSON.stringify(s));
  }
});

test('locationTokens: a multi-city cell is every city; any non-city piece makes the posting unknown', () => {
  assert.deepEqual(tokens('Lyon; Porto'), ['lyon', 'porto']);
  assert.deepEqual(tokens('Lyon, France', 'Porto, Portugal'), ['lyon', 'porto']);
  assert.deepEqual(tokens('Lyon, Porto'), ['lyon', 'porto'], 'an unsplit comma list over-matches, never under-matches');
  assert.deepEqual(tokens('Lyon | Remote'), []);
  assert.deepEqual(tokens(''), []);
  assert.deepEqual(tokens(), []);
});

test('isNewLocation: only a fully new city of a key with a known location record', () => {
  const map = new Map();
  recordLocations(map, 'k', new Set(['lyon']));
  assert.equal(isNewLocation(map, 'k', new Set(['porto'])), true);
  assert.equal(isNewLocation(map, 'k', new Set(['lyon'])), false);
  assert.equal(isNewLocation(map, 'k', new Set(['porto', 'lyon'])), false, 'overlap is a duplicate');
  assert.equal(isNewLocation(map, 'k', new Set()), false, 'unknown new location');
  assert.equal(isNewLocation(map, 'other', new Set(['porto'])), false, 'a key with no record was seen somewhere unknown');
  assert.equal(isNewLocation(undefined, 'k', new Set(['porto'])), false);
  recordLocations(map, 'k', new Set());
  assert.equal(map.get('k').has(ANY_LOCATION), true);
  assert.equal(isNewLocation(map, 'k', new Set(['nice'])), false, 'once seen somewhere unknown, every city is blocked');
});
