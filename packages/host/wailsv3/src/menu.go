package adapter

import (
	"fmt"
	"strings"

	"github.com/wailsapp/wails/v3/pkg/application"

	host "github.com/soksak-app/core/packages/host/go/src"
)

// menuRoles are the Wails roles that the item ids of the contract table use. The app items also pass through here with the titles of the language table, and
// close-all is not here because the performClose: role of close-window provides it together with the system.
// fullscreen was measured: unlike an earlier measurement that said the system adds it to the View menu by itself, in these apps it does not
// appear even when the menu opens (2026-09-30, V5-112), so it is created here.
var menuRoles = map[string]application.Role{
	"about":              application.About,
	"services":           application.ServicesMenu,
	"hide":               application.Hide,
	"hide-others":        application.HideOthers,
	"show-all":           application.ShowAll,
	"quit":               application.Quit,
	"close-window":       application.CloseWindow,
	"undo":               application.Undo,
	"redo":               application.Redo,
	"cut":                application.Cut,
	"copy":               application.Copy,
	"paste":              application.Paste,
	"select-all":         application.SelectAll,
	"fullscreen":         application.FullScreen,
	"bring-all-to-front": application.BringAllToFront,
}

// menuModifiers converts the shortcut modifier keys of the contract table to Wails modifier keys.
var menuModifiers = map[string]string{
	"cmd":   "CmdOrCtrl",
	"shift": "Shift",
	"ctrl":  "Ctrl",
	// Wails does not recognize "OptOrAlt" but recognizes "OptionOrAlt".
	"opt": "OptionOrAlt",
}

// ApplicationMenuFor builds the Wails menu of the application menu of the contract table in language.
func ApplicationMenuFor(language string) (*application.Menu, error) {
	menus, err := host.ApplicationMenuFor(language)
	if err != nil {
		return nil, err
	}
	return applicationMenu(menus)
}

// applicationMenu builds the Wails menu of menus.
func applicationMenu(menus []host.Menu) (*application.Menu, error) {
	menu := application.NewMenu()
	for _, entry := range menus {
		submenu := menu.AddSubmenu(entry.Title)
		for _, item := range entry.Items {
			if err := addMenuItem(submenu, item); err != nil {
				return nil, err
			}
		}
	}
	return menu, nil
}

// addMenuItem builds an item in submenu. An item with Run is a command item with its title and shortcut. A role item changes its
// title and shortcut to those of the contract table when the table has them, and otherwise keeps those that the framework provides.
func addMenuItem(submenu *application.Menu, entry host.MenuItem) error {
	accelerator, err := menuAccelerator(entry.Key)
	if err != nil {
		return err
	}
	var item *application.MenuItem
	if entry.Run != nil {
		item = submenu.Add(entry.Title)
		item.OnClick(func(*application.Context) { entry.Run() })
	} else {
		role, ok := menuRoles[entry.Role]
		if !ok {
			return fmt.Errorf("the menu table has no role for item %q", entry.Role)
		}
		if item = addRoleItem(submenu, role); item == nil {
			return fmt.Errorf("menu role %v has no item", role)
		}
		if entry.Title != "" {
			item.SetLabel(entry.Title)
		}
	}
	if accelerator != "" {
		item.SetAccelerator(accelerator)
	}
	return nil
}

// addRoleItem puts a role item into submenu and returns that item. Menu.AddRole returns the menu, so
// the role item just put in is found by its role.
func addRoleItem(submenu *application.Menu, role application.Role) *application.MenuItem {
	submenu.AddRole(role)
	return submenu.FindByRole(role)
}

// menuAccelerator converts a shortcut of the contract table (cmd+w) to a Wails shortcut (CmdOrCtrl+w). An empty key is an empty
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
