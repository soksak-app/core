package host

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"

	"github.com/min-median-max/soksak/packages/host/wailsv3/src/platform"
	"github.com/wailsapp/wails/v3/pkg/application"
)

// linkMaxLength 는 열 수 있는 URL 의 최대 글자 수다.
const linkMaxLength = 8192

type LinkOpenRequest struct {
	URL string `json:"url"`
}

// ValidateLink 는 사용자의 기본 애플리케이션으로 열 수 있는 절대 http, https, mailto URL 만 허용한다.
func ValidateLink(value string) error {
	if len(value) > linkMaxLength {
		return fmt.Errorf("link URL is longer than %d characters", linkMaxLength)
	}
	parsed, err := url.Parse(value)
	if err != nil {
		return fmt.Errorf("link URL does not parse: %w", err)
	}
	switch parsed.Scheme {
	case "http", "https":
		if parsed.Host == "" {
			return fmt.Errorf("link URL %q has no host", value)
		}
	case "mailto":
		if parsed.Opaque == "" {
			return fmt.Errorf("link URL %q has no address", value)
		}
	default:
		return fmt.Errorf("link URL scheme %q is not opened", parsed.Scheme)
	}
	return nil
}

func (h *Host) LinkOpen(ctx context.Context, requestJSON json.RawMessage) error {
	request, err := argument[LinkOpenRequest]("request", requestJSON)
	if err != nil {
		return err
	}
	if _, err := h.surface(ctx); err != nil {
		return err
	}
	if err := ValidateLink(request.URL); err != nil {
		return err
	}
	var callErr error
	application.InvokeSync(func() {
		current, err := platform.Current()
		if err != nil {
			callErr = err
			return
		}
		callErr = current.OpenLink(request.URL)
	})
	return callErr
}
