#include "signals.h"
#include <pthread.h>
#include <signal.h>
#include <stddef.h>
#include <errno.h>

int sp_block_async_signals(void) {
    if (!pthread_main_np()) return -1;
    sigset_t set;
    sigfillset(&set);
    const int faults[] = {SIGILL, SIGTRAP, SIGABRT, SIGEMT, SIGFPE, SIGBUS, SIGSEGV, SIGSYS};
    for (size_t i = 0; i < sizeof faults / sizeof faults[0]; i++) sigdelset(&set, faults[i]);
    return pthread_sigmask(SIG_BLOCK, &set, NULL);
}

static const int kTerminationSignals[] = {SIGTERM, SIGINT, SIGHUP};
#define TERMINATION_SIGNAL_COUNT (sizeof kTerminationSignals / sizeof kTerminationSignals[0])
static struct sigaction earlierTermination[TERMINATION_SIGNAL_COUNT];
static volatile sig_atomic_t terminationSenders[TERMINATION_SIGNAL_COUNT];

// Runs inside the signal, so it only stores a number and calls the earlier handler.
static void recordTermination(int signal, siginfo_t *info, void *context) {
    for (size_t index = 0; index < TERMINATION_SIGNAL_COUNT; index++) {
        if (kTerminationSignals[index] != signal) continue;
        terminationSenders[index] = info ? info->si_pid : 0;
        struct sigaction earlier = earlierTermination[index];
        if (earlier.sa_flags & SA_SIGINFO) {
            if (earlier.sa_sigaction != NULL) earlier.sa_sigaction(signal, info, context);
        } else if (earlier.sa_handler == SIG_DFL) {
            // The earlier action ends the process: it is restored and the signal raised again, so the default action runs.
            sigaction(signal, &earlier, NULL);
            raise(signal);
        } else if (earlier.sa_handler != SIG_IGN && earlier.sa_handler != NULL) {
            earlier.sa_handler(signal);
        }
        return;
    }
}

int sp_termination_signals_record(void) {
    for (size_t index = 0; index < TERMINATION_SIGNAL_COUNT; index++) {
        struct sigaction action = {0};
        action.sa_sigaction = recordTermination;
        action.sa_flags = SA_SIGINFO | SA_ONSTACK | SA_RESTART;
        sigemptyset(&action.sa_mask);
        if (sigaction(kTerminationSignals[index], &action, &earlierTermination[index])) return errno;
    }
    return 0;
}

int sp_termination_signal_sender(int signal) {
    for (size_t index = 0; index < TERMINATION_SIGNAL_COUNT; index++) {
        if (kTerminationSignals[index] == signal) return terminationSenders[index];
    }
    return 0;
}
