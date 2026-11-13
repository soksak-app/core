/* Suite test fixture: prints "ran" and its arguments after the program name, and passes. */
#include <stdio.h>

int main(int argc, char **argv) {
    printf("ran");
    for (int i = 1; i < argc; i += 1) printf(" %s", argv[i]);
    printf("\n");
    return 0;
}
