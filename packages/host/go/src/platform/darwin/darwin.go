// Package darwin implements the macOS host through a typed native interface.
//
// Native window, webview, input, layout, recording and Dock operations belong
// to native/darwin. The framework adapter installs their generated binding
// before host preparation; this package owns the shared Go platform logic.
package darwin
