const test = require('node:test');
const assert = require('node:assert');
const { total, totalOriginal } = require('./total.js');

test('original reproduces bug: total(100, 0.1) returns 120', () => {
  assert.strictEqual(totalOriginal(100, 0.1), 120);
});

test('fixed: total(100, 0.1) returns 110', () => {
  assert.strictEqual(total(100, 0.1), 110);
});

test('fixed: zero tax returns the price unchanged', () => {
  assert.strictEqual(total(100, 0), 100);
});
