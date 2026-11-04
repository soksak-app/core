//go:build darwin

#include <stddef.h>

#include "main_thread.h"

static void (*installedWorker)(void (^)(void));
static void (*installedMain)(void (^)(void));

void hostInstallMainThread(void (*worker)(void (^)(void)), void (*main)(void (^)(void))) {
    installedWorker = worker;
    installedMain = main;
}

void hostRunOnWorker(void (^task)(void)) {
    if (installedWorker == NULL) {
        task();
        return;
    }
    installedWorker(task);
}

void hostRunOnMain(void (^call)(void)) {
    if (installedMain == NULL) {
        call();
        return;
    }
    installedMain(call);
}
