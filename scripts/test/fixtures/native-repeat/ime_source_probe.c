/* Source probe fixture: prints the snapshot that the file <argv[0]>.snapshot holds, as one JSON line on standard output. */
#include <stdio.h>

int main(int argc, char **argv) {
    (void)argc;
    char path[4096];
    snprintf(path, sizeof path, "%s.snapshot", argv[0]);
    FILE *in = fopen(path, "r");
    if (!in) return 1;
    int c;
    while ((c = fgetc(in)) != EOF) putchar(c);
    fclose(in);
    return 0;
}
