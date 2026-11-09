#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// Host-facing native operations; callback contexts are integer tokens, never Go pointers.
bool installQuitRequest(void);
void main_sp_quit_request_answer(void);
void main_sp_quit_request_cancel(void);
int main_sp_quit_request_event_type(void);
