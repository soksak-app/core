/* Runs of the repeat tests: counts its runs in the file <argv[0]>.count, prints the count and exits 1 from the second run on. */
#include <stdio.h>

int main(int argc, char **argv) {
    (void)argc;
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
    printf("probe %d\n", n);
    return n < 2 ? 0 : 1;
}
