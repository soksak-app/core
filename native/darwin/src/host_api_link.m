#include "host_api_link.h"

#include <stdlib.h>
#include "link.h"
#include "main_thread.h"

// The native call runs on the main thread (main_thread.h).
char *main_sp_link_open(const char *url) { return ON_MAIN(char *, sp_link_open(url)); }
