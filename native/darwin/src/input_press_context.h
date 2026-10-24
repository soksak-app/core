#ifndef SOKSAK_INPUT_PRESS_CONTEXT_H
#define SOKSAK_INPUT_PRESS_CONTEXT_H

#include <stdbool.h>

// The nested context of a directly dispatched synthetic mouse-down, scoped to its synchronous view callback.
typedef struct sp_input_press_context {
    struct sp_input_press_context *previous;
    void *window;
    double x;
    double y;
} sp_input_press_context;

void sp_input_press_context_push(sp_input_press_context *context, void *window, double x, double y);
void sp_input_press_context_pop(sp_input_press_context *context);
bool sp_input_press_context_point(void *window, double *x, double *y);

#endif
