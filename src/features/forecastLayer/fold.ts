// The minimum / maximum over the window's steps, per grid node and at a picked point. Pure, unit-tested (fold.test.ts).

export type FoldKind = 'min' | 'max';

export type Fold = {
    kind: FoldKind;
    value: Float32Array; // K; ±Infinity until a step is added
    argStep: Uint16Array; // the step index of the extreme, the earliest on ties; NO_STEP until a step is added
    nodata: Uint8Array; // 1: nodata in at least one step
    count: number; // steps added
    add: (stepIndex: number, grid: Float32Array, mask: Uint8Array | null) => void;
    range: () => [number, number] | null; // [min, max] of the valid nodes, null if none
};

export const NO_STEP = 0xffff;

const better = (kind: FoldKind, a: number, b: number): boolean => (kind === 'max' ? a > b : a < b);

// A running fold over 257 × 257 nodes; steps may arrive in any order. `grid` is one step in K (NaN = nodata),
// `mask` its nodata mask (≥ 128 = nodata) or null if it has none.
// Algorithm: docs/forecast-layer-algorithm.md §3
export function createFold(kind: FoldKind, size = 257 * 257): Fold {
    const value = new Float32Array(size).fill(kind === 'max' ? -Infinity : Infinity);
    const argStep = new Uint16Array(size).fill(NO_STEP);
    const nodata = new Uint8Array(size);
    const fold: Fold = {
        kind,
        value,
        argStep,
        nodata,
        count: 0,
        add(stepIndex, grid, mask) {
            fold.count++;
            for (let i = 0; i < size; i++) {
                const v = grid[i];
                if ((mask && mask[i] >= 128) || Number.isNaN(v)) {
                    nodata[i] = 1;
                } else if (better(kind, v, value[i]) || (v === value[i] && stepIndex < argStep[i])) {
                    value[i] = v;
                    argStep[i] = stepIndex;
                }
            }
        },
        range() {
            let lo = Infinity;
            let hi = -Infinity;
            for (let i = 0; i < size; i++) {
                if (!nodata[i] && argStep[i] !== NO_STEP) {
                    lo = Math.min(lo, value[i]);
                    hi = Math.max(hi, value[i]);
                }
            }
            return lo <= hi ? [lo, hi] : null;
        },
    };
    return fold;
}

export type PointSample = {
    value: number; // bilinear interpolation of the four nodes' extremes: the spatial envelope shown by the picker
    extreme: number; // the extreme of the bilinear point series
    stepIndex: number; // where the point series reaches its extreme, the earliest on ties: the picker's time
    series: number[]; // the point series per step, NaN for a missing step
};

// The picker at a point between four nodes. `steps[s]` holds step s's values at the nodes [top-left, top-right,
// bottom-left, bottom-right] (K, NaN = nodata), or null if the step is missing (failed); fc / fr are the point's
// fractions towards the right / bottom nodes. null if a node has no data in some step, or no step is there.
// Algorithm: docs/forecast-layer-algorithm.md §5
export function foldPoint(kind: FoldKind, steps: (number[] | null)[], fc: number, fr: number): PointSample | null {
    const w = [(1 - fc) * (1 - fr), fc * (1 - fr), (1 - fc) * fr, fc * fr];
    const nodeExtremes = [0, 1, 2, 3].map(() => (kind === 'max' ? -Infinity : Infinity));
    const series: number[] = [];
    let best = -1;
    for (let s = 0; s < steps.length; s++) {
        const nodes = steps[s];
        if (!nodes) {
            series.push(NaN);
            continue;
        }
        if (nodes.some(Number.isNaN)) {
            return null;
        }
        let p = 0;
        for (let k = 0; k < 4; k++) {
            p += w[k] * nodes[k];
            if (better(kind, nodes[k], nodeExtremes[k])) {
                nodeExtremes[k] = nodes[k];
            }
        }
        series.push(p);
        if (best < 0 || better(kind, p, series[best])) {
            best = s;
        }
    }
    if (best < 0) {
        return null;
    }
    const value = nodeExtremes.reduce((sum, v, k) => sum + w[k] * v, 0);
    return { value, extreme: series[best], stepIndex: best, series };
}
