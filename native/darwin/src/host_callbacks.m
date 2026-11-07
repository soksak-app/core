#include "host_callbacks.h"
#include <stdio.h>
#include <stdlib.h>
#include <Block.h>

static sp_host_callbacks installed;
static bool ready;

void sp_host_presentation_complete(void *completion, const char *failure) {
    void (^presented)(const char *) = completion;
    presented(failure);
    Block_release(presented);
}

const char *sp_host_callbacks_install(const sp_host_callbacks *callbacks) {
    if (ready) return "native callbacks are already installed";
    if (!callbacks) return "native callback table is missing";
#define SP_HOST_CALLBACK_REQUIRE(mode, result, name, parameters, arguments) \
    if (!callbacks->name) return "native callback is missing: " #name;
    SP_HOST_CALLBACKS(SP_HOST_CALLBACK_REQUIRE)
#undef SP_HOST_CALLBACK_REQUIRE
    installed = *callbacks;
    ready = true;
    return NULL;
}

static void requireCallback(bool installed, const char *name) {
    if (!installed) {
        fprintf(stderr, "native callback %s is not installed\n", name);
        abort();
    }
}

#define SP_HOST_CALLBACK_V(call) call
#define SP_HOST_CALLBACK_R(call) return call
#define SP_HOST_CALLBACK_DEFINE(mode, result, name, parameters, arguments) \
    result sp_host_callback_##name parameters { \
        requireCallback(ready, #name); \
        SP_HOST_CALLBACK_##mode(installed.name arguments); \
    }
SP_HOST_CALLBACKS(SP_HOST_CALLBACK_DEFINE)

#ifdef SOKSAK_DIAGNOSTIC
static sp_host_diagnostic_callbacks diagnosticCallbacks;
static bool diagnosticReady;

const char *sp_host_diagnostic_callbacks_install(const sp_host_diagnostic_callbacks *callbacks) {
    if (diagnosticReady) return "native diagnostic callbacks are already installed";
    if (!callbacks) return "native diagnostic callback table is missing";
#define SP_HOST_DIAGNOSTIC_CALLBACK_REQUIRE(mode, result, name, parameters, arguments) \
    if (!callbacks->name) return "native diagnostic callback is missing: " #name;
    SP_HOST_DIAGNOSTIC_CALLBACKS(SP_HOST_DIAGNOSTIC_CALLBACK_REQUIRE)
#undef SP_HOST_DIAGNOSTIC_CALLBACK_REQUIRE
    diagnosticCallbacks = *callbacks;
    diagnosticReady = true;
    return NULL;
}

#define SP_HOST_DIAGNOSTIC_CALLBACK_DEFINE(mode, result, name, parameters, arguments) \
    result sp_host_diagnostic_callback_##name parameters { \
        requireCallback(diagnosticReady, #name); \
        SP_HOST_CALLBACK_##mode(diagnosticCallbacks.name arguments); \
    }
SP_HOST_DIAGNOSTIC_CALLBACKS(SP_HOST_DIAGNOSTIC_CALLBACK_DEFINE)
#endif
