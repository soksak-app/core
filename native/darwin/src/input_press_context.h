#ifndef SOKSAK_INPUT_PRESS_CONTEXT_H
#define SOKSAK_INPUT_PRESS_CONTEXT_H

#include <stdbool.h>
#include <stdint.h>

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
// A press origin is kept by window, pointer and button. The pointer is the one of sp_input_pointer_then whose input is delivered;
// outside such a delivery it is SP_INPUT_POINTER_MAIN, which also stands for a person's press.
uint64_t sp_input_press_origin_set(void *window, int button, double x, double y);
bool sp_input_press_origin_point(void *window, int button, double *x, double *y, uint64_t *token);
// The state of the application and of the window at the press of a stored origin. Returns false when no origin is stored.
bool sp_input_press_origin_state(void *window, int button, bool *active, bool *key);
void sp_input_press_origin_clear(void *window, int button, uint64_t token);
// Whether any pointer of sp_input_pointer holds an open press of the button in the window. An origin outlives the release of its press, so it does not tell this.
bool sp_input_press_open(void *window, int button);

#endif
