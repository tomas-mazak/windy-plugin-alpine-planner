import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createFold, foldPoint, NO_STEP } from './fold.ts';

const grid = (...v: number[]) => Float32Array.from(v);

test('max and min per node, with the step of the extreme', () => {
    for (const [kind, want, arg] of [
        ['max', [5, 7, 3], [1, 0, 2]],
        ['min', [1, 2, -4], [0, 1, 0]],
    ] as const) {
        const fold = createFold(kind, 3);
        fold.add(0, grid(1, 7, -4), null);
        fold.add(1, grid(5, 2, 0), null);
        fold.add(2, grid(3, 4, 3), null);
        assert.deepEqual([...fold.value], want);
        assert.deepEqual([...fold.argStep], arg);
        assert.equal(fold.count, 3);
    }
});

test('ties go to the earliest step, whatever the order of the steps', () => {
    for (const order of [
        [0, 1, 2],
        [2, 1, 0],
        [1, 2, 0],
    ]) {
        const fold = createFold('max', 2);
        const steps = [grid(4, 1), grid(4, 9), grid(2, 9)];
        for (const s of order) {
            fold.add(s, steps[s], null);
        }
        assert.deepEqual([...fold.value], [4, 9]);
        assert.deepEqual([...fold.argStep], [0, 1]);
    }
});

test('the result is the same in any order', () => {
    const steps = [grid(1, 8, 3), grid(6, 2, 3.5), grid(0, 5, 9)];
    const ref = createFold('min', 3);
    steps.forEach((g, s) => ref.add(s, g, null));
    const rev = createFold('min', 3);
    [2, 0, 1].forEach(s => rev.add(s, steps[s], null));
    assert.deepEqual([...rev.value], [...ref.value]);
    assert.deepEqual([...rev.argStep], [...ref.argStep]);
});

test('a node with nodata in any step is nodata; range covers the valid nodes only', () => {
    const fold = createFold('max', 3);
    assert.equal(fold.range(), null);
    fold.add(0, grid(1, 2, 3), Uint8Array.from([0, 255, 0]));
    fold.add(1, grid(4, 9, NaN), null);
    assert.deepEqual([...fold.nodata], [0, 1, 1]);
    assert.deepEqual(fold.range(), [4, 4]);
    const empty = createFold('min', 2);
    empty.add(0, grid(1, 2), Uint8Array.from([255, 255]));
    assert.equal(empty.range(), null);
    assert.deepEqual([...empty.argStep], [NO_STEP, NO_STEP]);
});

test('picker: value from the node extremes, time from the point series', () => {
    // Two nodes peak at different steps: halfway between them the point series peaks lower than the node maxima.
    const steps = [
        [10, 0, 10, 0],
        [0, 10, 0, 10],
        [4, 4, 4, 4],
    ];
    const p = foldPoint('max', steps, 0.5, 0.5)!;
    assert.equal(p.value, 10);
    assert.equal(p.extreme, 5);
    assert.equal(p.stepIndex, 0); // a tie between steps 0 and 1: the earliest
    assert.deepEqual(p.series, [5, 5, 4]);
    // At a node, the two agree.
    const node = foldPoint('min', steps, 0, 0)!;
    assert.equal(node.value, 0);
    assert.equal(node.extreme, 0);
    assert.equal(node.stepIndex, 1);
});

test('picker: missing steps are skipped, nodata at a node gives null', () => {
    const p = foldPoint('max', [null, [1, 2, 3, 4], null], 1, 1)!;
    assert.equal(p.value, 4);
    assert.equal(p.stepIndex, 1);
    assert.ok(Number.isNaN(p.series[0]));
    assert.equal(foldPoint('max', [[1, 2, 3, 4], [1, NaN, 3, 4]], 0.5, 0.5), null);
    assert.equal(foldPoint('min', [null, null], 0.5, 0.5), null);
});
