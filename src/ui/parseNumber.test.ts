import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseNumber } from './parseNumber.ts';

test('separators and units are dropped', () => {
    for (const text of ['1800', '1,800', '1 800', '1.800', '1800 m', ' 1 800 m ', '1 800']) {
        assert.equal(parseNumber(text), 1800, text);
    }
});

test('a leading sign is kept: plus, hyphen and the minus sign', () => {
    assert.equal(parseNumber('+200'), 200);
    assert.equal(parseNumber('-200'), -200);
    assert.equal(parseNumber('−200'), -200);
    assert.equal(parseNumber('−150 m'), -150);
    assert.equal(parseNumber('+0 m'), 0);
});

test('no digit: nothing to commit', () => {
    assert.equal(parseNumber(''), null);
    assert.equal(parseNumber('m'), null);
    assert.equal(parseNumber('−'), null);
});
