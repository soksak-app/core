# Capture connector plugins

[한국어](capture-connector-plugins.ko.md)

## Problem

A connector plugin shows its application through the embed protocol, which needs an adapter inside the application. An application whose own distribution has no adapter cannot be shown, and an adapter in another party's application exists only when that party adds it. Most applications therefore have no path into a surface.

## Approach

A connector plugin shows an application without an adapter by capturing the window of the application and sending the input of the card to that window. The application runs as itself, from its own distribution; the plugin needs nothing inside it. The embed protocol stays the path of an application that has an adapter, because it draws without a copy and takes input exactly.

- Capture: the application sidecar captures the window of the application with ScreenCaptureKit and supplies its frames to the image region of the card, as the embed path does.
- Input: the sidecar sends the pointer, wheel and key input of the card to the window with the accessibility and event APIs of the platform.
- Window: the window of the application stays outside the visible screen and follows the size of the card.
- Permissions: screen recording and accessibility; the plugin screen states a missing permission as an error that names it.

## Gate

A prototype measures the same gate as the embed path before the plugin kind is specified: the delay from a native pointer move to the first captured frame that shows it, and the frame gaps during playback, on an application without an adapter. The approach is adopted when the median delay stays within 50 ms and the frame gap p99 within 34 ms at 60 Hz; otherwise this proposal records the measured values and is closed.

## Order

1. Prototype in the application sidecar and a gate check; record the measurements.
2. When the gate passes: the specification of the capture path, the manifest field that selects it, and the plugin screen for its permissions.
3. The connector plugin of the example video editor through the capture path.
