package host

// PageProcessEnded returns the place and the text of the error line that the host writes when the WebContent process
// of the window ends, and whether the host writes it: the host ends the process on purpose while it quits
// (docs/spec/diagnostics.md).
func PageProcessEnded(window string, quitting bool) (string, string, bool) {
	return "page process", window + ": terminated", !quitting
}
