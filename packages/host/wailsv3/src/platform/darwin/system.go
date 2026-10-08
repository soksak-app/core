//go:build darwin

package darwin

import "syscall"

// OSVersion returns the product version of macOS, such as "26.6.2", from the kern.osproductversion sysctl.
func (implementation) OSVersion() (string, error) {
	return syscall.Sysctl("kern.osproductversion")
}
