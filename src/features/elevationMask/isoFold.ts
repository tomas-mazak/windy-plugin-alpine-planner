// The running minimum and maximum of the effective freezing level F over a window's steps, per grid node. Pure,
// unit-tested (isoFold.test.ts). Both extremes are always kept, so Min, Max and Both share one fold. Steps may arrive in
// any order; a step that failed simply isn't added.
// Algorithm: docs/freezing-mask-algorithm.md §6.3

export type IsoFold = {
    min: Float32Array; // m; +Infinity until a step is added
    max: Float32Array; // m; −Infinity until a step is added
    nodata: Uint8Array; // 1: nodata in at least one step
    count: number; // steps added
    add: (F: Float32Array) => void; // one step's F, NaN = nodata
};

export function createIsoFold(size = 257 * 257): IsoFold {
    const min = new Float32Array(size).fill(Infinity);
    const max = new Float32Array(size).fill(-Infinity);
    const nodata = new Uint8Array(size);
    const fold: IsoFold = {
        min,
        max,
        nodata,
        count: 0,
        add(F) {
            fold.count++;
            for (let i = 0; i < size; i++) {
                const f = F[i];
                if (Number.isNaN(f)) {
                    nodata[i] = 1;
                } else {
                    if (f < min[i]) {
                        min[i] = f;
                    }
                    if (f > max[i]) {
                        max[i] = f;
                    }
                }
            }
        },
    };
    return fold;
}
