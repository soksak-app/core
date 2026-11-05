package workbench

import (
	"fmt"
	"math"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/egoist/mygo/ui"
	"github.com/soksak-app/core/packages/workbench-mygo/src/layout"
)

// The verification of the drawn plane, the value of the status core.verify. It judges by numbers: it reads the layout model and
// what the window drew, changes nothing, and the rows have the names of the page workbench. Everything that a row reads is a value
// of VerifyInput, so adding a row requires no edit of the shell.

// VerifyRow is a row of the verification. A row that is Skipped had nothing to measure: the status lists it apart from the rows.
type VerifyRow struct {
	Name    string `json:"name"`
	Note    string `json:"note"`
	OK      bool   `json:"ok"`
	Skipped bool   `json:"-"`
}

// VerifyStatus is the value of the status core.verify.
type VerifyStatus struct {
	Failed int         `json:"failed"`
	Rows   []VerifyRow `json:"rows"`
	// Skipped holds the checks that had nothing to measure in this state, which are no pass.
	Skipped []VerifySkipped `json:"skipped"`
}

// VerifySkipped is a check that had nothing to measure, and why.
type VerifySkipped struct {
	Name string `json:"name"`
	Note string `json:"note"`
}

// VerifySurface is a surface of a layout record: where the workbench declared it, where the host applied it, and its state.
type VerifySurface struct {
	ID       string
	Declared layout.Rect
	Applied  layout.Rect
	Visible  bool
	Dim      bool
}

// VerifyRecord is a layout record of the compositor.
type VerifyRecord struct {
	Seq      int
	Surfaces []VerifySurface
	Settled  bool
}

// LatePlacement is how long a placement waits for the answer of the host before the check states it as failed. It is the bound after
// which a window check takes a pending request for stopped (docs/spec/logging.md, stall dumps).
const LatePlacement = 3 * time.Second

// DrawnSurface is the slot of a surface that the plane drew. Card is the card that holds it.
type DrawnSurface struct {
	Frame layout.Rect
	Dim   bool
	Card  string
}

// DropBand is how far the header and the footer of a drop zone reach into a card.
type DropBand struct {
	HeaderPx, FooterPx float64
}

// CardChrome is the drawn box of a card with its head and its foot.
type CardChrome struct {
	Box, Head, Foot layout.Rect
}

// VerifyInput is what the verification reads, in plane coordinates.
type VerifyInput struct {
	Grid *layout.Grid
	// Tabs is the number of tabs of a card.
	Tabs func(card string) int
	// Scale is the number of device pixels of a point, and CardRadius the corner radius of a card.
	Scale, CardRadius float64
	// Outline is the rail outline and RailGroups the rectangles of each of its groups.
	Outline    layout.Outline
	RailGroups [][]layout.Rect
	// Latest and Seated are the last commit and the commit that the host answered.
	Latest, Seated *VerifyRecord
	// Pending tells that the latest commit waits for the native placement answer of the host, and PendingFor for how long.
	Pending    bool
	PendingFor time.Duration
	// Drawn holds the slots of the plane by surface, Cards the drawn box of each card, and Transformed the number of cards that a
	// transform moves.
	Drawn map[string]DrawnSurface
	Cards map[string]layout.Rect
	// Plane is the box of the plane, Pad its margin and Rules the drawn lines.
	Plane layout.Rect
	Pad   float64
	Rules []layout.Rect
	// Band is what the plane passes to the drop zones, Head and Foot the declared heights of those rows, and Chrome the drawn cards.
	Band       DropBand
	Head, Foot float64
	Chrome     []CardChrome
	// Controls is the area of the window buttons, nil when the window has none, and Bar the first row.
	Controls *layout.Rect
	Bar      layout.Rect
}

// maxDelta is the largest difference of two rectangles.
func maxDelta(a, b layout.Rect) float64 {
	return max(math.Abs(a.X-b.X), math.Abs(a.Y-b.Y), math.Abs(a.W-b.W), math.Abs(a.H-b.H))
}

// beyond is how far a goes beyond b at the farthest point: 0 when a is inside b.
func beyond(a, b layout.Rect) float64 {
	if a.W <= 0 || a.H <= 0 {
		return 0
	}
	return max(0, b.X-a.X, b.Y-a.Y, a.X+a.W-(b.X+b.W), a.Y+a.H-(b.Y+b.H))
}

// WholePoints returns the whole points inside r, where a window stands the view of a surface whose slot is r: a web page paints whole
// points only, and a whole point lies on a device pixel at each scale.
func WholePoints(r layout.Rect) layout.Rect {
	left, top := math.Ceil(r.X), math.Ceil(r.Y)
	return layout.Rect{X: left, Y: top, W: max(math.Floor(r.X+r.W)-left, 0), H: max(math.Floor(r.Y+r.H)-top, 0)}
}

// expectedRailLoops adds up the connected clusters of each rail group: two rectangles are connected when both their gaps are at
// most gap (+0.5).
func expectedRailLoops(groups [][]layout.Rect, gap float64) int {
	loops := 0
	for _, group := range groups {
		pending := make(map[int]bool, len(group))
		for index := range group {
			pending[index] = true
		}
		for index := range group {
			if !pending[index] {
				continue
			}
			loops++
			delete(pending, index)
			work := []int{index}
			for len(work) > 0 {
				a := group[work[len(work)-1]]
				work = work[:len(work)-1]
				for other := range pending {
					b := group[other]
					if max(b.X-(a.X+a.W), a.X-(b.X+b.W)) <= gap+.5 && max(b.Y-(a.Y+a.H), a.Y-(b.Y+b.H)) <= gap+.5 {
						delete(pending, other)
						work = append(work, other)
					}
				}
			}
		}
	}
	return loops
}

// isPlace tells whether id is a fixed window sidebar card.
func isPlace(id string) bool { return id == "left" || id == "right" }

// windowSidebarsPlaced checks the drawn width and the place of the window sidebars. The id of a sidebar is its side, so a side holds
// one sidebar at most: it stands in the edge column of that side at full height and does not exceed the stored width.
func windowSidebarsPlaced(grid *layout.Grid) bool {
	columns, rows := len(grid.Lines("x"))-1, len(grid.Lines("y"))-1
	rects := grid.Rects()
	for _, card := range grid.Cards() {
		if !isPlace(card.ID) {
			continue
		}
		fits := card.Width == nil || rects[card.ID].W <= *card.Width+.5
		edge := card.C0 == 0
		if card.ID == "right" {
			edge = card.C1 == columns
		}
		if !fits || !card.Fixed || card.R0 != 0 || card.R1 != rows || !edge {
			return false
		}
	}
	return true
}

// surfaceComparison is what comparing a record with the drawn slots found.
type surfaceComparison struct {
	worst        float64
	at           string
	dim          int
	gone, missed []string
}

func frameText(r layout.Rect) string { return fmt.Sprintf("%.2f,%.2f %.2f×%.2f", r.X, r.Y, r.W, r.H) }

// named is the ids of a list, sorted, so a failure names the surfaces that it counts.
func named(ids []string) string {
	if len(ids) == 0 {
		return ""
	}
	slices.Sort(ids)
	return " [" + strings.Join(ids, ", ") + "]"
}

// compare compares surfaces with the slots of the plane. It counts the surfaces that are only in the record and the surfaces that
// are only in the plane together: a record that overlaps nothing passes because nothing overlaps, not because it is correct.
func compare(in VerifyInput, surfaces []VerifySurface) surfaceComparison {
	var out surfaceComparison
	told := make(map[string]bool, len(surfaces))
	for _, surface := range surfaces {
		told[surface.ID] = true
		slot, ok := in.Drawn[surface.ID]
		if !ok {
			out.gone = append(out.gone, surface.ID)
			continue
		}
		if delta := maxDelta(slot.Frame, surface.Declared); delta > out.worst {
			out.worst = delta
			out.at = fmt.Sprintf(" · %s drawn %s declared %s", surface.ID, frameText(slot.Frame), frameText(surface.Declared))
			// The drawn card and the place of the surface in it tell whether the difference comes from the size of the card or from the
			// layout inside the card.
			if card, ok := in.Cards[slot.Card]; ok {
				frame := slot.Frame
				out.at += fmt.Sprintf(" · card %s inset %.2f,%.2f,%.2f,%.2f · plane %s · devicePixelRatio %v", frameText(card),
					frame.X-card.X, frame.Y-card.Y, card.X+card.W-frame.X-frame.W, card.Y+card.H-frame.Y-frame.H, frameText(in.Plane), in.Scale)
			}
		}
		if surface.Dim != slot.Dim {
			out.dim++
		}
	}
	for id := range in.Drawn {
		if !told[id] {
			out.missed = append(out.missed, id)
		}
	}
	return out
}

// Verify runs the verification once. A device pixel ratio that is not positive is an error: the rows that read it would judge nothing.
func Verify(in VerifyInput) ([]VerifyRow, error) {
	if !(in.Scale > 0) {
		return nil, fmt.Errorf("verify: the device pixel ratio %v is not a positive number", in.Scale)
	}
	grid := in.Grid
	var rows []VerifyRow
	add := func(name string, ok bool, note string) {
		rows = append(rows, VerifyRow{Name: name, Note: note, OK: ok})
	}
	// skip states a check that has nothing to measure in this state: it is no pass.
	skip := func(name, note string) {
		rows = append(rows, VerifyRow{Name: name, Note: note, Skipped: true})
	}
	cards := grid.Cards()
	box := grid.Rects()
	rects := make([]layout.Rect, 0, len(cards))
	for _, card := range cards {
		rects = append(rects, box[card.ID])
	}

	railRects := 0
	for _, group := range in.RailGroups {
		railRects += len(group)
	}
	expected, wantSharp := expectedRailLoops(in.RailGroups, grid.Gap()), 0
	if in.CardRadius == 0 {
		wantSharp = in.Outline.Corners
	}
	if len(in.RailGroups) == 0 && len(in.Outline.Loops) == 0 {
		skip("V0 레일 외곽선", "레일이 없다")
	} else {
		add("V0 레일 외곽선", in.Outline.Sharp == wantSharp && len(in.Outline.Loops) == expected,
			fmt.Sprintf("%d/%d개 루프 · %d개 연결 묶음 · %d개 사각형", len(in.Outline.Loops), expected, len(in.RailGroups), railRects))
	}

	// V1: cards that read the same line have exactly the same boundary. The far side of a card is x + w, so two cards that end on one
	// line can differ in the last bit of that addition, and the check allows only as much as tells that from a misaligned layout.
	drift, shared := 0.0, 0
	const ulp = 1e-9
	for _, axis := range []layout.Axis{"x", "y"} {
		for line := 1; line < len(grid.Lines(axis))-1; line++ {
			var ends, starts []float64
			for _, card := range cards {
				r := box[card.ID]
				low, high, start, end := card.C0, card.C1, r.X, r.X+r.W
				if axis == "y" {
					low, high, start, end = card.R0, card.R1, r.Y, r.Y+r.H
				}
				if high == line {
					ends = append(ends, end)
				}
				if low == line {
					starts = append(starts, start)
				}
			}
			for _, values := range [][]float64{ends, starts} {
				if len(values) > 1 {
					drift = max(drift, slices.Max(values)-slices.Min(values))
					shared++
				}
			}
		}
	}
	if shared == 0 {
		skip("V1 공유 경계 편차 == 0", "경계를 함께 쓰는 카드가 없다")
	} else {
		add("V1 공유 경계 편차 == 0", drift <= ulp, fmt.Sprintf("최대 %.1epx · 허용 %.0epx · 경계 %d개", drift, ulp, shared))
	}

	// V2: the sum of the slot boxes. A card that lost its place in a plane too small is what the library does, so only a card with a
	// negative side violates the rule; such cards cancel each other in the sum, so they are counted.
	area, inverted := 0.0, 0
	for _, card := range cards {
		area += (grid.BoundaryPos("x", card.C1) - grid.BoundaryPos("x", card.C0)) * (grid.BoundaryPos("y", card.R1) - grid.BoundaryPos("y", card.R0))
	}
	for _, r := range rects {
		if r.W < 0 || r.H < 0 {
			inverted++
		}
	}
	want := grid.Width() * grid.Height()
	note := fmt.Sprintf("Δ %.1fpx²", area-want)
	if inverted > 0 {
		note += fmt.Sprintf(" · 뒤집힌 카드 %d장", inverted)
	}
	add("V2 판이 빈틈없이 덮임", math.Abs(area-want) < 2 && inverted == 0, note)

	// V3: the gap is exactly gap only while the plane has room; a card drawn without sides or gaps that the plane shrinks are the
	// layout of a plane too small, so then the gap only must not be wider.
	worst, overlap, squeezed := math.Inf(1), 0, false
	for i, a := range rects {
		squeezed = squeezed || a.W <= 0 || a.H <= 0
		for _, b := range rects[i+1:] {
			dx, dy := max(b.X-(a.X+a.W), a.X-(b.X+b.W)), max(b.Y-(a.Y+a.H), a.Y-(b.Y+b.H))
			if dx < -0.01 && dy < -0.01 {
				overlap++
				continue
			}
			worst = min(worst, max(dx, dy))
		}
	}
	gap := grid.Gap()
	gapOK := squeezed && worst <= gap+0.5 || !squeezed && math.Abs(worst-gap) < 0.5
	note = fmt.Sprintf("겹침 %d쌍", overlap)
	if overlap == 0 {
		note = fmt.Sprintf("최소 %.1fpx", worst)
		if squeezed {
			note += " · 판이 좁아 통로가 줄었다"
		}
	}
	if overlap == 0 && math.IsInf(worst, 1) {
		skip(fmt.Sprintf("V3 겹침 0 · 통로 %vpx", gap), "카드가 하나뿐이다")
	} else {
		add(fmt.Sprintf("V3 겹침 0 · 통로 %vpx", gap), overlap == 0 && gapOK, note)
	}

	// V4: capturing the state and restoring it gives the same state. A space switch goes through this path, so if they differ the
	// layout changes just by moving between spaces. It rebuilds a copy, so the live plane does not change.
	state := grid.ToJSON()
	minSize, width, height := grid.MinSize(), grid.Width(), grid.Height()
	trip, err := layout.New(&state, layout.Options{Gap: &gap, MinSize: &minSize, Width: &width, Height: &height})
	if err != nil {
		return nil, fmt.Errorf("verify: the captured state does not restore: %w", err)
	}
	rebuilt, smallest := 0.0, math.Inf(1)
	for id, was := range trip.Rects() {
		now, ok := box[id]
		if !ok {
			rebuilt = math.Inf(1)
			continue
		}
		rebuilt = max(rebuilt, maxDelta(was, now))
	}
	for _, r := range rects {
		smallest = min(smallest, r.W, r.H)
	}
	add("V4 담았다 되돌리면 그대로", rebuilt == 0, fmt.Sprintf("사본 %.4fpx · 그려진 최소 변 %.0fpx", rebuilt, smallest))

	add("V5 배치가 slicing", grid.IsSlicing(), "한 영역을 통째로 자른 결과만 가능")

	open, closable := 0, 0
	for _, card := range cards {
		if !card.Fixed {
			open++
			if grid.CanClose(card.ID) {
				closable++
			}
		}
	}
	if open <= 1 {
		skip("V6 마지막 하나 빼고 전부 닫힌다", "열린 카드가 하나뿐이다")
	} else {
		add("V6 마지막 하나 빼고 전부 닫힌다", closable == open, fmt.Sprintf("%d/%d", closable, open))
	}

	const pendingNote = "host placement pending"
	switch {
	case in.Latest == nil:
		skip("V7a element − declared == 0", "아직 커밋 없음")
	case in.Pending && in.PendingFor >= LatePlacement:
		add("V7a element − declared == 0", false, fmt.Sprintf("host placement unanswered for %d ms (seq %d)", in.PendingFor.Milliseconds(), in.Latest.Seq))
	case in.Pending:
		skip("V7a element − declared == 0", pendingNote)
	case len(in.Latest.Surfaces) == 0 && len(in.Drawn) == 0:
		skip("V7a element − declared == 0", "커밋에도 판에도 표면이 없다")
	default:
		found := compare(in, in.Latest.Surfaces)
		seated := "none"
		if in.Seated != nil {
			seated = strconv.Itoa(in.Seated.Seq)
		}
		add("V7a element − declared == 0", len(found.gone) == 0 && len(found.missed) == 0 && found.worst < 0.5 && found.dim == 0,
			fmt.Sprintf("최대 %.2fpx · 커밋에 없는 표면 %d%s · 사라진 표면 %d%s · 흐림이 다른 표면 %d · 0이 아니면 커밋이 뒤처진 것 (seq %d, seated %s, pending %t)%s",
				found.worst, len(found.missed), named(found.missed), len(found.gone), named(found.gone), found.dim, in.Latest.Seq, seated, in.Pending, found.at))
	}

	skip("V7c 미리 게시한 자리 == 그려진 자리", "이 창은 자리를 미리 게시하지 않는다")

	// V7b: the window stands a surface on the whole points inside its declared rectangle, so the applied rectangle is compared with
	// exactly those.
	land, escaped, landed, landedAt := 0.0, 0.0, 0, ""
	if in.Seated != nil {
		for _, surface := range in.Seated.Surfaces {
			if !surface.Visible || surface.Declared.W < 1 || surface.Declared.H < 1 {
				continue
			}
			delta := maxDelta(WholePoints(surface.Declared), surface.Applied)
			if delta > land {
				landedAt = fmt.Sprintf(" · %s declared %s applied %s", surface.ID, frameText(surface.Declared), frameText(surface.Applied))
			}
			land = max(land, delta)
			escaped = max(escaped, beyond(surface.Applied, surface.Declared))
			landed++
		}
	}
	if landed == 0 {
		skip("V7b applied == declared", "아직 답 없음")
	} else {
		state := "갱신 중"
		if in.Seated.Settled {
			state = "정지"
		}
		add("V7b applied == declared", escaped == 0 && land == 0,
			fmt.Sprintf("밖으로 %.2fpx · 차이 %.2fpx · %s (seq %d)%s", escaped, land, state, in.Seated.Seq, landedAt))
	}

	skip("V8 뷰가 transform 을 안 쓴다", "이 창의 카드에는 transform 이 없다")

	// V9: a stroke of the outline that passes inside a card is covered there by the native surface of the card.
	onCard, samples := 0, 0
	for _, loop := range in.Outline.Loops {
		for i, a := range loop {
			b := loop[(i+1)%len(loop)]
			steps := max(1, int(math.Ceil(math.Hypot(b.X-a.X, b.Y-a.Y)/6)))
			for step := 0; step <= steps; step++ {
				samples++
				part := float64(step) / float64(steps)
				x, y := a.X+(b.X-a.X)*part, a.Y+(b.Y-a.Y)*part
				for _, r := range in.Cards {
					if x > r.X+2 && x < r.X+r.W-2 && y > r.Y+2 && y < r.Y+r.H-2 {
						onCard++
						break
					}
				}
			}
		}
	}
	if samples == 0 {
		skip("V9 레일 획이 카드 안을 안 지난다", "레일 획이 없다")
	} else {
		add("V9 레일 획이 카드 안을 안 지난다", onCard == 0, fmt.Sprintf("표본 %d점 중 %d점 침범", samples, onCard))
	}

	// V10: a native surface is not clipped by the card, so a surface larger than the card is drawn outside it.
	escape, standing := 0.0, 0
	if in.Latest != nil {
		for _, surface := range in.Latest.Surfaces {
			card, ok := in.Cards[in.Drawn[surface.ID].Card]
			if !surface.Visible || !ok {
				continue
			}
			standing++
			a := surface.Applied
			escape = max(escape, card.X-a.X, a.X+a.W-(card.X+card.W), card.Y-a.Y, a.Y+a.H-(card.Y+card.H))
		}
	}
	switch {
	case in.Pending:
		skip("V10 표면이 카드를 안 뚫는다", pendingNote)
	case standing == 0:
		skip("V10 표면이 카드를 안 뚫는다", "카드 안에 보이는 표면이 없다")
	default:
		add("V10 표면이 카드를 안 뚫는다", escape <= 0, fmt.Sprintf("최대 %.2fpx · 표면 %d개", escape, standing))
	}

	// R: a line continues from the edge of the plane to the border outside it and no further. It is measured only when the plane has
	// the size that the cards were drawn at: until then the lines are of the earlier size.
	paintedWidth, paintedHeight := 0.0, 0.0
	for _, r := range in.Cards {
		paintedWidth, paintedHeight = max(paintedWidth, r.X+r.W), max(paintedHeight, r.Y+r.H)
	}
	laid := math.Abs(in.Plane.W-paintedWidth) < 0.5 && math.Abs(in.Plane.H-paintedHeight) < 0.5
	past, lines := 0.0, 0
	for _, rule := range in.Rules {
		// A line that is not drawn has size 0 and coordinate 0, which would count as going out by the whole plane.
		if rule.W == 0 && rule.H == 0 {
			continue
		}
		lines++
		past = max(past, in.Plane.X-rule.X, rule.X+rule.W-(in.Plane.X+in.Plane.W), in.Plane.Y-rule.Y, rule.Y+rule.H-(in.Plane.Y+in.Plane.H))
	}
	switch {
	case in.Pending:
		skip("R 선은 판 밖으로 여백까지만 나간다", pendingNote)
	case !laid:
		skip("R 선은 판 밖으로 여백까지만 나간다", "판이 아직 새 크기로 그려지지 않았다")
	case lines == 0:
		skip("R 선은 판 밖으로 여백까지만 나간다", "그려진 선이 없다")
	default:
		add("R 선은 판 밖으로 여백까지만 나간다", past <= in.Pad+0.01, fmt.Sprintf("최대 %.2fpx · 여백 %.2fpx", past, in.Pad))
	}

	// D: the header and the footer of a drop zone end where the drawn head and foot end. A card too low to hold both rows shrinks
	// them, so its drawn rows are not a target to measure.
	bandOff, banded := 0.0, 0
	for _, card := range in.Chrome {
		if card.Head.H < in.Head-0.01 || card.Foot.H < in.Foot-0.01 {
			continue
		}
		bandOff = max(bandOff, math.Abs(card.Head.Y+card.Head.H-card.Box.Y-in.Band.HeaderPx), math.Abs(card.Box.Y+card.Box.H-card.Foot.Y-in.Band.FooterPx))
		banded++
	}
	if banded == 0 {
		skip("D 드롭 구획이 그려진 머리·발에서 끝난다", "머리와 발을 온전히 담은 카드가 없다")
	} else {
		add("D 드롭 구획이 그려진 머리·발에서 끝난다", bandOff < 0.01,
			fmt.Sprintf("최대 %.2fpx · 카드 %d장 · 머리 %.1fpx · 발 %.1fpx", bandOff, banded, in.Band.HeaderPx, in.Band.FooterPx))
	}

	empty := 0
	for _, card := range cards {
		if !isPlace(card.ID) && in.Tabs(card.ID) == 0 {
			empty++
		}
	}
	add("T5 빈 카드 0", empty == 0, fmt.Sprintf("%d/%d 카드가 내용을 가짐", len(cards)-empty, len(cards)))

	places := 0
	for _, card := range cards {
		if isPlace(card.ID) {
			places++
		}
	}
	if places == 0 {
		skip("P 자리는 카드다", "창 사이드바가 없다")
	} else {
		add("P 자리는 카드다", windowSidebarsPlaced(grid), fmt.Sprintf("%d개 창 사이드바 · 가장자리 연속 열 · 저장 폭 상한 · 전체 높이", places))
	}

	// W: the buttons stand at the vertical center of the first row. In full screen the window moves them out of the row, so there is
	// nothing to compare, and AppKit aligns them to device pixels, so an odd remainder differs by one pixel.
	if in.Controls == nil || in.Controls.Y+in.Controls.H > in.Bar.Y+in.Bar.H {
		skip("W 창 단추는 첫 행 가운데", "창 단추가 첫 행에 없다")
	} else {
		above, below := in.Controls.Y-in.Bar.Y, in.Bar.Y+in.Bar.H-(in.Controls.Y+in.Controls.H)
		pixel := 1 / in.Scale
		add("W 창 단추는 첫 행 가운데", math.Abs(above-below) <= pixel,
			fmt.Sprintf("행 %.1fpx · 단추 %.1fpx · 위 %.1f 아래 %.1f · device pixel %.2fpx", in.Bar.H, in.Controls.H, above, below, pixel))
	}
	return rows, nil
}

// DrawnCards reads the box of each card from the element tree of the window, in the coordinates of plane.
func DrawnCards(tree []ui.ElementNode, plane layout.Rect) map[string]layout.Rect {
	cards := map[string]layout.Rect{}
	var walk func(nodes []ui.ElementNode)
	walk = func(nodes []ui.ElementNode) {
		for _, node := range nodes {
			if exposed, ok := node.Key.(Exposed); ok && exposed.Name == "core.card" {
				cards[exposed.Item] = layout.Rect{X: float64(node.Bounds.X) - plane.X, Y: float64(node.Bounds.Y) - plane.Y, W: float64(node.Bounds.W), H: float64(node.Bounds.H)}
			}
			walk(node.Children)
		}
	}
	walk(tree)
	return cards
}

// DrawnChrome reads the box of each card with its head and its foot from the element tree of the window.
func DrawnChrome(tree []ui.ElementNode) []CardChrome {
	boxes := map[string]*CardChrome{}
	order := []string{}
	box := func(id string) *CardChrome {
		if boxes[id] == nil {
			boxes[id] = &CardChrome{}
			order = append(order, id)
		}
		return boxes[id]
	}
	var walk func(nodes []ui.ElementNode)
	walk = func(nodes []ui.ElementNode) {
		for _, node := range nodes {
			if exposed, ok := node.Key.(Exposed); ok {
				r := layout.Rect{X: float64(node.Bounds.X), Y: float64(node.Bounds.Y), W: float64(node.Bounds.W), H: float64(node.Bounds.H)}
				switch exposed.Name {
				case "core.card":
					box(exposed.Item).Box = r
				case "core.card.header":
					box(exposed.Item).Head = r
				case "core.card.status":
					box(exposed.Item).Foot = r
				}
			}
			walk(node.Children)
		}
	}
	walk(tree)
	chrome := make([]CardChrome, 0, len(order))
	for _, id := range order {
		chrome = append(chrome, *boxes[id])
	}
	return chrome
}

// Verification holds the value of the status core.verify.
type Verification struct {
	status *VerifyStatus
}

// NewVerification makes the verification of a window.
func NewVerification() *Verification { return &Verification{} }

// Update replaces the status with the rows of the current state. rows runs the verification of the drawn plane and runs only when
// drawn is true: without a drawn plane nothing is verified, so no stale row stays. failure is the error of the last layout that
// failed, whose row is added in both cases. A verification that could not run is the error that it returns and a failed row, so the
// answer of the verification before it does not stay.
func (v *Verification) Update(drawn bool, rows func() ([]VerifyRow, error), failure *string) error {
	out := []VerifyRow{}
	var unverified error
	if drawn {
		verified, err := rows()
		if err != nil {
			unverified = err
			verified = []VerifyRow{{Name: "Verification", Note: err.Error()}}
		}
		out = verified
	}
	if failure != nil {
		out = append(out, VerifyRow{Name: "Surface presentation", Note: *failure})
	}
	status := &VerifyStatus{Rows: []VerifyRow{}, Skipped: []VerifySkipped{}}
	for _, row := range out {
		switch {
		case row.Skipped:
			status.Skipped = append(status.Skipped, VerifySkipped{Name: row.Name, Note: row.Note})
		case !row.OK:
			status.Failed++
			status.Rows = append(status.Rows, row)
		default:
			status.Rows = append(status.Rows, row)
		}
	}
	v.status = status
	return unverified
}

// Status is the value of the status core.verify, null before the first verification.
func (v *Verification) Status() *VerifyStatus { return v.status }
