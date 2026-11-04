//go:build !darwin

package platform

// InstallMainThread has nothing to install: only the darwin layer has main-thread functions.
func InstallMainThread() {}
