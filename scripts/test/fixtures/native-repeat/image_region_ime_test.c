/* Activation repeat test: prints its first argument and its run count, and passes only the backspace variant on its first run. */
#include <stdio.h>
#include <string.h>

int main(int argc, char **argv) {
    char path[4096];
    snprintf(path, sizeof path, "%s.count", argv[0]);
    int n = 0;
    FILE *in = fopen(path, "r");
    if (in) {
        if (fscanf(in, "%d", &n) != 1) n = 0;
        fclose(in);
    }
    n += 1;
    FILE *out = fopen(path, "w");
    if (!out) return 2;
    fprintf(out, "%d\n", n);
    fclose(out);
    const char *arg = argc > 1 ? argv[1] : "";
    printf("arg:%s run:%d\n", arg, n);
    return strcmp(arg, "--backspace-trace-abc-baseline") == 0 && n < 2 ? 0 : 1;
}
