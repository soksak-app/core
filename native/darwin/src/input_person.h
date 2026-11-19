#pragma once

#include <stdbool.h>

// Diagnostic builds: dispatches through -[NSApplication sendEvent:], in window, the event that the window server gives the
// application for an action of a person at x, y, in points from the top left of the content of window: action "press" is a down
// and an up of the left button, "move" a mouse move and "scroll" a scroll of four points. The native library did not send it as
// the input of a pointer, so it ends the open synthetic gestures as an action of a person does, and then the view at the point
// receives it (docs/spec/endpoint.md). It moves no system cursor and asks the system for nothing. AppKit activates the application
// at a press in a window that is not the key window, so a press is refused unless window is the virtual key window or the key
// window of an application that is really active.
//
// Returns true after the dispatch. Otherwise returns false and stores in *error a message that the caller frees with free():
// "the window is not shown", "a press of a person reaches only the key window", "action must be press, move or scroll", "the scroll event has no window" or
// "no window or not the main thread". Call it on the main thread.
bool sp_input_person(void *window, const char *action, double x, double y, char **error);
