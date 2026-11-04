package workbench

import "github.com/egoist/mygo/ui"

// ariaRoles names each role of the element tree with its ARIA role, the name that the audit reports on every host
// (docs/spec/hosts.md#workbench).
var ariaRoles = map[ui.Role]string{
	ui.RoleGroup: "group", ui.RoleText: "text", ui.RoleButton: "button", ui.RoleLink: "link", ui.RoleCheckBox: "checkbox",
	ui.RoleRadio: "radio", ui.RoleSwitch: "switch", ui.RoleSlider: "slider", ui.RoleProgress: "progressbar",
	ui.RoleTextField: "textbox", ui.RoleImage: "img", ui.RoleList: "list", ui.RoleScroll: "region", ui.RoleDialog: "dialog",
	ui.RolePopup: "dialog", ui.RoleTooltip: "tooltip", ui.RolePopUpButton: "combobox", ui.RoleTabList: "tablist", ui.RoleTab: "tab",
	ui.RoleSplitter: "separator", ui.RoleStatus: "status", ui.RoleTable: "table", ui.RoleRow: "row", ui.RoleCell: "cell",
	ui.RoleColumnHeader: "columnheader", ui.RoleTree: "tree", ui.RoleTreeItem: "treeitem", ui.RoleListItem: "listitem",
	ui.RoleMenuButton: "button", ui.RoleToolbar: "toolbar", ui.RoleRadioGroup: "radiogroup", ui.RoleToggleButton: "button",
	ui.RoleComboBox: "combobox", ui.RoleDisclosure: "button", ui.RoleMeter: "meter", ui.RoleStepper: "spinbutton",
	ui.RoleColorWell: "button", ui.RoleAlertDialog: "alertdialog", ui.RoleMenu: "menu", ui.RoleMenuBar: "menubar",
	ui.RoleMenuItem: "menuitem", ui.RoleMenuItemCheckBox: "menuitemcheckbox", ui.RoleMenuItemRadio: "menuitemradio",
	ui.RoleHeading: "heading", ui.RoleNavigation: "navigation",
}

// AriaRole returns the ARIA role of role.
func AriaRole(role ui.Role) string { return ariaRoles[role] }
