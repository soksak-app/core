package workbench

import (
	"encoding/json"
	"fmt"
	"slices"
	"time"
)

// The notice store of the workbench: one list of records for the toasts, the status lines and the entries of the notice center
// (docs/spec/notifications.md#notice-center). A record is shown while it is not closed; a closed record stays an entry until it is
// cleared, expires or its origin is withdrawn.

// noticeCenterAge is how long an entry other than an error or a progress notice stays (docs/spec/notifications.md#notice-center).
const noticeCenterAge = 7 * 24 * time.Hour

// noticeTimeoutMs is the time that a success or info toast stays shown (TOAST_MS of packages/workbench/notices.js).
const noticeTimeoutMs = 4000

// shownToasts returns the records that are shown, oldest first.
func (e *ShownErrors) shownToasts() []*errorToast {
	return slices.DeleteFunc(slices.Clone(e.toasts), func(toast *errorToast) bool { return toast.closed })
}

// recordOf returns the record with id, closed or not, or nil.
func (e *ShownErrors) recordOf(id string) *errorToast {
	at := slices.IndexFunc(e.toasts, func(toast *errorToast) bool { return toast.id == id })
	if at == -1 {
		return nil
	}
	return e.toasts[at]
}

// NoticeFields are the fields of a notice of the store, checked as tab.notify checks them (docs/spec/notifications.md#commands-and-statuses).
type NoticeFields = noticeFields

// NotifyFrom shows a notice of fields from source for origin: a shown notice of the same origin with the same kind and title takes the new text
// and actions and adds no count (docs/spec/notifications.md#notices).
func (e *ShownErrors) NotifyFrom(origin string, fields NoticeFields, source NoticeSource) string {
	if origin != "" && fields.Kind != "progress" {
		for _, toast := range e.toasts {
			if toast.origin != origin {
				continue
			}
			if toast.kind == fields.Kind && toast.title == fields.Title {
				// A closed occurrence stays closed: its entry is rewritten and no toast opens (docs/spec/notifications.md#notices).
				toast.text, toast.source, toast.actions, toast.at, toast.read = fields.Text, source, actionsOf(fields), e.now(), false
				if !toast.closed {
					e.scheduleNotice(toast)
				}
				return toast.id
			}
			toast.origin = ""
		}
	}
	id := e.Notify(fields, source)
	if origin != "" {
		e.recordOf(id).origin = origin
	}
	return id
}

// Notify shows a notice of fields from source and returns its id. A shown notice of the same kind and title takes the occurrence: its
// count grows and its fields take the new values. Progress notices never merge.
func (e *ShownErrors) Notify(fields noticeFields, source NoticeSource) string {
	if fields.Kind != "progress" {
		for _, toast := range e.toasts {
			if !toast.closed && toast.kind == fields.Kind && toast.title == fields.Title {
				toast.count++
				toast.text, toast.source, toast.actions, toast.at, toast.read = fields.Text, source, actionsOf(fields), e.now(), false
				e.scheduleNotice(toast)
				return toast.id
			}
		}
	}
	e.seq++
	toast := &errorToast{id: fmt.Sprintf("notice-%d", e.seq), kind: fields.Kind, title: fields.Title, text: fields.Text, count: 1,
		origins: map[errorOrigin]struct{}{}, source: source, actions: actionsOf(fields), at: e.now()}
	e.toasts = append(e.toasts, toast)
	e.scheduleNotice(toast)
	return toast.id
}

// actionsOf returns the actions of a notice as a list, which is empty for a notice without an action.
func actionsOf(fields noticeFields) []NoticeAction {
	if fields.Action == nil {
		return []NoticeAction{}
	}
	return []NoticeAction{*fields.Action}
}

// scheduleNotice gives a shown record the deadline of its kind: a progress notice has none, a success or info notice has a fixed
// time, and a warning or an error follows the setting of the problem toasts.
func (e *ShownErrors) scheduleNotice(toast *errorToast) {
	toast.stopTimer()
	switch toast.kind {
	case "progress":
		toast.timed = false
	case "success", "info":
		e.scheduleSpan(toast, noticeTimeoutMs)
	default:
		e.scheduleToast(toast)
	}
}

// ProgressNotice sets the progress of the progress notice id; progress is nil while the amount is unknown.
func (e *ShownErrors) ProgressNotice(id string, progress *float64) error {
	toast, err := e.progressRecord(id)
	if err != nil {
		return err
	}
	toast.progress = progress
	return nil
}

// progressRecord returns the progress record of id; the texts of the refusals are those of the web command.
func (e *ShownErrors) progressRecord(id string) (*errorToast, error) {
	toast := e.recordOf(id)
	if toast == nil {
		return nil, fmt.Errorf("notice %s is not an entry", id)
	}
	if toast.kind != "progress" {
		return nil, fmt.Errorf("notice %s is not a progress notice", id)
	}
	return toast, nil
}

// DoneNotice ends the progress notice id as kind, with title.
func (e *ShownErrors) DoneNotice(id, kind, title string) error {
	toast, err := e.progressRecord(id)
	if err != nil {
		return err
	}
	toast.kind, toast.title, toast.progress, toast.at = kind, title, nil, e.now()
	if !toast.closed {
		e.scheduleNotice(toast)
	}
	return nil
}

// ReadNotice marks the entry id read; an id that no entry has is refused.
func (e *ShownErrors) ReadNotice(id string) error {
	toast := e.recordOf(id)
	if toast == nil {
		return fmt.Errorf("notice %s is not an entry", id)
	}
	toast.read = true
	return nil
}

// ReadAllNotices marks every entry read.
func (e *ShownErrors) ReadAllNotices() {
	for _, toast := range e.toasts {
		toast.read = true
	}
}

// noticeGroup is the group of an entry in the center: progress, today, yesterday or its day (YYYY-MM-DD, local time).
func (e *ShownErrors) noticeGroup(toast *errorToast) string {
	if toast.kind == "progress" {
		return "progress"
	}
	now := e.now()
	switch toast.at.Format("2006-01-02") {
	case now.Format("2006-01-02"):
		return "today"
	case now.AddDate(0, 0, -1).Format("2006-01-02"):
		return "yesterday"
	}
	return toast.at.Format("2006-01-02")
}

// ClearNoticeGroup removes the entries of group, which is today, yesterday or a day (YYYY-MM-DD); progress entries are not in a clearable group.
func (e *ShownErrors) ClearNoticeGroup(group string) error {
	if group != "today" && group != "yesterday" && !isDay(group) {
		return fmt.Errorf("group %s is not today, yesterday or a day", group)
	}
	e.removeWhere(func(toast *errorToast) bool { return toast.kind != "progress" && e.noticeGroup(toast) == group })
	return nil
}

// isDay reports whether s is a day in the form YYYY-MM-DD.
func isDay(s string) bool {
	_, err := time.Parse("2006-01-02", s)
	return err == nil && len(s) == len("2006-01-02")
}

// ClearAllNotices removes every entry except the progress entries, which end with their work.
func (e *ShownErrors) ClearAllNotices() {
	e.removeWhere(func(toast *errorToast) bool { return toast.kind != "progress" })
}

// removeWhere removes the records for which remove returns true; a removed record releases its origins.
func (e *ShownErrors) removeWhere(remove func(*errorToast) bool) {
	for _, toast := range e.toasts {
		if remove(toast) {
			toast.stopTimer()
			for origin := range toast.origins {
				delete(e.occurrences, origin)
			}
		}
	}
	e.toasts = slices.DeleteFunc(e.toasts, remove)
}

// ExpireNotices drops the entries that are older than the age of the center, except the error and the progress entries.
func (e *ShownErrors) ExpireNotices() {
	limit := e.now().Add(-noticeCenterAge)
	e.removeWhere(func(toast *errorToast) bool {
		return toast.kind != "error" && toast.kind != "progress" && toast.at.Before(limit)
	})
}

// UnreadNotices counts the unread entries and reports whether an unread entry is a warning or an error.
func (e *ShownErrors) UnreadNotices() (int, bool) {
	unread, problems := 0, false
	for _, toast := range e.toasts {
		if toast.read {
			continue
		}
		unread++
		if toast.kind == "warning" || toast.kind == "error" {
			problems = true
		}
	}
	return unread, problems
}

// EntryStatuses returns the entries of the center, the newest first, after the expired ones are dropped.
func (e *ShownErrors) EntryStatuses() []map[string]any {
	e.ExpireNotices()
	list := make([]map[string]any, 0, len(e.toasts))
	for i := len(e.toasts) - 1; i >= 0; i-- {
		toast := e.toasts[i]
		item := map[string]any{"id": toast.id, "kind": toast.kind, "title": displayTitle(toast), "text": toast.text,
			"source": toast.source, "actions": toast.actions, "at": toast.at.Format(time.RFC3339), "count": toast.count, "read": toast.read}
		if toast.kind == "progress" {
			item["progress"] = toast.progress
		}
		list = append(list, item)
	}
	return list
}

// storedNotice is an entry of notices.json (docs/spec/notifications.md#notice-center).
type storedNotice struct {
	ID      string         `json:"id"`
	Kind    string         `json:"kind"`
	Title   string         `json:"title"`
	Text    string         `json:"text"`
	Source  NoticeSource   `json:"source"`
	Actions []NoticeAction `json:"actions"`
	At      string         `json:"at"`
	Count   int            `json:"count"`
	Read    bool           `json:"read"`
}

// RestoreNotices replaces nothing: it adds the entries of notices.json, which the host read as document, as closed records. A document
// that does not hold the current form, or an entry with an invalid time, is refused and no entry is added.
func (e *ShownErrors) RestoreNotices(document any) error {
	if document == nil {
		return nil
	}
	encoded, err := json.Marshal(document)
	if err != nil {
		return fmt.Errorf("notices.json: %w", err)
	}
	var stored struct {
		Format  int            `json:"format"`
		Notices []storedNotice `json:"notices"`
	}
	if err := json.Unmarshal(encoded, &stored); err != nil || stored.Format != 1 {
		return fmt.Errorf("notices.json holds no notices of format 1: %s", encoded)
	}
	restored := make([]*errorToast, 0, len(stored.Notices))
	for _, notice := range stored.Notices {
		at, err := time.Parse(time.RFC3339, notice.At)
		if err != nil {
			return fmt.Errorf("notices.json: notice %s has no valid time", notice.ID)
		}
		e.seq++
		restored = append(restored, &errorToast{id: fmt.Sprintf("notice-%d", e.seq), kind: notice.Kind, title: notice.Title, text: notice.Text,
			count: notice.Count, origins: map[errorOrigin]struct{}{}, source: notice.Source, actions: notice.Actions, at: at, read: notice.Read,
			closed: true})
	}
	e.toasts = append(restored, e.toasts...)
	e.ExpireNotices()
	return nil
}

// PersistableNotices returns the entries that notices.json holds: the entries without progress, after the expired ones are dropped.
func (e *ShownErrors) PersistableNotices() []map[string]any {
	e.ExpireNotices()
	list := []map[string]any{}
	for _, toast := range e.toasts {
		if toast.kind == "progress" {
			continue
		}
		list = append(list, map[string]any{"id": toast.id, "kind": toast.kind, "title": toast.title, "text": toast.text, "source": toast.source,
			"actions": toast.actions, "at": toast.at.Format(time.RFC3339), "count": toast.count, "read": toast.read})
	}
	return list
}

// noticeFilters are the filters of the center (docs/spec/notifications.md#notice-center).
var noticeFilters = []string{"all", "problems", "progress"}

// ToggleNotices opens or closes the center. Opening drops the expired entries, so the file written after it holds no expired entry.
func (e *ShownErrors) ToggleNotices() {
	e.noticeOpen = !e.noticeOpen
	if e.noticeOpen {
		e.ExpireNotices()
	}
}

// SetNoticeFilter sets the filter of the center; a value that is not a filter is refused.
func (e *ShownErrors) SetNoticeFilter(filter string) error {
	if !slices.Contains(noticeFilters, filter) {
		return fmt.Errorf("filter %s is not one of all, problems, progress", filter)
	}
	e.noticeFilter = filter
	return nil
}

// bellTitle is the tooltip of the bell: the notice center, with the number of unread entries while there are some.
func (s *Shell) bellTitle() string {
	unread, _ := s.errors.UnreadNotices()
	if unread == 0 {
		return "알림 센터"
	}
	return fmt.Sprintf("알림 센터, 읽지 않음 %d개", unread)
}
