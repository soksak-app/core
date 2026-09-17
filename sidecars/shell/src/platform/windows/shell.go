//go:build windows

package windows

import (
	"os"

	"github.com/min-median-max/soksak/sidecars/shell/src/platform"
)

type implementation struct{}

func init() { platform.Register(implementation{}) }

// Shell 은 %COMSPEC% 을, 설정되지 않았으면 cmd.exe 를 반환한다.
func (implementation) Shell() string {
	if program := os.Getenv("COMSPEC"); program != "" {
		return program
	}
	return "cmd.exe"
}
