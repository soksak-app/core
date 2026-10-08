#import <Foundation/Foundation.h>
#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#import "application_log.h"

void sp_log_error(const char *where, const char *text) {
    char *line = NULL;
    int length = asprintf(&line, "error: %s: %s\n", where, text);
    if (length < 0) abort();
    // 한 번의 write 는 같은 파일에 쓰는 다른 줄과 섞이지 않는다. 짧게 쓰인 나머지는 이어서 쓴다.
    for (ssize_t offset = 0; offset < length;) {
        ssize_t written = write(STDERR_FILENO, line + offset, (size_t)(length - offset));
        if (written < 0 && errno == EINTR) continue;
        if (written <= 0) abort();
        offset += written;
    }
    free(line);
}

// An uncaught exception ends the process by an abort. Its line is written once, so the abort does not add a second.
static volatile sig_atomic_t exceptionReported = 0;

static const int kFatalSignals[] = {SIGABRT, SIGBUS, SIGFPE, SIGILL, SIGSEGV, SIGTRAP};
#define FATAL_SIGNAL_COUNT (sizeof(kFatalSignals) / sizeof(kFatalSignals[0]))
static struct sigaction previousActions[FATAL_SIGNAL_COUNT];

static const char *fatalLine(int signalNumber) {
    switch (signalNumber) {
    case SIGABRT: return "error: fatal: SIGABRT\n";
    case SIGBUS: return "error: fatal: SIGBUS\n";
    case SIGFPE: return "error: fatal: SIGFPE\n";
    case SIGILL: return "error: fatal: SIGILL\n";
    case SIGSEGV: return "error: fatal: SIGSEGV\n";
    case SIGTRAP: return "error: fatal: SIGTRAP\n";
    default: return "error: fatal: signal\n";
    }
}

// Runs inside a fatal signal, so it calls only write and the functions that a signal handler may call.
static void fatalSignal(int signalNumber, siginfo_t *info, void *context) {
    if (!exceptionReported) {
        const char *line = fatalLine(signalNumber);
        // The process ends after this handler, and the standard error is the only place that can take the line, so a
        // failed write has nowhere to report to.
        ssize_t written = write(STDERR_FILENO, line, strlen(line));
        (void)written;
    }
    for (size_t index = 0; index < FATAL_SIGNAL_COUNT; index++) {
        if (kFatalSignals[index] != signalNumber) continue;
        struct sigaction previous = previousActions[index];
        if (previous.sa_flags & SA_SIGINFO) {
            if (previous.sa_sigaction != NULL) previous.sa_sigaction(signalNumber, info, context);
        } else if (previous.sa_handler != SIG_DFL && previous.sa_handler != SIG_IGN && previous.sa_handler != NULL) {
            previous.sa_handler(signalNumber);
        }
        break;
    }
    signal(signalNumber, SIG_DFL);
    raise(signalNumber);
}

static void uncaughtException(NSException *exception) {
    NSString *text = [NSString stringWithFormat:@"uncaught exception %@: %@", exception.name, exception.reason];
    sp_log_error("fatal", text.UTF8String);
    exceptionReported = 1;
}

void sp_log_install_fatal_handlers(void) {
    for (size_t index = 0; index < FATAL_SIGNAL_COUNT; index++) {
        struct sigaction action;
        memset(&action, 0, sizeof action);
        action.sa_sigaction = fatalSignal;
        action.sa_flags = SA_SIGINFO | SA_ONSTACK;
        sigemptyset(&action.sa_mask);
        if (sigaction(kFatalSignals[index], &action, &previousActions[index]) != 0) {
            sp_log_error("fatal", "install the signal handler failed");
        }
    }
    NSSetUncaughtExceptionHandler(&uncaughtException);
}
