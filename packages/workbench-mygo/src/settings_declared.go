package workbench

import "fmt"

// DeclaredPage is a settings page of a declaration: its sections in order, each with its items, and each item names a component of the
// component set (docs/spec/settings.md#declaration).
type DeclaredPage struct {
	ID       string
	Label    string
	Sections []DeclaredSection
}

// DeclaredSection is a section of a declared page: its label and its items in order.
type DeclaredSection struct {
	ID    string
	Label string
	Items []DeclaredItem
}

// DeclaredItem is one item of a declared section: the component that draws it, its label and the setting key that it changes.
type DeclaredItem struct {
	Component string
	Label     string
	Key       string
}

// declaredComponents maps each component of the set to the exposed element that it draws (docs/spec/settings.md#controls).
var declaredComponents = map[string]string{
	"Toggle":    "core.settings-tab.set",
	"Segmented": "core.settings-tab.choice",
	"Select":    "core.settings-tab.choice",
}

// declaredItemPlan is an item lowered to the exposed element and the setting key of its component.
type declaredItemPlan struct {
	label    string
	key      string
	exposure string
}

// declaredSectionPlan is a section lowered to its label and its item plans.
type declaredSectionPlan struct {
	label string
	items []declaredItemPlan
}

// planDeclaredPage lowers a page to its sections in declaration order. An item whose component is not in the component set refuses the
// whole page, and the error names the page, the section, the item and the component.
func planDeclaredPage(page DeclaredPage) ([]declaredSectionPlan, error) {
	plan := make([]declaredSectionPlan, 0, len(page.Sections))
	for _, section := range page.Sections {
		lowered := declaredSectionPlan{label: section.Label, items: make([]declaredItemPlan, 0, len(section.Items))}
		for i, item := range section.Items {
			exposure, ok := declaredComponents[item.Component]
			if !ok {
				return nil, fmt.Errorf("page %s, section %s, item %d: component %s is not in the component set", page.ID, section.ID, i, item.Component)
			}
			lowered.items = append(lowered.items, declaredItemPlan{label: item.Label, key: item.Key, exposure: exposure})
		}
		plan = append(plan, lowered)
	}
	return plan, nil
}
