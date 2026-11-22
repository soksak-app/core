// The plan and the apply of a whole arrangement, core.layout.plan and core.layout.apply (docs/spec/cli.md#planning-an-arrangement), as
// packages/workbench/test/layout-operations.test.mjs states them for the page workbench. The plane of the window of these cases is
// 782 × 710 points beside its window sidebar.
package workbench_test

import (
	"encoding/json"
	"fmt"
	"math"
	"slices"
	"strconv"
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
	Active int     `json:"active"`
	Group  *string `json:"group"`
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
	a := cardNode("a", tab("tab-aaaaaa", "plain"), paramTab("tab-bbbbbb", "notes", map[string]any{"path": "s.md"}))
	// The text size of a card is part of its data, which a kept card keeps.
	a["data"].(map[string]any)["textSize"] = 1.25
	f := layoutShell(t, treeSpace("spc-aaaaaa", cutNode("x", kidNode(0.5, a), kidNode(0.5, cardNode("b", tab("tab-cccccc", "plain"))))))
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
	f := layoutShell(t, treeSpace("spc-aaaaaa", cutNode("x", kidNode(0.5, cardNode("a", tab("tab-aaaaaa", "plain"))),
		kidNode(0.5, cardNode("b", tab("tab-bbbbbb", "plain"))))),
		treeSpace("spc-bbbbbb", cardNode("other", tab("tab-oooooo", "plain"))))
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
	// A space with a group card is planned like one without: the plan of two cards keeps no group, which therefore ends in the apply.
	grouped := f.mustPlan(`{"count":2,"plugin":"notes"}`)
	if !grouped.Feasible || grouped.Reason != nil || len(grouped.Cards) != 2 || len(grouped.Kept) != 3 {
		t.Fatalf("the plan of a space with a group card is %+v", grouped)
	}
}

// groupRow is the request of a row of n cards, each with one new tab of notes, in the group object group.
func groupRow(group string, n int) string {
	return `{"group":` + group + `,"tree":{"direction":"row","children":[` +
		strings.TrimSuffix(strings.Repeat(`{"tabs":[{"plugin":"notes"}]},`, n), ",") + `]}}`
}

// groupNames is the name of each group card of the grid, with its member count, in the order of core.grid.
func (f *tabShell) groupNames() []string {
	f.t.Helper()
	var out []string
	grid := f.read("core.grid")
	cards, _ := grid["cards"].([]any)
	groups, _ := grid["groups"].([]any)
	for _, group := range groups {
		entry := group.(map[string]any)
		members := 0
		for _, card := range cards {
			if card.(map[string]any)["parent"] == entry["id"] {
				members++
			}
		}
		out = append(out, entry["group"].(map[string]any)["name"].(string)+":"+strconv.Itoa(members))
	}
	return out
}

// contract: layout.apply.groups
func TestAGroupOfFiveCardsPlansAndAppliesAsOneGroupCard(t *testing.T) {
	f := layoutShell(t, oneCard(tab("tab-aaaaaa", "plain")))
	before := f.described()
	plan := f.mustPlan(`{"tree":` + groupRow(`{"name":"alpha"}`, 5) + `}`)
	if !plan.Feasible || plan.Reason != nil {
		t.Fatalf("the plan of a group of five cards is %+v", plan)
	}
	if f.described() != before {
		t.Fatal("the plan changed the layout")
	}
	// The tree names the group card and keeps its five cards as the members of its row.
	var tree struct {
		Group struct {
			Name string `json:"name"`
		} `json:"group"`
		Tree struct {
			Direction string            `json:"direction"`
			Children  []json.RawMessage `json:"children"`
		} `json:"tree"`
	}
	if err := json.Unmarshal(plan.Tree, &tree); err != nil {
		t.Fatal(err)
	}
	if tree.Group.Name != "alpha" || tree.Tree.Direction != "row" || len(tree.Tree.Children) != 5 {
		t.Fatalf("the tree of the plan is %s", plan.Tree)
	}
	// Every card of a new group card is a new card of a group that the plan does not name by identifier.
	for k, card := range plan.Cards {
		if card.Group != nil {
			t.Fatalf("card %d of the plan names the group %s", k+1, *card.Group)
		}
	}
	answer, layout := f.twice("core.layout.apply", `{"tree":`+string(plan.Tree)+`}`)
	if got := f.groupNames(); !slices.Equal(got, []string{"alpha:5"}) {
		t.Fatalf("the group cards of the grid are %v after the apply %v", got, answer)
	}
	group := f.read("core.grid")["groups"].([]any)[0].(map[string]any)["id"].(string)
	cards := answer["cards"].([]any)
	if len(cards) != 5 {
		t.Fatalf("the apply answered %d cards", len(cards))
	}
	for k, card := range cards {
		if got := card.(map[string]any)["group"]; got != group {
			t.Fatalf("card %d of the apply is in the group %v, not %s", k+1, got, group)
		}
	}
	// The focus is on the first content card in workbench order, which is a member of the group.
	if focused := layout.focusedCard(); focused == "" || focused == group {
		t.Fatalf("the focus is on %q after the apply", focused)
	}
	// A repeated plan names the kept group card and its name, and a new name does not rename it.
	again := f.mustPlan(`{"tree":` + groupRow(`{"name":"beta"}`, 5) + `}`)
	var kept struct {
		Group struct {
			Name string `json:"name"`
		} `json:"group"`
	}
	if err := json.Unmarshal(again.Tree, &kept); err != nil {
		t.Fatal(err)
	}
	if kept.Group.Name != "alpha" || len(again.Cards) != 5 {
		t.Fatalf("the repeated plan names the group %q with the cards %v", kept.Group.Name, planned(again.Cards))
	}
	for k, card := range again.Cards {
		if card.Group == nil || *card.Group != group {
			t.Fatalf("card %d of the repeated plan is in the group %v, not %s", k+1, card.Group, group)
		}
	}
	if _, err := f.apply("core.layout.apply", `{"tree":`+string(again.Tree)+`}`); err != nil {
		t.Fatal(err)
	}
	if got := f.groupNames(); !slices.Equal(got, []string{"alpha:5"}) {
		t.Fatalf("the kept group card is %v", got)
	}
	if kept := f.read("core.grid")["groups"].([]any)[0].(map[string]any)["id"]; kept != group {
		t.Fatalf("the kept group card has the identifier %v, not %s", kept, group)
	}
}

// contract: layout.apply.groups
func TestTwoGroupCardsBuiltByOneApplyKeepTheirIdentifiersWhenACardMovesIntoTheSecond(t *testing.T) {
	f := layoutShell(t, oneCard(tab("tab-aaaaaa", "plain")))
	pair := func(name string) string {
		return `{"group":{"name":"` + name + `"},"tree":{"direction":"row","children":[{"tabs":[{"plugin":"notes"}]},{"tabs":[{"plugin":"notes"}]}]}}`
	}
	plan := f.mustPlan(`{"tree":{"direction":"row","children":[` + pair("G1") + `,` + pair("G2") + `]}}`)
	if !plan.Feasible || plan.Reason != nil {
		t.Fatalf("the plan of two group cards is %+v", plan)
	}
	first, err := f.plan("core.layout.apply", `{"tree":`+string(plan.Tree)+`}`)
	if err != nil {
		t.Fatal(err)
	}
	// Each group card is identified by its name in core.grid.
	ids := map[string]string{}
	for _, group := range f.read("core.grid")["groups"].([]any) {
		entry := group.(map[string]any)
		ids[entry["group"].(map[string]any)["name"].(string)] = entry["id"].(string)
	}
	if len(ids) != 2 || ids["G1"] == "" || ids["G2"] == "" {
		t.Fatalf("the group cards after the first apply are %v", ids)
	}
	if len(first.Cards) != 4 || first.Cards[0].Group == nil || *first.Cards[0].Group != ids["G1"] ||
		first.Cards[1].Group == nil || *first.Cards[1].Group != ids["G1"] ||
		first.Cards[2].Group == nil || *first.Cards[2].Group != ids["G2"] ||
		first.Cards[3].Group == nil || *first.Cards[3].Group != ids["G2"] {
		t.Fatalf("the first apply built the cards %v", planned(first.Cards))
	}
	a, b, c, d := first.Cards[0], first.Cards[1], first.Cards[2], first.Cards[3]
	tabOf := func(card plannedCard) string { return *card.Tabs[0].Tab }
	// Card a stays in G1, card b moves into G2 with c and d, and G1 takes a new card with a new tab.
	moved := fmt.Sprintf(`{"tree":{"direction":"row","children":[`+
		`{"group":{"name":"other"},"tree":{"direction":"row","children":[{"tabs":[{"tab":"%s"}]},{"tabs":[{"plugin":"notes"}]}]}},`+
		`{"group":{"name":"other2"},"tree":{"direction":"row","children":[{"tabs":[{"tab":"%s"}]},{"tabs":[{"tab":"%s"}]},{"tabs":[{"tab":"%s"}]}]}}`+
		`]}}`, tabOf(a), tabOf(c), tabOf(d), tabOf(b))
	movedPlan := f.mustPlan(moved)
	if !movedPlan.Feasible || movedPlan.Reason != nil {
		t.Fatalf("the plan of the moved card is %+v", movedPlan)
	}
	before := f.described()
	second, err := f.plan("core.layout.apply", `{"tree":`+string(movedPlan.Tree)+`}`)
	if err != nil {
		t.Fatal(err)
	}
	if len(second.Cards) != 5 {
		t.Fatalf("the second apply built %d cards: %v", len(second.Cards), planned(second.Cards))
	}
	wantGroups := []string{ids["G1"], ids["G1"], ids["G2"], ids["G2"], ids["G2"]}
	for k, card := range second.Cards {
		if card.Group == nil || *card.Group != wantGroups[k] {
			t.Fatalf("card %d of the second apply is in the group %v, not %s", k+1, card.Group, wantGroups[k])
		}
	}
	// Cards a, c, d and b keep their identifiers; the new card of G1 keeps none of the first four cards.
	if *second.Cards[0].Card != *a.Card || *second.Cards[2].Card != *c.Card || *second.Cards[3].Card != *d.Card || *second.Cards[4].Card != *b.Card {
		t.Fatalf("the second apply kept the cards %v, not %v", planned(second.Cards), planned(first.Cards))
	}
	for _, old := range first.Cards {
		if *second.Cards[1].Card == *old.Card {
			t.Fatalf("the new card of G1 is the card %s", *old.Card)
		}
	}
	// Tab b keeps its identifier and moves with its card; every other tab keeps its identifier too.
	if tabOf(second.Cards[4]) != tabOf(b) || tabOf(second.Cards[0]) != tabOf(a) || tabOf(second.Cards[2]) != tabOf(c) || tabOf(second.Cards[3]) != tabOf(d) {
		t.Fatalf("the second apply moved the tabs to %v", planned(second.Cards))
	}
	// The group cards keep their identifiers and names, and the names of the second request are not applied to them.
	var names []string
	for _, group := range f.read("core.grid")["groups"].([]any) {
		entry := group.(map[string]any)
		if entry["id"] != any(ids[entry["group"].(map[string]any)["name"].(string)]) {
			t.Fatalf("the group %v is not one of the group cards of the first apply", entry)
		}
		names = append(names, entry["group"].(map[string]any)["name"].(string))
	}
	slices.Sort(names)
	if !slices.Equal(names, []string{"G1", "G2"}) {
		t.Fatalf("the group cards are named %v", names)
	}
	got := f.groupNames()
	slices.Sort(got)
	if !slices.Equal(got, []string{"G1:2", "G2:3"}) {
		t.Fatalf("the group cards hold %v", got)
	}
	// A repeated apply answers the same and changes nothing.
	after := f.described()
	if after == before {
		t.Fatal("the second apply changed no layout, so card b did not move")
	}
	again, err := f.plan("core.layout.apply", `{"tree":`+string(movedPlan.Tree)+`}`)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(planned(again.Cards), " ") != strings.Join(planned(second.Cards), " ") || f.described() != after {
		t.Fatalf("the repeated apply answered %v and changed the layout", planned(again.Cards))
	}
}

// contract: layout.plan.group-refusals
func TestAGroupOfOneCardIsRefusedByThePlanAndTheApply(t *testing.T) {
	f := layoutShell(t, oneCard(tab("tab-aaaaaa", "plain")))
	before := f.described()
	const want = "a group of the tree holds at least two cards"
	tree := `{"tree":{"group":{},"tree":{"tabs":[{"plugin":"notes"}]}}}`
	plan := f.mustPlan(tree)
	if plan.Feasible || plan.Reason == nil || *plan.Reason != want {
		t.Fatalf("the plan of a group of one card is feasible %v with the reason %v", plan.Feasible, plan.Reason)
	}
	if _, err := f.plan("core.layout.apply", tree); err == nil || err.Error() != want {
		t.Fatalf("the apply of a group of one card answered %v", err)
	}
	if f.described() != before {
		t.Fatal("the refused group changed the layout")
	}
}

// contract: layout.plan.group-refusals
func TestAGroupNameOutsideOneToFortyCharactersIsRefused(t *testing.T) {
	f := layoutShell(t, oneCard(tab("tab-aaaaaa", "plain")))
	before := f.described()
	long := strings.Repeat("g", 41)
	for _, name := range []string{`"   "`, `"` + long + `"`} {
		want := "group name must be 1 to 40 characters: " + strings.TrimSpace(strings.Trim(name, `"`))
		tree := `{"tree":` + groupRow(`{"name":`+name+`}`, 2) + `}`
		plan := f.mustPlan(tree)
		if plan.Feasible || plan.Reason == nil || *plan.Reason != want {
			t.Fatalf("the plan with the name %s is feasible %v with the reason %v", name, plan.Feasible, plan.Reason)
		}
		if _, err := f.plan("core.layout.apply", tree); err == nil || err.Error() != want {
			t.Fatalf("the apply with the name %s answered %v", name, err)
		}
	}
	if f.described() != before {
		t.Fatal("a refused group name changed the layout")
	}
}
