package host

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"unicode"

	"github.com/wailsapp/wails/v3/pkg/application"

	"github.com/soksak-app/core/packages/host/wailsv3/src/routine"
)

// NotificationRequest is the system notification of one tab (docs/spec/plugins.md#tab-reports). Only Surface is used for removal.
type NotificationRequest struct {
	Surface string `json:"surface"`
	Title   string `json:"title,omitempty"`
	Body    string `json:"body,omitempty"`
}

// NotificationState is the permission of the notification center and the last failure of a permission request, a post, and a removal.
type NotificationState struct {
	Authorization string  `json:"authorization"`
	Error         *string `json:"error"`
}

// notificationText allows only text of 1 to limit characters without control characters.
func notificationText(field, value string, limit int) error {
	if value == "" || len([]rune(value)) > limit || strings.IndexFunc(value, unicode.IsControl) >= 0 {
		return fmt.Errorf("notification %s must be 1 to %d characters without control characters", field, limit)
	}
	return nil
}

// ValidateNotification checks a notification request. For removal, it checks only the surface.
func ValidateNotification(request NotificationRequest, removal bool) error {
	if err := notificationText("surface", request.Surface, 256); err != nil || removal {
		return err
	}
	if err := notificationText("title", request.Title, 256); err != nil {
		return err
	}
	return notificationText("body", request.Body, 1024)
}

// notificationIdentifier is the identifier in the notification center. It returns the window name and the surface from a notification that was clicked.
func notificationIdentifier(window, surface string) string {
	// default: the JSON conversion of a list of strings does not fail, so the error value is not received.
	identifier, _ := json.Marshal([]string{window, surface})
	return string(identifier)
}

// startNotifications starts using the notification center. Call it once after the application started.
func (h *Host) startNotifications() error {
	var err error
	application.InvokeSync(func() {
		err = system.StartNotifications(func(event string) { routine.Go("notification-event", func() { HandleNotificationEvent(h, event) }) })
	})
	if err != nil {
		return fmt.Errorf("system notifications: %w", err)
	}
	return nil
}

// HandleNotificationEvent announces an event of the notification center to the windows. The permission state goes to all windows and a clicked notification goes to its window.
func HandleNotificationEvent(h *Host, raw string) {
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
		EmitHost(LevelInfo, "host.notification.event", map[string]any{"type": event.Type, "authorization": event.Authorization, "window": "", "surface": ""})
		if event.Error != nil {
			LogError("notification", *event.Error)
		}
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
		EmitHost(LevelInfo, "host.notification.event", map[string]any{"type": event.Type, "authorization": "", "window": target[0], "surface": target[1]})
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

// notificationFailed announces a failure to all windows as an error of the notification state and records it. Without a window, the notification state cannot show the error.
func (h *Host) notificationFailed(reason string) {
	LogError("notification", reason)
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

// NotificationState returns the permission state that was announced last. The page reads it when it starts.
func (h *Host) NotificationState(ctx context.Context) (NotificationState, error) {
	if _, err := h.surface(ctx); err != nil {
		return NotificationState{}, err
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.notifications, nil
}

// Notify posts the tab notification of the calling window as a system notification.
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

// NotificationRemove removes the tab notification of the calling window.
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
