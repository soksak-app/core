/* Marks a run: creates the file <argv[0]>.executed, so a caller can see that the program was started. */
#include <stdio.h>

int main(int argc, char **argv) {
    (void)argc;
    char path[4096];
    snprintf(path, sizeof path, "%s.executed", argv[0]);
    FILE *out = fopen(path, "w");
    if (!out) return 1;
    fclose(out);
    return 0;
}
