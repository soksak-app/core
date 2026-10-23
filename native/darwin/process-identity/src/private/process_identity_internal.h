#import "launch_services.h"

#ifndef SOKSAK_PROCESS_IDENTITY_INTERNAL_H
#define SOKSAK_PROCESS_IDENTITY_INTERNAL_H

typedef struct {
    OSStatus (*register_application)(CFDictionaryRef, ProcessSerialNumber *);
    SPLSASNRef (*current_application_asn)(void);
    OSStatus (*set_application_information_item)(SPLSSessionID, SPLSASNRef, CFStringRef, CFTypeRef, CFDictionaryRef *);
    CFTypeRef (*copy_application_information_item)(SPLSSessionID, SPLSASNRef, CFTypeRef);
} SPProcessIdentityServices;

#ifdef SOKSAK_PROCESS_IDENTITY_TESTING
int sp_process_set_display_name_with_services(const char *display_name, char *error, size_t error_capacity,
    const SPProcessIdentityServices *services);
#endif

#endif
