//! What the end of a process of a WebView2 means for its page. It holds no system call, so it also runs where WebView2 does not exist.

/// What a host does when a process of a web view failed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProcessFailure {
    /// The page is gone, so the host records it and loads the page again. After the end of the browser process that load fails and its
    /// failure is recorded: a web view that lost that process does not come back.
    PageEnded,
    /// The page stays: WebView2 starts again a process of this kind by itself, or only a frame ended.
    PageStays,
}

/// The meaning of a COREWEBVIEW2_PROCESS_FAILED_KIND.
pub fn process_failure(kind: i32) -> ProcessFailure {
    const BROWSER_PROCESS_EXITED: i32 = 0;
    const RENDER_PROCESS_EXITED: i32 = 1;
    match kind {
        BROWSER_PROCESS_EXITED | RENDER_PROCESS_EXITED => ProcessFailure::PageEnded,
        _ => ProcessFailure::PageStays,
    }
}

#[cfg(test)]
#[path = "process_failure_test.rs"]
mod tests;
