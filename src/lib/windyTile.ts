// Fetches and decodes a Windy `/im/v3.0`-format tile (257 × 265 px: an 8-row header,
// then 257 × 257 nodes). Framework-free: no MapLibre/Windy dependency, so the
// pure modules and their unit tests can use it.

const HEADER_ROWS = 8;
const GRID_SIZE = 257;

export type WindyTileHeader = {
    min: number;
    step: number;
};

export type WindyTile = {
    header: WindyTileHeader;
    grid: Uint8Array; // R: the value byte
    mask: Uint8Array; // nodata mask, 0 = valid, 255 = no data (JPEG: B; PNG: from alpha)
    url: string; // the final URL, after redirects
};

// JPEG carries the nodata mask in B (255 = no data), PNG in alpha (0 = no data). The canvas stores pixels
// premultiplied, so RGB is lost where alpha is 0; those pixels are nodata anyway (there's no partial alpha).
export type WindyTileFormat = 'jpg' | 'png';

export async function fetchWindyTile(url: string, format: WindyTileFormat, signal?: AbortSignal): Promise<WindyTile> {
    const resp = await fetch(url, { signal });
    if (!resp.ok) {
        throw new Error(`fetch ${url}: HTTP ${resp.status}`);
    }
    const blob = await resp.blob();
    // colorSpaceConversion/premultiplyAlpha 'none': the browser must not touch
    // our raw byte values.
    const bitmap = await createImageBitmap(blob, {
        colorSpaceConversion: 'none',
        premultiplyAlpha: 'none',
    });

    const { width, height } = bitmap;
    const canvas: OffscreenCanvas | HTMLCanvasElement =
        typeof OffscreenCanvas !== 'undefined'
            ? new OffscreenCanvas(width, height)
            : Object.assign(document.createElement('canvas'), { width, height });
    const ctx = canvas.getContext('2d', { willReadFrequently: true }) as
        | CanvasRenderingContext2D
        | OffscreenCanvasRenderingContext2D
        | null;
    if (!ctx) {
        throw new Error('failed to create 2d canvas context');
    }
    ctx.drawImage(bitmap, 0, 0);
    const { data } = ctx.getImageData(0, 0, width, height); // RGBA Uint8ClampedArray

    const header = decodeHeader(data, width);
    const grid = new Uint8Array(GRID_SIZE * GRID_SIZE);
    const mask = new Uint8Array(GRID_SIZE * GRID_SIZE);
    for (let row = 0; row < GRID_SIZE; row++) {
        const srcRow = HEADER_ROWS + row;
        let srcIdx = srcRow * width * 4;
        let dstIdx = row * GRID_SIZE;
        for (let col = 0; col < GRID_SIZE; col++, srcIdx += 4, dstIdx++) {
            grid[dstIdx] = data[srcIdx];
            mask[dstIdx] = format === 'png' ? (data[srcIdx + 3] < 128 ? 255 : 0) : data[srcIdx + 2];
        }
    }
    return { header, grid, mask, url: resp.url };
}

// Decoded values, NaN where there's no data (masked, or a non-finite header). A null mask has no nodata (step tiles).
// Algorithm: docs/freezing-mask-algorithm.md §2, docs/forecast-layer-algorithm.md §1.1
export function windyTileValues({ header, grid, mask }: Pick<WindyTile, 'header' | 'grid'> & { mask: Uint8Array | null }): Float32Array {
    const values = new Float32Array(grid.length);
    const valid = Number.isFinite(header.min) && Number.isFinite(header.step);
    for (let i = 0; i < grid.length; i++) {
        values[i] = valid && !(mask && mask[i] >= 128) ? header.min + header.step * grid[i] : NaN;
    }
    return values;
}

// A tile entirely outside a regional model's domain may decode to a +-inf header.
// Decodes the header exactly as Windy does: byte i
// is read from the flat-coloured block at row 4, column 4*i+2, split back out
// of the coarse R/G/B steps the encoder used, then the 28 bytes are
// reassembled as 7 little-endian float32s.
function decodeHeader(data: Uint8ClampedArray, width: number): WindyTileHeader {
    const bytes = new Uint8Array(28);
    for (let i = 0; i < 28; i++) {
        const idx = (4 * width + 4 * i + 2) * 4;
        const r = data[idx];
        const g = data[idx + 1];
        const b = data[idx + 2];
        const byte = (Math.round(r / 64) << 6) + (Math.round(g / 16) << 2) + Math.round(b / 64);
        bytes[i] = byte & 0xff;
    }
    const view = new DataView(bytes.buffer);
    const f: number[] = [];
    for (let i = 0; i < 7; i++) {
        f.push(view.getFloat32(i * 4, true));
    }
    return { min: f[0], step: (f[1] - f[0]) / 255 };
}
