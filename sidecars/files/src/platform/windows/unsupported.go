//go:build windows

package windows

import (
	"errors"

	"github.com/min-median-max/soksak/sidecars/files/src/platform"
)

type implementation struct{}

func init() { platform.Register(implementation{}) }

func (implementation) Watch(string, func(), func(error)) (func() error, error) {
	return nil, errors.New("watching directories is not implemented on windows")
}
