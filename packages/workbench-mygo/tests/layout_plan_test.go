// The plan and the apply of a whole arrangement, core.layout.plan and core.layout.apply (docs/spec/cli.md#planning-an-arrangement), as
// packages/workbench/test/layout-operations.test.mjs states them for the page workbench. The plane of the window of these cases is
// 782 × 710 points beside its window sidebar.
package workbench_test

import (
	"encoding/json"
	"math"
	"slices"
	"strings"
	"testing"
)

// plannedLayout is the answer of core.layout.plan and core.layout.apply.
type plannedLayout struct {
	Feasible bool            `json:"feasible"`
	Tree     json.RawMessage `json:"tree"`
	Cards    []plannedCard   `json:"cards"`
	Plane    *plannedSize    `json:"plane"`
	Minimum  *plannedSize    `json:"minimum"`
	Kept     []string        `json:"kept"`
	Closed   []string        `json:"closed"`
	Reason   *string         `json:"reason"`
	Needed   *plannedSize    `json:"needed"`
	Proposal *struct {
		Tree  json.RawMessage `json:"tree"`
		Cards []plannedCard   `json:"cards"`
	} `json:"proposal"`
}

type plannedSize struct {
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
}

type plannedCard struct {
	Card  *string `json:"card"`
	Frame struct {
		X      float64 `json:"x"`
		Y      float64 `json:"y"`
		Width  float64 `json:"width"`
		Height float64 `json:"height"`
	} `json:"frame"`
	Tabs []struct {
		Tab    *string         `json:"tab"`
		Plugin string          `json:"plugin"`
		Params json.RawMessage `json:"params"`
	} `json:"tabs"`
	Active int `json:"active"`
}

// plan runs core.layout.plan or core.layout.apply with params and reads its answer.
func (f *tabShell) plan(name, params string) (plannedLayout, error) {
	f.t.Helper()
	text, err := f.apply(name, params)
	if err != nil {
		return plannedLayout{}, err
	}
	var answer plannedLayout
	if err := json.Unmarshal([]byte(text), &answer); err != nil {
		f.t.Fatal(err)
	}
	return answer, nil
}

// mustPlan runs core.layout.plan with params and fails the test on an error.
func (f *tabShell) mustPlan(params string) plannedLayout {
	f.t.Helper()
	answer, err := f.plan("core.layout.plan", params)
	if err != nil {
		f.t.Fatalf("core.layout.plan %s: %v", params, err)
	}
	return answer
}

// planned is the cards as card:tab,tab with - for a new card or tab, in reading order.
func planned(cards []plannedCard) []string {
	out := []string{}
	for _, card := range cards {
		text := "-"
		if card.Card != nil {
			text = *card.Card
		}
		var tabs []string
		for _, tab := range card.Tabs {
			if tab.Tab == nil {
				tabs = append(tabs, "-")
			} else {
				tabs = append(tabs, *tab.Tab)
			}
		}
		out = append(out, text+":"+strings.Join(tabs, ","))
	}
	return out
}

// rowSizes is the number of cards of each row of planned cards, by their top edge.
func rowSizes(cards []plannedCard) []int {
	var sizes []int
	top := math.Inf(-1)
	for _, card := range cards {
		if math.Abs(card.Frame.Y-top) > 1e-6 {
			sizes = append(sizes, 0)
			top = card.Frame.Y
		}
		sizes[len(sizes)-1]++
	}
	return sizes
}

// tabCounts is the number of tabs of each planned card.
func tabCounts(cards []plannedCard) []int {
	var out []int
	for _, card := range cards {
		out = append(out, len(card.Tabs))
	}
	return out
}

// terminalRow is the request of a row of n cards, each with one new tab of notes.
func terminalRow(n int) string {
	return `{"tree":{"direction":"row","children":[` + strings.TrimSuffix(strings.Repeat(`{"tabs":[{"plugin":"notes"}]},`, n), ",") + `]}}`
}

// contract: layout.plan.count-grid
func TestAPlanOfACountAnswersTheMostEvenGridAndChangesNothing(t *testing.T) {
	f := layoutShell(t, oneCard(tab("tab-aaaaaa", "plain")))
	before := f.described()
	plan := f.mustPlan(`{"count":10,"plugin":"notes"}`)
	if f.described() != before {
		t.Fatal("the plan changed the layout")
	}
	if !plan.Feasible || plan.Reason != nil || plan.Needed != nil || plan.Proposal != nil {
		t.Fatalf("the plan is %+v", plan)
	}
	if *plan.Plane != (plannedSize{782, 710}) || *plan.Minimum != (plannedSize{96, 96}) {
		t.Fatalf("the plane is %v and the minimum %v", *plan.Plane, *plan.Minimum)
	}
	// Of the grids of 1 to 10 rows, three rows of 4, 3 and 3 cards are nearest to a square in a plane of 782 × 710.
	if got := rowSizes(plan.Cards); !slices.Equal(got, []int{4, 3, 3}) {
		t.Fatalf("the rows hold %v cards", got)
	}
	want := append([]string{"main:-,tab-aaaaaa"}, slices.Repeat([]string{"-:-"}, 9)...)
	if got := planned(plan.Cards); !slices.Equal(got, want) {
		t.Fatalf("the cards are %v", got)
	}
	if !slices.Equal(plan.Kept, []string{"tab-aaaaaa"}) || len(plan.Closed) != 0 {
		t.Fatalf("kept %v and closed %v", plan.Kept, plan.Closed)
	}
	// The tree is the tree of an apply: the kept tab is an entry {tab} of the first card.
	var tree struct {
		Children []struct {
			Children []json.RawMessage `json:"children"`
		} `json:"children"`
	}
	if err := json.Unmarshal(plan.Tree, &tree); err != nil {
		t.Fatal(err)
	}
	if got := string(tree.Children[0].Children[0]); got != `{"tabs":[{"plugin":"notes","params":null},{"tab":"tab-aaaaaa"}],"active":0}` {
		t.Fatalf("the first card of the tree is %s", got)
	}
}

// contract: layout.apply.builds-once
func TestALayoutApplyBuildsThePlanOnceAndAnswersTheSame(t *testing.T) {
	f := layoutShell(t, oneCard(tab("tab-aaaaaa", "plain")))
	plan := f.mustPlan(`{"count":10,"plugin":"notes"}`)
	answer, layout := f.twice("core.layout.apply", `{"tree":`+string(plan.Tree)+`}`)
	text, err := json.Marshal(answer)
	if err != nil {
		t.Fatal(err)
	}
	var applied plannedLayout
	if err := json.Unmarshal(text, &applied); err != nil {
		t.Fatal(err)
	}
	for k, card := range applied.Cards {
		if card.Frame != plan.Cards[k].Frame {
			t.Fatalf("card %d is drawn at %v and was planned at %v", k+1, card.Frame, plan.Cards[k].Frame)
		}
		if card.Card == nil || slices.ContainsFunc(card.Tabs, func(tab struct {
			Tab    *string         `json:"tab"`
			Plugin string          `json:"plugin"`
			Params json.RawMessage `json:"params"`
		}) bool {
			return tab.Tab == nil
		}) {
			t.Fatalf("card %d of the apply is %v", k+1, planned(applied.Cards[k:k+1]))
		}
	}
	if *applied.Cards[0].Card != "main" || layout.focusedCard() != "main" {
		t.Fatalf("the first card is %s and the focus is %s", *applied.Cards[0].Card, layout.focusedCard())
	}
	if layout.Root.Direction != "column" || len(layout.Root.Children) != 3 {
		t.Fatalf("the layout is %s", layout.Root.shape())
	}
	// The cards of a row are drawn at one width, and the rows at one height.
	for _, row := range layout.Root.Children {
		for _, card := range row.Children {
			if math.Abs(card.Frame.Width-row.Children[0].Frame.Width) > 1e-6 || math.Abs(card.Frame.Height-layout.Root.Children[0].Children[0].Frame.Height) > 1e-6 {
				t.Fatalf("the layout is %s", f.described())
			}
		}
	}
	if got := layout.tabs(t, "main"); len(got) != 2 || got[1] != "tab-aaaaaa" || !strings.HasSuffix(got[0], "*") {
		t.Fatalf("main holds %v", got)
	}
	// A repeated plan of the count takes the tabs that the apply made and keeps every card.
	again := f.mustPlan(`{"count":10,"plugin":"notes"}`)
	if !slices.Equal(planned(again.Cards), planned(applied.Cards)) || !slices.Equal(again.Kept, []string{"tab-aaaaaa"}) {
		t.Fatalf("the repeated plan is %v with kept %v, the apply %v", planned(again.Cards), again.Kept, planned(applied.Cards))
	}
}

// contract: layout.plan.below-the-minimum
func TestAPlanBelowTheMinimumStatesThePlaneAndTheNearestGrid(t *testing.T) {
	f := layoutShell(t, oneCard(tab("tab-aaaaaa", "plain")))
	before := f.described()
	plan := f.mustPlan(terminalRow(30))
	// 30 cards of 96 points and 29 corridors of 12 points need 3228 points across.
	want := "card 1 of the tree would be 14 × 710 points, below the minimum 96 × 96 points; the tree needs a plane of 3228 × 96 points and " +
		"the plane is 782 × 710 points"
	if plan.Feasible || plan.Reason == nil || *plan.Reason != want {
		t.Fatalf("the plan is feasible %v with the reason %v", plan.Feasible, plan.Reason)
	}
	if *plan.Needed != (plannedSize{3228, 96}) {
		t.Fatalf("the plan needs %v", *plan.Needed)
	}
	if got := rowSizes(plan.Proposal.Cards); !slices.Equal(got, []int{6, 6, 6, 6, 6}) {
		t.Fatalf("the proposal holds the rows %v", got)
	}
	if !slices.Equal(planned(plan.Proposal.Cards), planned(plan.Cards)) {
		t.Fatalf("the proposal holds %v", planned(plan.Proposal.Cards))
	}
	if _, err := f.plan("core.layout.apply", terminalRow(30)); err == nil || err.Error() != want {
		t.Fatalf("the apply answered %v", err)
	}
	// Of more cards than any grid fits, the proposal is the most even grid of the largest count that fits, seven across and six down,
	// whose last card takes the rest; the plan is of the grid nearest to a square.
	many := f.mustPlan(`{"count":60,"plugin":"notes"}`)
	if many.Feasible || many.Proposal == nil {
		t.Fatalf("the plan of 60 cards is %+v", many)
	}
	if got := rowSizes(many.Proposal.Cards); !slices.Equal(got, []int{7, 7, 7, 7, 7, 7}) {
		t.Fatalf("the proposal of 60 cards holds the rows %v", got)
	}
	if got := tabCounts(many.Proposal.Cards); got[0] != 2 || got[len(got)-1] != 19 {
		t.Fatalf("the proposal of 60 cards holds the tabs %v", got)
	}
	// A tree whose corridors leave its cards no extent states the plane.
	wide := f.mustPlan(terminalRow(70))
	if wide.Feasible || wide.Reason == nil || *wide.Reason != "the cards of the tree have no extent in the plane of 782 × 710 points" ||
		wide.Needed != nil || len(wide.Cards) != 0 {
		t.Fatalf("the plan of 70 cards is %+v", wide)
	}
	if got := tabCounts(wide.Proposal.Cards); len(got) != 42 || got[len(got)-1] != 29 {
		t.Fatalf("the proposal of 70 cards holds the tabs %v", got)
	}
	if f.described() != before {
		t.Fatal("a plan or a refused apply changed the layout")
	}
}

// contract: layout.apply.moves-existing-tabs
func TestALayoutApplyMovesTheTabsWithTheirIdentifiers(t *testing.T) {
	a := gridCard("a", 0, 1, 0, 1, tab("tab-aaaaaa", "plain"), paramTab("tab-bbbbbb", "notes", map[string]any{"path": "s.md"}))
	// The text size of a card is part of its data, which a kept card keeps.
	a["data"].(map[string]any)["textSize"] = 1.25
	f := layoutShell(t, gridSpace("spc-aaaaaa", []float64{0, 0.5, 1}, []float64{0, 1}, a, gridCard("b", 1, 2, 0, 1, tab("tab-cccccc", "plain"))))
	tree := `{"tree":{"direction":"column","children":[{"tabs":[{"tab":"tab-cccccc"}]},` +
		`{"tabs":[{"plugin":"notes","params":{"path":"s.md"}},{"tab":"tab-aaaaaa"}],"active":1}]}}`
	answer, layout := f.twice("core.layout.apply", tree)
	cards := answer["cards"].([]any)
	if len(cards) != 2 || cards[0].(map[string]any)["card"] != "b" || cards[1].(map[string]any)["card"] != "a" {
		t.Fatalf("the apply answered %v", answer)
	}
	if layout.Root.shape() != "column[b 0.5, a 0.5]" {
		t.Fatalf("the layout is %s", layout.Root.shape())
	}
	if got := layout.tabs(t, "a"); !slices.Equal(got, []string{"tab-bbbbbb", "tab-aaaaaa*"}) {
		t.Fatalf("a holds %v", got)
	}
	if sizes := status[map[string]any](t, f.shellFixture, "core.text")["cards"].(map[string]any); sizes["a"] != 1.25 {
		t.Fatalf("the text sizes of the cards are %v", sizes)
	}
	// A tab that the tree does not hold closes with close true; a modified one refuses the apply.
	one := `{"tree":{"tabs":[{"tab":"tab-bbbbbb"}]},"close":true}`
	f.modified("tab-cccccc")
	before := f.described()
	if _, err := f.plan("core.layout.apply", one); err == nil || err.Error() != "tab tab-cccccc has unsaved changes; core.layout.close asks the person" {
		t.Fatalf("the apply of a modified tab answered %v", err)
	}
	if f.described() != before {
		t.Fatal("the refused apply changed the layout")
	}
	f.viewCalled("tab-cccccc", "tab.modified", false)
	closed, err := f.plan("core.layout.apply", one)
	if err != nil {
		t.Fatal(err)
	}
	if got := planned(closed.Cards); !slices.Equal(got, []string{"a:tab-bbbbbb"}) || len(closed.Kept) != 0 ||
		!slices.Equal(closed.Closed, []string{"tab-cccccc", "tab-aaaaaa"}) {
		t.Fatalf("the apply with close answered %v, kept %v and closed %v", got, closed.Kept, closed.Closed)
	}
	if got := f.layout().Root.shape(); got != "a" {
		t.Fatalf("the layout is %s", got)
	}
}

// contract: layout.plan.refusals
func TestAPlanThatCannotResolveItsTreeStatesTheReason(t *testing.T) {
	f := layoutShell(t, gridSpace("spc-aaaaaa", []float64{0, 0.5, 1}, []float64{0, 1},
		gridCard("a", 0, 1, 0, 1, tab("tab-aaaaaa", "plain")), gridCard("b", 1, 2, 0, 1, tab("tab-bbbbbb", "plain"))),
		gridSpace("spc-bbbbbb", []float64{0, 1}, []float64{0, 1}, gridCard("other", 0, 1, 0, 1, tab("tab-oooooo", "plain"))))
	before := f.described()
	for _, refusal := range []struct{ tree, reason string }{
		{`{"tabs":[{"tab":"tab-zzzzzz"}]}`, "tab tab-zzzzzz is not a tab of the active space"},
		{`{"tabs":[{"tab":"tab-oooooo"}]}`, "tab tab-oooooo is not a tab of the active space"},
		{`{"direction":"row","children":[{"tabs":[{"tab":"tab-aaaaaa"}]},{"tabs":[{"tab":"tab-aaaaaa"}]}]}`, "tab tab-aaaaaa stands twice in the tree"},
		{`{"tabs":[{"plugin":"nothing"}]}`, "unknown plugin nothing"},
		{`{"tabs":[{"plugin":"plain","params":{"name":"x"}}]}`, "plugin plain declares no tab params"},
		{`{"direction":"row","children":[{"tabs":[{"tab":"tab-aaaaaa"}]}]}`, "tree.children must hold at least two nodes"},
	} {
		plan := f.mustPlan(`{"tree":` + refusal.tree + `}`)
		if plan.Feasible || plan.Reason == nil || *plan.Reason != refusal.reason {
			t.Fatalf("the plan of %s is feasible %v with the reason %v", refusal.tree, plan.Feasible, plan.Reason)
		}
		if _, err := f.plan("core.layout.apply", `{"tree":`+refusal.tree+`}`); err == nil || err.Error() != refusal.reason {
			t.Fatalf("the apply of %s answered %v", refusal.tree, err)
		}
		if f.described() != before {
			t.Fatalf("the refusal of %s changed the layout", refusal.tree)
		}
	}
	for _, request := range []struct{ params, text string }{
		{`{"tree":{"tabs":[{"tab":"tab-aaaaaa"}]},"count":2}`, "core.layout.plan takes tree or count with plugin, not both"},
		{`{"count":2}`, "core.layout.plan needs tree, or count with plugin"},
		{`{"count":0,"plugin":"notes"}`, "count must be a whole number of at least 1"},
	} {
		if _, err := f.plan("core.layout.plan", request.params); err == nil || err.Error() != request.text {
			t.Fatalf("core.layout.plan %s answered %v", request.params, err)
		}
	}
	f.run(t, "core.card.fullscreen", `{"card":"a"}`)
	if plan := f.mustPlan(`{"count":2,"plugin":"notes"}`); plan.Reason == nil ||
		*plan.Reason != "the layout does not change while card a is fullscreen; restore the arrangement first" {
		t.Fatalf("the plan of a fullscreen arrangement has the reason %v", plan.Reason)
	}
	f.run(t, "core.card.fullscreen", `{"card":"a"}`)
	if _, err := f.apply("core.group.create", `{"card":"b","side":"right","plugin":"plain"}`); err != nil {
		t.Fatal(err)
	}
	grouped := f.mustPlan(`{"count":2,"plugin":"notes"}`)
	if grouped.Reason == nil || !strings.HasPrefix(*grouped.Reason, "core.layout.plan arranges a space without group cards; group card-") ||
		!strings.Contains(*grouped.Reason, " holds b, card-") {
		t.Fatalf("the plan of a space with a group card has the reason %v", grouped.Reason)
	}
}
