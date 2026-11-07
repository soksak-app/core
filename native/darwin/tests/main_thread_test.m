// The native library owns the installed thread dispatch functions, so every host binding uses the same dispatch state.
#include "main_thread.h"
#include <stdio.h>
#include <stdlib.h>
#include <signal.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

static int workerCalls;
static int mainCalls;
static void worker(void (^task)(void)) { workerCalls++; task(); }
static void mainThread(void (^task)(void)) { mainCalls++; task(); }

static int failures;
static void check(bool passed, const char *name) {
    fprintf(passed ? stdout : stderr, "%s: %s\n", passed ? "PASS" : "FAIL", name);
    if (!passed) failures++;
}

static void checkMissing(bool missingWorker) {
    int output[2];
    if (pipe(output) != 0) { perror("pipe"); exit(2); }
    fflush(NULL);
    pid_t child = fork();
    if (child < 0) { perror("fork"); exit(2); }
    if (child == 0) {
        close(output[0]);
        if (dup2(output[1], STDERR_FILENO) < 0) _exit(2);
        close(output[1]);
        hostInstallMainThread(missingWorker ? NULL : worker, missingWorker ? mainThread : NULL);
        if (missingWorker) hostRunOnWorker(^{});
        else hostRunOnMain(^{});
        _exit(3);
    }
    close(output[1]);
    int status = 0;
    if (waitpid(child, &status, 0) != child) { perror("waitpid"); exit(2); }
    char message[1024];
    ssize_t count = read(output[0], message, sizeof(message) - 1);
    if (count < 0) { perror("read"); exit(2); }
    message[count] = '\0';
    close(output[0]);
    const char *missing = missingWorker ? "main-thread function hostRunOnWorker is not installed"
                                        : "main-thread function hostRunOnMain is not installed";
    check(WIFSIGNALED(status) && WTERMSIG(status) == SIGABRT && strstr(message, missing) != NULL,
          missingWorker ? "a missing worker ends the process and names the missing function"
                        : "a missing main-thread function ends the process and names the missing function");
}

int main(void) {
    bool hasWorker = true, hasMain = true;
    hostMainThreadInstalled(&hasWorker, &hasMain);
    check(!hasWorker && !hasMain, "the native library initially has neither thread dispatch function");

    hostInstallMainThread(worker, NULL);
    hostMainThreadInstalled(&hasWorker, &hasMain);
    check(hasWorker && !hasMain, "a missing main-thread function is reported independently");
    hostInstallMainThread(NULL, mainThread);
    hostMainThreadInstalled(&hasWorker, &hasMain);
    check(!hasWorker && hasMain, "a missing worker function is reported independently");

    hostInstallMainThread(worker, mainThread);
    hostMainThreadInstalled(&hasWorker, &hasMain);
    check(hasWorker && hasMain, "both thread dispatch functions are installed in the native library");
    __block int value = 0;
    hostRunOnWorker(^{ value = 17; });
    check(value == 17 && workerCalls == 1 && mainCalls == 0,
          "a worker task completes through the installed worker before returning");
    hostRunOnMain(^{ value = 23; });
    check(value == 23 && workerCalls == 1 && mainCalls == 1,
          "a main-thread call completes through the installed main-thread function before returning");
    int workerResult = ON_WORKER(int, 31);
    int mainResult = ON_MAIN(int, 47);
    check(workerResult == 31 && mainResult == 47 && workerCalls == 2 && mainCalls == 2,
          "thread dispatch returns the value produced on each installed function");
    checkMissing(true);
    checkMissing(false);
    return failures ? 1 : 0;
}
