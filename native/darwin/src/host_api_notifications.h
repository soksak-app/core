#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// Host-facing native operations; callback contexts are integer tokens, never Go pointers.
const char *startNotifications(void);
void main_sp_notifications_post(const char *identifier, const char *title, const char *body);
void main_sp_notifications_remove(const char *identifier);
