#ifndef SOKSAK_IME_CLI_H
#define SOKSAK_IME_CLI_H

#include <stdbool.h>

typedef enum {
    SP_IME_CLI_DEFAULT,
    SP_IME_CLI_ABC_BASELINE
} sp_ime_cli_mode;

typedef void (*sp_ime_cli_run)(sp_ime_cli_mode mode, void *context);

// Parses an invocation before the caller initializes AppKit or reads an input source.
bool sp_ime_cli_dispatch(int argc, const char *argv[], sp_ime_cli_run run, void *context, const char **failure);

#endif
