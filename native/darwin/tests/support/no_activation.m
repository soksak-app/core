#import <Cocoa/Cocoa.h>
#import <stdio.h>
#import <stdlib.h>
#import <unistd.h>

// Checks of make test do not activate the application. Every check links this file, and a check fails at exit if the
// process is active. Checks of make test-activation call sp_test_declare_activation before they activate.
void sp_test_declare_activation(void);

static bool declared;

void sp_test_declare_activation(void) { declared = true; }

// Changes the exit code to 1 if the process of a check that did not declare activation is active at exit.
static void failWhenActive(void) {
    if (declared || NSApp == nil || !NSApp.isActive) return;
    fprintf(stderr, "FAIL: the test process is active at exit; a make test check must not activate the application\n");
    _exit(1);
}

__attribute__((constructor)) static void install(void) { atexit(failWhenActive); }
