import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { sha256 } from '../src/core/sha256.ts';
import { canonical } from '../src/core/canonical.ts';

test('sha256 of "abc" matches the published test vector', () => {
  assert.equal(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(sha256(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

test('sha256 matches node:crypto on every padding edge and on unicode', () => {
  // 55, 56 and 64 bytes are where the padding needs one or two extra blocks.
  for (const len of [1, 55, 56, 63, 64, 65, 119, 120, 1000, 100_000]) {
    const s = 'x'.repeat(len);
    assert.equal(sha256(s), createHash('sha256').update(s).digest('hex'), `length ${len}`);
  }
  const u = 'Ship week — “Built in the browser” 🎬';
  assert.equal(sha256(u), createHash('sha256').update(u).digest('hex'));
});

test('canonical JSON sorts keys and has one form per value', () => {
  assert.equal(canonical({ b: 1, a: [true, null, 'x'], c: { z: 0, y: -1.5 } }), '{"a":[true,null,"x"],"b":1,"c":{"y":-1.5,"z":0}}');
  assert.equal(canonical({ a: 1, b: 2 }), canonical({ b: 2, a: 1 }));
  assert.equal(canonical({ a: undefined, b: 1 }), '{"b":1}');
  assert.throws(() => canonical({ a: NaN }), /cannot store the number NaN/);
});
