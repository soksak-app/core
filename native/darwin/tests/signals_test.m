#include "signals.h"
#include <pthread.h>
#include <signal.h>
#include <stdio.h>
#include <unistd.h>

static volatile sig_atomic_t earlierHandlerCalls = 0;
static void earlierHandler(int signal) { (void)signal; earlierHandlerCalls++; }

// The recorder of the termination signals keeps the process that sent each one and passes the signal to the handler that
// was installed before it, as the hosts install theirs first.
static int checkSenderRecord(void) {
    struct sigaction earlier = {0};
    earlier.sa_handler = earlierHandler;
    if (sigaction(SIGTERM, &earlier, NULL)) return 20;
    if (sp_termination_signal_sender(SIGTERM) != 0) return 21;
    if (sp_termination_signals_record()) return 22;
    if (kill(getpid(), SIGTERM)) return 23;
    if (earlierHandlerCalls != 1) return 24;
    if (sp_termination_signal_sender(SIGTERM) != getpid()) return 25;
    if (sp_termination_signal_sender(SIGHUP) != 0) return 26;
    puts("PASS: a termination signal records the process that sent it and reaches the earlier handler");
    return 0;
}

static void *otherThread(void *unused) {
    return (void *)(long)sp_block_async_signals();
}
int main(void) {
    int recorded = checkSenderRecord();
    if (recorded) return recorded;
    sigset_t before, after;
    if (pthread_sigmask(SIG_BLOCK, NULL, &before)) return 1;
    if (sp_block_async_signals()) return 2;
    if (pthread_sigmask(SIG_BLOCK, NULL, &after)) return 3;
    if (!sigismember(&after, SIGTERM) || !sigismember(&after, SIGPROF) || !sigismember(&after, SIGURG)) return 4;
    const int faults[] = {SIGILL, SIGTRAP, SIGABRT, SIGEMT, SIGFPE, SIGBUS, SIGSEGV, SIGSYS};
    for (size_t i = 0; i < sizeof faults / sizeof faults[0]; i++) {
        if (sigismember(&before, faults[i]) != sigismember(&after, faults[i])) return 5;
    }
    pthread_t worker;
    void *result;
    if (pthread_create(&worker, NULL, otherThread, NULL)) return 6;
    if (pthread_join(worker, &result) || (long)result != -1) return 7;
    if (pthread_sigmask(SIG_SETMASK, &before, NULL)) return 8;
    puts("PASS: main-thread asynchronous signals are blocked without changing fault masks");
    puts("PASS: asynchronous signal setup rejects another thread");
    return 0;
}
