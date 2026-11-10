// GLSL ES 3.00 (WebGL2 only, as Windy's map renders with WebGL2). One
// quad per drawn tile, in Mercator pixel space (docs/windy-integration.md); geometry is
// positioned via u_matrix + u_quadBounds, sampling is Windy's corner-registered
// 257x257 tile grid.

export const VERTEX_SHADER = `#version 300 es
in vec2 aLocal;
uniform mat4 u_matrix;
uniform vec4 u_quadBounds; // x0,y0,x1,y1 in Mercator pixel space (worldSize = 512 * 2^zoom)
out vec2 p;
void main() {
    p = aLocal;
    vec2 world = vec2(mix(u_quadBounds.x, u_quadBounds.z, aLocal.x), mix(u_quadBounds.y, u_quadBounds.w, aLocal.y));
    gl_Position = u_matrix * vec4(world, 0.0, 1.0);
}`;

// Isotherm mode (u_mode == 1). Algorithm: docs/freezing-mask-algorithm.md §5, §6.4
export const FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec2 p;
uniform sampler2D u_tile;
uniform float u_min;
uniform float u_step;
uniform float u_from;
uniform float u_to;
uniform float u_opacity;
uniform int u_mode;         // 0: elevation range, 1: freezing level
uniform sampler2D u_F;      // effective freezing level tile (RGBA16F), r: F_min, g: F_max (m; Instant: both F), b: nodata (1)
uniform int u_iso;          // 0: Instant and Max (g), 1: Min (r), 2: Both
uniform float u_bandOpacity; // Both: between F_min and F_max
uniform float u_lineWidth;  // Both: the line along F_max, px
uniform vec3 u_d0rect;      // maps p into the deg0 tile: q = u_d0rect.xy + p * u_d0rect.z
uniform bool u_allNodata;   // the deg0 tile has no data at all (outside a regional model)
uniform float u_offset;
uniform bool u_debugRaw;
uniform bool u_debugBorders;
out vec4 outColor;

void main() {
    // Corner-registered 257x257 grid: pixel k sits at
    // k/256 of the tile, the +0.5/257 fixup lands exactly on grid points.
    vec2 uv = (p * 256.0 + 0.5) / 257.0;
    float r = texture(u_tile, uv).r;
    float h = u_min + u_step * 255.0 * r;
    vec4 result;
    if (u_debugRaw) {
        float t = clamp(h / 8850.0, 0.0, 1.0);
        result = vec4(vec3(t), 1.0);
    } else if (u_mode == 1) {
        vec2 q = u_d0rect.xy + p * u_d0rect.z;
        vec2 uvD = (q * 256.0 + 0.5) / 257.0;          // corner-registered 257 grid
        vec3 Fs = texture(u_F, uvD).rgb;               // r: F_min, g: F_max (m), b: nodata
        float fMax = Fs.g + u_offset;
        float f = u_iso == 0 ? fMax : Fs.r + u_offset; // the full-dimming edge
        float w = max(fwidth(h - f), 1.0);
        float frozen = smoothstep(-w, w, h - f);       // 1 above freezing level + offset
        float dim = u_opacity * (1.0 - frozen);
        if (u_iso == 2) {
            // Both: full below F_min, the band up to F_max, clear above it, and a line along F_max
            float wMax = max(fwidth(h - fMax), 1.0);
            float stayed = smoothstep(-wMax, wMax, h - fMax);
            float px = abs(h - fMax) / max(fwidth(h - fMax), 1e-3);
            float line = 1.0 - smoothstep(u_lineWidth * 0.5 - 0.5, u_lineWidth * 0.5 + 0.5, px);
            dim = max(mix(u_opacity, u_bandOpacity * (1.0 - stayed), frozen), u_opacity * line);
        }
        float a = u_allNodata ? u_opacity
                : Fs.b > 0.5 ? u_opacity               // no model data here (outside a regional model)
                : h <= 0.0 ? u_opacity                 // sea / below sea level: always dimmed
                : dim;
        result = vec4(0.0, 0.0, 0.0, a);
    } else {
        float w = max(fwidth(h), 1.0); // anti-aliased edges
        float inBand = smoothstep(u_from - w, u_from + w, h)
                     * (1.0 - smoothstep(u_to - w, u_to + w, h));
        result = vec4(0.0, 0.0, 0.0, u_opacity * (1.0 - inBand)); // black, premultiplied
    }
    if (u_debugBorders) {
        vec2 e = max(fwidth(p), vec2(0.001)) * 1.5;
        if (p.x < e.x || p.x > 1.0 - e.x || p.y < e.y || p.y > 1.0 - e.y) {
            result = vec4(1.0, 0.0, 0.0, 1.0);
        }
    }
    outColor = result;
}`;
