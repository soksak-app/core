#include "soksak_process_identity.h"
#include <string.h>

int main(void) {
    char error[256] = {0};
    int status = soksak_process_set_display_name("soksak://sidecar/relocated", error, sizeof(error));
    return status == 0 && error[0] == '\0' ? 0 : 1;
}
