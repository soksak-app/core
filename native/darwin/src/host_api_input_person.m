// Native implementation of the host binding of the diagnostic action of a person (input_person.h).
#include "host_api_input_person.h"

#include <stdbool.h>
#include <stdint.h>
#include "input_person.h"
#include "main_thread.h"

// The native call runs on the main thread (main_thread.h).
bool main_sp_input_person(uintptr_t window, const char *action, double x, double y, char **error) {
    return ON_MAIN(bool, sp_input_person((void *)window, action, x, y, error));
}
