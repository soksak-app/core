package host

// PageProcessEnded returns the place and the text of the error line that the host writes when the WebContent process
// of the window ends (docs/spec/diagnostics.md).
func PageProcessEnded(window string) (string, string) {
	return "page process", window + ": terminated"
}
