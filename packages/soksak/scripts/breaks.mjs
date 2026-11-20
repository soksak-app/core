/**
 * One deliberate defect per promise the layout specification makes.
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
    id: "cut-gaps",
    what: "a cut is drawn without the corridors between its kids",
    file: "dist/soksak.js",
    find: "        const free = room - (node.kids.length - 1) * unit[axis] - ",
    to: "        const free = room - ",
  },
  {
    id: "remove-ratio",
    what: "a remove gives the share of the card to the other kids in equal parts, not by one factor",
    file: "dist/cuts.js",
    find: "        kid.share *= (free + share) / free;",
    to: "        kid.share += share / taking.length;",
  },
  {
    id: "remove-fixed",
    what: "a remove scales the fraction of a fixed card",
    file: "dist/cuts.js",
    find: "const taking = holder.kids.filter((kid) => !(isCard(kid.node) && kid.node.fixed));",
    to: "const taking = holder.kids;",
  },
  {
    id: "fixed-kid",
    what: "a close keeps the share of a sibling cut that holds a fixed card",
    file: "dist/soksak.js",
    find: "return isCard(node) && node.fixed === true;",
    to: "return cardsOf(node).some((leaf) => leaf.fixed);",
  },
  {
    id: "add-held",
    what: "an add where every kid beside it holds a px size gives the new card no fraction",
    file: "dist/cuts.js",
    find: "const even = isEven(into, input) || paying.length === 0;",
    to: "const even = isEven(into, input);",
  },
  {
    id: "add-alone",
    what: "an add on an uneven level takes the span from every kid",
    file: "dist/cuts.js",
    find: "const even = isEven(into, input) || paying.length === 0;",
    to: "const even = true;",
  },
  {
    id: "add-even",
    what: "an add on an even level takes the span from the kid beside it alone",
    file: "dist/cuts.js",
    find: "const even = isEven(into, input) || paying.length === 0;",
    to: "const even = paying.length === 0;",
  },
  {
    id: "run-level",
    what: "an add beside a run of kids wraps the run in a cut of its own",
    file: "dist/cuts.js",
    find: "    if (level.cut === axis)\n        return { holder: level, first, last };\n",
    to: "",
  },
  {
    id: "no-payer",
    what: "a state that records a payer is read",
    file: "dist/tree.js",
    find: "    if ('paidBy' in state)",
    to: "    if (false)",
  },
  {
    id: "state",
    what: "toJSON leaves the payload behind",
    file: "dist/tree.js",
    find: "    if (node.data !== undefined)\n        out.data = node.data;\n    if (node.width",
    to: "    if (node.width",
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
    id: "boundary",
    what: "hasBoundary returns true for any index",
    file: "dist/soksak.js",
    find: "return Number.isInteger(line) && line >= 1 && line <= this.arr(axis).length - 2;",
    to: "return true;",
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
    id: "corridor",
    what: "a card is drawn over the corridor at its near line instead of stopping at it",
    file: "dist/geometry.js",
    find: "    const near = axle.at[lo] + axle.lo[lo] + framesLo * axle.unit;",
    to: "    const near = axle.at[lo] + framesLo * axle.unit;",
  },
  {
    id: "cost-clamp",
    what: "a kid whose fraction is less than the costs inside it is drawn below them",
    file: "dist/soksak.js",
    find: "                    sizes[i] = costs[i];\n                    rest -= costs[i];",
    to: "                    sizes[i] = 0;\n                    rest -= costs[i];",
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
      "this.boundary.move(drag.axis, drag.line, drag.base + (now - drag.from)), el));\n        });",
    to:
      "this.boundary.move(drag.axis, drag.line, drag.base - (now - drag.from)), el));\n        });",
  },
  {
    id: "drag-way-mouse",
    what: "a mouse drag runs the wrong way",
    file: "dist/dom.js",
    find:
      "this.boundary.move(drag.axis, drag.line, drag.base + (now - drag.from)), el));\n        };",
    to:
      "this.boundary.move(drag.axis, drag.line, drag.base - (now - drag.from)), el));\n        };",
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
    find: "if (host.clientWidth > 0 && host.clientHeight > 0) {",
    to: "if (host.clientWidth >= 0 && host.clientHeight >= 0) {",
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
    find: "            const stale = this.drop(e.pointerId);\n            if (stale === null || stale === void 0 ? void 0 : stale.moved)\n                this.disarm(stale.on);",
    to: "            ;",
  },
  {
    id: "stale-pair",
    what: "a drag dropped by a press with the same pointer leaves the pair armed",
    file: "dist/dom.js",
    find: "            const stale = this.drop(e.pointerId);\n            if (stale === null || stale === void 0 ? void 0 : stale.moved)\n                this.disarm(stale.on);",
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
    find: "        if (host)\n            this.settle();",
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
    find: "        if (drag.moved)\n            this.disarm(drag.on);",
    to: "        ;",
  },
  {
    id: "settle-reach",
    what: "a gesture ends over a change smaller than the width its divider is grabbed at",
    file: "dist/dom.js",
    find: "        const reach = Math.max(this.grid.gap, this.grid.grabSize);",
    to: "        const reach = Math.min(this.grid.gap, this.grid.grabSize);",
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
    find: "        if (this.drawing && (!this.renumbered || this.holds().some((drag) => drag.on === el))) {\n            return true;\n        }",
    to: "        ;",
  },
  {
    id: "render-reason-settle",
    what: "a render the host names a reason of its own for settles no gesture, so only the word render reaches one",
    file: "dist/dom.js",
    find: "    render(reason = 'render') {\n        this.draw(reason, true);\n    }",
    to: "    render(reason = 'render') {\n        this.draw(reason, reason === 'render');\n    }",
  },
  {
    id: "drawing-host-draw",
    what: "a draw the host is holding of the host's own change counts as one of the view's, so a press takes hold of the boundary the change renumbered onto the line its divider carries",
    file: "dist/dom.js",
    find: "        this.drawing = !host;",
    to: "        this.drawing = true;",
  },
  {
    id: "stale-pair-divider",
    what: "a press disarms the divider it landed on rather than the one the drag it dropped was on, so a drag another divider's press dropped leaves its own pair armed",
    file: "dist/dom.js",
    find: "            const stale = this.drop(e.pointerId);\n            if (stale === null || stale === void 0 ? void 0 : stale.moved)\n                this.disarm(stale.on);",
    to: "            const stale = this.drop(e.pointerId);\n            if (stale === null || stale === void 0 ? void 0 : stale.moved)\n                lastTap = -Infinity;",
  },
  {
    id: "lost-release-divider",
    what: "a mouse press disarms the divider it landed on rather than the one the drag it dropped was on, so a drag another divider's press dropped leaves its own pair armed",
    file: "dist/dom.js",
    find: "            const stale = this.dropMouse();\n            if (stale === null || stale === void 0 ? void 0 : stale.moved)\n                this.disarm(stale.on);",
    to: "            const stale = this.dropMouse();\n            if (stale === null || stale === void 0 ? void 0 : stale.moved)\n                lastPress = -Infinity;",
  },
  {
    id: "stands-renumbered",
    what: "a press takes hold of the line its divider carries although a change the host is holding the draw of renumbered it away",
    file: "dist/dom.js",
    find: "        if (this.drawing && (!this.renumbered || this.holds().some((drag) => drag.on === el))) {\n            return true;\n        }",
    to: "        if (this.drawing) {\n            return true;\n        }",
  },
  {
    id: "press-line-of",
    what: "a press reads the line off the element rather than off the gesture holding it, so a second finger drives the boundary the renumber moved onto that number",
    file: "dist/dom.js",
    find: "        const held = this.holds().find((drag) => drag.on === el);\n        return held ? held.line : Number(el.dataset.line);",
    to: "        return Number(el.dataset.line);",
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
    id: "drag-resize",
    what: "a resize under a drag leaves the drag holding the position on the old plane",
    file: "dist/dom.js",
    find: "            drag.base += this.grid.boundaryPos(drag.axis, drag.line) - was[i];",
    to: "            ;",
  },
  {
    id: "second-finger",
    what: "a second finger on a held divider centres the boundary",
    file: "dist/dom.js",
    find: "            if (((_a = this.drags.get(tapId)) === null || _a === void 0 ? void 0 : _a.on) !== el && e.timeStamp - lastTap < DOUBLE_TAP_MS) {",
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
    id: "merge-reason-mouse",
    what: "a fold a mouse release performs is reported as a drag",
    file: "dist/dom.js",
    find:
      "        this.draw(merged ? 'merge' : 'drag');\n" +
      "        return drag.moved;\n" +
      "    }\n" +
      "    /**\n" +
      "     * End a drag and report whether it moved the boundary.",
    to:
      "        this.draw('drag');\n" +
      "        return drag.moved;\n" +
      "    }\n" +
      "    /**\n" +
      "     * End a drag and report whether it moved the boundary.",
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
    find: "            const stale = this.dropMouse();\n            if (stale === null || stale === void 0 ? void 0 : stale.moved)\n                this.disarm(stale.on);",
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
    id: "card-id",
    what: "a card element is not marked with the id of the card it draws",
    file: "dist/dom.js",
    find: "                el.dataset.cardId = card.id;\n",
    to: "",
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
    find: "    draw(reason, host = false) {",
    to: "    draw(reason, host = false) {\n        this.disposed = false;",
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
    find: "        if (own !== null && other !== null) {",
    to: "        if (false) {",
  },
  {
    id: "line-order",
    what: "a rewrite of the slot widths leaves the line array out of order",
    file: "dist/soksak.js",
    find: "            if (a[i] > a[i + 1])\n                a[i] = a[i + 1];",
    to: "            ;",
  },
  {
    id: "passed-it",
    what: "a drag keeps a step that landed further from the target than it stood",
    file: "dist/soksak.js",
    find: "                if (Math.abs(target - this.boundaryPos(axis, line)) > Math.abs(off)) {",
    to: "                if (false) {",
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
    what: "the last kid of a cut ends where the sizes end, so an axis where every declared size is zero leaves the plane uncovered",
    file: "dist/soksak.js",
    find: "const end = last ? slot[hi] : sizes ? at + size + u / 2 : at + size;",
    to: "const end = sizes ? at + size + (last ? 0 : u / 2) : at + size;",
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
      "                lastTap = -Infinity;\n                this.carry(() => this.boundary.center(axis, line), el);\n                this.draw('center');",
    to:
      "                lastTap = -Infinity;\n                this.carry(() => this.boundary.center(axis, line), el);\n                this.draw('drag');",
  },
  {
    id: "centre-reason-mouse",
    what: "a centring by a second mouse press is reported as a drag",
    file: "dist/dom.js",
    find:
      "                lastPress = -Infinity;\n                this.carry(() => this.boundary.center(axis, line), el);\n                this.draw('center');",
    to:
      "                lastPress = -Infinity;\n                this.carry(() => this.boundary.center(axis, line), el);\n                this.draw('drag');",
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
    find: "return options.observeResize !== false && observerAvailable;",
    to: "return observerAvailable;",
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
    id: "insert-fits",
    what: "an insert that takes a card below minSize is kept rather than undone",
    file: "dist/soksak.js",
    // Anchored to the insert by its indent: the split undoes itself with the same
    // check one level less deep.
    find: "            this.keepFixed(drawnBefore);\n            if (!this.stillFits(axis, was, empty)) {\n                this.restore(undo);\n                return null;\n            }\n",
    to: "            this.keepFixed(drawnBefore);\n",
  },
  {
    id: "split-fits",
    what: "a split that takes another card below the size it has is kept rather than undone",
    file: "dist/soksak.js",
    find: "if (!this.stillFits(axis, was, empty) || (whole === null && drawn < this.min - 0.01)) {",
    to: "if (whole === null && drawn < this.min - 0.01) {",
  },
  {
    id: "fits-min",
    what: "the check a change runs reads no card's size, so a change may take one below minSize",
    file: "dist/soksak.js",
    find: "            if (now < Math.min(this.min, was) - 0.01)\n                return false;",
    to: "            ;",
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
    id: "centre-scaled",
    what: "centring moves once and does not check where the boundary landed",
    file: "dist/soksak.js",
    find: "            for (let pass = 0; pass < 8 && this.hasBoundary(axis, line); pass++) {",
    to: "            for (let pass = 0; pass < 1 && this.hasBoundary(axis, line); pass++) {",
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
  {
    id: "stands-inside",
    what: "a card standing inside a gap refuses every split, travel and insert",
    file: "dist/soksak.js",
    find: "            if (flat.has(c.id))\n                return true;\n",
    to: "",
  },
  {
    id: "boundary-axis",
    what: "hasBoundary answers for an axis that is not one",
    file: "dist/soksak.js",
    find: "    hasBoundary(axis, line) {\n        if (this.noAxis(axis))\n            return false;\n",
    to: "    hasBoundary(axis, line) {\n",
  },
  {
    id: "fill-fixed",
    what: "a fixed card can be closed",
    file: "dist/soksak.js",
    find: "if (!card || card.fixed)",
    to: "if (!card)",
  },
  {
    id: "grip-active",
    what: "the grip keeps its resting colour while the divider is hovered, focused or held",
    file: "dist/theme.js",
    find:
      "\n.${prefix}-divider:hover::after,\n" +
      ".${prefix}-divider:focus-visible::after,\n" +
      ".${prefix}-divider[data-dragging]::after {\n" +
      "  background: var(--${prefix}-grip-active);\n" +
      "}\n",
    to: "\n",
  },
  {
    id: "spanning-size",
    what: "a card that came to span two slots keeps the px size it declared",
    file: "dist/soksak.js",
    find: "            if (card.width !== undefined && card.c1 - card.c0 !== 1)\n                delete card.width;\n",
    to: "",
  },
  {
    id: "run-at-border",
    what: "a run of coincident lines reaching the plane's border is inset as if it met a card",
    file: "dist/geometry.js",
    find: "        slot += step;\n    if (slot < 0 || slot > a.length - 2)\n        return 0;\n    return corridor(plane, axis, read) / 2;\n",
    to: "        slot += step;\n    return corridor(plane, axis, read) / 2;\n",
  },
  {
    id: "no-area",
    what: "a change that leaves a card with no area is kept",
    file: "dist/soksak.js",
    find: "        // Every card must have a non-zero area, including one just created.\n        if (!this.hasArea(flat))\n            return false;\n",
    to: "        // Every card must have a non-zero area, including one just created.\n",
  },
  {
    id: "settle-declared",
    what: "the settle names a slot holding a px size as the one that paid",
    file: "dist/soksak.js",
    find: "            // that holds a px size is skipped here.\n            if (held[slot] !== null)\n                continue;\n",
    to: "            // that holds a px size is skipped here.\n",
  },
  {
    id: "mouse-move-others",
    what: "a mouse move drives the held drag once for every divider on the plane",
    file: "dist/dom.js",
    find: "        const mouseMove = (e) => {\n            const drag = this.mouseDrag;\n            if (this.disposed || !drag || drag.on !== el)\n                return;\n",
    to: "        const mouseMove = (e) => {\n            const drag = this.mouseDrag;\n            if (this.disposed || !drag)\n                return;\n",
  },
  {
    id: "key-unhandled",
    what: "a key the view does not handle is swallowed and reported as a drag",
    file: "dist/dom.js",
    find: "            const step = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[e.key];\n            if (step === undefined)\n                return;\n",
    to: "            const step = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[e.key];\n",
  },
  {
    id: "no-flex-cut",
    what: "a cut is measured on an axis where nothing flexes, so a card no width can be taken from is split",
    file: "dist/soksak.js",
    find: "        const per = own !== null ? own / (a[card[hi]] - a[card[lo]] || 1) : this.sharedExtent(axis);\n        if (per <= EPS)\n            return null;\n",
    to: "        const per = own !== null ? own / (a[card[hi]] - a[card[lo]] || 1) : this.sharedExtent(axis);\n",
  },
  {
    id: "cancel-elsewhere",
    what: "a release or cancel delivered to another divider ends the drag this one holds",
    file: "dist/dom.js",
    find: "        const stop = (e) => {\n            var _a;\n            if (((_a = this.drags.get(e.pointerId)) === null || _a === void 0 ? void 0 : _a.on) !== el)\n                return;\n",
    to: "        const stop = (e) => {\n            var _a;\n",
  },
];
