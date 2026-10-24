#include "support/ime_cli.h"
#include <stdio.h>
#include <string.h>

static unsigned failures;
static unsigned calls;
static sp_ime_cli_mode received_mode;

static void run(sp_ime_cli_mode mode, void *context) {
    calls++;
    received_mode = mode;
    (void)context;
}

static void check(bool condition, const char *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message);
    if (!condition) failures++;
}

int main(void) {
    const char *failure = NULL;
    const char *default_argv[] = {"image_region_ime_test"};
    calls = 0;
    check(sp_ime_cli_dispatch(1, default_argv, run, NULL, &failure)
        && calls == 1 && received_mode == SP_IME_CLI_DEFAULT && failure == NULL,
        "the no-argument activation mode is dispatched explicitly");

    const char *focused_argv[] = {"image_region_ime_test", "--backspace-trace-abc-baseline"};
    calls = 0;
    check(sp_ime_cli_dispatch(2, focused_argv, run, NULL, &failure)
        && calls == 1 && received_mode == SP_IME_CLI_ABC_BASELINE && failure == NULL,
        "the ABC-baseline activation mode is dispatched explicitly");

    const char *unknown_argv[] = {"image_region_ime_test", "--source-probe"};
    calls = 0;
    check(!sp_ime_cli_dispatch(2, unknown_argv, run, NULL, &failure) && calls == 0 && failure != NULL,
        "an unknown option is rejected before the activation callback can run");

    const char *extra_argv[] = {"image_region_ime_test", "--backspace-trace-abc-baseline", "extra"};
    calls = 0;
    check(!sp_ime_cli_dispatch(3, extra_argv, run, NULL, &failure) && calls == 0 && failure != NULL,
        "extra arguments are rejected before the activation callback can run");

    return failures == 0 ? 0 : 1;
}
