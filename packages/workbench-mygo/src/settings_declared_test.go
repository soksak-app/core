package workbench

import (
	"strings"
	"testing"
)

// A page declaration lowers to its sections in declaration order, and each item to the exposed element of its component, so the three
// items of two sections draw as three exposed controls in order (docs/spec/settings.md#declarations).
func TestADeclaredPageLowersSectionsAndItemsInOrder(t *testing.T) {
	page := DeclaredPage{ID: "main", Label: "Main", Sections: []DeclaredSection{
		{ID: "one", Label: "First", Items: []DeclaredItem{
			{Component: "Toggle", Label: "Dim", Key: "dim"},
		}},
		{ID: "two", Label: "Second", Items: []DeclaredItem{
			{Component: "Segmented", Label: "Mode", Key: "mode"},
			{Component: "Select", Label: "Opening", Key: "projectOpening"},
		}},
	}}
	plan, err := planDeclaredPage(page)
	if err != nil {
		t.Fatalf("a valid page is refused: %v", err)
	}
	var labels, names, keys []string
	for _, section := range plan {
		labels = append(labels, section.label)
		for _, item := range section.items {
			names = append(names, item.exposure)
			keys = append(keys, item.key)
		}
	}
	if strings.Join(labels, ",") != "First,Second" {
		t.Fatalf("section labels = %v; want First, Second", labels)
	}
	if strings.Join(names, ",") != "core.settings-tab.set,core.settings-tab.choice,core.settings-tab.choice" {
		t.Fatalf("exposed controls = %v", names)
	}
	if strings.Join(keys, ",") != "dim,mode,projectOpening" {
		t.Fatalf("item keys = %v; want dim, mode, projectOpening", keys)
	}
}

// A component that is not in the component set refuses the page, and the error names the component.
func TestADeclaredPageRefusesAnUnknownComponentByName(t *testing.T) {
	page := DeclaredPage{ID: "main", Label: "Main", Sections: []DeclaredSection{
		{ID: "one", Label: "First", Items: []DeclaredItem{{Component: "Dropdown", Label: "X", Key: "x"}}},
	}}
	_, err := planDeclaredPage(page)
	if err == nil || !strings.Contains(err.Error(), "Dropdown") {
		t.Fatalf("an unknown component error = %v; want it to name Dropdown", err)
	}
}
