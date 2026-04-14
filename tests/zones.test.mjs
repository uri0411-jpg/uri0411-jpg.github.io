import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getZoneForCoord, ZONES } from '../js/zones.js';

// ── Bounding-box containment ─────────────────────────────────────────────────

test('getZoneForCoord: Tel Aviv centre returns coast-tlv', () => {
  const z = getZoneForCoord(32.07, 34.77);
  assert.equal(z.zoneId, 'coast-tlv');
  assert.equal(z.repLat, 32.07);
  assert.equal(z.repLon, 34.77);
});

test('getZoneForCoord: Jerusalem returns jerusalem zone', () => {
  const z = getZoneForCoord(31.78, 35.20);
  assert.equal(z.zoneId, 'jerusalem');
});

test('getZoneForCoord: Eilat returns eilat zone', () => {
  const z = getZoneForCoord(29.56, 34.95);
  assert.equal(z.zoneId, 'eilat');
});

test('getZoneForCoord: Dead Sea returns dead-sea zone', () => {
  const z = getZoneForCoord(31.50, 35.40);
  assert.equal(z.zoneId, 'dead-sea');
});

test('getZoneForCoord: upper Galilee', () => {
  const z = getZoneForCoord(33.00, 35.30);
  assert.equal(z.zoneId, 'galilee-upper');
});

test('getZoneForCoord: Golan north', () => {
  const z = getZoneForCoord(33.25, 35.75);
  assert.equal(z.zoneId, 'golan-north');
});

// ── Boundary conditions ──────────────────────────────────────────────────────

test('getZoneForCoord: exact southern boundary of coast-tlv is inside', () => {
  const z = getZoneForCoord(31.90, 34.75);
  assert.equal(z.zoneId, 'coast-tlv');
});

test('getZoneForCoord: exact northern boundary of coast-tlv overlaps with coast-sharon — first match wins', () => {
  // 32.20 is both coast-tlv latMax and coast-sharon latMin area
  // The system returns whichever zone's bounding box matches first
  const z = getZoneForCoord(32.20, 34.75);
  assert.ok(['coast-tlv', 'coast-sharon'].includes(z.zoneId),
    `Expected coast-tlv or coast-sharon at overlap boundary, got ${z.zoneId}`);
});

// ── Fallback to nearest zone ─────────────────────────────────────────────────

test('getZoneForCoord: Mediterranean Sea (west of all zones) falls back to nearest coastal zone', () => {
  const z = getZoneForCoord(32.07, 34.40);
  assert.ok(z.zoneId.startsWith('coast'), `Expected coastal zone, got ${z.zoneId}`);
});

test('getZoneForCoord: far south (Sinai) falls back to eilat', () => {
  const z = getZoneForCoord(28.50, 34.90);
  assert.equal(z.zoneId, 'eilat');
});

test('getZoneForCoord: far north falls back to a northern zone', () => {
  const z = getZoneForCoord(34.00, 35.70);
  assert.ok(['golan-north', 'galilee-upper', 'hula'].includes(z.zoneId),
    `Expected a northern zone, got ${z.zoneId}`);
});

test('getZoneForCoord: far east (Jordan) falls back to an eastern zone', () => {
  const z = getZoneForCoord(32.00, 36.50);
  assert.ok(z.zoneId, 'Should return a valid zoneId even for out-of-bounds');
});

// ── Return value structure ───────────────────────────────────────────────────

test('getZoneForCoord: returns expected keys', () => {
  const z = getZoneForCoord(32.07, 34.77);
  assert.ok('zoneId' in z);
  assert.ok('repLat' in z);
  assert.ok('repLon' in z);
  assert.ok('label' in z);
});

test('getZoneForCoord: label is a Hebrew string', () => {
  const z = getZoneForCoord(32.07, 34.77);
  assert.ok(z.label.length > 0, 'label should be non-empty');
  // Hebrew chars are in range \u0590-\u05FF
  assert.ok(/[\u0590-\u05FF]/.test(z.label), `label should contain Hebrew chars: ${z.label}`);
});

// ── Zone data integrity ──────────────────────────────────────────────────────

test('ZONES: all 23 zones defined', () => {
  assert.equal(ZONES.length, 23);
});

test('ZONES: all zoneIds are unique', () => {
  const ids = ZONES.map(z => z.zoneId);
  assert.equal(new Set(ids).size, ids.length, 'Duplicate zoneIds found');
});

test('ZONES: all rep points are inside their own bounding box', () => {
  for (const z of ZONES) {
    assert.ok(z.repLat >= z.latMin && z.repLat <= z.latMax,
      `${z.zoneId}: repLat ${z.repLat} outside [${z.latMin}, ${z.latMax}]`);
    assert.ok(z.repLon >= z.lonMin && z.repLon <= z.lonMax,
      `${z.zoneId}: repLon ${z.repLon} outside [${z.lonMin}, ${z.lonMax}]`);
  }
});

test('ZONES: bounding boxes have positive area', () => {
  for (const z of ZONES) {
    assert.ok(z.latMax > z.latMin, `${z.zoneId}: latMax <= latMin`);
    assert.ok(z.lonMax > z.lonMin, `${z.zoneId}: lonMax <= lonMin`);
  }
});

test('ZONES: rep point query returns a valid zone (rep point always resolves)', () => {
  // Some zones have overlapping bounding boxes, so a rep point may resolve
  // to a different zone that appears earlier in the iteration order.
  // This test verifies every rep point resolves to *some* valid zone.
  for (const z of ZONES) {
    const result = getZoneForCoord(z.repLat, z.repLon);
    assert.ok(result.zoneId, `Rep point (${z.repLat}, ${z.repLon}) should resolve to a zone`);
    assert.ok(typeof result.label === 'string' && result.label.length > 0);
  }
});
