// Theme query, setting, and delivery to the page.

package host

import (
	"encoding/json"
	"fmt"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// Theme is the theme of the main page. The host passes it to the pages that it provides.
type Theme struct {
	Scheme string            `json:"scheme"`
	Tokens map[string]string `json:"tokens"`
}

// Theme returns the current theme. The page calls it once after it loads and receives later changes through the theme
// event.
func (s *Surfaces) Theme() Theme {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.theme
}

// SetTheme records the theme and publishes it to the open pages. The main page calls it when the theme is selected and not at every
// render.
func (s *Surfaces) SetTheme(theme Theme) error {
	// If a theme without tokens were left as it is, the next Theme call would return JSON null,
	// and a page that receives it would stop while iterating over the tokens.
	if theme.Tokens == nil {
		theme.Tokens = map[string]string{}
	}
	s.mu.Lock()
	s.theme = theme
	s.mu.Unlock()
	var err error
	application.InvokeSync(func() { err = system.ConfigureMainWindow(s.window.NativeWindow(), theme.Scheme == "dark") })
	if err != nil {
		return err
	}
	application.InvokeSync(func() {
		for _, document := range s.documents.All() {
			system.SetDocumentAppearance(document, theme.Scheme == "dark")
		}
	})
	s.Emit("theme", theme)
	// A view receives the theme after its ready message, so only the views with a ready document are posted to.
	s.postThemeToViews()
	return nil
}

// themeScript returns the document-start script that sets window.sokTheme to the frozen theme value {scheme, tokens}, which the
// first page script of a view reads (docs/spec/native-surfaces.md#view-surfaces).
func themeScript(theme Theme) (string, error) {
	text, err := json.Marshal(theme)
	if err != nil {
		return "", fmt.Errorf("theme cannot be serialized: %w", err)
	}
	return "window.sokTheme = Object.freeze(" + string(text) + ");", nil
}
