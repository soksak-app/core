// 테마 조회, 설정과 페이지 전달.

package host

import (
	"github.com/wailsapp/wails/v3/pkg/application"
)

// Theme 은 메인 페이지의 테마다. 호스트가 제공하는 페이지에 전달한다.
type Theme struct {
	Scheme string            `json:"scheme"`
	Tokens map[string]string `json:"tokens"`
}

// Theme 은 현재 테마를 반환한다. 페이지는 로드한 뒤 한 번 호출하고 이후 변경은 theme
// 이벤트로 받는다.
func (s *Surfaces) Theme() Theme {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.theme
}

// SetTheme 은 테마를 기록하고 열린 페이지에 발행한다. 메인 페이지는 렌더링마다가 아니라
// 테마를 선택할 때 호출한다.
func (s *Surfaces) SetTheme(theme Theme) error {
	// 토큰이 없는 테마를 그대로 두면 다음 Theme 호출이 JSON 의 null 을 반환하고,
	// 그것을 받은 페이지는 토큰을 순회하다 멈춘다.
	if theme.Tokens == nil {
		theme.Tokens = map[string]string{}
	}
	s.mu.Lock()
	s.theme = theme
	s.mu.Unlock()
	application.InvokeSync(func() { system.ConfigureMainWindow(s.window.NativeWindow(), theme.Scheme == "dark") })
	application.InvokeSync(func() {
		for _, document := range s.documents.All() {
			system.SetDocumentAppearance(document, theme.Scheme == "dark")
		}
	})
	s.Emit("theme", theme)
	return nil
}
