import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatMinSec, formatSpeed } from '../src/format.ts';

test('formatMinSec: zero seconds', () => {
  assert.equal(formatMinSec(0), '0:00');
});

test('formatMinSec: sub-minute', () => {
  assert.equal(formatMinSec(5), '0:05');
});

test('formatMinSec: exact minute', () => {
  assert.equal(formatMinSec(60), '1:00');
});

test('formatMinSec: second-padding', () => {
  assert.equal(formatMinSec(65), '1:05');
});

test('formatMinSec: multi-minute', () => {
  assert.equal(formatMinSec(185), '3:05');
});

test('formatMinSec: fractional seconds truncate down', () => {
  assert.equal(formatMinSec(59.9), '0:59');
  assert.equal(formatMinSec(60.9), '1:00');
});

test('formatMinSec: negative values clamp to zero', () => {
  assert.equal(formatMinSec(-5), '0:00');
});

test('formatSpeed: 1 -> "1.00x"', () => {
  assert.equal(formatSpeed(1), '1.00x');
});

test('formatSpeed: 0.25', () => {
  assert.equal(formatSpeed(0.25), '0.25x');
});

test('formatSpeed: 0.5', () => {
  assert.equal(formatSpeed(0.5), '0.50x');
});

test('formatSpeed: rounds to two decimal places', () => {
  assert.equal(formatSpeed(0.833333), '0.83x');
});
