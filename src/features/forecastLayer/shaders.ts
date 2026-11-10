// GLSL ES 3.00. The colour pass reproduces how Windy colours its temperature layer (a clamped Catmull-Rom bicubic over
// the nodes, bilinear nodata opacity, the colour scale), the draw pass how it draws the coloured tiles
// (docs/windy-integration.md). Values are Kelvin floats instead of Windy's normalised bytes: the Hermite weights sum to 1, so
// interpolating min + step·byte equals rescaling the interpolated byte, and Windy's [0, 1] clamps become clamps to
// the data tile's [min, max]. The draw pass uses the elevation mask's vertex shader (one quad per tile).

export { VERTEX_SHADER as DRAW_VS } from '../elevationMask/shaders';

// A full-viewport quad: with a 256² viewport, v_uv is at the texel centres (i + 0.5) / 256.
export const COLOR_VS = `#version 300 es
in vec2 aLocal;
out vec2 v_uv;
void main() {
    v_uv = aLocal;
    gl_Position = vec4(aLocal * 2.0 - 1.0, 0.0, 1.0);
}`;

// Windy's Catmull-Rom cubic Hermite (cubicHermite.glsl, cubicHermiteVec4.glsl), clamped to u_range.
const HERMITE = `vec4 hermite4(vec4 A, vec4 B, vec4 C, vec4 D, float t) {
    vec4 a = -A * 0.5 + 3.0 * B * 0.5 - 3.0 * C * 0.5 + D * 0.5;
    vec4 b = A - 5.0 * B * 0.5 + 2.0 * C - D * 0.5;
    vec4 c = -A * 0.5 + C * 0.5;
    float tt = t * t;
    return clamp(a * tt * t + b * tt + c * t + B, vec4(u_range.x), vec4(u_range.y));
}

float hermite(vec4 X, float t) {
    float a = -X.x * 0.5 + 3.0 * X.y * 0.5 - 3.0 * X.z * 0.5 + X.w * 0.5;
    float b = X.x - 5.0 * X.y * 0.5 + 2.0 * X.z - X.w * 0.5;
    float c = -X.x * 0.5 + X.z * 0.5;
    float tt = t * t;
    return clamp(a * tt * t + b * tt + c * t + X.y, u_range.x, u_range.y);
}`;

// Algorithm: docs/forecast-layer-algorithm.md §4
export const COLOR_FS = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 v_uv;
uniform sampler2D u_data;      // RG32F 257², NEAREST. r: value (K), g: 1 where nodata
uniform sampler2D u_lut;       // Windy's colour scale, LINEAR
uniform vec2 u_lutScaleOffset; // value -> lut x
uniform vec3 u_rect;           // x: the render tile's size in data pixels, yz: its offset in the data tile
uniform vec2 u_range;          // the data tile's [min, max]
out vec4 outColor;

${HERMITE}
// The data at offset (i, j) from the pixel, as Windy's NEAREST lookups at coord + k * 0.998 / 257 pick it.
vec2 at(vec2 u, float i, float j) {
    ivec2 texel = clamp(ivec2(floor(u + vec2(i, j) * 0.998)), ivec2(0), ivec2(256));
    return texelFetch(u_data, texel, 0).rg;
}

vec4 row(vec2 u, float j) {
    return vec4(at(u, -1.0, j).r, at(u, 0.0, j).r, at(u, 1.0, j).r, at(u, 2.0, j).r);
}

void main() {
    vec2 u = v_uv * u_rect.x + u_rect.yz; // in data pixels: grid node k sits at k (corner-registered)
    vec2 f1 = fract(v_uv * u_rect.x);
    vec2 f0 = 1.0 - f1;
    vec4 w4 = vec4(f0.y * f0.x, f0.y * f1.x, f1.y * f0.x, f1.y * f1.x);

    vec4 r0 = row(u, -1.0);
    vec4 r1 = row(u, 0.0);
    vec4 r2 = row(u, 1.0);
    vec4 r3 = row(u, 2.0);
    float value = hermite(hermite4(r0, r1, r2, r3, f1.y), f1.x);
    value = clamp(value, min(min(r1.y, r1.z), min(r2.y, r2.z)), max(max(r1.y, r1.z), max(r2.y, r2.z)));

    vec3 color = texture(u_lut, vec2(value * u_lutScaleOffset.x + u_lutScaleOffset.y, 0.5)).rgb;
    float nodata = dot(vec4(at(u, 0.0, 0.0).g, at(u, 1.0, 0.0).g, at(u, 0.0, 1.0).g, at(u, 1.0, 1.0).g), w4);
    float opacity = 1.0 - max(sign(nodata - 0.33), 0.0);
    outColor = vec4(mix(vec3(128.0 / 255.0), color, opacity), 1.0); // grey where there's no data
}`;

// The colour pass with the lapse rate correction: the real height h of each texel from our elevation tile (bilinear),
// its height relative to the model terrain r = h − z_s (z_s bilinear between the nodes), the two height bands around
// r, COLOR_FS's bicubic with its 2 × 2 clamp at each band (from the texture array), and linear interpolation between the
// bands. Band k holds every node's value at z_s + oLo + k · S. Bands are °C (u_range too); the LUT takes K.
// Algorithm: docs/forecast-layer-algorithm.md §7.6
export const COLOR_BANDS_FS = `#version 300 es
precision highp float;
precision highp sampler2D;
precision highp sampler2DArray;
in vec2 v_uv;
uniform sampler2DArray u_bands; // R16F 257² × K layers, NEAREST: °C per band
uniform sampler2D u_nodata;    // R8 257², NEAREST: 1 where nodata
uniform sampler2D u_zs;        // R32F 257², NEAREST: the model terrain (m)
uniform sampler2D u_elev;      // our elevation tile, R8 257², LINEAR
uniform vec3 u_elevRect;       // maps v_uv into the elevation tile: q = xy + v_uv * z
uniform vec2 u_elevMinStep;    // its header: m = min + step * byte
uniform vec3 u_bandGeom;       // oLo (m), S (m), K
uniform sampler2D u_lut;
uniform vec2 u_lutScaleOffset;
uniform vec3 u_rect;
uniform vec2 u_range;          // the folded bands' [min, max], °C
out vec4 outColor;

${HERMITE}

ivec2 texel(vec2 u, float i, float j) {
    return clamp(ivec2(floor(u + vec2(i, j) * 0.998)), ivec2(0), ivec2(256));
}

vec4 row(vec2 u, float j, int k) {
    return vec4(
        texelFetch(u_bands, ivec3(texel(u, -1.0, j), k), 0).r,
        texelFetch(u_bands, ivec3(texel(u, 0.0, j), k), 0).r,
        texelFetch(u_bands, ivec3(texel(u, 1.0, j), k), 0).r,
        texelFetch(u_bands, ivec3(texel(u, 2.0, j), k), 0).r
    );
}

// COLOR_FS's bicubic at band k, with its 2 × 2 clamp.
float band(vec2 u, vec2 f1, int k) {
    vec4 r0 = row(u, -1.0, k);
    vec4 r1 = row(u, 0.0, k);
    vec4 r2 = row(u, 1.0, k);
    vec4 r3 = row(u, 2.0, k);
    float value = hermite(hermite4(r0, r1, r2, r3, f1.y), f1.x);
    return clamp(value, min(min(r1.y, r1.z), min(r2.y, r2.z)), max(max(r1.y, r1.z), max(r2.y, r2.z)));
}

void main() {
    vec2 u = v_uv * u_rect.x + u_rect.yz;
    vec2 f1 = fract(v_uv * u_rect.x);
    vec2 f0 = 1.0 - f1;
    vec4 w4 = vec4(f0.y * f0.x, f0.y * f1.x, f1.y * f0.x, f1.y * f1.x);

    vec2 q = u_elevRect.xy + v_uv * u_elevRect.z;
    float h = u_elevMinStep.x + u_elevMinStep.y * 255.0 * texture(u_elev, (q * 256.0 + 0.5) / 257.0).r;
    float zs = mix(
        mix(texelFetch(u_zs, texel(u, 0.0, 0.0), 0).r, texelFetch(u_zs, texel(u, 1.0, 0.0), 0).r, f1.x),
        mix(texelFetch(u_zs, texel(u, 0.0, 1.0), 0).r, texelFetch(u_zs, texel(u, 1.0, 1.0), 0).r, f1.x),
        f1.y
    );
    float K = u_bandGeom.z;
    float pos = clamp((h - zs - u_bandGeom.x) / u_bandGeom.y, 0.0, K - 1.0); // outside the bands: the nearest one
    float k0 = min(floor(pos), K - 2.0);
    float value = mix(band(u, f1, int(k0)), band(u, f1, int(k0) + 1), pos - k0) + 273.15;

    vec3 color = texture(u_lut, vec2(value * u_lutScaleOffset.x + u_lutScaleOffset.y, 0.5)).rgb;
    float nodata = dot(vec4(
        texelFetch(u_nodata, texel(u, 0.0, 0.0), 0).r,
        texelFetch(u_nodata, texel(u, 1.0, 0.0), 0).r,
        texelFetch(u_nodata, texel(u, 0.0, 1.0), 0).r,
        texelFetch(u_nodata, texel(u, 1.0, 1.0), 0).r
    ), w4);
    float opacity = 1.0 - max(sign(nodata - 0.33), 0.0);
    outColor = vec4(mix(vec3(128.0 / 255.0), color, opacity), 1.0);
}`;

export const DRAW_FS = `#version 300 es
precision highp float;
in vec2 p;
uniform sampler2D u_tile; // the coloured render tile, RGBA8 256², LINEAR
out vec4 outColor;
void main() {
    outColor = vec4(texture(u_tile, p).rgb, 1.0);
}`;
