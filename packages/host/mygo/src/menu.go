package adapter

import (
	"fmt"
	"strings"

	"github.com/egoist/mygo"

	host "github.com/soksak-app/core/packages/host/go/src"
)

// menuRoles are the mygo roles that the item ids of the contract table use.
var menuRoles = map[string]mygo.MenuRole{
	"about":              mygo.RoleAbout,
	"services":           mygo.RoleServices,
	"hide":               mygo.RoleHide,
	"hide-others":        mygo.RoleHideOthers,
	"show-all":           mygo.RoleUnhide,
	"quit":               mygo.RoleQuit,
	"close-window":       mygo.RoleClose,
	"undo":               mygo.RoleUndo,
	"redo":               mygo.RoleRedo,
	"cut":                mygo.RoleCut,
	"copy":               mygo.RoleCopy,
	"paste":              mygo.RolePaste,
	"select-all":         mygo.RoleSelectAll,
	"fullscreen":         mygo.RoleToggleFullScreen,
	"bring-all-to-front": mygo.RoleFront,
}

// menuModifiers converts the shortcut modifier keys of the contract table to mygo modifier keys.
var menuModifiers = map[string]string{
	"cmd":   "CmdOrCtrl",
	"shift": "Shift",
	"ctrl":  "Ctrl",
	"opt":   "Alt",
}

// ApplicationMenuFor builds the mygo menu of the application menu of the contract table in language.
func ApplicationMenuFor(language string) (*mygo.Menu, error) {
	menus, err := host.ApplicationMenuFor(language)
	if err != nil {
		return nil, err
	}
	return applicationMenu(menus)
}

// applicationMenu builds the mygo menu of menus.
func applicationMenu(menus []host.Menu) (*mygo.Menu, error) {
	entries := make([]*mygo.MenuItem, 0, len(menus))
	for _, entry := range menus {
		items := make([]*mygo.MenuItem, 0, len(entry.Items))
		for _, item := range entry.Items {
			built, err := menuItem(item)
			if err != nil {
				return nil, err
			}
			items = append(items, built)
		}
		entries = append(entries, &mygo.MenuItem{Label: entry.Title, Submenu: items})
	}
	return mygo.NewMenu(entries), nil
}

// menuItem builds an item. An item with Run is a command item with its title and shortcut. A role item takes the title and the
// shortcut of the contract table when the table has them, and otherwise keeps those that the framework provides.
func menuItem(entry host.MenuItem) (*mygo.MenuItem, error) {
	accelerator, err := menuAccelerator(entry.Key)
	if err != nil {
		return nil, err
	}
	item := &mygo.MenuItem{Label: entry.Title, Accelerator: accelerator}
	if entry.Run != nil {
		run := entry.Run
		item.Click = func(*mygo.MenuItem, *mygo.Window) { run() }
		return item, nil
	}
	role, ok := menuRoles[entry.Role]
	if !ok {
		return nil, fmt.Errorf("the menu table has no role for item %q", entry.Role)
	}
	item.Role = role
	return item, nil
}

// menuAccelerator converts a shortcut of the contract table (cmd+w) to a mygo shortcut (CmdOrCtrl+w). An empty key is an empty
// shortcut, and a modifier key that is not in the table returns an error.
func menuAccelerator(key string) (string, error) {
	if key == "" {
		return "", nil
	}
	parts := strings.Split(key, "+")
	out := make([]string, 0, len(parts))
	for _, part := range parts[:len(parts)-1] {
		mapped, ok := menuModifiers[part]
		if !ok {
			return "", fmt.Errorf("menu key %q has an unknown modifier %q", key, part)
		}
		out = append(out, mapped)
	}
	return strings.Join(append(out, parts[len(parts)-1]), "+"), nil
}
