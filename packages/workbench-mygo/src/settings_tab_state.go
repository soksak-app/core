package workbench

// The state of the settings tab that its commands change (docs/spec/settings.md#status). The state is part of the key of the model
// where the model reads it, so a change builds the model once.

// settingsBrowse is the state of 찾아보기: its search text, its switch and the number of rows it shows.
type settingsBrowse struct {
	query         string
	hideInstalled bool
	// limit is the number of catalog rows shown; it starts at the first 30 rows and grows by 30 with core.settings-tab.browse {more}.
	limit int
}

// settingsBrowseFirst is the number of rows that 찾아보기 shows at once (docs/spec/settings.md#찾아보기).
const settingsBrowseFirst = 30

// settingsConfirm is the open confirmation of a set or a plugin removal (docs/spec/settings.md#사이드바-세트).
type settingsConfirm struct {
	kind, id string
}

// settingsUndo is the toast of the last change on the tab: the key, the label and the old and new values, with the scope of the change
// and the cancel of its deadline.
type settingsUndo struct {
	key, label, scope string
	old, new          any
	cancel            func()
}

// settingsBrowseStatus is the browse member of the status.
type settingsBrowseStatus struct {
	Query         string `json:"query"`
	HideInstalled bool   `json:"hideInstalled"`
	Shown         int    `json:"shown"`
}

// settingsActionStatus is one action button of the plugin rows and pages.
type settingsActionStatus struct {
	Plugin   string `json:"plugin"`
	Action   string `json:"action"`
	Disabled bool   `json:"disabled"`
}

// settingsUndoStatus is the toast of the status.
type settingsUndoStatus struct {
	Key   string `json:"key"`
	Label string `json:"label"`
	Old   any    `json:"old"`
	New   any    `json:"new"`
}

// settingsConfirmStatus is the open confirmation of the status.
type settingsConfirmStatus struct {
	Kind string `json:"kind"`
	ID   string `json:"id"`
}

// settingsErrorStatus is one error line that the tab shows.
type settingsErrorStatus struct {
	Key  string `json:"key"`
	Text string `json:"text"`
}

// settingsResultsStatus is the result of a search: the keys of the matching settings, the ids of the matching installed plugins and the
// number of matching catalog plugins.
type settingsResultsStatus struct {
	Settings []string `json:"settings"`
	Plugins  []string `json:"plugins"`
	Catalog  int      `json:"catalog"`
}
