#include "signals.h"
#include <pthread.h>
#include <signal.h>
#include <stdio.h>

static void *otherThread(void *unused) {
    return (void *)(long)sp_block_async_signals();
}
int main(void) {
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
