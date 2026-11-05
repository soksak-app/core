package workbench

import (
	"encoding/json"
	"fmt"
	"maps"
	"slices"
	"strings"
	"unicode/utf16"

	"github.com/egoist/mygo/ui"
)

// The notices of the tabs (docs/spec/plugins.md#tab-reports), as packages/workbench/tab-reports.js and
// packages/workbench/system-notifications.js hold them. A notice of a tab that is not visible marks its tab, or with the policy
// system stands as a notification of the operating system. Showing the tab removes it.

// noticeLimit is the longest notice in the UTF-16 units of the plugin API.
const noticeLimit = 1024

// noticeDenied is the last line of the help of a notice while the operating system refuses notifications.
const noticeDenied = "System notifications are turned off for this application."

// systemNotices is the state of the notification center for a window.
type systemNotices struct {
	// posted holds the text of each notice sent to the center, and accepted the tabs whose notice it accepted.
	posted        map[string]string
	accepted      []string
	authorization string
	failure       *string
}

func newSystemNotices() *systemNotices {
	return &systemNotices{posted: map[string]string{}, accepted: []string{}, authorization: "notDetermined"}
}

// notificationStatus is the status core.notifications.
type notificationStatus struct {
	Authorization string   `json:"authorization"`
	Error         *string  `json:"error"`
	Posted        []string `json:"posted"`
}

func controlled(text string) bool {
	for _, r := range text {
		if r <= 0x1f || (r >= 0x7f && r <= 0x9f) {
			return true
		}
	}
	return false
}

// noticePolicy reads the policy of a notice, which a view may leave out.
func noticePolicy(raw json.RawMessage) (string, error) {
	if len(raw) == 0 {
		return "tab", nil
	}
	var policy string
	if err := json.Unmarshal(raw, &policy); err != nil || (policy != "tab" && policy != "system") {
		return "", fmt.Errorf("unknown tab notice policy: %s", strings.Trim(string(raw), `"`))
	}
	return policy, nil
}

// reportNotice puts a notice on a tab that is not visible. A visible tab already shows its surface, so nothing changes.
func (s *Shell) reportNotice(tab string, notice tabNotice) error {
	if length := len(utf16.Encode([]rune(notice.Text))); length == 0 || length > noticeLimit || controlled(notice.Text) {
		return fmt.Errorf("a tab notice must be 1 to %d characters without control characters", noticeLimit)
	}
	policy, err := noticePolicy(notice.Policy)
	if err != nil {
		return err
	}
	if s.tabVisible(tab) {
		return nil
	}
	report := s.report(tab)
	if report.Notice != nil && report.Notice.Text == notice.Text && report.noticePolicy == policy {
		return nil
	}
	report.Notice, report.noticePolicy = &notice, policy
	s.syncNotices()
	s.options.Invalidate()
	return nil
}

// tabVisible tells whether the tab is the active tab of the focused card, which is where the eyes of a person are.
func (s *Shell) tabVisible(tab string) bool {
	if s.plane == nil || s.focused == "" {
		return false
	}
	data, err := s.cardData(s.focused)
	if err != nil || data == nil {
		return false
	}
	active := data.ActiveTab()
	return active != nil && active.ID == tab
}

// tabNoticeText returns the text of the mark of a tab. A notice of the policy system stands in the notification center instead.
func (s *Shell) tabNoticeText(tab string) string {
	report := s.surfaces.reports[tab]
	if report == nil || report.Notice == nil || report.noticePolicy == "system" {
		return ""
	}
	return report.Notice.Text
}

// clearVisibleNotices removes the notice of each tab that a frame showed.
func (s *Shell) clearVisibleNotices() {
	removed := false
	for tab, report := range s.surfaces.reports {
		if report.Notice != nil && s.tabVisible(tab) {
			report.Notice, report.noticePolicy = nil, ""
			removed = true
		}
	}
	if removed {
		s.syncNotices()
		s.options.Invalidate()
	}
}

// tabTitle returns the name of the tab of a notification.
func (s *Shell) tabTitle(tab string) string {
	if held := s.surfaces.held[tab]; held != nil {
		return s.tabName(held.tab)
	}
	return tab
}

// syncNotices posts each new or changed notice of the policy system and removes each one that left.
func (s *Shell) syncNotices() {
	notices := s.notices
	for tab, report := range s.surfaces.reports {
		if report.Notice == nil || report.noticePolicy != "system" || notices.posted[tab] == report.Notice.Text {
			continue
		}
		notices.posted[tab] = report.Notice.Text
		request := map[string]string{"surface": tab, "title": s.tabTitle(tab), "body": report.Notice.Text}
		s.calls.Call("notify", request, s.noticeFailed("post"))
	}
	for _, tab := range slices.Sorted(maps.Keys(notices.posted)) {
		if report := s.surfaces.reports[tab]; report != nil && report.Notice != nil && report.noticePolicy == "system" {
			continue
		}
		delete(notices.posted, tab)
		notices.accepted = slices.DeleteFunc(notices.accepted, func(id string) bool { return id == tab })
		s.calls.Call("notificationRemove", map[string]string{"surface": tab}, s.noticeFailed("remove"))
	}
}

// noticeFailed returns the answer of a call of the notification center, which names a failure in core.notifications.
func (s *Shell) noticeFailed(operation string) func(any, error) {
	return func(_ any, err error) {
		if err != nil {
			reason := operation + ": " + err.Error()
			s.notices.failure = &reason
			s.options.Invalidate()
		}
	}
}

// noticeState reads the state of the notification center, in the first call and in the event notification-state.
func (s *Shell) noticeState(value any) {
	state, err := decode[struct {
		Authorization string  `json:"authorization"`
		Error         *string `json:"error"`
	}](value)
	if err != nil {
		s.noticeFailed("state")(nil, err)
		return
	}
	s.notices.authorization, s.notices.failure = state.Authorization, state.Error
	s.options.Invalidate()
}

// noticeEvent handles an event of the notification center and tells whether it was one.
func (s *Shell) noticeEvent(name string, data []any) bool {
	if name != "notification-state" && name != "notification-posted" && name != "notification-activated" {
		return false
	}
	if len(data) != 1 {
		s.noticeFailed(name)(nil, fmt.Errorf("the event carries %d values, want one", len(data)))
		return true
	}
	if name == "notification-state" {
		s.noticeState(data[0])
		return true
	}
	event, err := decode[surfaceEvent](data[0])
	if err != nil {
		s.noticeFailed(name)(nil, err)
		return true
	}
	if name == "notification-activated" {
		params, err := json.Marshal(tabParam{event.Surface})
		if err != nil {
			s.noticeFailed("activate")(nil, err)
			return true
		}
		s.registry.RunLater("core.tab.select", params, s.noticeFailed("activate"))
		return true
	}
	if _, posted := s.notices.posted[event.Surface]; posted && !slices.Contains(s.notices.accepted, event.Surface) {
		s.notices.accepted = append(s.notices.accepted, event.Surface)
		s.options.Invalidate()
	}
	return true
}

// startNotices reads the state of the notification center and declares core.notifications.
func (s *Shell) startNotices(done func()) {
	s.calls.Call("notificationState", nil, func(value any, err error) {
		defer done()
		if err != nil {
			s.noticeFailed("state")(nil, err)
			return
		}
		s.noticeState(value)
	})
}

// noticeMark draws the dot of a tab that holds a notice. Its label is the help of the notice.
func (s *Shell) noticeMark(c *ui.Context, tab string) {
	text := s.tabNoticeText(tab)
	if text == "" {
		return
	}
	if s.notices.authorization == "denied" {
		text += "\n" + noticeDenied
	}
	ui.Box(c.Key("notice-"+tab)).Role(ui.RoleStatus).Label(text).Size(s.metrics.noticeDot, s.metrics.noticeDot).
		Radius(s.metrics.noticeDot / 2).Background(s.palette.Focus)
}
