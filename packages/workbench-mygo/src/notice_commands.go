package workbench

import (
	"encoding/json"
	"fmt"
)

// The commands and the status of the notice center (docs/spec/notifications.md#commands-and-statuses). Each refusal is -32602 with the
// text of the web command (packages/workbench/core-exposure.js).

// noticeFieldNames are the fields of a notice of core.notices.add, which the card and plugin fields do not belong to.
var noticeFieldNames = []string{"kind", "title", "text", "action", "system"}

// registerNotices registers the status core.notices and the commands of the notice entries.
func (s *Shell) registerNotices() {
	s.registry.Status("core.notices", func() any { return s.noticeStatus() })
	s.registry.Command("core.notices.add", func(raw json.RawMessage) (any, error) { return s.noticeAdd(raw) })
	s.registry.Command("core.notices.progress", func(raw json.RawMessage) (any, error) { return s.noticeProgress(raw) })
	s.registry.Command("core.notices.done", func(raw json.RawMessage) (any, error) { return s.noticeDone(raw) })
	s.registry.Command("core.notices.read", func(raw json.RawMessage) (any, error) { return s.noticeRead(raw) })
	s.registry.Command("core.notices.toggle", func(json.RawMessage) (any, error) {
		s.errors.ToggleNotices()
		return s.noticeChanged()
	})
	s.registry.Command("core.notices.filter", func(raw json.RawMessage) (any, error) { return s.noticeFilter(raw) })
	s.registry.Command("core.notices.read-all", func(json.RawMessage) (any, error) {
		s.errors.ReadAllNotices()
		return s.noticeChanged()
	})
	s.registry.Command("core.notices.clear", func(raw json.RawMessage) (any, error) { return s.noticeClear(raw) })
	s.registry.Command("core.notices.clear-all", func(json.RawMessage) (any, error) {
		s.errors.ClearAllNotices()
		return s.noticeChanged()
	})
}

// noticeStatus returns the value of core.notices.
func (s *Shell) noticeStatus() map[string]any {
	entries := s.errors.EntryStatuses()
	unread, problems := s.errors.UnreadNotices()
	style := "popover"
	if value, ok := s.settings.Value("noticeCenterStyle").(string); ok && value != "" {
		style = value
	}
	return map[string]any{"open": s.errors.noticeOpen, "style": style, "filter": s.errors.noticeFilter, "unread": unread, "problems": problems, "entries": entries}
}

// noticeChanged writes the entries to notices.json and asks for a frame, and returns nothing.
func (s *Shell) noticeChanged() (any, error) {
	s.persistNotices()
	s.options.Invalidate()
	return nil, nil
}

// persistNotices writes the entries of the center to notices.json in the order of the calls. A refused write is reported.
func (s *Shell) persistNotices() {
	s.calls.CallInOrder("notices", "workspace", map[string]any{"kind": "noticesPut", "notices": s.errors.PersistableNotices()}, func(_ any, err error) {
		if err != nil {
			s.fail(err)
		}
	})
}

// loadNotices reads notices.json at start. The read is ordered before the writes, and the first draw does not wait for it.
func (s *Shell) loadNotices() {
	s.calls.CallInOrder("notices", "workspace", map[string]any{"kind": "notices"}, func(value any, err error) {
		if err != nil {
			s.fail(err)
			return
		}
		if err := s.errors.RestoreNotices(value); err != nil {
			s.fail(err)
			return
		}
		s.options.Invalidate()
	})
}

// noticeAdd gives a card or a plugin a notice and returns its id.
func (s *Shell) noticeAdd(raw json.RawMessage) (any, error) {
	object, err := decodeObject(raw)
	if err != nil {
		return nil, Refuse(InvalidParams, "%s", err)
	}
	cardRaw, hasCard := object["card"]
	pluginRaw, hasPlugin := object["plugin"]
	if hasCard == hasPlugin {
		return nil, Refuse(InvalidParams, "core.notices.add takes exactly one of card and plugin")
	}
	delete(object, "card")
	delete(object, "plugin")
	fieldsRaw, err := json.Marshal(object)
	if err != nil {
		return nil, Refuse(InvalidParams, "%s", err)
	}
	if _, err := plainObject(fieldsRaw, noticeFieldNames, "a notice"); err != nil {
		return nil, Refuse(InvalidParams, "%s", err)
	}
	var source NoticeSource
	if hasPlugin {
		name := rawText(pluginRaw)
		if s.loadedPlugin(name) == nil {
			return nil, Refuse(InvalidParams, "plugin %s does not exist", name)
		}
		fields, err := checkNoticeFields(object)
		if err != nil {
			return nil, Refuse(InvalidParams, "%s", err)
		}
		if fields.System != nil && *fields.System {
			return nil, Refuse(InvalidParams, "core.notices.add with plugin takes no system flag; a page of the plugin posts system notices")
		}
		source = NoticeSource{Kind: "plugin", Plugin: name}
		return s.addNotice(fields, source)
	}
	card := rawText(cardRaw)
	target, ok := s.planes.Card(card)
	if !ok {
		return nil, Refuse(InvalidParams, "card %s does not exist", card)
	}
	data, err := s.readCard(target)
	if err != nil {
		return nil, err
	}
	active := data.ActiveTab()
	if active == nil {
		return nil, Refuse(InvalidParams, "card %s has no tab", card)
	}
	fields, err := checkNoticeFields(object)
	if err != nil {
		return nil, Refuse(InvalidParams, "%s", err)
	}
	source = NoticeSource{Kind: "card", Card: card, Tab: active.ID, Label: active.Title, Plugin: active.Plugin}
	return s.addNotice(fields, source)
}

// addNotice adds the notice to the center, writes the center, and returns the id of the notice.
func (s *Shell) addNotice(fields noticeFields, source NoticeSource) (any, error) {
	id := s.errors.Notify(fields, source)
	s.persistNotices()
	s.options.Invalidate()
	return id, nil
}

// noticeProgress sets the progress of a progress notice; progress is null or a number from 0 to 1.
func (s *Shell) noticeProgress(raw json.RawMessage) (any, error) {
	object, err := plainObject(raw, []string{"id", "progress"}, "a notice progress")
	if err != nil {
		return nil, Refuse(InvalidParams, "%s", err)
	}
	id, ok := decodeString(object["id"])
	if !ok || id == "" {
		return nil, Refuse(InvalidParams, "a notice id must be a non-empty string")
	}
	var progress *float64
	if value := object["progress"]; string(value) != "null" {
		var number float64
		if err := json.Unmarshal(value, &number); err != nil || number < 0 || number > 1 {
			return nil, Refuse(InvalidParams, "a notice progress must be a number from 0 to 1, or null while the amount is unknown")
		}
		progress = &number
	}
	if err := s.errors.ProgressNotice(id, progress); err != nil {
		return nil, Refuse(InvalidParams, "%s", err)
	}
	return s.noticeChanged()
}

// noticeDone ends a progress notice as success or error.
func (s *Shell) noticeDone(raw json.RawMessage) (any, error) {
	object, err := plainObject(raw, []string{"id", "kind", "title"}, "a finished notice")
	if err != nil {
		return nil, Refuse(InvalidParams, "%s", err)
	}
	id, ok := decodeString(object["id"])
	if !ok || id == "" {
		return nil, Refuse(InvalidParams, "a notice id must be a non-empty string")
	}
	kind, ok := decodeString(object["kind"])
	if !ok || (kind != "success" && kind != "error") {
		return nil, Refuse(InvalidParams, "a finished notice must be success or error")
	}
	fields, err := checkNoticeFields(map[string]json.RawMessage{"kind": json.RawMessage(`"info"`), "title": object["title"]})
	if err != nil {
		return nil, Refuse(InvalidParams, "%s", err)
	}
	if err := s.errors.DoneNotice(id, kind, fields.Title); err != nil {
		return nil, Refuse(InvalidParams, "%s", err)
	}
	return s.noticeChanged()
}

// noticeRead marks one entry read.
func (s *Shell) noticeRead(raw json.RawMessage) (any, error) {
	var params struct {
		ID json.RawMessage `json:"id"`
	}
	if err := json.Unmarshal(raw, &params); err != nil {
		return nil, Refuse(InvalidParams, "%s", err)
	}
	id, ok := decodeString(params.ID)
	if !ok {
		id = rawText(params.ID)
	}
	if err := s.errors.ReadNotice(id); err != nil {
		return nil, Refuse(InvalidParams, "%s", err)
	}
	return s.noticeChanged()
}

// noticeClear removes the entries of a group of the center.
func (s *Shell) noticeClear(raw json.RawMessage) (any, error) {
	var params struct {
		Group json.RawMessage `json:"group"`
	}
	if err := json.Unmarshal(raw, &params); err != nil {
		return nil, Refuse(InvalidParams, "%s", err)
	}
	group, ok := decodeString(params.Group)
	if !ok {
		group = rawText(params.Group)
	}
	if err := s.errors.ClearNoticeGroup(group); err != nil {
		return nil, Refuse(InvalidParams, "%s", err)
	}
	return s.noticeChanged()
}

// decodeObject returns the keys of a JSON object, and refuses any other value.
func decodeObject(raw json.RawMessage) (map[string]json.RawMessage, error) {
	var object map[string]json.RawMessage
	if err := json.Unmarshal(raw, &object); err != nil || object == nil {
		return nil, fmt.Errorf("params must be an object")
	}
	return object, nil
}

// rawText is the JSON text of a value, which names the value of a refusal that is not a string.
func rawText(raw json.RawMessage) string {
	if text, ok := decodeString(raw); ok {
		return text
	}
	return string(raw)
}

// noticeFilter sets the filter of the center.
func (s *Shell) noticeFilter(raw json.RawMessage) (any, error) {
	var params struct {
		Filter json.RawMessage `json:"filter"`
	}
	if err := json.Unmarshal(raw, &params); err != nil {
		return nil, Refuse(InvalidParams, "%s", err)
	}
	filter, ok := decodeString(params.Filter)
	if !ok {
		filter = rawText(params.Filter)
	}
	if err := s.errors.SetNoticeFilter(filter); err != nil {
		return nil, Refuse(InvalidParams, "%s", err)
	}
	return s.noticeChanged()
}
