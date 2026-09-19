// 터미널 표면의 부팅과 동작을 처리한다.
//
// startTerminal 함수는 인자로 받은 의존성을 사용하므로 브라우저와 Node 환경에서 모두 부를 수 있다.

/**
 * 입력 텍스트를 base64로 인코딩한다.
 */
function encodeBytes(text, encoder) {
  const bytes = encoder.encode(text);
  return btoa(String.fromCharCode(...bytes));
}

/**
 * 키 이벤트를 sidecar 메시지 형식으로 변환한다.
 * 평문과 특수 키 모두에 사용한다.
 */
function keyToMessage(keyName, text = "", modifiers = {}) {
  const message = {
    op: "input",
    keys: [{
      key: keyName,
      text: text || "",
      shift: modifiers.shift || false,
      alt: modifiers.alt || false,
      ctrl: modifiers.ctrl || false,
    }],
  };
  return message;
}

/**
 * 텍스트 입력을 base64로 인코딩하여 사이드카로 전송한다.
 */
function sendInput(text, terminal, id, encoder) {
  const base64 = encodeBytes(text, encoder);
  return terminal.send(id, { op: "input", bytes: base64 });
}

/**
 * 터미널 표면을 초기화하고 사이드카와 연결한다.
 *
 * @param {Object} options - 의존성 객체
 * @param {Element} options.view - 터미널 표시 영역
 * @param {Function} options.attachImage - 이미지 영역 붙이기 함수
 * @param {Object} options.sidecar - 사이드카 포트
 * @param {Object} options.expose - 공개 항목 등록 함수 모음
 * @param {number} options.scale - 장치 픽셀 비율 (devicePixelRatio)
 * @param {Object} options.window - window 객체 (기본값: 글로벌 window)
 * @returns {Promise<void>}
 */
export async function startTerminal({ view, attachImage, sidecar, expose, scale, window: globalWindow = globalThis.window }) {
  // 브라우저 환경에서 필요한 객체들
  const window = globalWindow;
  const ResizeObserver = globalWindow.ResizeObserver;
  const TextEncoder = globalWindow.TextEncoder;
  const devicePixelRatio = scale ?? globalWindow.devicePixelRatio ?? 1;

  const id = new URLSearchParams(view.ownerDocument?.location?.search ?? "").get("id");
  const encoder = new TextEncoder();

  // 공개 status 마다 값이 바뀔 때 호출할 함수
  const watchers = { session: new Set() };
  const changed = (name) => {
    for (const fn of watchers[name]) fn(read[name]());
  };
  const watch = (name) => (fn) => {
    watchers[name].add(fn);
    return () => watchers[name].delete(fn);
  };

  // 현재 세션 상태
  let session = { sessionId: "", cols: 80, rows: 24, cellWidth: 8, cellHeight: 16 };

  const read = {
    // 세션 상태
    session: () => session,
  };

  // 터미널 사이드카가 이 표면의 VT 세션을 실행한다
  const terminal = sidecar;

  // 이미지 영역 생성 및 사이드카 메시지 핸들링
  let region = null;

  // 이미지 영역 붙이기
  region = attachImage(view, "view", "@soksak/sidecar-vt-alacritty");
  if (!region) throw new Error("Failed to attach image region");

  // 영역 insert 이벤트: 평문 텍스트 입력
  region.on("insert", async (event) => {
    const { text } = event;
    await sendInput(text, terminal, id, encoder);
  });

  // 영역 key 이벤트: 특수 키와 수정자
  // 사이드카는 키 이름만 받고 이스케이프 시퀀스를 생성한다
  region.on("key", async (event) => {
    const { key, shift = false, alt = false, ctrl = false } = event;
    // 키 이름을 sidecar 메시지 형식으로 변환
    const message = keyToMessage(key, "", { shift, alt, ctrl });
    await terminal.send(id, message);
  });

  // 포인터 다운 시 focus 호출
  view.addEventListener("pointerdown", () => {
    region.focus().catch((error) => console.error(`focus failed: ${error.message}`));
  });

  // 뷰 크기 변경 감지
  const resizeObserver = new ResizeObserver(() => {
    if (region === null) return;
    const width = Math.round(view.clientWidth);
    const height = Math.round(view.clientHeight);
    terminal.send(id, { op: "resize", width, height, scale: devicePixelRatio })
      .catch((error) => console.error(`resize failed: ${error.message}`));
  });
  resizeObserver.observe(view);

  // 사이드카 메시지 수신
  await terminal.on(id, (body) => {
    if (body.event === "state") {
      session = {
        sessionId: body.sessionId || "",
        cols: body.cols || 80,
        rows: body.rows || 24,
        cellWidth: body.cellWidth || 8,
        cellHeight: body.cellHeight || 16,
      };
      changed("session");
    } else if (body.error) {
      console.error(`sidecar error: ${body.error}`);
    }
  });

  // 초기 open 명령
  const width = Math.round(view.clientWidth);
  const height = Math.round(view.clientHeight);
  await terminal.send(id, { op: "open", width, height, scale: devicePixelRatio, image: "view" })
    .catch((error) => console.error(`open failed: ${error.message}`));

  // 공개 항목 등록
  await Promise.all([
    expose.status("terminal.session", read.session, watch("session")),
    expose.command("terminal.input", async ({ bytes }) => {
      if (typeof bytes !== "string") throw new Error("terminal.input requires bytes");
      await sendInput(bytes, terminal, id, encoder);
      return null;
    }),
    expose.command("terminal.screen.read", async () => {
      if (region === null) throw new Error("Terminal not initialized");
      return new Promise((resolve, reject) => {
        let resolved = false;
        const unsubscribe = region.on("screen", (event) => {
          if (event && event.lines) {
            resolved = true;
            unsubscribe();
            resolve(event.lines);
          }
        });
        terminal.send(id, { op: "screen.read" }).catch((error) => {
          unsubscribe();
          reject(error);
        });
        // Timeout after 5 seconds
        setTimeout(() => {
          if (!resolved) {
            unsubscribe();
            reject(new Error("screen.read timeout"));
          }
        }, 5000);
      });
    }),
    expose.command("terminal.close", async () => {
      await terminal.send(id, { op: "close" });
      return null;
    }),
    expose.dom("terminal.view", view),
  ]);
}
