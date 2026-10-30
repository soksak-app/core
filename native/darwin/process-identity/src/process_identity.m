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
    // The check-in dictionary carries the display name, so LaunchServices lists the process with that name from the moment
    // it registers it. A registration without the name lists the executable name until the set call below, and a process
    // that reads the list in that interval receives the executable name. LaunchServices applies the dictionary only at the
    // first registration of a process; the set call makes the name exact for a process that is already registered.
    const void *infoKeys[] = {_kLSDisplayNameKey};
    const void *infoValues[] = {requested};
    CFDictionaryRef info = CFDictionaryCreate(kCFAllocatorDefault, infoKeys, infoValues, 1,
        &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
    if (info == NULL) {
        setError(error, error_capacity, "creating LaunchServices check-in information", ENOMEM);
        CFRelease(requested);
        return ENOMEM;
    }
    OSStatus status = services->register_application(info, NULL);
    CFRelease(info);
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
    // The error names the value that LaunchServices returned, so a failed readback shows whether the value was missing,
    // of another type or another name. The caller holds no autorelease pool, so the text is built in one.
    if (!matches && error && error_capacity) @autoreleasepool {
        NSString *found = copied == NULL ? @"no value"
            : CFGetTypeID(copied) != CFStringGetTypeID()
                ? [NSString stringWithFormat:@"a value of type %@", CFBridgingRelease(CFCopyTypeIDDescription(CFGetTypeID(copied)))]
                : [NSString stringWithFormat:@"\"%@\"", (__bridge NSString *)copied];
        snprintf(error, error_capacity, "LaunchServices display name readback found %s, expected \"%s\"", found.UTF8String, display_name);
    }
    if (copied) CFRelease(copied);
    CFRelease(requested);
    if (!matches) return EIO;
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
