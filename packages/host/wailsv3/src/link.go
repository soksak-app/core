package host

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"

	"github.com/soksak-app/core/packages/host/wailsv3/src/platform"
	"github.com/wailsapp/wails/v3/pkg/application"
)

// linkMaxLength is the maximum number of characters of a URL that can be opened.
const linkMaxLength = 8192

type LinkOpenRequest struct {
	URL string `json:"url"`
}

// ValidateLink allows only an absolute http, https, or mailto URL that can be opened with the default application of the user.
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
