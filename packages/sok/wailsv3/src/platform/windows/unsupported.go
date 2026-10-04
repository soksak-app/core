//go:build windows

package windows

import (
	"errors"

	"github.com/soksak-app/core/packages/sok/wailsv3/src/platform"
)

type windows struct{}

func init() { platform.Register(windows{}) }

func (windows) ProcessRunning(int) error { return errors.New("not implemented on windows") }

func (windows) Key() (string, error) { return "", errors.New("not implemented on windows") }
