/**
 * Colour arithmetic for the brand reader: parse a CSS colour, convert, measure. Pure.
 *
 * Colours leave here as `#RRGGBB` in upper case, which is what a profile stores (`brand.primary`).
 * Named colours are not read: a brand colour is a number in CSS, and the named ones that matter
 * (white, black, grey) are exactly the ones that are dropped anyway.
 */

export interface Rgb {
    r: number;
    g: number;
    b: number;
}

export interface Hsl {
    /** 0 to 360. */
    h: number;
    /** 0 to 1. */
    s: number;
    /** 0 to 1. */
    l: number;
}

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));
const byte = (n: number): number => Math.round(clamp(n, 0, 255));

export function toHex({ r, g, b }: Rgb): string {
    return `#${[r, g, b].map((v) => byte(v).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}

export function hexToRgb(hex: string): Rgb | null {
    const m = hex.match(/^#([0-9a-f]{6})$/i);
    if (!m) return null;
    const n = parseInt(m[1]!, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function rgbToHsl({ r, g, b }: Rgb): Hsl {
    const rn = r / 255;
    const gn = g / 255;
    const bn = b / 255;
    const max = Math.max(rn, gn, bn);
    const min = Math.min(rn, gn, bn);
    const l = (max + min) / 2;
    const d = max - min;
    if (d === 0) return { h: 0, s: 0, l };
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h: number;
    if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    return { h: h * 60, s, l };
}

export function hslToRgb({ h, s, l }: Hsl): Rgb {
    const hue = (((h % 360) + 360) % 360) / 360;
    if (s === 0) return { r: l * 255, g: l * 255, b: l * 255 };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const channel = (t: number): number => {
        let x = t;
        if (x < 0) x += 1;
        if (x > 1) x -= 1;
        if (x < 1 / 6) return p + (q - p) * 6 * x;
        if (x < 1 / 2) return q;
        if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
        return p;
    };
    return { r: channel(hue + 1 / 3) * 255, g: channel(hue) * 255, b: channel(hue - 1 / 3) * 255 };
}

/** The shortest way round the colour wheel between two hues, 0 to 180 degrees. */
export function hueDistance(a: number, b: number): number {
    const d = Math.abs(((a % 360) + 360) % 360 - (((b % 360) + 360) % 360));
    return d > 180 ? 360 - d : d;
}

/** WCAG 2.x relative luminance. */
export function luminance({ r, g, b }: Rgb): number {
    const lin = (v: number): number => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio of two `#RRGGBB` colours, 1 to 21. */
export function contrastRatio(a: string, b: string): number {
    const ra = hexToRgb(a);
    const rb = hexToRgb(b);
    if (!ra || !rb) return 1;
    const la = luminance(ra);
    const lb = luminance(rb);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const num = (s: string): number => Number.parseFloat(s);

/** One channel of `rgb()`: a number or a percentage. */
const channel = (s: string): number => (s.endsWith('%') ? (num(s) / 100) * 255 : num(s));

/**
 * A CSS colour as `#RRGGBB`, or null. Reads `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()` and `rgba()` (commas
 * or spaces, numbers or percentages), `hsl()` and `hsla()`. A fully transparent colour is null: it paints nothing.
 */
export function parseColour(input: string): string | null {
    const s = input.trim().toLowerCase().replace(/\s*!important$/, '');
    let m = s.match(/^#([0-9a-f]{3,8})$/);
    if (m) {
        const h = m[1]!;
        if (h.length === 3 || h.length === 4) {
            if (h.length === 4 && h[3] === '0') return null;
            return `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`.toUpperCase();
        }
        if (h.length === 6 || h.length === 8) {
            if (h.length === 8 && h.slice(6) === '00') return null;
            return `#${h.slice(0, 6)}`.toUpperCase();
        }
        return null;
    }
    m = s.match(/^rgba?\(\s*([\d.]+%?)\s*[,\s]\s*([\d.]+%?)\s*[,\s]\s*([\d.]+%?)\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/);
    if (m) {
        const alpha = m[4] === undefined ? 1 : m[4].endsWith('%') ? num(m[4]) / 100 : num(m[4]);
        if (alpha === 0) return null;
        const rgb = { r: channel(m[1]!), g: channel(m[2]!), b: channel(m[3]!) };
        return [rgb.r, rgb.g, rgb.b].every(Number.isFinite) ? toHex(rgb) : null;
    }
    m = s.match(/^hsla?\(\s*([\d.]+)(?:deg)?\s*[,\s]\s*([\d.]+)%\s*[,\s]\s*([\d.]+)%\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/);
    if (m) {
        const alpha = m[4] === undefined ? 1 : m[4].endsWith('%') ? num(m[4]) / 100 : num(m[4]);
        if (alpha === 0) return null;
        const hsl = { h: num(m[1]!), s: clamp(num(m[2]!) / 100, 0, 1), l: clamp(num(m[3]!) / 100, 0, 1) };
        return [hsl.h, hsl.s, hsl.l].every(Number.isFinite) ? toHex(hslToRgb(hsl)) : null;
    }
    return null;
}

/** A colour worth being a brand colour: neither grey (saturation under 15%) nor near-white or near-black (lightness outside 8 to 92%). */
export function isBrandable(hex: string): boolean {
    const rgb = hexToRgb(hex);
    if (!rgb) return false;
    const { s, l } = rgbToHsl(rgb);
    return s >= 0.15 && l >= 0.08 && l <= 0.92;
}

/** How far apart two colours are, 0 to 441 (straight-line distance in RGB). */
export function colourDistance(a: string, b: string): number {
    const ra = hexToRgb(a);
    const rb = hexToRgb(b);
    if (!ra || !rb) return Infinity;
    return Math.hypot(ra.r - rb.r, ra.g - rb.g, ra.b - rb.b);
}
