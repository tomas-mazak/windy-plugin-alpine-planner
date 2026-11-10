// A data tile's 257 × 257 node grid. Pure and framework-free (node:test).

export const GRID = 257;

// The first of node i's 8 neighbours (inside the grid) for which `valid` holds, or -1. Nodata nodes take such a
// neighbour's values before upload, so interpolation near a domain edge doesn't mix in a meaningless value.
export function validNeighbour(i: number, valid: (j: number) => boolean): number {
    const [r, c] = [Math.floor(i / GRID), i % GRID];
    for (const [dr, dc] of NEIGHBOURS) {
        const [rj, cj] = [r + dr, c + dc];
        if (rj >= 0 && rj < GRID && cj >= 0 && cj < GRID && valid(rj * GRID + cj)) {
            return rj * GRID + cj;
        }
    }
    return -1;
}

// Left, right, up, down, then the diagonals: the order the packers have always used.
const NEIGHBOURS = [[0, -1], [0, 1], [-1, 0], [1, 0], [-1, -1], [-1, 1], [1, -1], [1, 1]] as const;
