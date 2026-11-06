package windows

// processFailure is what the end of a process of a WebView2 means for its page. It holds no system call, so it also runs where WebView2
// does not exist.
type processFailure int

const (
	// pageEnded: the page is gone, so the host records its end and the page is loaded again. After the end of the browser process that
	// load fails and its failure is recorded: a web view that lost that process does not come back.
	pageEnded processFailure = iota
	// pageStays: WebView2 starts again a process of this kind by itself, or only a frame ended.
	pageStays
)

// processFailureOf is the meaning of a COREWEBVIEW2_PROCESS_FAILED_KIND.
func processFailureOf(kind int32) processFailure {
	const browserProcessExited, renderProcessExited = 0, 1
	switch kind {
	case browserProcessExited, renderProcessExited:
		return pageEnded
	default:
		return pageStays
	}
}
