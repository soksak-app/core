#import "launch_services.h"

#ifndef SOKSAK_PROCESS_IDENTITY_INTERNAL_H
#define SOKSAK_PROCESS_IDENTITY_INTERNAL_H

#ifdef SOKSAK_PROCESS_IDENTITY_TESTING
// The check-in dictionary that soksak_process_set_display_name registers the process with, for the display name; the caller releases it.
CFDictionaryRef sp_process_copy_check_in_information(CFStringRef display_name);
#endif

#endif
