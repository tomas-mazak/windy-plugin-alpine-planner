import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createIsoFold } from './isoFold.ts';

const F = (...v: number[]) => Float32Array.from(v);

test('min and max per node', () => {
    const fold = createIsoFold(3);
    fold.add(F(1200, 800, -300));
    fold.add(F(1500, 600, 0));
    fold.add(F(900, 700, 250));
    assert.deepEqual([...fold.min], [900, 600, -300]);
    assert.deepEqual([...fold.max], [1500, 800, 250]);
    assert.deepEqual([...fold.nodata], [0, 0, 0]);
    assert.equal(fold.count, 3);
});

test('nodata in any step makes the node nodata', () => {
    const fold = createIsoFold(3);
    fold.add(F(1000, NaN, 500));
    fold.add(F(1100, 900, 600));
    fold.add(F(1200, 950, NaN));
    assert.deepEqual([...fold.nodata], [0, 1, 1]);
    assert.equal(fold.min[0], 1000);
    assert.equal(fold.max[0], 1200);
});

test('the order of the steps does not matter', () => {
    const steps = [F(1, 8, 3), F(6, 2, NaN), F(0, 5, 9)];
    const results = [
        [0, 1, 2],
        [2, 1, 0],
        [1, 2, 0],
    ].map(order => {
        const fold = createIsoFold(3);
        order.forEach(s => fold.add(steps[s]));
        return [[...fold.min], [...fold.max], [...fold.nodata]];
    });
    assert.deepEqual(results[1], results[0]);
    assert.deepEqual(results[2], results[0]);
});

test('one step gives min = max = F', () => {
    const fold = createIsoFold(3);
    fold.add(F(1234.5, -50, 3000));
    assert.deepEqual([...fold.min], [1234.5, -50, 3000]);
    assert.deepEqual([...fold.max], [1234.5, -50, 3000]);
    assert.equal(fold.count, 1);
});

test('a failed step is simply not added', () => {
    const fold = createIsoFold(2);
    fold.add(F(1000, 2000));
    // step 2 failed: nothing added
    fold.add(F(1400, 1800));
    assert.deepEqual([...fold.min], [1000, 1800]);
    assert.deepEqual([...fold.max], [1400, 2000]);
    assert.equal(fold.count, 2);
});
