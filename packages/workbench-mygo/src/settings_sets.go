package workbench

import (
	"errors"
	"fmt"
	"slices"
)

// The sidebar sets and links of the settings (docs/spec/settings.md#stored-sets-and-links). Each function takes a list and
// returns a new one, which the store writes.

// setTitleMax is the most characters of the title of a set.
const setTitleMax = 40

// StoredSet is a sidebar set of the settings.
type StoredSet struct {
	ID       string   `json:"id"`
	Title    string   `json:"title"`
	Sections []string `json:"sections"`
	Layout   string   `json:"layout"`
}

// StoredLink connects a place, and for a window or card place a plugin, to a set.
type StoredLink struct {
	Place  string  `json:"place"`
	Plugin *string `json:"plugin"`
	Set    string  `json:"set"`
}

func (l StoredLink) pluginID() string {
	if l.Plugin == nil {
		return ""
	}
	return *l.Plugin
}

// clonedSets returns a copy of sets whose sections are their own.
func clonedSets(sets []StoredSet) []StoredSet {
	cloned := slices.Clone(sets)
	for i := range cloned {
		cloned[i].Sections = slices.Clone(cloned[i].Sections)
	}
	return cloned
}

// CreateSet appends a set titled 새 세트 with the first free number, the layout list and no sections.
func CreateSet(sets []StoredSet) []StoredSet {
	number := 1
	for slices.ContainsFunc(sets, func(set StoredSet) bool { return set.ID == fmt.Sprintf("set-%d", number) }) {
		number++
	}
	return append(clonedSets(sets), StoredSet{ID: fmt.Sprintf("set-%d", number), Title: "새 세트", Sections: []string{}, Layout: "list"})
}

func setIndex(sets []StoredSet, id string) (int, error) {
	index := slices.IndexFunc(sets, func(set StoredSet) bool { return set.ID == id })
	if index < 0 {
		return 0, fmt.Errorf("unknown set %s", id)
	}
	return index, nil
}

// UpdateSet changes the title or the layout of a set; a nil value leaves it.
func UpdateSet(sets []StoredSet, id string, title, layout *string) ([]StoredSet, error) {
	index, err := setIndex(sets, id)
	if err != nil {
		return nil, err
	}
	next := clonedSets(sets)
	if title != nil {
		if length := len([]rune(*title)); length < 1 || length > setTitleMax {
			return nil, fmt.Errorf("set title must be 1 to %d characters", setTitleMax)
		}
		next[index].Title = *title
	}
	if layout != nil {
		if *layout != "list" && *layout != "tabs" {
			return nil, errors.New("set layout must be list or tabs")
		}
		next[index].Layout = *layout
	}
	return next, nil
}

// ChangeRow changes one section row of a set: choose replaces the row index with section, up and down swap it with a
// neighbour, remove deletes it, and add appends the first of registered that the set does not have.
func ChangeRow(sets []StoredSet, id, action string, index int, section string, registered []string) ([]StoredSet, error) {
	at, err := setIndex(sets, id)
	if err != nil {
		return nil, err
	}
	next := clonedSets(sets)
	rows := next[at].Sections
	row := func() error {
		if index < 0 || index >= len(rows) {
			return fmt.Errorf("set %s has no row %d", id, index)
		}
		return nil
	}
	if action != "add" {
		if !slices.Contains([]string{"choose", "up", "down", "remove"}, action) {
			return nil, fmt.Errorf("unknown row action %s", action)
		}
		if err := row(); err != nil {
			return nil, err
		}
	}
	switch action {
	case "choose":
		if !slices.Contains(registered, section) {
			return nil, fmt.Errorf("unknown section %s", section)
		}
		for i, other := range rows {
			if i != index && other == section {
				return nil, fmt.Errorf("section %s is already in set %s", section, id)
			}
		}
		rows[index] = section
	case "up":
		if index == 0 {
			return nil, fmt.Errorf("row %d cannot move up", index)
		}
		rows[index-1], rows[index] = rows[index], rows[index-1]
	case "down":
		if index == len(rows)-1 {
			return nil, fmt.Errorf("row %d cannot move down", index)
		}
		rows[index], rows[index+1] = rows[index+1], rows[index]
	case "remove":
		rows = slices.Delete(rows, index, index+1)
	case "add":
		free := slices.IndexFunc(registered, func(candidate string) bool { return !slices.Contains(rows, candidate) })
		if free < 0 {
			return nil, fmt.Errorf("set %s already contains every registered section", id)
		}
		rows = append(rows, registered[free])
	}
	next[at].Sections = rows
	return next, nil
}

// linkPlaces are the places of a link.
var linkPlaces = []string{"left", "right", "window-left", "window-right", "card-left", "card-right", "card-top", "card-bottom"}

// ChooseLink returns links with one choice changed: choice is a set id or off, and plugin is empty for the general choice of
// left or right.
func ChooseLink(links []StoredLink, place, plugin, choice string) ([]StoredLink, error) {
	if !slices.Contains(linkPlaces, place) {
		return nil, fmt.Errorf("unknown sidebar place %s", place)
	}
	general := place == "left" || place == "right"
	if general != (plugin == "") {
		return nil, fmt.Errorf("invalid plugin for %s", place)
	}
	if choice == "inherit" {
		return nil, fmt.Errorf("%s has no inherit choice", place)
	}
	rest := slices.DeleteFunc(slices.Clone(links), func(link StoredLink) bool { return link.Place == place && link.pluginID() == plugin })
	if choice == "off" {
		return rest, nil
	}
	link := StoredLink{Place: place, Set: choice}
	if plugin != "" {
		link.Plugin = &plugin
	}
	return append(rest, link), nil
}

// DeleteSet removes a set and every link to it.
func DeleteSet(sets []StoredSet, links []StoredLink, id string) ([]StoredSet, []StoredLink, error) {
	index, err := setIndex(sets, id)
	if err != nil {
		return nil, nil, err
	}
	remaining := slices.Delete(clonedSets(sets), index, index+1)
	return remaining, slices.DeleteFunc(slices.Clone(links), func(link StoredLink) bool { return link.Set == id }), nil
}
