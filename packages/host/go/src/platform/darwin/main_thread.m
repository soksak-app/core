//go:build darwin

#include <stdio.h>
#include <stdlib.h>

#include "main_thread.h"

static void (*installedWorker)(void (^)(void));
static void (*installedMain)(void (^)(void));

void hostInstallMainThread(void (*worker)(void (^)(void)), void (*main)(void (^)(void))) {
    installedWorker = worker;
    installedMain = main;
}

// A call before the installation went past the check of the start of the library (RequireMainThread), so it is a programming
// error: the process ends with the name of the missing function instead of running the block on the calling thread.
static void hostAbortMissing(const char *name) {
    fprintf(stderr, "main-thread function %s is not installed: the framework adapter installs it through darwin.InstallMainThread "
                    "before the start of the library, and a test installs a test function in its TestMain\n", name);
    abort();
}

void hostRunOnWorker(void (^task)(void)) {
    if (installedWorker == NULL) hostAbortMissing("hostRunOnWorker");
    installedWorker(task);
}

void hostRunOnMain(void (^call)(void)) {
    if (installedMain == NULL) hostAbortMissing("hostRunOnMain");
    installedMain(call);
}

void hostMainThreadInstalled(bool *worker, bool *main) {
    *worker = installedWorker != NULL;
    *main = installedMain != NULL;
}
