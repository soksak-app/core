//go:build windows

package windows

import (
	"errors"

	"github.com/min-median-max/soksak/packages/sok/wailsv3/src/platform"
)

type windows struct{}

func init() { platform.Register(windows{}) }

func (windows) ProcessRunning(int) error { return errors.New("not implemented on windows") }
