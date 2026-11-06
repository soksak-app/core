SHELL := /bin/sh
BUILD := $(CURDIR)/build
LIBDIR := lib
LIBRARY := $(LIBDIR)/libsoksak-process-identity.a
OBJECT := $(BUILD)/process_identity.o
TEST_EXECUTABLE := $(BUILD)/process_identity_test
# MACOS_MINIMUM of the Makefile of the repository declares the minimum macOS version once. The Makefile of native/darwin
# passes it; a make in this folder alone reads it. The pkg-config file puts it in Cflags so that a consumer compiles for it.
ifeq ($(origin MACOS_MINIMUM),undefined)
MACOS_MINIMUM := $(shell sed -n 's/^MACOS_MINIMUM = //p' $(CURDIR)/../../../Makefile)
endif
ifeq ($(MACOS_MINIMUM),)
$(error $(abspath $(CURDIR)/../../../Makefile) declares no MACOS_MINIMUM = <macOS version>)
endif
MINIMUM := -mmacosx-version-min=$(MACOS_MINIMUM)
# The architecture of the release platform darwin-arm64, as in the Makefile of native/darwin.
ARCH := arm64
CFLAGS := -arch $(ARCH) -fmodules -Wall -Werror -O2 $(MINIMUM)
FRAMEWORKS := -framework ApplicationServices -framework CoreServices

.PHONY: build test test-process-identity test-package-relocation repeat clean
build: $(LIBRARY) $(LIBDIR)/pkgconfig/soksak-process-identity.pc

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
	  'Version: 0.0.40' \
	  'Cflags: -I$${includedir} $(MINIMUM)' \
	  'Libs: -L$${libdir} -lsoksak-process-identity $(FRAMEWORKS)' > $@.next
	@if cmp -s $@.next $@; then rm $@.next; else mv $@.next $@; fi

test: test-process-identity test-package-relocation

test-process-identity: $(TEST_EXECUTABLE) build
	@NATIVE_TEST_ONLY=process_identity node ../../../scripts/native-tests.mjs $(CURDIR)/build process_identity_test

test-package-relocation: build
	@NATIVE_TEST_ONLY=package_relocation node ../../../scripts/native-tests.mjs $(CURDIR)/tests package_relocation_test.sh

# Each run is one run of scripts/native-tests.mjs, so the test is named, timed and limited as in test-process-identity.
repeat: $(BUILD)/$(TEST)
	@case "$(COUNT)" in ''|*[!0-9]*|0) echo "repeat requires TEST=<name>_test and a positive COUNT" >&2; exit 2;; esac
	@i=1; while [ $$i -le $(COUNT) ]; do \
	  echo "START: $(TEST) run $$i of $(COUNT)"; \
	  node ../../../scripts/native-tests.mjs $(abspath $(BUILD)) $(TEST) || { echo "FAIL: $(TEST) run $$i of $(COUNT); load $$(uptime)" >&2; exit 1; }; \
	  i=$$((i + 1)); \
	done; echo "PASS: $(TEST) passed $(COUNT) consecutive runs"

$(TEST_EXECUTABLE): tests/process_identity_test.m src/process_identity.m include/soksak_process_identity.h src/private/launch_services.h src/private/process_identity_internal.h | $(BUILD)
	@clang $(CFLAGS) -DSOKSAK_PROCESS_IDENTITY_TESTING -Iinclude -Isrc $< src/process_identity.m $(FRAMEWORKS) -framework Foundation -o $@

clean:
	@rm -rf $(BUILD) $(LIBRARY) $(LIBDIR)/pkgconfig/soksak-process-identity.pc
