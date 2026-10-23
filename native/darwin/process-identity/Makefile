SHELL := /bin/sh
BUILD := build
LIBDIR := lib
LIBRARY := $(LIBDIR)/libsoksak-process-identity.a
OBJECT := $(BUILD)/process_identity.o
TEST := $(BUILD)/process_identity_test
MINIMUM := -mmacosx-version-min=14.4
CFLAGS := -fmodules -Wall -Werror -O2 $(MINIMUM)
FRAMEWORKS := -framework ApplicationServices -framework CoreServices

.PHONY: all test clean
all: $(LIBRARY) $(LIBDIR)/pkgconfig/soksak-process-identity.pc

$(BUILD):
	@mkdir -p $@

$(LIBDIR)/pkgconfig:
	@mkdir -p $@

$(OBJECT): src/process_identity.m include/soksak_process_identity.h src/private/launch_services.h src/private/process_identity_internal.h | $(BUILD)
	@clang $(CFLAGS) -Iinclude -Isrc -c $< -o $@

$(LIBRARY): $(OBJECT) | $(LIBDIR)
	@rm -f $@
	@ar rcs $@ $<

$(LIBDIR):
	@mkdir -p $@

$(LIBDIR)/pkgconfig/soksak-process-identity.pc: Makefile | $(LIBDIR)/pkgconfig
	@printf '%s\n' \
	  'prefix=$${pcfiledir}/../..' \
	  'exec_prefix=$${prefix}' \
	  'libdir=$${prefix}/lib' \
	  'includedir=$${prefix}/include' \
	  'Name: soksak-process-identity' \
	  'Description: macOS process display identity' \
	  'Version: 0.0.20' \
	  'Cflags: -I$${includedir} $(MINIMUM)' \
	  'Libs: -L$${libdir} -lsoksak-process-identity $(FRAMEWORKS)' > $@.next
	@if cmp -s $@.next $@; then rm $@.next; else mv $@.next $@; fi

test: $(TEST) all
	@NATIVE_TEST_ONLY=process_identity node ../../../scripts/native-tests.mjs $(CURDIR)/build process_identity_test
	@NATIVE_TEST_ONLY=package_relocation node ../../../scripts/native-tests.mjs $(CURDIR)/tests package_relocation_test.sh

$(TEST): tests/process_identity_test.m src/process_identity.m include/soksak_process_identity.h src/private/launch_services.h src/private/process_identity_internal.h | $(BUILD)
	@clang $(CFLAGS) -DSOKSAK_PROCESS_IDENTITY_TESTING -Iinclude -Isrc $< src/process_identity.m $(FRAMEWORKS) -framework Foundation -o $@

clean:
	@rm -rf $(BUILD) $(LIBRARY) $(LIBDIR)/pkgconfig/soksak-process-identity.pc
