package workbench

import (
	"errors"
	"fmt"
	"maps"
	"slices"
	"strings"
	"unicode/utf16"
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

// CreateSet appends a set with the title of a new set, the first free number, the layout list and no sections.
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

// WindowEdges are the edges of a window; each holds at most one fixed window sidebar, whose card id is the edge
// (docs/spec/external-sidebars.md).
var WindowEdges = []string{"left", "right", "top", "bottom"}

// IsWindowEdge reports whether id names an edge of the window.
func IsWindowEdge(id string) bool { return slices.Contains(WindowEdges, id) }

// linkPlaces are the places of a link: the general edge choices, the plugin window choices and the internal card sides.
var linkPlaces = []string{"left", "right", "top", "bottom", "window-left", "window-right", "window-top", "window-bottom", "card-left", "card-right", "card-top", "card-bottom"}

// ChooseLink returns links with one choice changed: choice is a set id or off, and plugin is empty for the general choice of
// an edge.
func ChooseLink(links []StoredLink, place, plugin, choice string) ([]StoredLink, error) {
	if !slices.Contains(linkPlaces, place) {
		return nil, fmt.Errorf("unknown sidebar place %s", place)
	}
	general := IsWindowEdge(place)
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

// reservedSetIDs are the values that are no set id: off of a choice of a setting and inherit of a choice of a card.
var reservedSetIDs = []string{"off", "inherit"}

// validateSidebars checks the sets and the links in their stored form with the rules and the messages of validateSidebars of
// @soksak/plugin-api, which the page runs over the same values. A message starts with where. When loaded holds the ids of the
// loaded plugins, a link of a plugin that is not loaded keeps a set that is not known, which the plugin uses again when it is
// installed again (docs/spec/settings.md#stored-sets-and-links).
func validateSidebars(sets, links any, where string, loaded map[string]bool) error {
	setList, setsOK := sets.([]any)
	linkList, linksOK := links.([]any)
	if !setsOK || !linksOK {
		return fmt.Errorf("%s: sidebars requires sets and links", where)
	}
	known := map[string]bool{}
	for _, item := range setList {
		set, ok := item.(map[string]any)
		id, idOK := set["id"].(string)
		title, titleOK := set["title"].(string)
		sections, sectionsOK := set["sections"].([]any)
		if !ok || !idOK || id == "" || !titleOK || !sectionsOK {
			return fmt.Errorf("%s: every set requires id, title, and sections", where)
		}
		if err := onlyFields(fmt.Sprintf("%s set %s", where, id), set, "id", "title", "sections", "layout"); err != nil {
			return err
		}
		// The page counts the UTF-16 units of the title.
		if length := len(utf16.Encode([]rune(title))); length < 1 || length > setTitleMax {
			return fmt.Errorf("%s: set %s title must be 1 to %d characters", where, id, setTitleMax)
		}
		names := make([]string, 0, len(sections))
		for _, section := range sections {
			name, ok := section.(string)
			if !ok || name == "" {
				return fmt.Errorf("%s: set %s sections must be section ids", where, id)
			}
			names = append(names, name)
		}
		listed := map[string]bool{}
		for _, name := range names {
			if listed[name] {
				return fmt.Errorf("%s: set %s lists section %s twice", where, id, name)
			}
			listed[name] = true
		}
		if layout, _ := set["layout"].(string); layout != "list" && layout != "tabs" { // silent: a layout that is no string is no layout.
			return fmt.Errorf("%s: set %s layout must be list or tabs", where, id)
		}
		if slices.Contains(reservedSetIDs, id) {
			return fmt.Errorf("%s: set id %s is reserved", where, id)
		}
		if known[id] {
			return fmt.Errorf("%s: duplicate set %s", where, id)
		}
		known[id] = true
	}
	seen := map[string]bool{}
	for _, item := range linkList {
		link, ok := item.(map[string]any)
		place, _ := link["place"].(string) // silent: a place that is no string is no place of linkPlaces.
		if !ok || !slices.Contains(linkPlaces, place) {
			return fmt.Errorf("%s: every link requires a place (%s) and a known set", where, strings.Join(linkPlaces, ", "))
		}
		if err := onlyFields(where+" link", link, "place", "plugin", "set"); err != nil {
			return err
		}
		plugin, named := link["plugin"].(string)
		if link["plugin"] != nil && (!named || plugin == "") {
			return fmt.Errorf("%s: a link plugin is null or a plugin id", where)
		}
		general := IsWindowEdge(place)
		if general && named {
			return fmt.Errorf("%s: a general window link requires plugin null", where)
		}
		if !general && !named {
			return fmt.Errorf("%s: a %s link names a plugin", where, place)
		}
		set, _ := link["set"].(string) // silent: a set that is no string is no known set.
		kept := loaded != nil && named && !loaded[plugin]
		if !kept && !known[set] {
			return fmt.Errorf("%s: a %s link requires a known set", where, place)
		}
		key := place + " general"
		if named {
			key = place + " " + plugin
		}
		if seen[key] {
			return fmt.Errorf("%s: link %s appears twice", where, key)
		}
		seen[key] = true
	}
	return nil
}

// onlyFields refuses the first field of value in sorted order that keys does not name.
func onlyFields(where string, value map[string]any, keys ...string) error {
	for _, key := range slices.Sorted(maps.Keys(value)) {
		if !slices.Contains(keys, key) {
			return fmt.Errorf("%s: unknown field %s", where, key)
		}
	}
	return nil
}

// checkSidebarReferences checks the sections of the sets and the plugins of the links against the loaded plugins, as
// checkSidebarReferences of @soksak/plugin-api does: a section that a loaded plugin does not declare, and a card link of a loaded
// plugin without a surface, are refused, and a reference to a plugin that is not loaded is kept.
func checkSidebarReferences(sets []StoredSet, links []StoredLink, plugins []LoadedPlugin, where string) error {
	byID := map[string]LoadedPlugin{}
	for _, plugin := range plugins {
		byID[plugin.ID] = plugin
	}
	for _, set := range sets {
		for _, section := range set.Sections {
			plugin, _, _ := strings.Cut(section, ".") // silent: a section id is `<plugin id>.<name>`.
			owner, loaded := byID[plugin]
			if loaded && !slices.ContainsFunc(owner.Sections, func(declared LoadedSection) bool { return declared.ID == section }) {
				return fmt.Errorf("%s: set %s names unknown section %s", where, set.ID, section)
			}
		}
	}
	for _, link := range links {
		owner, loaded := byID[link.pluginID()]
		if link.Plugin == nil || !loaded {
			continue
		}
		if !strings.HasPrefix(link.Place, "window-") && !owner.Surface {
			return fmt.Errorf("%s: link names plugin %s without a surface", where, owner.ID)
		}
	}
	return nil
}
