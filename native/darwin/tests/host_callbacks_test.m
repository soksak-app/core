// Native callbacks are installed as a complete table, copied once, and dispatched without a link to Go symbols.
#include "host_callbacks.h"
#include "main_thread.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <signal.h>
#include <sys/wait.h>
#include <unistd.h>
#import <Foundation/Foundation.h>
#include <Block.h>

static int completionLeases;
@interface SPHostCompletionLease : NSObject
- (BOOL)live;
@end
@implementation SPHostCompletionLease
- (id)init { self = [super init]; if (self) completionLeases++; return self; }
- (BOOL)live { return YES; }
- (void)dealloc { completionLeases--; [super dealloc]; }
@end

#define STUB_V(result, name, parameters) static result stub_##name parameters {}
#define STUB_R(result, name, parameters) static result stub_##name parameters { return 0; }
#define STUB(mode, result, name, parameters, arguments) STUB_##mode(result, name, parameters)
SP_HOST_CALLBACKS(STUB)
#ifdef SOKSAK_DIAGNOSTIC
SP_HOST_DIAGNOSTIC_CALLBACKS(STUB)
#endif

static int failures;
static void check(bool passed, const char *name) {
    fprintf(passed ? stdout : stderr, "%s: %s\n", passed ? "PASS" : "FAIL", name);
    if (!passed) failures++;
}

static void checkMissing(const char *name, void (^call)(void)) {
    int output[2];
    if (pipe(output) != 0) { perror("pipe"); exit(2); }
    fflush(NULL);
    pid_t child = fork();
    if (child < 0) { perror("fork"); exit(2); }
    if (child == 0) {
        close(output[0]);
        if (dup2(output[1], STDERR_FILENO) < 0) _exit(2);
        close(output[1]);
        call();
        _exit(3);
    }
    close(output[1]);
    int status = 0;
    if (waitpid(child, &status, 0) != child) { perror("waitpid"); exit(2); }
    char message[1024];
    ssize_t size = read(output[0], message, sizeof(message) - 1);
    if (size < 0) { perror("read"); exit(2); }
    message[size] = '\0';
    close(output[0]);
    check(WIFSIGNALED(status) && WTERMSIG(status) == SIGABRT && strstr(message, name)
          && strstr(message, "is not installed"), "an unregistered callback aborts and names its entry");
}

static int view;
static int hit(uintptr_t owner, void *target) {
    return owner == 17 && target == &view ? -37 : 0;
}
static bool receivedPoint;
static void point(uintptr_t owner, int phase, double x, double y) {
    receivedPoint = owner == 19 && phase == -3 && x == 12.25 && y == -0.5;
}
static bool receivedImage;
static void image(uintptr_t context, uint64_t generation, uint64_t raster, int sequence) {
    receivedImage = context == 17 && generation == UINT64_C(0xf123456789abcdef)
        && raster == UINT64_C(0x8123456789abcdef) && sequence == -7;
}
#ifdef SOKSAK_DIAGNOSTIC
static bool receivedExit;
static void processExited(uintptr_t context, bool exited) { receivedExit = context == 29 && exited; }
#endif
static bool serve(uintptr_t context, char *plugin, char *path, void **bytes, size_t *length, char **contentType) {
    if (context != 17 || strcmp(plugin, "plugin") || strcmp(path, "/file")) return false;
    *bytes = strdup("body");
    *length = 4;
    *contentType = strdup("text/plain");
    return true;
}

static void directly(void (^work)(void)) { work(); }

int main(void) { @autoreleasepool {
#define COUNT(mode, result, name, parameters, arguments) +1
    enum { baseCount = 0 SP_HOST_CALLBACKS(COUNT), diagnosticCount = 0 SP_HOST_DIAGNOSTIC_CALLBACKS(COUNT) };
    check(baseCount == 36 && diagnosticCount == 7, "the native ABI declares 36 base and 7 diagnostic callbacks");
    hostInstallMainThread(directly, directly);
    checkMissing("surface_hit", ^{ hostRunOnWorker(^{ sp_host_callback_surface_hit(0, NULL); }); });
    sp_host_callbacks callbacks = {0};
    check(sp_host_callbacks_install(NULL) != NULL, "a missing callback table is rejected");
#define INITIALIZE(mode, result, name, parameters, arguments) callbacks.name = stub_##name;
    SP_HOST_CALLBACKS(INITIALIZE)
#define MISSING(mode, result, name, parameters, arguments) { \
    sp_host_callbacks incomplete = callbacks; incomplete.name = NULL; \
    const char *failure = sp_host_callbacks_install(&incomplete); \
    check(failure && strstr(failure, #name), "a missing " #name " is named and leaves registration open"); \
}
    SP_HOST_CALLBACKS(MISSING)
    callbacks.surface_hit = hit;
    callbacks.surface_point = point;
    callbacks.image_released = image;
    callbacks.core_root_serve = serve;
    check(sp_host_callbacks_install(&callbacks) == NULL, "a complete callback table is installed");
    callbacks.surface_hit = NULL;
    check(ON_WORKER(int, sp_host_callback_surface_hit(17, &view)) == -37,
          "the native owner copies the table and preserves a signed callback result");
    hostRunOnWorker(^{ sp_host_callback_surface_point(19, -3, 12.25, -0.5); });
    check(receivedPoint, "integer and floating callback arguments keep their values");
    hostRunOnWorker(^{ sp_host_callback_image_released(17, UINT64_C(0xf123456789abcdef), UINT64_C(0x8123456789abcdef), -7); });
    check(receivedImage, "integer token, unsigned 64-bit and signed callback arguments keep their values");
    __block void *bytes = NULL;
    __block size_t length = 0;
    __block char *contentType = NULL;
    bool served = ON_WORKER(bool, sp_host_callback_core_root_serve(17, "plugin", "/file", &bytes, &length, &contentType));
    check(served && bytes && !memcmp(bytes, "body", 4) && length == 4 && contentType && !strcmp(contentType, "text/plain"),
          "a boolean callback returns its byte pointer, length and string output");
    free(bytes);
    free(contentType);
    bytes = NULL; length = 0; contentType = NULL;
    served = ON_WORKER(bool, sp_host_callback_core_root_serve(17, "missing", "/file", &bytes, &length, &contentType));
    check(!served && !bytes && length == 0 && !contentType, "a false callback result preserves its untouched output pointers");
    check(sp_host_callbacks_install(&callbacks) != NULL, "the installed callback table cannot be replaced");
    check(ON_WORKER(int, sp_host_callback_surface_hit(17, &view)) == -37, "a rejected replacement preserves the installed callbacks");
    SPHostCompletionLease *lease = [[SPHostCompletionLease alloc] init];
    __block bool completed = false;
    void *completion = Block_copy(^(const char *failure) {
        completed = !strcmp(failure, "failure") && [lease live] && completionLeases == 1;
    });
    [lease release];
    check(completionLeases == 1, "the copied completion retains its native state until completion");
    hostRunOnMain(^{ sp_host_presentation_complete(completion, "failure"); });
    check(completed && completionLeases == 0, "presentation completion invokes and releases its transferred block on the main thread");
#ifdef SOKSAK_DIAGNOSTIC
    checkMissing("process_exit_answered", ^{ hostRunOnWorker(^{ sp_host_diagnostic_callback_process_exit_answered(0, false); }); });
    sp_host_diagnostic_callbacks diagnostics = {0};
#define INITIALIZE_DIAGNOSTIC(mode, result, name, parameters, arguments) diagnostics.name = stub_##name;
    SP_HOST_DIAGNOSTIC_CALLBACKS(INITIALIZE_DIAGNOSTIC)
#define MISSING_DIAGNOSTIC(mode, result, name, parameters, arguments) { \
    sp_host_diagnostic_callbacks incomplete = diagnostics; incomplete.name = NULL; \
    const char *failure = sp_host_diagnostic_callbacks_install(&incomplete); \
    check(failure && strstr(failure, #name), "a missing diagnostic " #name " is named and leaves registration open"); \
}
    SP_HOST_DIAGNOSTIC_CALLBACKS(MISSING_DIAGNOSTIC)
    diagnostics.process_exit_answered = processExited;
    check(sp_host_diagnostic_callbacks_install(&diagnostics) == NULL, "the diagnostic callbacks have their own complete registration");
    diagnostics.process_exit_answered = NULL;
    hostRunOnWorker(^{ sp_host_diagnostic_callback_process_exit_answered(29, true); });
    check(receivedExit, "the diagnostic owner copies its table and dispatches the registered callback");
    receivedExit = false;
    check(sp_host_diagnostic_callbacks_install(&diagnostics) != NULL, "the diagnostic callbacks cannot be replaced");
    hostRunOnWorker(^{ sp_host_diagnostic_callback_process_exit_answered(29, true); });
    check(receivedExit, "a rejected diagnostic replacement preserves its installed callback");
    check(ON_WORKER(int, sp_host_callback_surface_hit(17, &view)) == -37, "diagnostic registration leaves the base callbacks unchanged");
#endif
    return failures ? 1 : 0;
}}
