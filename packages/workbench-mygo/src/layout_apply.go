package workbench

import (
	"encoding/json"
	"fmt"
	"math"
	"slices"

	"github.com/soksak-app/core/packages/workbench-mygo/src/layout"
)

// Planning an arrangement (docs/spec/cli.md#planning-an-arrangement): core.layout.plan and core.layout.apply, as planInLayout and
// applyInLayout of packages/workbench/plane.js answer them for the page.

// layoutApplyParam is the parameters of core.layout.apply.
type layoutApplyParam struct {
	Tree  json.RawMessage `json:"tree"`
	Close bool            `json:"close,omitempty"`
}

func (s *Shell) registerLayoutPlan() {
	command(s, "core.layout.plan", func(value planRequest) (any, error) {
		return s.planLayout(value)
	})
	command(s, "core.layout.apply", func(value layoutApplyParam) (any, error) {
		return s.applyLayout(value)
	})
}

// planContent is the ids of the content cards of the plane in the order of the grid.
func (s *Shell) planContent() []string {
	ids := []string{}
	for _, card := range s.plane.Cards() {
		if !isPlace(card.ID) {
			ids = append(ids, card.ID)
		}
	}
	return ids
}

// planOperations are the operations of the size rule of the layout library on the content cards of the plane.
func (s *Shell) planOperations() planOperations {
	origin := s.planeOrigin()
	// The head of a group card is drawn as reframe of the group tree draws it: the head, and the corridor below it unless the seam takes none.
	options := s.groupOptions()
	head := options.Head
	if !options.Seam {
		head += s.plane.Gap()
	}
	return planOperations{
		cards:    s.planContent,
		withdraw: s.plane.Withdraw,
		insert: func(target, side string, node *layout.Node) error {
			_, err := s.plane.Insert(layout.Target{target}, side, node)
			return err
		},
		even: s.plane.Even,
		frame: func(id string) planFrame {
			rect, _ := s.plane.Rect(id) // silent: buildPlanTree asks only for the cards that it built.
			return planFrame{X: origin.X + rect.X, Y: origin.Y + rect.Y, Width: rect.W, Height: rect.H}
		},
		boxes: func() []string {
			var out []string
			for _, id := range s.planes.Cards() {
				if s.planes.IsGroup(id) {
					out = append(out, id)
				}
			}
			return out
		},
		unwrap: s.plane.Unwrap,
		group: func(target, side string, node *layout.Node, box string) error {
			return s.plane.Group(target, side, node, layout.GroupInit{Box: box, Head: head})
		},
	}
}

// planSpace is the active space as planArrangement reads it.
func (s *Shell) planSpace() (planSpace, error) {
	if s.plane == nil || s.opened() == nil || s.browsing {
		return planSpace{refusal: fmt.Sprintf("window %s shows no space", s.options.Name)}, nil
	}
	minimum := &planSize{Width: s.plane.MinSize(), Height: s.plane.MinSize()}
	type placed struct {
		card layout.Card
		rect layout.Rect
	}
	var content []placed
	left, top, right, bottom := math.Inf(1), math.Inf(1), math.Inf(-1), math.Inf(-1)
	for _, card := range s.plane.Cards() {
		if isPlace(card.ID) {
			continue
		}
		rect, _ := s.plane.Rect(card.ID) // silent: a card of the grid has a rectangle.
		content = append(content, placed{card, rect})
		left, top = min(left, rect.X), min(top, rect.Y)
		right, bottom = max(right, rect.X+rect.W), max(bottom, rect.Y+rect.H)
	}
	space := planSpace{plane: &planSize{Width: right - left, Height: bottom - top}, minimum: minimum, tabs: []planTab{},
		parent: s.planes.Parent, groupName: s.planes.GroupName}
	for _, id := range s.planes.Cards() {
		if s.planes.IsGroup(id) {
			space.taken = append(space.taken, s.planes.GroupName(id))
		}
	}
	if s.fullscreen != "" {
		space.refusal = fmt.Sprintf("the layout does not change while card %s is fullscreen; restore the arrangement first", s.fullscreen)
	}
	slices.SortStableFunc(content, func(a, b placed) int {
		if a.rect.Y != b.rect.Y {
			return cmpFloat(a.rect.Y, b.rect.Y)
		}
		return cmpFloat(a.rect.X, b.rect.X)
	})
	for _, entry := range content {
		data, err := layout.DecodeCardData(entry.card.Data)
		if err != nil {
			return planSpace{}, fmt.Errorf("card %s: %w", entry.card.ID, err)
		}
		if data == nil {
			continue
		}
		for _, tab := range data.TabList() {
			space.tabs = append(space.tabs, planTab{Tab: tab.ID, Card: entry.card.ID, Plugin: tab.Plugin, Params: tab.Rest["params"]})
		}
	}
	space.entry = func(plugin string, params json.RawMessage) (json.RawMessage, error) {
		known, err := s.knownPlugin(plugin)
		if err != nil {
			return nil, err
		}
		return checkTabParams(known, params)
	}
	space.unsaved = s.tabModified
	// The plan builds on a copy of the plane without the minimum, so it reads the size of every card and judges it by the minimum.
	space.measure = func(tree *planNode) ([]planFrame, error) {
		var frames []planFrame
		err := s.planes.Probe(func() error {
			kept := s.plane.MinSize()
			s.plane.SetMinSize(0)
			defer s.plane.SetMinSize(kept)
			return s.planes.Arrange(func(issue func() string) error {
				leaves := planLeaves(tree)
				ids := make([]string, len(leaves))
				for k := range leaves {
					if k == 0 {
						ids[k] = s.planContent()[0]
					} else {
						ids[k] = issue()
					}
				}
				assignBoxes(tree, issue)
				built, err := buildPlanTree(s.planOperations(), tree, ids)
				frames = built
				return err
			})
		})
		return frames, err
	}
	return space, nil
}

// cmpFloat orders two numbers.
func cmpFloat(a, b float64) int {
	switch {
	case a < b:
		return -1
	case a > b:
		return 1
	}
	return 0
}

// planLayout is core.layout.plan: whether the arrangement can be built in the plane of the active space and what it would be.
func (s *Shell) planLayout(request planRequest) (planAnswer, error) {
	space, err := s.planSpace()
	if err != nil {
		return planAnswer{}, err
	}
	return planArrangement(request, space)
}

// applyLayout is core.layout.apply: it builds the plan of its tree with the operations of the size rule on the plane, moves the
// existing tabs into their cards, opens the new tabs, closes the tabs of closed, builds the group cards of the tree and focuses the first
// content card in workbench order. A plan that is not feasible changes nothing and fails with its reason.
func (s *Shell) applyLayout(value layoutApplyParam) (map[string]any, error) {
	space, err := s.planSpace()
	if err != nil {
		return nil, err
	}
	planned, err := planArrangement(planRequest{Tree: value.Tree, Close: value.Close}, space)
	if err != nil {
		return nil, err
	}
	if !planned.Feasible {
		return nil, fmt.Errorf("%s", *planned.Reason)
	}
	// A new tab whose params name a session shows it, as a tab of core.layout.open does, so the session must be open before the layout
	// changes (docs/spec/plugins.md#owned-sessions).
	if err := s.checkPlannedSessions(planned.Tree); err != nil {
		return nil, err
	}
	var showing [][2]string
	held := map[string]layout.Tab{}
	for _, id := range s.planContent() {
		data, err := s.cardData(id)
		if err != nil {
			return nil, err
		}
		for _, tab := range data.TabList() {
			held[tab.ID] = tab
		}
	}
	// The leaders of the kept group cards and of the root level, before the apply changes them.
	oldLeaders := map[string]string{}
	for _, group := range collectGroups(planned.Tree) {
		if group.Group.Card != "" {
			if leader, ok := s.planes.Leader(group.Group.Card); ok {
				oldLeaders[group.Group.Card] = leader
			}
		}
	}
	// silent: a root level without a leader yields the empty string, which groupLeaders reads as no leader.
	rootLeader, _ := s.planes.Leader("")
	before := s.planContent()
	var named *planNode
	ids := slices.Clone(planned.ids)
	err = s.planes.Arrange(func(issue func() string) error {
		for k, id := range ids {
			if id == "" {
				ids[k] = issue()
			}
		}
		assignBoxes(planned.Tree, issue)
		if _, err := buildPlanTree(s.planOperations(), planned.Tree, ids); err != nil {
			return err
		}
		k := 0
		// The tree of the result names each tab by its identifier, the new tabs included, and each group by its name.
		var place func(node *planNode) (*planNode, error)
		place = func(node *planNode) (*planNode, error) {
			if node.Group != nil {
				inner, err := place(node.Group.Tree)
				if err != nil {
					return nil, err
				}
				return &planNode{Group: &planGroup{Name: node.Group.Name, Tree: inner}}, nil
			}
			if node.Direction != "" {
				out := &planNode{Direction: node.Direction}
				for _, child := range node.Children {
					inner, err := place(child)
					if err != nil {
						return nil, err
					}
					out.Children = append(out.Children, inner)
				}
				return out, nil
			}
			tabs := []layout.Tab{}
			for _, entry := range node.Tabs {
				if entry.Tab != "" {
					tabs = append(tabs, held[entry.Tab])
					continue
				}
				known, err := s.knownPlugin(entry.Plugin)
				if err != nil {
					return nil, err
				}
				tab, err := s.newTabOf(known, nil)
				if err != nil {
					return nil, err
				}
				if entry.Params != nil {
					tab.Rest["params"] = entry.Params
				}
				session, err := sessionOfParams(entry.Params)
				if err != nil {
					return nil, err
				}
				if session != "" {
					showing = append(showing, [2]string{tab.ID, session})
				}
				tabs = append(tabs, tab)
			}
			id := ids[k]
			k++
			// A kept card keeps the rest of its data, its text size and its sidebars; a new card has no data.
			data := &layout.CardData{}
			if card, _ := s.plane.Card(id); len(card.Data) > 0 { // silent: buildPlanTree placed every card of the tree.
				decoded, err := layout.DecodeCardData(card.Data)
				if err != nil {
					return nil, fmt.Errorf("card %s: %w", id, err)
				}
				if decoded != nil {
					data = decoded
				}
			}
			data.Tabs = tabs
			data.SelectTab(tabs[node.Active].ID)
			if err := s.storeCard(id, data); err != nil {
				return nil, err
			}
			out := &planNode{Active: node.Active}
			for _, tab := range tabs {
				out.Tabs = append(out.Tabs, planEntry{Tab: tab.ID})
			}
			return out, nil
		}
		result, err := place(planned.Tree)
		named = result
		return err
	})
	if err != nil {
		return nil, err
	}
	// The boxes take their names and leaders, and the group tree is read from the grid as the stored layout is.
	leaders, rootNext := groupLeaders(planned.Tree, ids, oldLeaders, rootLeader)
	for _, group := range collectGroups(planned.Tree) {
		data, err := groupData(group.Group.Name, leaders[group.Group.Box])
		if err != nil {
			return nil, err
		}
		if !s.plane.SetData(group.Group.Box, data) {
			return nil, fmt.Errorf("group %s is not in the layout", group.Group.Box)
		}
	}
	leader := json.RawMessage("null")
	if rootNext != "" {
		leader, err = json.Marshal(rootNext)
		if err != nil {
			return nil, err
		}
	}
	last, err := json.Marshal(s.planes.LastCard())
	if err != nil {
		return nil, err
	}
	tree, err := layout.ReadTree(s.plane.ToJSON(), nil, leader, last, s.groupOptions(), s.plane)
	if err != nil {
		return nil, err
	}
	s.showPlane(tree)
	for _, pair := range showing {
		s.owned.Show(pair[0], pair[1], s.cardSizeOf(pair[0]), func(err error) {
			if err != nil {
				s.fail(err)
			}
		})
	}
	// The focus takes the first content card in workbench order, which is no window sidebar.
	for _, card := range s.contentCards() {
		if !isPlace(card.ID) {
			s.focusCard(card.ID)
			break
		}
	}
	for _, id := range before {
		if _, ok := s.plane.Card(id); !ok {
			delete(s.operated, id)
		}
	}
	s.settleThen(s.droppedTabs(planned.Closed))
	space, err = s.planSpace()
	if err != nil {
		return nil, err
	}
	tree2, err := json.Marshal(named)
	if err != nil {
		return nil, err
	}
	applied, err := planArrangement(planRequest{Tree: tree2}, space)
	if err != nil {
		return nil, err
	}
	return map[string]any{"tree": applied.Tree, "cards": applied.Cards, "kept": planned.Kept, "closed": planned.Closed}, nil
}

// checkPlannedSessions refuses a tree whose new tab names a session in its params that is not open.
func (s *Shell) checkPlannedSessions(node *planNode) error {
	if node.Group != nil {
		return s.checkPlannedSessions(node.Group.Tree)
	}
	for _, child := range node.Children {
		if err := s.checkPlannedSessions(child); err != nil {
			return err
		}
	}
	for _, entry := range node.Tabs {
		if entry.Tab != "" {
			continue
		}
		session, err := sessionOfParams(entry.Params)
		if err != nil {
			return err
		}
		if session != "" && !s.owned.IsOpen(session) {
			return fmt.Errorf("session %s is not open", session)
		}
	}
	return nil
}
