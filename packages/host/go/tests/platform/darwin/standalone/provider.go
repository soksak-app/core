//go:build darwin

package standalone

import (
	"github.com/soksak-app/core/packages/host/go/src/platform/darwin/abi"
)

var startupHooks []func() error

// RegisterStartup adds a tagged test profile installer before TestMain initializes native work.
func RegisterStartup(install func() error) { startupHooks = append(startupHooks, install) }

// InstallProviders declares the selected native test binding and every enabled profile before initialization.
// The installer is passed in so this fixture does not import the production package it also tests internally.
func InstallProviders(install func(func(abi.Callbacks) (abi.NativeFunctions, error)) error) error {
	if err := install(Provider); err != nil {
		return err
	}
	for _, hook := range startupHooks {
		if err := hook(); err != nil {
			return err
		}
	}
	return nil
}
