// Duration of the window resize animation.
//
// AppKit reads the user default NSWindowResizeTime in `-[NSWindow animationResizeTime:]` to decide the
// duration of zoom and animated resizes. The window frame and the web document are presented separately,
// so the longer this time is, the longer the interval in which the content appears later than the window.
void windowResizeInstant(void);
