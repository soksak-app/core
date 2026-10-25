#import <Foundation/Foundation.h>
#include <errno.h>
#include <stdio.h>
#include <string.h>
#import "soksak_process_identity.h"
#import "private/process_identity_internal.h"

static void setError(char *error, size_t capacity, const char *operation, int status) {
    if (error == NULL || capacity == 0) return;
    snprintf(error, capacity, "%s failed with status %d", operation, status);
}

static BOOL validDisplayName(const char *name) {
    static const char prefix[] = "soksak://sidecar/";
    if (name == NULL || strncmp(name, prefix, sizeof(prefix) - 1) != 0) return NO; // silent: this predicate rejects names that the caller reports as invalid.
    const unsigned char *id = (const unsigned char *)name + sizeof(prefix) - 1;
    if (*id < 'a' || *id > 'z') return NO; // silent: this predicate rejects ids that the caller reports as invalid.
    for (; *id; id++) {
        if ((*id >= 'a' && *id <= 'z') || (*id >= '0' && *id <= '9') || *id == '-') continue;
        return NO; // silent: this predicate rejects characters that the caller reports as an invalid display name.
    }
    return YES;
}

static int processSetDisplayNameWithServices(const char *display_name, char *error, size_t error_capacity,
    const SPProcessIdentityServices *services) {
    if (error && error_capacity) error[0] = '\0';
    if (services == NULL || services->register_application == NULL || services->current_application_asn == NULL ||
        services->set_application_information_item == NULL || services->copy_application_information_item == NULL) {
        setError(error, error_capacity, "process identity services", EINVAL);
        return EINVAL;
    }
    if (!validDisplayName(display_name)) {
        setError(error, error_capacity, "invalid process display name", EINVAL);
        return EINVAL;
    }
    CFStringRef requested = CFStringCreateWithCString(kCFAllocatorDefault, display_name, kCFStringEncodingASCII);
    if (requested == NULL) {
        setError(error, error_capacity, "creating process display name", EINVAL);
        return EINVAL;
    }
    OSStatus status = services->register_application(NULL, NULL);
    if (status != noErr) {
        setError(error, error_capacity, "LaunchServices registration", (int)status);
        CFRelease(requested);
        return (int)status;
    }
    SPLSASNRef asn = services->current_application_asn();
    if (asn == NULL) {
        setError(error, error_capacity, "current process ASN", EINVAL);
        CFRelease(requested);
        return EINVAL;
    }
    status = services->set_application_information_item(SPLSDefaultSessionID, asn,
        _kLSDisplayNameKey, requested, NULL);
    if (status != noErr) {
        setError(error, error_capacity, "LaunchServices display name set", (int)status);
        CFRelease(requested);
        return (int)status;
    }
    CFTypeRef copied = services->copy_application_information_item(SPLSDefaultSessionID, asn, _kLSDisplayNameKey);
    BOOL matches = copied != NULL && CFGetTypeID(copied) == CFStringGetTypeID() && CFEqual(copied, requested);
    if (copied) CFRelease(copied);
    CFRelease(requested);
    if (!matches) {
        setError(error, error_capacity, "LaunchServices display name readback", EIO);
        return EIO;
    }
    return 0;
}

static const SPProcessIdentityServices launchServices = {
    .register_application = _RegisterApplication,
    .current_application_asn = _LSGetCurrentApplicationASN,
    .set_application_information_item = _LSSetApplicationInformationItem,
    .copy_application_information_item = _LSCopyApplicationInformationItem,
};

int soksak_process_set_display_name(const char *display_name, char *error, size_t error_capacity) {
    return processSetDisplayNameWithServices(display_name, error, error_capacity, &launchServices);
}

#ifdef SOKSAK_PROCESS_IDENTITY_TESTING
int sp_process_set_display_name_with_services(const char *display_name, char *error, size_t error_capacity,
    const SPProcessIdentityServices *services) {
    return processSetDisplayNameWithServices(display_name, error, error_capacity, services);
}
#endif
