/**
 * One deliberate defect per promise the README makes.
 *
 * A mutation run flips operators and finds what no test is watching. This is
 * the other direction: each entry removes a behaviour the library states, and
 * the suite must fail. A break that survives names a promise nothing holds the
 * code to — and unlike a mutant, there is no arguing it is equivalent, because
 * the behaviour is gone.
 *
 * `find` must appear in the built file exactly as written, and exactly once.
 * When a break stops applying, the code moved: read it and either follow the
 * code or delete the entry, but do not leave it silently unapplied. When it
 * applies twice, it removes two behaviours and reports one result for both, so
 * a site nothing watches is reported as caught on the strength of another:
 * anchor it to the site it names, or write one entry per site.
 */
export const BREAKS = [
  {
    id: "state",
    what: "toJSON leaves the payload behind",
    file: "dist/soksak.js",
    find: "cards: this.list.map((c) => ({ ...c })),",
    to: "cards: this.list.map(({ data, ...c }) => ({ ...c })),",
  },
  {
    id: "frozen",
    what: "cards hands back the grid's own objects",
    file: "dist/soksak.js",
    find: "return this.list.map((c) => Object.freeze({ ...c }));",
    to: "return this.list;",
  },
  {
    id: "lines",
    what: "lines hands back the live array",
    file: "dist/soksak.js",
    find: "return [...(axis === 'x' ? this.xs : this.ys)];",
    to: "return axis === 'x' ? this.xs : this.ys;",
  },
  {
    id: "slicing",
    what: "isSlicing returns true for anything",
    file: "dist/slicing.js",
    find: "export function isSlicing(list, memo = new Map()) {",
    to: "export function isSlicing(list, memo = new Map()) {\n    return true;",
  },
  {
    id: "boundary",
    what: "hasBoundary returns true for any index",
    file: "dist/soksak.js",
    find: "return Number.isInteger(line) && line >= 1 && line <= this.arr(axis).length - 2;",
    to: "return true;",
  },
  {
    id: "insert-size",
    what: "insertAt takes a size the plane cannot hold",
    file: "dist/soksak.js",
    find: "|| init.size < 0 || init.size >= plane)",
    to: "|| init.size < 0)",
  },
  {
    id: "one-slot",
    what: "setSize writes onto a card spanning two slots",
    file: "dist/soksak.js",
    find: "if (px !== null && (!Number.isFinite(px) || px < 0 || spanOf(card, axis) !== 1))",
    to: "if (px !== null && (!Number.isFinite(px) || px < 0))",
  },
  {
    id: "gap-guard",
    what: "the gap setter takes anything",
    file: "dist/soksak.js",
    find: "set gap(px) {\n        if (!Number.isFinite(px) || px < 0)\n            return;",
    to: "set gap(px) {",
  },
  {
    id: "border",
    what: "merging drops the plane's border instead of the interior line",
    file: "dist/soksak.js",
    find: "const [keep, drop] = border(line) ? [line, found] : [found, line];",
    to: "const [keep, drop] = [found, line];",
  },
  {
    id: "spanning",
    what: "mergeCoincident folds a pair a card stands between",
    file: "dist/soksak.js",
    find: "if (this.list.some((c) => at(c, lo) === at(c, hi)))\n            return false;",
    to: ";",
  },
  {
    id: "corridor",
    what: "a starved slot eats the corridor instead of stopping at it",
    file: "dist/geometry.js",
    find: "                size[i] = corridor[i];\n                room -= corridor[i];",
    to: "                size[i] = 0;\n                room -= corridor[i];",
  },
  {
    id: "starve-run",
    what: "a stop takes one slot of a run, so a line no card reads decides how much room it releases",
    file: "dist/geometry.js",
    find: "for (let i = runFrom[starved]; i < runTo[starved]; i++) {",
    to: "for (let i = runFrom[starved]; i < starved + 1; i++) {",
  },
  {
    id: "place",
    what: "the view draws every card in the corner with no size",
    file: "dist/dom.js",
    find: "function place(el, rect) {",
    to: "function place(el, rect) {\n    rect = { x: 0, y: 0, w: 0, h: 0 };",
  },
  {
    id: "drag-way",
    what: "a pointer drag runs the wrong way",
    file: "dist/dom.js",
    // Anchored by the line that closes the pointermove listener. The mouse path
    // moves the boundary with the same text, and the shorter find patched both.
    find:
      "this.grid.moveBoundary(drag.axis, drag.line, drag.base + (now - drag.from)), el));\n" +
      "        });",
    to:
      "this.grid.moveBoundary(drag.axis, drag.line, drag.base - (now - drag.from)), el));\n" +
      "        });",
  },
  {
    id: "drag-way-mouse",
    what: "a mouse drag runs the wrong way",
    file: "dist/dom.js",
    find:
      "this.grid.moveBoundary(drag.axis, drag.line, drag.base + (now - drag.from)), el));\n" +
      "        };",
    to:
      "this.grid.moveBoundary(drag.axis, drag.line, drag.base - (now - drag.from)), el));\n" +
      "        };",
  },
  {
    id: "sweep",
    what: "a swept divider keeps its drag and takes everyone else's",
    file: "dist/dom.js",
    // Named down to `forget`. `held` reads the same map with the same text, so
    // the shorter find patched that too and reported on a site it does not name.
    find: "for (const [pointer, drag] of [...this.drags])\n            if (drag.on === el)",
    to: "for (const [pointer, drag] of [...this.drags])\n            if (drag.on !== el)",
  },
  {
    id: "sweep-held",
    what: "held reports a divider a pointer holds as free",
    file: "dist/dom.js",
    find: "for (const drag of this.drags.values())\n            if (drag.on === el)",
    to: "for (const drag of this.drags.values())\n            if (drag.on !== el)",
  },
  {
    id: "hidden-host",
    what: "a host that reports no size is measured as nothing",
    file: "dist/dom.js",
    find: "if (host.clientWidth <= 0 || host.clientHeight <= 0)",
    to: "if (host.clientWidth < 0 || host.clientHeight < 0)",
  },
  {
    id: "radius",
    what: "outline turns every corner the same way",
    file: "dist/outline.js",
    find: "${turn > 0 ? 1 : 0} ",
    to: "${1} ",
  },
  {
    id: "bleed",
    what: "a rule bleeds past the end a card stops it at",
    file: "dist/dom.js",
    find: "const head = rule.x <= EDGE ? bleed : 0;",
    to: "const head = bleed;",
  },
  {
    id: "gap-reversible",
    what: "a gap change re-fits the slots instead of re-expressing them, and does not come back",
    file: "dist/soksak.js",
    find: "    set gap(px) {",
    to: "    set gap(px) {\n        const was = this.list.length ? slotWidths(this.plane, 'y') : null;\n        if (was) { this.plane.gap = px; this.setSlotWidths('y', was); this.changed(); return; }",
  },
  {
    id: "range-here",
    what: "the range a boundary can move within leaves out where it stands",
    file: "dist/soksak.js",
    find: "        const at = along[line];",
    to: "        const at = min;",
  },
  {
    id: "middle-lines",
    what: "centring halves the two lines beside the boundary, not the two cards",
    file: "dist/soksak.js",
    find: "        let start = -Infinity;\n        let end = Infinity;",
    to: "        let start = along[line - 1];\n        let end = along[line + 1];",
  },
  {
    id: "no-flex",
    what: "a drag on an axis where nothing flexes folds the line onto the one before it",
    file: "dist/soksak.js",
    find: "                if (usable <= EPS)\n                    break;",
    to: "                if (usable <= EPS) {\n                    a[line] = clamp(a[line - 1], a[line - 1], a[line + 1]);\n                    break;\n                }",
  },
  {
    id: "named-paid",
    what: "the slot a settle names is not the slot that pays",
    file: "dist/soksak.js",
    find: "            if (this.fits(axis) && this.namedKept(axis, want))",
    to: "            if (this.fits(axis))",
  },
  {
    id: "border-span",
    what: "a card that went in at the plane's border returns nothing",
    file: "dist/soksak.js",
    find: "                    : card[lo] === 0",
    to: "                    : false",
  },
  {
    id: "border-span-far",
    what: "a card standing against the plane's far border returns nothing",
    file: "dist/soksak.js",
    find: "                        : card[hi] === this.arr(axis).length - 1",
    to: "                        : false",
  },
  {
    id: "insert-line",
    what: "canInsertAt answers for the line one past the end of the axis",
    file: "dist/soksak.js",
    find: "if (!Number.isInteger(line) || line < 0 || line > a.length - 1)",
    to: "if (!Number.isInteger(line) || line < 0 || line > a.length)",
  },
  {
    id: "zero-width-corridor",
    what: "a slot named at nothing is given a corridor, so a run of coincident lines comes apart",
    file: "dist/soksak.js",
    find: "asked > EPS ? corridorWhenWide : corridorOf",
    to: "corridorWhenWide",
  },
  {
    id: "blank-corridor",
    what: "a slot standing at zero width is asked what it holds now, not what it will hold once wide",
    file: "dist/geometry.js",
    find: "    let lo = slot === 0 || !read.has(slot) ? 0 : half;",
    to: "    let lo = inset(plane, axis, slot, 'lo', read);",
  },
  {
    id: "inside-out",
    what: "a grab area over coincident lines is drawn with a negative length",
    file: "dist/geometry.js",
    find: "                const run = Math.max(0, end - start);",
    to: "                const run = end - start;",
  },
  {
    id: "one-pass",
    what: "a drag converts px into span once, so it lands short while a slot is stopped",
    file: "dist/soksak.js",
    find: "            for (let pass = 0; pass < 8; pass++) {\n                // Only the sharing slots hold normalised width, so convert against those.",
    to: "            for (let pass = 0; pass < 1; pass++) {\n                // Only the sharing slots hold normalised width, so convert against those.",
  },
  {
    id: "rule-gap",
    what: "a rule is extended by the gap of the other axis",
    file: "dist/geometry.js",
    find: "        const half = halfCorridor(plane, down);",
    to: "        const half = halfCorridor(plane, axis);",
  },
  {
    id: "span-side",
    what: "a closed card's line comes off the side its width came from, not its span",
    file: "dist/soksak.js",
    find: "                const from = paid.span === 'lo' || paid.span === 'hi'",
    to: "                const from = false",
  },
  {
    id: "pool-paid",
    what: "a card the sharing slots paid for gives its width to one slot",
    file: "dist/soksak.js",
    find: "this.settleOn(axis, want, paid.to === '' ? [] : order(first, want.length));",
    to: "this.settleOn(axis, want, order(first, want.length));",
  },
  {
    id: "took-back",
    what: "a span taken from every slot is not given back to every slot",
    file: "dist/soksak.js",
    find: "if (paid.span === 'all' && took < 1 - EPS) {",
    to: "if (false) {",
  },
  {
    id: "one-sided",
    what: "a boundary that cannot move without redrawing a third card reports a range",
    file: "dist/soksak.js",
    find: "            if ((declared[line - 1] !== null) !== (declared[line] !== null)) {",
    to: "            if (false) {",
  },
  {
    id: "span-share",
    what: "a sharing span is rewritten counting the corridor the slot holds",
    file: "dist/soksak.js",
    find: "        const share = (i) => holds ? size[i] : Math.max(0, size[i] - corridorOf(plane, axis, i, read));",
    to: "        const share = (i) => size[i];",
  },
  {
    id: "from-line",
    what: "a drag is converted from the line before it, so the corridor is scaled with the span",
    file: "dist/soksak.js",
    find: "                const off = target - this.boundaryPos(axis, line);",
    to: "                const off = target - linePositions(this.plane, axis)[line - 1];",
  },
  {
    id: "stale-hold",
    what: "a press with a pointer already down leaves the divider it held marked",
    file: "dist/dom.js",
    find: "            if ((_a = this.drop(e.pointerId)) === null || _a === void 0 ? void 0 : _a.moved)\n                lastTap = -Infinity;",
    to: "            ;",
  },
  {
    id: "stale-pair",
    what: "a drag dropped by a press with the same pointer leaves the pair armed",
    file: "dist/dom.js",
    find: "            if ((_a = this.drop(e.pointerId)) === null || _a === void 0 ? void 0 : _a.moved)\n                lastTap = -Infinity;",
    to: "            this.drop(e.pointerId);",
  },
  {
    id: "renumbered",
    what: "a drag that passes a line no card reads loses the element it holds",
    file: "dist/dom.js",
    find: "        this.refile(dividers, step);",
    to: "        ;",
  },
  {
    id: "carry-others",
    what: "a change renumbers the drag that made it and leaves every other drag on the old line",
    file: "dist/dom.js",
    find: "            const stands = drag.on === on ? at : was[i];",
    to: "            if (drag.on !== on)\n                return;\n            const stands = at;",
  },
  {
    id: "nearest-line",
    what: "a renumbered drag matches its boundary by an exact position and misses it by a rounding",
    file: "dist/dom.js",
    find: "                const off = Math.abs(this.grid.boundaryPos(drag.axis, k) - stands);",
    to: "                const off = this.grid.boundaryPos(drag.axis, k) === stands ? 0 : Infinity;",
  },
  {
    id: "refile-order",
    what: "refile files one element at a time, so one wants the key another has not left",
    file: "dist/dom.js",
    find: "        for (const { was } of moving)\n            this.dividerEls.delete(was);\n        for (const { drag } of moving) {",
    to: "        for (const { drag, was } of moving) {\n            this.dividerEls.delete(was);",
  },
  {
    id: "carry-anchor",
    what: "a change carries the line of every other gesture but not its press anchor",
    file: "dist/dom.js",
    find: "                drag.base += this.grid.boundaryPos(drag.axis, line) - was[i];",
    to: "                ;",
  },
  {
    id: "refile-held",
    what: "a gesture takes the key another gesture holds, and that other gesture loses its divider",
    file: "dist/dom.js",
    find: "                if (d.axis !== drag.axis || d.line !== drag.line || this.holding(d.key))",
    to: "                if (d.axis !== drag.axis || d.line !== drag.line)",
  },
  {
    id: "across-length",
    what: "re-filing measures the stretch an element covers by the width it is grabbed at",
    file: "dist/dom.js",
    find: "    const end = start + Number.parseFloat(axis === 'x' ? el.style.height : el.style.width);",
    to: "    const end = start + Number.parseFloat(axis === 'x' ? el.style.width : el.style.height);",
  },
  {
    id: "across-most",
    what: "re-filing takes a stretch it merely reaches rather than the one it covers most",
    file: "dist/dom.js",
    find: "    return Math.min(end, hi) - Math.max(start, lo);",
    to: "    return Math.max(end, hi) - Math.max(start, lo);",
  },
  {
    id: "host-renumber",
    what: "a change the host makes renumbers a gesture's line, and the gesture drives the boundary that number now names",
    file: "dist/dom.js",
    find: "        if (reason === 'render')\n            this.settle();",
    to: "        ;",
  },
  {
    id: "across-start",
    what: "re-filing measures an overlap from the earlier of the two starts, so a stretch the element does not reach counts as covered",
    file: "dist/dom.js",
    find: "    return Math.min(end, hi) - Math.max(start, lo);",
    to: "    return Math.min(end, hi) - Math.min(start, lo);",
  },
  {
    id: "refile-most",
    what: "re-filing takes the first stretch an element touches rather than the one it covers most",
    file: "dist/dom.js",
    find: "                if (over > best) {",
    to: "                if (over > 0 && !to) {",
  },
  {
    id: "settle-pair",
    what: "a gesture the settle ends leaves the press that moved the boundary armed as the first of a pair",
    file: "dist/dom.js",
    find: "        if (drag.moved)\n            (_a = this.disarms.get(drag.on)) === null || _a === void 0 ? void 0 : _a();",
    to: "        ;",
  },
  {
    id: "resize-settle",
    what: "a resize carries a gesture over a change the host made, so the settle at the host's render finds no distance left to measure",
    file: "dist/dom.js",
    find: "                this.settle();\n                // A resize moves the boundary",
    to: "                // A resize moves the boundary",
  },
  {
    id: "settle-reach",
    what: "a gesture ends over a change smaller than the width its divider is grabbed at",
    file: "dist/dom.js",
    find: "        const reach = Math.max(this.grid.gap, this.grid.grabSize);",
    to: "        const reach = Math.min(this.grid.gap, this.grid.grabSize);",
  },
  {
    id: "move-settle",
    what: "a pointer move drives the boundary a change the host has not drawn renumbered onto its line",
    file: "dist/dom.js",
    find: "            this.settle();\n            if (this.drags.get(e.pointerId) !== drag)\n                return;",
    to: "            ;",
  },
  {
    id: "mouse-move-settle",
    what: "a mouse move drives the boundary a change the host has not drawn renumbered onto its line",
    file: "dist/dom.js",
    find: "            this.settle();\n            if (this.mouseDrag !== drag)\n                return;",
    to: "            ;",
  },
  {
    id: "press-stands",
    what: "a press takes hold of the boundary the line its divider carries names, wherever the host has since moved that boundary",
    file: "dist/dom.js",
    find: "            if (!this.stands(el, axis, line))\n                return;\n            // A press with this pointer already down is a press the release of which",
    to: "            // A press with this pointer already down is a press the release of which",
  },
  {
    id: "mouse-press-stands",
    what: "a mouse press takes hold of the boundary the line its divider carries names, wherever the host has since moved that boundary",
    file: "dist/dom.js",
    find: "            if (!this.stands(el, axis, line))\n                return;\n            // A press with one already held is a press the release of which was never",
    to: "            // A press with one already held is a press the release of which was never",
  },
  {
    id: "key-stands",
    what: "a key drives the boundary the line its divider carries names, wherever the host has since moved that boundary",
    file: "dist/dom.js",
    find: "            if (!this.stands(el, axis, line))\n                return;\n            // The record is set before the change runs, because that is when the line",
    to: "            // The record is set before the change runs, because that is when the line",
  },
  {
    id: "stands-reach",
    what: "a press takes no hold across a change smaller than the width its divider is grabbed at",
    file: "dist/dom.js",
    find: "        return off <= Math.max(this.grid.gap, this.grid.grabSize);",
    to: "        return off <= Math.min(this.grid.gap, this.grid.grabSize);",
  },
  {
    id: "stands-drawing",
    what: "a press is refused while the host holds a draw of the view's own change",
    file: "dist/dom.js",
    find: "        if (this.drawing)\n            return true;",
    to: "        ;",
  },
  {
    id: "refile-gone",
    what: "a drag whose boundary is gone leaves its element in the host",
    file: "dist/dom.js",
    find: "                this.forget(drag.on);\n                continue;",
    to: "                continue;",
  },
  {
    id: "forget-mouse",
    what: "a divider that is gone leaves its mouse listeners on the document driving the boundary",
    file: "dist/dom.js",
    find: "        (_a = this.mouseDisposers.get(el)) === null || _a === void 0 ? void 0 : _a();",
    to: "        ;",
  },
  {
    id: "refile-taken",
    what: "a gesture cannot take the key an element nothing holds sits on",
    file: "dist/dom.js",
    find: "                if (d.axis !== drag.axis || d.line !== drag.line || this.holding(d.key))",
    to: "                if (d.axis !== drag.axis || d.line !== drag.line || this.dividerEls.has(d.key))",
  },
  {
    id: "refile-exact",
    what: "refile takes the stretch across the line only where it matches exactly",
    file: "dist/dom.js",
    find: "    return Math.min(end, hi) - Math.max(start, lo);",
    to: "    return start === lo && end === hi ? 1 : 0;",
  },
  {
    id: "key-hold",
    what: "a key does not hold the divider it is changing",
    file: "dist/dom.js",
    find: "        if (this.pressed)\n            live.push(this.pressed);",
    to: "        ;",
  },
  {
    id: "centre-line",
    what: "centring measures the next boundary up after it drops a line",
    file: "dist/soksak.js",
    find: "            while (line > 1 && this.boundaryPos(axis, line) !== at)\n                line--;",
    to: "            ;",
  },
  {
    id: "drag-resize",
    what: "a resize under a drag leaves the drag holding the position on the old plane",
    file: "dist/dom.js",
    find: "                    drag.base += this.grid.boundaryPos(drag.axis, drag.line) - was[i];",
    to: "                    ;",
  },
  {
    id: "second-finger",
    what: "a second finger on a held divider centres the boundary",
    file: "dist/dom.js",
    find: "            if (((_b = this.drags.get(tapId)) === null || _b === void 0 ? void 0 : _b.on) !== el && e.timeStamp - lastTap < DOUBLE_TAP_MS) {",
    to: "            if (e.timeStamp - lastTap < DOUBLE_TAP_MS) {",
  },
  {
    id: "still-marked",
    what: "a divider another pointer still holds stops carrying data-dragging",
    file: "dist/dom.js",
    // Anchored to the pointer drop. `dropMouse` marks with the same text, and
    // the shorter find patched both.
    find: "            /* the pointer may already be gone */\n        }\n        this.mark(drag.on);",
    to:
      "            /* the pointer may already be gone */\n        }\n" +
      "        delete drag.on.dataset.dragging;",
  },
  {
    id: "still-marked-mouse",
    what: "a divider a pointer still holds stops carrying data-dragging when the mouse lets go",
    file: "dist/dom.js",
    find: "        this.mouseDrag = null;\n        this.mark(drag.on);",
    to: "        this.mouseDrag = null;\n        delete drag.on.dataset.dragging;",
  },
  {
    id: "unread-rule",
    what: "a line no card reads is drawn as a rule",
    file: "dist/geometry.js",
    find: "            if (isVirtual(plane, axis, line, read))\n                continue;",
    to: "            ;",
  },
  {
    id: "lost-release",
    what: "a press after a drag whose release was lost centres the boundary",
    file: "dist/dom.js",
    find: "            if ((_a = this.dropMouse()) === null || _a === void 0 ? void 0 : _a.moved)\n                lastPress = -Infinity;",
    to: "            this.dropMouse();",
  },
  {
    id: "placed",
    what: "a card is given no position, so the rect the view writes places nothing",
    file: "dist/dom.js",
    // One entry per element the view positions. The rule and the grab area are
    // positioned with the same text, and the shorter find patched all three.
    find: "                const el = this.options.createCard(card);\n                el.style.position = 'absolute';",
    to: "                const el = this.options.createCard(card);",
  },
  {
    id: "placed-rule",
    what: "a rule is given no position, so the rect the view writes places nothing",
    file: "dist/dom.js",
    find: "                    el.style.position = 'absolute';",
    to: "                    ;",
  },
  {
    id: "placed-divider",
    what: "a grab area is given no position, so the rect the view writes places nothing",
    file: "dist/dom.js",
    find: "        el.className = `${this.prefix}-divider`;\n        el.style.position = 'absolute';",
    to: "        el.className = `${this.prefix}-divider`;",
  },
  {
    id: "grab-keys",
    what: "the grab area takes no focus, so no key reaches it",
    file: "dist/dom.js",
    find: "el.tabIndex = 0;",
    to: ";",
  },
  {
    id: "grab-touch",
    what: "a touch on the grab area scrolls the page instead of dragging",
    file: "dist/dom.js",
    find: "el.style.touchAction = 'none';",
    to: ";",
  },
  {
    id: "rule-press",
    what: "a rule takes the press meant for the card under it",
    file: "dist/dom.js",
    find: "el.style.pointerEvents = 'none';",
    to: ";",
  },
  {
    id: "edge-range",
    what: "zoneAt takes a negative edge, so no point is ever on a side",
    file: "dist/geometry.js",
    find: "Number.isFinite(asked) && asked >= 0 && asked <= 0.5",
    to: "Number.isFinite(asked) && asked <= 0.5",
  },
  {
    id: "edge-widest",
    what: "zoneAt refuses the widest band it documents, so 0.5 falls back to the default",
    file: "dist/geometry.js",
    find: "Number.isFinite(asked) && asked >= 0 && asked <= 0.5",
    to: "Number.isFinite(asked) && asked >= 0 && asked < 0.5",
  },
  {
    id: "chrome-size",
    what: "zoneAt takes a negative chrome height, so the body starts outside the card",
    file: "dist/geometry.js",
    find: "const size = (px) => Number.isFinite(px) && px >= 0 ? px : 0;",
    to: "const size = (px) => Number.isFinite(px) ? px : 0;",
  },
  {
    id: "gone-commit",
    what: "a destroyed view still tells the host where its cards are going",
    file: "dist/dom.js",
    find: "    draw(reason) {",
    to: "    draw(reason) {\n        this.disposed = false;",
  },
  {
    id: "pair-armed",
    what: "a drag whose release was never delivered leaves the double press armed",
    file: "dist/dom.js",
    find: "                if (this.endMouse())\n                    lastPress = -Infinity;\n                return;",
    to: "                this.endMouse();\n                return;",
  },
  {
    id: "pair-total",
    what: "a drag changes what every other declared slot is drawn at",
    file: "dist/soksak.js",
    find: "if (!holdsSizes(this.plane, axis) && asked > EPS) {",
    to: "if (false) {",
  },
  {
    id: "kept-slots",
    what: "a card that leaves by giving up its slots redraws the slots that stay",
    file: "dist/soksak.js",
    find: "const kept = held.filter((_, i) => i < from || i >= from + count);",
    to: "const kept = held.filter((_, i) => i < from || i > from + count);",
  },
  {
    id: "line-order",
    what: "a rewrite of the slot widths leaves the line array out of order",
    file: "dist/soksak.js",
    find: "            if (a[i] > a[i + 1])\n                a[i] = a[i + 1];",
    to: "            ;",
  },
  {
    id: "paid-back",
    what: "a card closed at a boundary gives its size to the other side",
    file: "dist/soksak.js",
    // Re-anchored: the line it hooked on was a guard that could not be reached,
    // and it went. The behaviour under test is the whole path, not that line.
    find: "                const gone = from === 'lo' ? card[lo] : card[hi];",
    to: "                const gone = from === 'lo' ? card[lo] : card[hi];\n                if (true)\n                    continue;",
  },
  {
    id: "range-end",
    what: "a drag to the end of the range is refused by one rounding",
    file: "dist/geometry.js",
    find: "if (sharedSpan > 1e-9 && room - (asked - now + drawn) - taken >= floor - 1e-9)",
    to: "if (sharedSpan > 1e-9 && room - (asked - now + drawn) - taken >= floor)",
  },
  {
    id: "passed-it",
    what: "a drag keeps a step that landed further from the target than it stood",
    file: "dist/soksak.js",
    find: "                if (Math.abs(target - this.boundaryPos(axis, line)) > Math.abs(off)) {",
    to: "                if (false) {",
  },
  {
    id: "no-span-left",
    what: "a pool too small for the tolerance is read as none, so the room a stop released lands nowhere",
    file: "dist/geometry.js",
    find: "const each = room / pool;",
    to: "const each = pool > 1e-9 ? room / pool : 0;",
  },
  {
    id: "resize-rewrite",
    what: "a resize rewrites a declared size instead of drawing it at the new scale",
    file: "dist/soksak.js",
    find: "this.w = width;\n        this.h = height;",
    to: "this.w = width;\n        this.h = height;\n        for (const c of this.list ?? []) {\n            if (c.width !== undefined && c.width > width)\n                c.width = width;\n            if (c.height !== undefined && c.height > height)\n                c.height = height;\n        }",
  },
  {
    id: "settle-payer",
    what: "the settle judges a card no choice of slot can widen, so no slot beside the boundary ever pays",
    file: "dist/soksak.js",
    find: "            if (!shares)\n                continue;",
    to: "            ;",
  },
  {
    id: "centre-range",
    what: "a centring measures the range again after every move, so it walks outside the one it reported",
    file: "dist/soksak.js",
    find: "const middle = clamp(this.middleOf(axis, line), low, high);",
    to: "const middle = this.middleOf(axis, line);",
  },
  {
    id: "flex-rate",
    what: "a cut is measured against a slot that does not flex with its span",
    file: "dist/soksak.js",
    find: "        return sharePerSpan(this.plane, axis);",
    to: "        const a = this.arr(axis); const sizes = slotSizes(this.plane, axis); const held = heldSizes(this.plane, axis); let px = 0; let span = 0; for (let i = 0; i < sizes.length; i++) { if (held[i] !== null) continue; px += sizes[i]; span += a[i + 1] - a[i]; } return span > EPS ? px / span : 0;",
  },
  {
    id: "all-zero",
    what: "an axis where every declared size is zero leaves the plane uncovered",
    file: "dist/geometry.js",
    find: "    if (asked <= 1e-9) {",
    to: "    if (false) {",
  },
  {
    id: "snap-off",
    what: "a drag snaps although snapping is off or the caller refused it",
    file: "dist/soksak.js",
    find: "if (allowSnap && this.snap !== 'off') {",
    to: "if (true) {",
  },
  {
    id: "span-size",
    what: "a card that comes to span two slots keeps the px size it declared",
    file: "dist/soksak.js",
    find: "if (card.width !== undefined && card.c1 - card.c0 !== 1)",
    to: "if (false)",
  },
  {
    id: "crossings-axis",
    what: "crossings counts the lines a card spans across on one axis only",
    file: "dist/soksak.js",
    find: "return Math.max(0, card.c1 - card.c0 - 1) + Math.max(0, card.r1 - card.r0 - 1);",
    to: "return Math.max(0, card.c1 - card.c0 - 1);",
  },
  {
    id: "made-up-axis",
    what: "lines answers for an axis that is not one",
    file: "dist/soksak.js",
    // Named down to `lines`. The guard is written the same way in three methods,
    // so the shorter text patched all three at once and the entry reported on a
    // site it does not name.
    find: "    lines(axis) {\n        if (this.noAxis(axis))\n            return [];",
    to: "    lines(axis) {\n        if (false)\n            return [];",
  },
  {
    id: "centre-reason",
    what: "a centring by a second tap is reported as a drag",
    file: "dist/dom.js",
    // One entry per gesture that centres. The mouse path and the key path draw
    // with the same text, and the shorter find patched all three.
    find:
      "                lastTap = -Infinity;\n" +
      "                this.carry(() => this.grid.centerBoundary(axis, line), el);\n" +
      "                this.draw('center');",
    to:
      "                lastTap = -Infinity;\n" +
      "                this.carry(() => this.grid.centerBoundary(axis, line), el);\n" +
      "                this.draw('drag');",
  },
  {
    id: "centre-reason-mouse",
    what: "a centring by a second mouse press is reported as a drag",
    file: "dist/dom.js",
    find:
      "                lastPress = -Infinity;\n" +
      "                this.carry(() => this.grid.centerBoundary(axis, line), el);\n" +
      "                this.draw('center');",
    to:
      "                lastPress = -Infinity;\n" +
      "                this.carry(() => this.grid.centerBoundary(axis, line), el);\n" +
      "                this.draw('drag');",
  },
  {
    id: "centre-reason-key",
    what: "a centring by Enter or Space is reported as a drag",
    file: "dist/dom.js",
    find: "                    this.draw('center');",
    to: "                    this.draw('drag');",
  },
  {
    id: "watch-host",
    what: "the view watches the host although it was told not to",
    file: "dist/dom.js",
    find: "if (options.observeResize !== false && typeof ResizeObserver !== 'undefined')",
    to: "if (typeof ResizeObserver !== 'undefined')",
  },
  {
    id: "grip",
    what: "the sheet declares the tokens and draws nothing with them",
    file: "dist/theme.js",
    // Anchored to the rule that draws the grip, at the start of a line. The
    // `prefers-reduced-motion` block names the same selector indented, and the
    // shorter find patched that too — a site the suite does not watch, reported
    // as caught on the strength of this one. That site is `reduced-motion`.
    find: "\n.${prefix}-divider::after {",
    to: "\n.${prefix}-nothing::after {",
  },
  {
    id: "reduced-motion",
    what: "the grip goes on animating where the person asked for no motion",
    file: "dist/theme.js",
    find:
      "@media (prefers-reduced-motion: reduce) {\n" +
      "  .${prefix}-divider::after {\n" +
      "    transition: none;\n" +
      "  }\n" +
      "}\n",
    to: "",
  },
  {
    id: "in-order",
    what: "split writes a line before the one it follows",
    file: "dist/soksak.js",
    find: "const value = Math.min(Math.max(cut.value, a[line - 1]), a[line]);",
    to: "const value = a[line - 1] - 1e-3;",
  },
  {
    id: "starved",
    what: "a slot a card spans past is charged the corridor it holds",
    file: "dist/geometry.js",
    find: "if (first >= 0 && fixed + span * each < need - 1e-9) {",
    to: "if (first >= 0 && (a[first + 1] - a[first]) * each < corridor[first] - 1e-9) {",
  },
  {
    id: "seam",
    what: "two edges a rounding apart leave a seam between two cards",
    file: "dist/outline.js",
    find: "if (!out.length || v - out[out.length - 1] > 0.01 + 1e-9)",
    to: "if (true)",
  },
  {
    id: "range-line",
    what: "boundaryRange answers for a line that carries no boundary",
    file: "dist/soksak.js",
    find: "if (!this.hasBoundary(axis, line))\n            return [0, 0];",
    to: "if (false)\n            return [0, 0];",
  },
  {
    id: "scaled-size",
    what: "a drag declares the size the plane drew, not the size that draws it",
    file: "dist/geometry.js",
    find: "export function declaredFor(plane, axis, slot, drawn) {",
    to: "export function declaredFor(plane, axis, slot, drawn) {\n    return drawn;",
  },
  {
    id: "centre-scaled",
    what: "centring moves once and does not check where the boundary landed",
    file: "dist/soksak.js",
    find: "let at = this.boundaryPos(axis, line);\n        for (let pass = 0; pass < 8; pass++) {",
    to: "let at = this.boundaryPos(axis, line);\n        for (let pass = 0; pass < 1; pass++) {",
  },
  {
    id: "pixel-grid",
    what: "the view places on whole units whatever the display draws",
    file: "dist/dom.js",
    find: "return typeof dpr === 'number' && dpr > 0 ? 1 / dpr : 1;",
    to: "return 1;",
  },
  {
    id: "commit-rects",
    what: "commit reports the grid's rects rather than the ones the render writes",
    file: "dist/dom.js",
    find: "on.set(id, onGrid(rect, step));",
    to: "on.set(id, rect);",
  },
  {
    id: "grab",
    what: "the grab area ignores grabSize, so a zero gap cannot be grabbed",
    file: "dist/geometry.js",
    find: "const hit = Math.max(plane.gap, grabSize);",
    to: "const hit = plane.gap;",
  },
];
