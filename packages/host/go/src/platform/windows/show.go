package windows

// The commands of ShowWindow.
const (
	swShowNoActivate = 4
	swShow           = 5
)

// showCommand is the command that shows a window: only an application that holds the foreground may take it.
func showCommand(holdsForeground bool) int {
	if holdsForeground {
		return swShow
	}
	return swShowNoActivate
}
