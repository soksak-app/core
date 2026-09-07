#include "window_probe_darwin.h"

extern void nativeProbeResult(char *);
static void probeToGo(const char *text) { nativeProbeResult((char *)text); }
void nativeRunProbe(void *window, const char *request) { spNativeProbe(window, request, probeToGo); }
