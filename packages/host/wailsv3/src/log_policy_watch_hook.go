//go:build diagnostics

package host

// SetLogPolicyWatchHook declares the function that the watch of the policy file calls on its goroutine for each notification
// that names the file, immediately before the read starts, with the paths that the watch holds
// (docs/spec/logging.md#classes-and-policy). A test reads from it whether the file was watched before its read, which a write in
// place right after the creation needs. nil removes the function.
func SetLogPolicyWatchHook(hook func(watched []string)) {
	logPolicyWatchHook.Store(&hook)
}
