#include "ime_cli.h"
#include <string.h>

bool sp_ime_cli_dispatch(int argc, const char *argv[], sp_ime_cli_run run, void *context, const char **failure) {
    if (failure) *failure = NULL;
    if (!run || argc < 1 || !argv || !argv[0]) {
        if (failure) *failure = "the IME test command is invalid";
        return false;
    }
    sp_ime_cli_mode mode = SP_IME_CLI_DEFAULT;
    if (argc == 1) {
        run(mode, context);
        return true;
    }
    if (argc == 2 && argv[1] && strcmp(argv[1], "--backspace-trace-abc-baseline") == 0) {
        mode = SP_IME_CLI_ABC_BASELINE;
        run(mode, context);
        return true;
    }
    if (failure) *failure = argc > 2 ? "unexpected extra arguments" : "unknown option";
    return false;
}
