//go:build darwin

package darwin

/*
#include <stdbool.h>
#include "window_facts.h"
*/
import "C"

import "syscall"

// OSVersion returns the product version of macOS, such as "26.6.2", from the kern.osproductversion sysctl.
func (implementation) OSVersion() (string, error) {
	return syscall.Sysctl("kern.osproductversion")
}

// ApplicationActive reports whether the application is the active application (sp_application_active of window_facts.h).
func (implementation) ApplicationActive() (bool, error) {
	return bool(C.sp_application_active()), nil
}
