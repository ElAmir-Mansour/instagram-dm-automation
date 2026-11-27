/**
 * Brand → the logo's preparation, all in the browser (Brand Kit Phase 1, contract §6.3). Not a route: `brand.js` loads this module the first
 * time the owner picks a file (`App.loadPageModule('brand_image')`), so a viewer never downloads it.
 *
 *   file (SVG / PNG / JPEG / WebP)  →  canvas  →  trim  →  measure  →  (remove the background)  →  PNG
 *
 * Why here and not on the server: the server decodes no image and stores no SVG (invariant I7). It re-reads the PNG's header and its colour
 * type when the logo is saved (`checkLogoUpload`), and takes the width and height from the file, never from this module's claim. What this
 * module measures that the server only trusts (`alpha`, `tone`, `colour`) decides one thing: whether a small plate sits behind the logo on
 * the tenant's own output. A wrong value costs the tenant a less readable logo, nothing more.
 *
 * Two kinds of function:
 *   - PURE ones take `{ data: Uint8ClampedArray, width, height }` (an `ImageData` has exactly that shape), so the tests run them on
 *     synthetic pixels with no canvas: `trimBounds`, `hasAlpha`, `mainColour`, `tone`, `flatEdges`, `removeBackground`, `whiten`,
 *     `checkSize`, `svgDimensions`, `scaleFor`.
 *   - the ones that touch the DOM (`load`, `imageOf`, `toPng`) are thin: they only move pixels between a canvas and those objects.
 *
 * `mix`, `contrast`, `readableOn`, `brandColours` and `plateFor` are the SAME formulas and constants as the server's `src/services/brand/resolve.ts`
 * (`mix`, `readableOn`, `brandColours`) and the Mac's `src/brand/logo.ts` (`plateFor`), so the preview shows what the render will draw. The nine
 * vectors of contract §5.2 are run through `plateFor` in `src/dashboard/brand.test.ts`.
 *
 * A file that came from a person is never trusted as markup: an SVG is parsed (`DOMParser`), refused when it does not parse or its root is not
 * `<svg>`, and only ever drawn through `<img>`, where it runs no script and fetches nothing (W3C SVG Security). Nothing in it reaches the page's DOM.
 */
const BrandImage = {
    // ─── Limits (the server's, and the contract's) ───────────────────────────
    /** A file bigger than this is refused before it is read. */
    FILE_MAX_BYTES: 10 * 1024 * 1024,
    /** An SVG is text: more than this many characters is not a logo. */
    SVG_MAX_CHARS: 1024 * 1024,
    /** An SVG is drawn this big on its long side, so the PNG is sharp. */
    SVG_LONG_SIDE: 2048,
    /** A raster is read no bigger than this on its long side (the PNG is capped lower still): keeps a phone's memory. */
    RASTER_READ_SIDE: 2048,
    /** The PNG's long side is capped here. */
    LONG_SIDE_CAP: 1600,
    /** The PNG must be at most this many bytes (the server's `PROFILE_LIMITS.logoBytes`). */
    PNG_MAX_BYTES: 3000000,
    /** The shrinking step when the PNG is still too heavy. */
    SHRINK: 0.8,
    MIN_SIDE: 200,
    MIN_ASPECT: 0.25,
    MAX_ASPECT: 8,
    TYPES: ['image/svg+xml', 'image/png', 'image/jpeg', 'image/webp'],

    // ─── The plate rule's constants (src/brand/logo.ts) ──────────────────────
    WORDMARK_ASPECT: 2.5,
    PLATE_PADDING: 0.25,
    PLATE_RADIUS: 0.22,
    PLATE_FOR_DARK_LOGO: '#FFFFFF',
    PLATE_FOR_LIGHT_LOGO: '#0B0B0F',
    MIN_LOGO_CONTRAST: 3,

    DEFAULT_PRIMARY: '#0E3B5C',
    DEFAULT_ACCENT: '#F2A33A',

    /** An error this module throws: `code` is the tail of a `brand.logo.<code>` message, `params` fill its `{placeholders}`. */
    fail(code, params) {
        const err = new Error(code);
        err.logoCode = code;
        if (params) err.params = params;
        return err;
    },

    // ─── Colour arithmetic (resolve.ts, byte for byte) ───────────────────────
    isHex(value) {
        return typeof value === 'string' && /^#[0-9A-F]{6}$/i.test(value);
    },

    safeHex(value, fallback) {
        return this.isHex(value) ? String(value).toUpperCase() : fallback;
    },

    hexToRgb(hex) {
        const n = parseInt(String(hex).slice(1), 16);
        return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    },

    rgbToHex(rgb) {
        return `#${rgb.map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
    },

    /** Per channel `round(a + (b - a) * k)`, `#RRGGBB` upper case. */
    mix(a, b, k) {
        const x = this.hexToRgb(a);
        const y = this.hexToRgb(b);
        return this.rgbToHex(x.map((c, i) => c + (y[i] - c) * k));
    },

    /** WCAG 2.x relative luminance of a `#RRGGBB`. */
    luminance(hex) {
        const lin = (c) => {
            const v = c / 255;
            return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
        };
        const [r, g, b] = this.hexToRgb(hex);
        return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    },

    /** WCAG contrast ratio, 1 to 21. A value that is not `#RRGGBB` reads as 1, like the server's `contrastRatio`. */
    contrast(a, b) {
        if (!this.isHex(a) || !this.isHex(b)) return 1;
        const x = this.luminance(a);
        const y = this.luminance(b);
        return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
    },

    /** The first step of `colour` toward white (0 to 40 steps of 2.5%) that reaches `min` on `background`; white when none does. */
    readableOn(colour, background, min = 4.5) {
        for (let i = 0; i <= 40; i += 1) {
            const next = this.mix(colour, '#FFFFFF', i * 0.025);
            if (this.contrast(next, background) >= min) return next;
        }
        return '#FFFFFF';
    },

    /** What the "use my brand colours" switch gives (resolve.ts `brandColours`). A value that is not hex falls back to the neutral defaults. */
    brandColours(primary, accent) {
        const p = this.safeHex(primary, this.DEFAULT_PRIMARY);
        const a = this.safeHex(accent, this.DEFAULT_ACCENT);
        const carouselInk = this.mix(p, '#000000', 0.82);
        return {
            carouselInk,
            carouselAccent: this.readableOn(a, carouselInk),
            reelAccent: this.readableOn(a, '#08080A'),
            explainerTitle: this.readableOn(a, '#000000'),
        };
    },

    /** 'light' when the colour's relative luminance is above 0.179 (it reads better on black), else 'dark'. */
    tone(hex) {
        return this.luminance(this.safeHex(hex, '#000000')) > 0.179 ? 'light' : 'dark';
    },

    /**
     * The plate rule (contract §5.2; the Mac's `plateFor`): `{ colour }` for the plate behind the logo, or null for none.
     * `background` is the colour directly behind the logo, or null over a picture or a video.
     */
    plateFor(logo, background) {
        if (!logo || logo.alpha !== true) return null;
        const colour = logo.tone === 'dark' ? this.PLATE_FOR_DARK_LOGO : this.PLATE_FOR_LIGHT_LOGO;
        if (background === null || background === undefined) return { colour };
        if (this.contrast(logo.colour, background) >= this.MIN_LOGO_CONTRAST) return null;
        return { colour };
    },

    isWordmark(logo) {
        return logo.width / logo.height >= this.WORDMARK_ASPECT;
    },

    /** Height `height` unless that is wider than `maxWidth`, then exactly `maxWidth` wide; rounded; never stretched. */
    logoBox(logo, height, maxWidth) {
        const width = Math.round((logo.width * height) / logo.height);
        if (width <= maxWidth) return { width, height: Math.round(height) };
        return { width: Math.round(maxWidth), height: Math.round((logo.height * maxWidth) / logo.width) };
    },

    // ─── Pixels: pure ────────────────────────────────────────────────────────
    /** Some pixel is not fully opaque (alpha under 250). */
    hasAlpha(img) {
        const d = img.data;
        for (let i = 3; i < d.length; i += 4) if (d[i] < 250) return true;
        return false;
    },

    /** Do the rgb of pixel `i` (an index into `data`) and `ref` (`[r, g, b]`) differ by no more than `tol` in every channel? */
    near(d, i, ref, tol) {
        return Math.abs(d[i] - ref[0]) <= tol && Math.abs(d[i + 1] - ref[1]) <= tol && Math.abs(d[i + 2] - ref[2]) <= tol;
    },

    /**
     * The box that holds the logo, `{ x, y, width, height }`, or null when nothing is in it. A transparent image: the pixels with alpha
     * of at least 16. An opaque one: the pixels that differ from the top-left pixel by more than `tol` in some channel.
     */
    trimBounds(img, tol = 12) {
        const { data: d, width: w, height: h } = img;
        if (!w || !h) return null;
        const opaque = !this.hasAlpha(img);
        const ref = [d[0], d[1], d[2]];
        let minX = w;
        let minY = h;
        let maxX = -1;
        let maxY = -1;
        for (let y = 0; y < h; y += 1) {
            for (let x = 0; x < w; x += 1) {
                const i = (y * w + x) * 4;
                const inside = opaque ? !this.near(d, i, ref, tol) : d[i + 3] >= 16;
                if (!inside) continue;
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
            }
        }
        if (maxX < 0) return null;
        return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
    },

    /** A copy of `img` cut to `box`. */
    cropImage(img, box) {
        const out = new Uint8ClampedArray(box.width * box.height * 4);
        for (let y = 0; y < box.height; y += 1) {
            const from = ((box.y + y) * img.width + box.x) * 4;
            out.set(img.data.subarray(from, from + box.width * 4), y * box.width * 4);
        }
        return { data: out, width: box.width, height: box.height };
    },

    /**
     * The logo's main colour, `#RRGGBB` upper case: over the pixels with alpha of at least 128, the most frequent 4-bit-per-channel bucket
     * (the lowest bucket wins a tie), and the average of its pixels. `#000000` for an image with no such pixel.
     */
    mainColour(img) {
        const d = img.data;
        const counts = new Uint32Array(4096);
        const sums = new Float64Array(4096 * 3);
        for (let i = 0; i < d.length; i += 4) {
            if (d[i + 3] < 128) continue;
            const key = ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4);
            counts[key] += 1;
            sums[key * 3] += d[i];
            sums[key * 3 + 1] += d[i + 1];
            sums[key * 3 + 2] += d[i + 2];
        }
        let best = -1;
        let bestCount = 0;
        for (let key = 0; key < 4096; key += 1) {
            if (counts[key] > bestCount) { best = key; bestCount = counts[key]; }
        }
        if (best < 0) return '#000000';
        return this.rgbToHex([sums[best * 3] / bestCount, sums[best * 3 + 1] / bestCount, sums[best * 3 + 2] / bestCount]);
    },

    /**
     * The share (0 to 1) of the border pixels within `tol` of the top-left pixel's colour. At least `EDGE_FLAT` means the logo sits on one plain
     * background, which "Remove the background" can lift.
     */
    flatEdges(img, tol = 24) {
        const { data: d, width: w, height: h } = img;
        if (!w || !h) return 0;
        const ref = [d[0], d[1], d[2]];
        let total = 0;
        let flat = 0;
        const look = (x, y) => {
            total += 1;
            if (this.near(d, (y * w + x) * 4, ref, tol)) flat += 1;
        };
        for (let x = 0; x < w; x += 1) { look(x, 0); if (h > 1) look(x, h - 1); }
        for (let y = 1; y < h - 1; y += 1) { look(0, y); if (w > 1) look(w - 1, y); }
        return flat / total;
    },

    EDGE_FLAT: 0.9,

    /**
     * Lift a plain background: a 4-connected flood fill from every border pixel within `tol` of the top-left colour sets alpha to 0, then the
     * result is trimmed. Returns the new image, or null when nothing is left. `img` is not changed.
     */
    removeBackground(img, tol = 24) {
        const { width: w, height: h } = img;
        const d = new Uint8ClampedArray(img.data);
        const ref = [d[0], d[1], d[2]];
        const seen = new Uint8Array(w * h);
        const stack = new Int32Array(w * h);
        let top = 0;
        const push = (x, y) => {
            const p = y * w + x;
            if (seen[p] || !this.near(d, p * 4, ref, tol)) return;
            seen[p] = 1;
            stack[top++] = p;
        };
        for (let x = 0; x < w; x += 1) { push(x, 0); push(x, h - 1); }
        for (let y = 0; y < h; y += 1) { push(0, y); push(w - 1, y); }
        while (top > 0) {
            const p = stack[--top];
            d[p * 4 + 3] = 0;
            const x = p % w;
            const y = (p - x) / w;
            if (x > 0) push(x - 1, y);
            if (x < w - 1) push(x + 1, y);
            if (y > 0) push(x, y - 1);
            if (y < h - 1) push(x, y + 1);
        }
        const cleared = { data: d, width: w, height: h };
        const box = this.trimBounds(cleared);
        return box ? this.cropImage(cleared, box) : null;
    },

    /** Every pixel with any alpha becomes white; the alpha is kept. A copy. */
    whiten(img) {
        const d = new Uint8ClampedArray(img.data);
        for (let i = 0; i < d.length; i += 4) {
            if (d[i + 3] > 0) { d[i] = 255; d[i + 1] = 255; d[i + 2] = 255; }
        }
        return { data: d, width: img.width, height: img.height };
    },

    /** What the server will refuse on size: `{ code, params }`, or null. (Its other limit, 4096 px, never happens: the PNG is capped at 1600.) */
    checkSize(width, height) {
        const short = Math.min(width, height);
        if (short < this.MIN_SIDE) return { code: 'tooSmall', params: { px: short } };
        const aspect = width / height;
        if (aspect < this.MIN_ASPECT || aspect > this.MAX_ASPECT) return { code: 'badShape' };
        return null;
    },

    /** Everything the page shows about an image: size, transparency, main colour and its tone, and whether its background is plain. */
    measure(img) {
        const alpha = this.hasAlpha(img);
        const colour = this.mainColour(img);
        return {
            width: img.width,
            height: img.height,
            alpha,
            colour,
            tone: this.tone(colour),
            flat: !alpha && this.flatEdges(img) >= this.EDGE_FLAT,
        };
    },

    /** The size a PNG of `width` × `height` is drawn at: the long side capped at `LONG_SIDE_CAP`. */
    scaleFor(width, height) {
        const long = Math.max(width, height);
        return long > this.LONG_SIDE_CAP ? this.LONG_SIDE_CAP / long : 1;
    },

    /** `{ w, h }` an SVG is drawn at, from its width and height attributes or its viewBox, long side `SVG_LONG_SIDE`; null when it has no size. */
    svgDimensions(widthAttr, heightAttr, viewBoxAttr) {
        const length = (v) => {
            const m = /^\s*([0-9]*\.?[0-9]+)\s*(px|pt|mm|cm|in|em|rem)?\s*$/i.exec(String(v == null ? '' : v));
            return m ? Number(m[1]) : null;
        };
        let w = length(widthAttr);
        let h = length(heightAttr);
        if (!(w > 0) || !(h > 0)) {
            const box = String(viewBoxAttr == null ? '' : viewBoxAttr).trim().split(/[\s,]+/).map(Number);
            if (box.length !== 4 || !(box[2] > 0) || !(box[3] > 0)) return null;
            w = box[2];
            h = box[3];
        }
        const k = this.SVG_LONG_SIDE / Math.max(w, h);
        return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
    },

    // ─── The DOM: thin ───────────────────────────────────────────────────────
    makeCanvas(width, height) {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        return canvas;
    },

    /** The canvas's pixels as a plain image object. */
    imageOf(canvas) {
        const data = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height);
        return { data: data.data, width: data.width, height: data.height };
    },

    /** A canvas that holds `img`. */
    canvasOf(img) {
        const canvas = this.makeCanvas(img.width, img.height);
        const ctx = canvas.getContext('2d');
        ctx.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
        return canvas;
    },

    /** Draw an `<img>` (already decoded) onto a new canvas of `w` × `h`. */
    drawn(image, w, h) {
        const canvas = this.makeCanvas(w, h);
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(image, 0, 0, w, h);
        return canvas;
    },

    /** An `<img>` from a URL, decoded, or an `unreadable` error. */
    loadImage(url) {
        return new Promise((resolve, reject) => {
            const image = new Image();
            image.onload = () => resolve(image);
            image.onerror = () => reject(this.fail('unreadable'));
            image.src = url;
        });
    },

    /** `file` → a canvas. Throws `fileTooBig` or `unreadable`. */
    async load(file) {
        if (!file || typeof file.size !== 'number') throw this.fail('unreadable');
        if (file.size > this.FILE_MAX_BYTES) throw this.fail('fileTooBig');
        const named = /\.svg$/i.test(String(file.name || ''));
        const type = this.TYPES.includes(file.type) ? file.type : (named ? 'image/svg+xml' : '');
        if (!type) throw this.fail('unreadable');
        return type === 'image/svg+xml' ? this.loadSvg(file) : this.loadRaster(file);
    },

    async loadSvg(file) {
        const text = await file.text();
        if (text.length > this.SVG_MAX_CHARS) throw this.fail('unreadable');
        const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
        const root = doc.documentElement;
        if (!root || doc.getElementsByTagName('parsererror').length > 0 || String(root.localName || root.nodeName).toLowerCase() !== 'svg') {
            throw this.fail('unreadable');
        }
        const size = this.svgDimensions(root.getAttribute('width'), root.getAttribute('height'), root.getAttribute('viewBox'));
        if (!size) throw this.fail('unreadable');
        root.setAttribute('width', String(size.w));
        root.setAttribute('height', String(size.h));
        const blob = new Blob([new XMLSerializer().serializeToString(root)], { type: 'image/svg+xml' });
        const url = URL.createObjectURL(blob);
        try {
            const image = await this.loadImage(url);
            return this.drawn(image, size.w, size.h);
        } finally {
            URL.revokeObjectURL(url);
        }
    },

    async loadRaster(file) {
        const url = URL.createObjectURL(file);
        try {
            const image = await this.loadImage(url);
            const w = image.naturalWidth || image.width;
            const h = image.naturalHeight || image.height;
            if (!w || !h) throw this.fail('unreadable');
            const k = Math.min(1, this.RASTER_READ_SIDE / Math.max(w, h));
            return this.drawn(image, Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k)));
        } finally {
            URL.revokeObjectURL(url);
        }
    },

    /** A canvas cut to `box`. */
    cropCanvas(canvas, box) {
        const out = this.makeCanvas(box.width, box.height);
        out.getContext('2d').drawImage(canvas, box.x, box.y, box.width, box.height, 0, 0, box.width, box.height);
        return out;
    },

    /**
     * A fresh canvas → the trimmed canvas and what is known of it. Throws `unreadable` for a picture with nothing in it (a blank page).
     * `{ canvas, image, stats }`.
     */
    inspect(canvas) {
        let image = this.imageOf(canvas);
        const box = this.trimBounds(image);
        if (!box) throw this.fail('unreadable');
        let out = canvas;
        if (box.width !== image.width || box.height !== image.height) {
            out = this.cropCanvas(canvas, box);
            image = this.imageOf(out);
        }
        return { canvas: out, image, stats: this.measure(image) };
    },

    /** The length in bytes of a base64 string. */
    base64Bytes(b64) {
        const pad = b64.endsWith('==') ? 2 : (b64.endsWith('=') ? 1 : 0);
        return Math.floor((b64.length * 3) / 4) - pad;
    },

    /**
     * A canvas → the PNG to upload: `{ base64, bytes, width, height }`. The long side is capped at 1600; while the PNG is over 3,000,000
     * bytes it is scaled by 0.8 again, as long as the short side stays at least 200, otherwise `tooBig`. `deps.makeCanvas` is for tests.
     */
    toPng(canvas, deps) {
        const make = (deps && deps.makeCanvas) || ((w, h) => this.makeCanvas(w, h));
        const w = canvas.width;
        const h = canvas.height;
        const encode = (scale) => {
            const nw = Math.max(1, Math.round(w * scale));
            const nh = Math.max(1, Math.round(h * scale));
            let target = canvas;
            if (nw !== w || nh !== h) {
                target = make(nw, nh);
                const ctx = target.getContext('2d');
                ctx.imageSmoothingQuality = 'high';
                ctx.drawImage(canvas, 0, 0, nw, nh);
            }
            const url = target.toDataURL('image/png');
            const base64 = url.slice(url.indexOf(',') + 1);
            return { base64, bytes: this.base64Bytes(base64), width: nw, height: nh };
        };
        let scale = this.scaleFor(w, h);
        let out = encode(scale);
        while (out.bytes > this.PNG_MAX_BYTES) {
            scale *= this.SHRINK;
            if (Math.min(Math.round(w * scale), Math.round(h * scale)) < this.MIN_SIDE) throw this.fail('tooBig');
            out = encode(scale);
        }
        return out;
    },
};
