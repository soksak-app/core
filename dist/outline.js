/**
 * Outline of a set of rects.
 *
 * `outline` returns the path around one or more rects, padded and rounded, as
 * a list of loops and an SVG path string. Adjacent rects give one loop;
 * separated rects give one loop each.
 */
/**
 * Grid lines and vertex keys read the same coordinates. Rounding only the keys
 * merged two vertices while leaving two grid lines, which cut the loop apart.
 */
const snap = (v) => Math.round(v * 100) / 100;
const key = (x, y) => `${snap(x)},${snap(y)}`;
/** Boundary of the union of axis-aligned rects, as closed rectilinear loops. */
export function unionLoops(rects) {
    var _a;
    const box = rects
        .map((r) => ({ x0: snap(r.x), y0: snap(r.y), x1: snap(r.x + r.w), y1: snap(r.y + r.h) }))
        .filter((b) => b.x1 > b.x0 && b.y1 > b.y0);
    if (!box.length)
        return [];
    const gx = [...new Set(box.flatMap((b) => [b.x0, b.x1]))].sort((a, b) => a - b);
    const gy = [...new Set(box.flatMap((b) => [b.y0, b.y1]))].sort((a, b) => a - b);
    const filled = (i, j) => {
        const cx = (gx[i] + gx[i + 1]) / 2;
        const cy = (gy[j] + gy[j + 1]) / 2;
        return box.some((b) => cx > b.x0 && cx < b.x1 && cy > b.y0 && cy < b.y1);
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
