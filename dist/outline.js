/**
 * Rounded outline around a set of rectangles.
 *
 * Panes separated by a corridor do not touch, so their plain union falls apart
 * into one loop per pane. Grow each rect by `pad` first: at `pad >= gap / 2` the
 * grown rects meet on the corridor centre line and the union closes into one
 * shape. That is the whole trick — the outline is derived from the pane borders,
 * pushed outward by exactly the margin every pane already owns.
 *
 * Every right angle is drawn as an arc, convex corners concentric with the pane
 * radius and reflex corners at the pad radius.
 */
const key = (x, y) => `${Math.round(x * 100) / 100},${Math.round(y * 100) / 100}`;
/** Boundary of the union of axis-aligned rects, as closed rectilinear loops. */
export function unionLoops(rects) {
    var _a;
    if (!rects.length)
        return [];
    const gx = [...new Set(rects.flatMap((r) => [r.x, r.x + r.w]))].sort((a, b) => a - b);
    const gy = [...new Set(rects.flatMap((r) => [r.y, r.y + r.h]))].sort((a, b) => a - b);
    const filled = (i, j) => {
        const cx = (gx[i] + gx[i + 1]) / 2;
        const cy = (gy[j] + gy[j + 1]) / 2;
        return rects.some((r) => cx > r.x && cx < r.x + r.w && cy > r.y && cy < r.y + r.h);
    };
    // Emit each filled cell clockwise; an edge shared by two filled cells cancels.
    const live = new Map();
    const edge = (ax, ay, bx, by) => {
        const back = `${key(bx, by)}|${key(ax, ay)}`;
        if (live.has(back))
            live.delete(back);
        else
            live.set(`${key(ax, ay)}|${key(bx, by)}`, [ax, ay, bx, by]);
    };
    for (let i = 0; i < gx.length - 1; i++) {
        for (let j = 0; j < gy.length - 1; j++) {
            if (!filled(i, j))
                continue;
            const [x0, x1, y0, y1] = [gx[i], gx[i + 1], gy[j], gy[j + 1]];
            edge(x0, y0, x1, y0);
            edge(x1, y0, x1, y1);
            edge(x1, y1, x0, y1);
            edge(x0, y1, x0, y0);
        }
    }
    const from = new Map();
    for (const e of live.values()) {
        const k = key(e[0], e[1]);
        const bucket = from.get(k);
        if (bucket)
            bucket.push(e);
        else
            from.set(k, [e]);
    }
    const used = new Set();
    const loops = [];
    for (const seed of live.values()) {
        if (used.has(seed))
            continue;
        const pts = [];
        let e = seed;
        while (e && !used.has(e)) {
            used.add(e);
            pts.push({ x: e[0], y: e[1] });
            e = ((_a = from.get(key(e[2], e[3]))) !== null && _a !== void 0 ? _a : []).find((n) => !used.has(n));
        }
        if (pts.length >= 4)
            loops.push(dropCollinear(pts));
    }
    return loops;
}
function dropCollinear(pts) {
    const out = [];
    for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        const a = pts[(i - 1 + pts.length) % pts.length];
        const b = pts[(i + 1) % pts.length];
        if (Math.abs((p.x - a.x) * (b.y - p.y) - (p.y - a.y) * (b.x - p.x)) > 1e-6)
            out.push(p);
    }
    return out;
}
/** One closed loop as an SVG path with every right angle turned into an arc. */
export function roundedPath(loop, radius, innerRadius) {
    const n = loop.length;
    let d = '';
    let sharp = 0;
    for (let i = 0; i < n; i++) {
        const p = loop[i];
        const a = loop[(i - 1 + n) % n];
        const b = loop[(i + 1) % n];
        const inX = p.x - a.x;
        const inY = p.y - a.y;
        const outX = b.x - p.x;
        const outY = b.y - p.y;
        const lenIn = Math.hypot(inX, inY);
        const lenOut = Math.hypot(outX, outY);
        const turn = inX * outY - inY * outX; // > 0 is convex on a clockwise loop
        const r = Math.min(turn > 0 ? radius : innerRadius, lenIn / 2, lenOut / 2);
        d += `${i === 0 ? 'M' : 'L'}${(p.x - (inX / lenIn) * r).toFixed(2)} ${(p.y - (inY / lenIn) * r).toFixed(2)}`;
        if (r > 0.5) {
            d +=
                `A${r.toFixed(2)} ${r.toFixed(2)} 0 0 ${turn > 0 ? 1 : 0} ` +
                    `${(p.x + (outX / lenOut) * r).toFixed(2)} ${(p.y + (outY / lenOut) * r).toFixed(2)}`;
        }
        else {
            sharp++;
        }
    }
    return { d: `${d}Z`, corners: n, sharp };
}
/**
 * Outline binding a set of rects into one shape.
 *
 * With `pad` at half the corridor the rects meet exactly and you get a single
 * loop; below that they stay apart and you get one loop each, which is a useful
 * signal rather than a failure.
 */
export function outline(rects, options = {}) {
    var _a, _b, _c;
    const pad = (_a = options.pad) !== null && _a !== void 0 ? _a : 0;
    const radius = (_b = options.radius) !== null && _b !== void 0 ? _b : pad;
    const innerRadius = (_c = options.innerRadius) !== null && _c !== void 0 ? _c : Math.max(4, pad);
    const grown = rects.map((r) => ({ x: r.x - pad, y: r.y - pad, w: r.w + pad * 2, h: r.h + pad * 2 }));
    const loops = unionLoops(grown);
    const parts = loops.map((l) => roundedPath(l, radius, innerRadius));
    return {
        path: parts.map((p) => p.d).join(' '),
        loops,
        corners: parts.reduce((n, p) => n + p.corners, 0),
        sharp: parts.reduce((n, p) => n + p.sharp, 0),
    };
}
/** Even-odd point test against a set of loops. */
export function contains(loops, x, y) {
    let inside = false;
    for (const loop of loops) {
        for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
            const a = loop[i];
            const b = loop[j];
            if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x)
                inside = !inside;
        }
    }
    return inside;
}
