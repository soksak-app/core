package host

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"unicode"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// NotificationRequest 는 탭 하나의 시스템 알림이다(docs/spec/plugins.md#tab-reports). 지울 때는 Surface 만 쓴다.
type NotificationRequest struct {
	Surface string `json:"surface"`
	Title   string `json:"title,omitempty"`
	Body    string `json:"body,omitempty"`
}

// NotificationState 는 알림 센터의 권한과 권한 요청, 게시, 제거의 마지막 실패다.
type NotificationState struct {
	Authorization string  `json:"authorization"`
	Error         *string `json:"error"`
}

// notificationText 는 제어 문자 없는 1 에서 limit 글자의 텍스트만 허용한다.
func notificationText(field, value string, limit int) error {
	if value == "" || len([]rune(value)) > limit || strings.IndexFunc(value, unicode.IsControl) >= 0 {
		return fmt.Errorf("notification %s must be 1 to %d characters without control characters", field, limit)
	}
	return nil
}

// ValidateNotification 은 알림 요청을 확인한다. removal 이면 표면만 확인한다.
func ValidateNotification(request NotificationRequest, removal bool) error {
	if err := notificationText("surface", request.Surface, 256); err != nil || removal {
		return err
	}
	if err := notificationText("title", request.Title, 256); err != nil {
		return err
	}
	return notificationText("body", request.Body, 1024)
}

// notificationIdentifier 는 알림 센터의 식별자다. 누른 알림을 창 이름과 표면으로 돌려받는다.
func notificationIdentifier(window, surface string) string {
	// 기본값: 문자열 목록의 JSON 변환은 실패하지 않으므로 오류 값을 받지 않는다.
	identifier, _ := json.Marshal([]string{window, surface})
	return string(identifier)
}

// startNotifications 는 알림 센터를 쓰기 시작한다. 애플리케이션이 시작한 뒤 한 번 부른다.
func (h *Host) startNotifications() error {
	var err error
	application.InvokeSync(func() {
		err = system.StartNotifications(func(event string) { go h.notificationEvent(event) })
	})
	if err != nil {
		return fmt.Errorf("system notifications: %w", err)
	}
	return nil
}

// notificationEvent 는 알림 센터의 사건을 창에 알린다. 권한 상태는 모든 창에, 누른 알림은 그 창에 간다.
func (h *Host) notificationEvent(raw string) {
	var event struct {
		Type          string  `json:"type"`
		Authorization string  `json:"authorization"`
		Error         *string `json:"error"`
		Identifier    string  `json:"identifier"`
	}
	if err := json.Unmarshal([]byte(raw), &event); err != nil {
		h.notificationFailed(fmt.Sprintf("notification event %q: %v", raw, err))
		return
	}
	switch event.Type {
	case "state":
		h.mu.Lock()
		h.notifications = NotificationState{Authorization: event.Authorization, Error: event.Error}
		h.mu.Unlock()
		h.emitNotificationState()
	case "posted", "activated":
		var target []string
		if err := json.Unmarshal([]byte(event.Identifier), &target); err != nil || len(target) != 2 {
			h.notificationFailed(fmt.Sprintf("%s notification %q has no window and surface", event.Type, event.Identifier))
			return
		}
		h.mu.Lock()
		var owner *Surfaces
		for _, s := range h.windows {
			if s.name == target[0] {
				owner = s
			}
		}
		h.mu.Unlock()
		if owner == nil {
			h.notificationFailed(fmt.Sprintf("the window %q of a %s notification is closed", target[0], event.Type))
			return
		}
		if event.Type == "activated" {
			owner.window.Show()
			owner.window.Focus()
		}
		owner.Emit("notification-"+event.Type, map[string]string{"surface": target[1]})
	default:
		h.notificationFailed(fmt.Sprintf("notification event %q has an unknown type", raw))
	}
}

// notificationFailed 는 실패를 알림 상태의 오류로 모든 창에 알린다.
func (h *Host) notificationFailed(reason string) {
	h.mu.Lock()
	h.notifications.Error = &reason
	h.mu.Unlock()
	h.emitNotificationState()
}

func (h *Host) emitNotificationState() {
	h.mu.Lock()
	state := h.notifications
	windows := make([]*Surfaces, 0, len(h.windows))
	for _, s := range h.windows {
		windows = append(windows, s)
	}
	h.mu.Unlock()
	for _, s := range windows {
		s.Emit("notification-state", state)
	}
}

// NotificationState 는 마지막으로 알린 권한 상태를 반환한다. 페이지가 시작할 때 읽는다.
func (h *Host) NotificationState(ctx context.Context) (NotificationState, error) {
	if _, err := h.surface(ctx); err != nil {
		return NotificationState{}, err
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.notifications, nil
}

// Notify 는 호출한 창의 탭 알림을 시스템 알림으로 게시한다.
func (h *Host) Notify(ctx context.Context, requestJSON json.RawMessage) error {
	request, err := argument[NotificationRequest]("request", requestJSON)
	if err != nil {
		return err
	}
	s, err := h.surface(ctx)
	if err != nil {
		return err
	}
	if err := ValidateNotification(request, false); err != nil {
		return err
	}
	application.InvokeSync(func() {
		err = system.PostNotification(notificationIdentifier(s.name, request.Surface), request.Title, request.Body)
	})
	return err
}

// NotificationRemove 는 호출한 창의 탭 알림을 지운다.
func (h *Host) NotificationRemove(ctx context.Context, requestJSON json.RawMessage) error {
	request, err := argument[NotificationRequest]("request", requestJSON)
	if err != nil {
		return err
	}
	s, err := h.surface(ctx)
	if err != nil {
		return err
	}
	if err := ValidateNotification(request, true); err != nil {
		return err
	}
	application.InvokeSync(func() {
		err = system.RemoveNotification(notificationIdentifier(s.name, request.Surface))
	})
	return err
}
