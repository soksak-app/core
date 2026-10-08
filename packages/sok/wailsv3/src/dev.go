//go:build dev

package sok

// A build with the dev tag runs beside the installed application, so it uses the .dev identifier.
func init() {
	devBuild = true
}
