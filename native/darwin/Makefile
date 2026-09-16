# macOS 공용 네이티브 라이브러리.
#
# 공용 소스를 정적 라이브러리 하나로 빌드하고, 사용하는 애플리케이션이 pkg-config 로
# 헤더와 라이브러리 위치를 찾도록 soksak-darwin.pc 를 생성한다.
#
#   make          build/libsoksak-darwin.a, build/soksak-darwin.pc
#   make test     입력 검사를 빌드하고 기준 실행과 등록 실행을 수행한다

SHELL := /bin/sh

SOURCES    := $(wildcard *.m)
BUILD      := $(CURDIR)/build
OBJECTS    := $(SOURCES:%.m=$(BUILD)/%.o)
LIBRARY    := $(BUILD)/libsoksak-darwin.a
PKGCONFIG  := $(BUILD)/soksak-darwin.pc
FRAMEWORKS := -framework Cocoa -framework WebKit -framework QuartzCore
# 소스가 사용하는 가장 새로운 API 는 macOS 12.0 의 것이다. 사용하는 빌드가 같은 최소
# 버전으로 컴파일·링크하도록 .pc 의 Cflags 와 Libs 에도 넣는다.
MINIMUM    := -mmacosx-version-min=12.0
CFLAGS     := -fblocks -fmodules -Wall -Werror -O2 $(MINIMUM)

.PHONY: all test clean

all: $(LIBRARY) $(PKGCONFIG)

$(BUILD)/%.o: %.m $(wildcard *.h) Makefile | $(BUILD)
	@clang $(CFLAGS) -c $< -o $@

$(LIBRARY): $(OBJECTS)
	@rm -f $@
	@ar rcs $@ $^

$(PKGCONFIG): Makefile | $(BUILD)
	@printf '%s\n' \
	  'Name: soksak-darwin' \
	  'Description: Shared macOS window, webview, and surface layout code' \
	  'Version: 0.0.1' \
	  'Cflags: -I$(CURDIR) $(MINIMUM)' \
	  'Libs: -L$(BUILD) -lsoksak-darwin $(FRAMEWORKS) $(MINIMUM)' > $@

$(BUILD):
	@mkdir -p $@

$(BUILD)/webview-input: tests/webview-input.m $(LIBRARY)
	@clang $(CFLAGS) -I$(CURDIR) $< -L$(BUILD) -lsoksak-darwin $(FRAMEWORKS) $(MINIMUM) -o $@

test: $(BUILD)/webview-input
	@$(BUILD)/webview-input --baseline
	@$(BUILD)/webview-input

clean:
	@rm -rf $(BUILD)
