#include "signals.h"
#include <pthread.h>
#include <signal.h>
#include <stddef.h>

int sp_block_async_signals(void) {
    if (!pthread_main_np()) return -1;
    sigset_t set;
    sigfillset(&set);
    const int faults[] = {SIGILL, SIGTRAP, SIGABRT, SIGEMT, SIGFPE, SIGBUS, SIGSEGV, SIGSYS};
    for (size_t i = 0; i < sizeof faults / sizeof faults[0]; i++) sigdelset(&set, faults[i]);
    return pthread_sigmask(SIG_BLOCK, &set, NULL);
}
