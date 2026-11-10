// Standard Web Mercator helpers, normalised to [0,1] world units with y
// growing southward -- the same convention XYZ tile x/y use.

export function mercatorX(lng: number): number {
    return (lng + 180) / 360;
}

export function mercatorY(lat: number): number {
    const rad = (lat * Math.PI) / 180;
    return (1 - Math.log(Math.tan(Math.PI / 4 + rad / 2)) / Math.PI) / 2;
}

export function tileXYToLngLat(x: number, y: number, z: number): { lng: number; lat: number } {
    const n = 2 ** z;
    const lng = (x / n) * 360 - 180;
    const yFrac = y / n;
    const lat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * yFrac))) * 180) / Math.PI;
    return { lng, lat };
}
