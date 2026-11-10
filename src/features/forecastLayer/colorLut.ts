// Windy's temperature colour scale as a lookup texture, built the way Windy builds its own layer's gradient texture:
// the palette precomputed into `steps` colours over [min, max], padded to a power-of-two width,
// sampled with LINEAR filtering at x = value * mul + add. The scale is in Kelvin, so it doesn't depend on the user's
// units. Windy's own table (colors.temp.getColor(), rebuilt when the palette is customised) is reused: its RGB bytes
// equal those of Windy's gradient texture, only alpha differs (opaque), and only RGB is drawn.

import colors from '@windy/colors';

const MAX_WIDTH = 2048;

export type ColorLut = { pixels: Uint8Array; width: number; mul: number; add: number };

// temp has 2048 steps, so getColor()'s table is exactly the texture; above MAX_WIDTH Windy would
// resample it.
export function tempColorLut(): ColorLut {
    const color = colors.temp;
    const steps = Math.min(color.steps, MAX_WIDTH);
    let width = 1;
    while (width < steps) {
        width *= 2;
    }
    const mul = steps / ((color.max - color.min) * width);
    const table = color.getColor().precomputedColors; // RGBA per step
    const pixels = new Uint8Array(width * 4);
    pixels.set(table.subarray(0, pixels.length));
    // Windy pads with the second-to-last colour, starting at the last one.
    if (table.length < pixels.length && table.length > 7) {
        const fill = table.slice(table.length - 8, table.length - 4);
        for (let p = table.length - 4; p < pixels.length; p += 4) {
            pixels.set(fill, p);
        }
    }
    return { pixels, width, mul, add: -mul * color.min };
}
