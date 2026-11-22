package workbench

import (
	"encoding/json"
	"slices"
	"sort"
	"strconv"
)

// The group cards of a planned arrangement (docs/spec/cli.md#planning-an-arrangement, docs/spec/groups.md#leader): the group nodes of a
// tree, the identifiers of their boxes, the kept group cards and names, and the leaders of the levels that an apply builds.

// collectGroups lists the group nodes of tree in pre-order, so an outer group comes before the groups inside it.
func collectGroups(tree *planNode) []*planNode {
	var out []*planNode
	var walk func(node *planNode)
	walk = func(node *planNode) {
		if node.Group != nil {
			out = append(out, node)
			walk(node.Group.Tree)
			return
		}
		for _, child := range node.Children {
			walk(child)
		}
	}
	walk(tree)
	return out
}

// assignBoxes gives each group node of tree the identifier of its box: the kept group card, or a new identifier from issue.
func assignBoxes(tree *planNode, issue func() string) {
	for _, group := range collectGroups(tree) {
		if group.Group.Card != "" {
			group.Group.Box = group.Group.Card
		} else {
			group.Group.Box = issue()
		}
	}
}

// leafGroups is the group nodes above each card of tree in tree order, outermost first.
func leafGroups(tree *planNode) [][]*planNode {
	var out [][]*planNode
	var walk func(node *planNode, path []*planNode)
	walk = func(node *planNode, path []*planNode) {
		if node.Group != nil {
			walk(node.Group.Tree, append(slices.Clone(path), node))
			return
		}
		if node.Direction == "" {
			out = append(out, path)
			return
		}
		for _, child := range node.Children {
			walk(child, path)
		}
	}
	walk(tree, nil)
	return out
}

// defaultGroupName is `그룹 <n>` for the smallest positive n that taken does not hold.
func defaultGroupName(taken []string) string {
	for n := 1; ; n++ {
		if name := "그룹 " + strconv.Itoa(n); !slices.Contains(taken, name) {
			return name
		}
	}
}

// resolveGroups names and keeps the group nodes of tree (docs/spec/cli.md#planning-an-arrangement). A group keeps the group card of the plane
// that holds the card its first card in reading order keeps, when no earlier group of the tree keeps that group card, and then it keeps
// the name of that card; otherwise it is a new group card, named by its name or else the smallest `그룹 <n>` that no group card of the space
// has, numbered in reading order of its first card. cards holds the resolved card of each card in tree order, and order the cards of tree
// in reading order. It sets Card and Name of each group node and returns the kept group card of each card in tree order, nil outside a kept
// group card and for a card of a new group card.
func resolveGroups(tree *planNode, cards []*resolvedCard, order []int, space planSpace) []*string {
	position := make([]int, len(order))
	for n, leaf := range order {
		position[leaf] = n
	}
	paths := leafGroups(tree)
	first := map[*planNode]int{}
	for k, path := range paths {
		for _, group := range path {
			if at, ok := first[group]; !ok || position[k] < at {
				first[group] = position[k]
			}
		}
	}
	groups := collectGroups(tree)
	sort.SliceStable(groups, func(i, j int) bool { return first[groups[i]] < first[groups[j]] })
	taken := slices.Clone(space.taken)
	keptBy := map[string]bool{}
	for _, group := range groups {
		parent := ""
		if kept := cards[order[first[group]]].card; kept != "" {
			parent = space.parent(kept)
		}
		if parent != "" && !keptBy[parent] {
			keptBy[parent] = true
			group.Group.Card = parent
			group.Group.Name = space.groupName(parent)
			continue
		}
		group.Group.Card = ""
		if group.Group.Name == "" {
			name := defaultGroupName(taken)
			group.Group.Name = name
			taken = append(taken, name)
		}
	}
	out := make([]*string, len(paths))
	for k, path := range paths {
		if len(path) == 0 {
			continue
		}
		if card := path[len(path)-1].Group.Card; card != "" {
			out[k] = &card
		}
	}
	return out
}

// groupLeaders gives the leader of each group node of tree by its box and the leader of the root level (docs/spec/groups.md#leader). A
// leader that is still a member of its level stays; otherwise the leader is the first member of the level in reading order. old holds the
// leader of each kept group card by identifier, and rootOld the leader of the root level before the apply; ids[k] is the card of the k-th
// card of tree in tree order.
func groupLeaders(tree *planNode, ids []string, old map[string]string, rootOld string) (map[string]string, string) {
	paths := leafGroups(tree)
	members := map[string][]string{}
	for _, leaf := range planReadingOrder(tree) {
		path := paths[leaf]
		for depth := -1; depth < len(path); depth++ {
			level, member := "", ids[leaf]
			if depth >= 0 {
				level = path[depth].Group.Box
			}
			if depth+1 < len(path) {
				member = path[depth+1].Group.Box
			}
			if !slices.Contains(members[level], member) {
				members[level] = append(members[level], member)
			}
		}
	}
	pick := func(level, kept string) string {
		if slices.Contains(members[level], kept) {
			return kept
		}
		if len(members[level]) == 0 {
			return ""
		}
		return members[level][0]
	}
	leaders := map[string]string{}
	for _, group := range collectGroups(tree) {
		leaders[group.Group.Box] = pick(group.Group.Box, old[group.Group.Box])
	}
	return leaders, pick("", rootOld)
}

// groupData is the data {name, leader} of a box (docs/spec/groups.md#storage).
func groupData(name, leader string) (json.RawMessage, error) {
	return json.Marshal(struct {
		Name   string `json:"name"`
		Leader string `json:"leader"`
	}{name, leader})
}
