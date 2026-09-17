//go:build linux

package linux

import (
	"os"

	"github.com/min-median-max/soksak/sidecars/shell/src/platform"
)

type implementation struct{}

func init() { platform.Register(implementation{}) }

// Shell 은 $SHELL 을, 설정되지 않았으면 /bin/sh 를 반환한다.
func (implementation) Shell() string {
	if program := os.Getenv("SHELL"); program != "" {
		return program
	}
	return "/bin/sh"
}
