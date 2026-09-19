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
      shift: modifiers.shift,
      alt: modifiers.alt,
      ctrl: modifiers.ctrl,
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
  // 호출자가 반드시 scale을 제공해야 한다. 없거나 양수가 아니면 계약 위반이다.
  if (typeof scale !== "number" || scale <= 0) {
    throw new Error(`startTerminal requires scale to be a positive number, got: ${typeof scale === "number" ? scale : typeof scale}`);
  }

  // 브라우저 환경에서 필요한 객체들
  const window = globalWindow;
  const ResizeObserver = globalWindow.ResizeObserver;
  const TextEncoder = globalWindow.TextEncoder;
  const devicePixelRatio = scale;

  const id = new URLSearchParams(view.ownerDocument?.location?.search || "").get("id");
  if (!id) {
    throw new Error("startTerminal requires surface id in URL search params");
  }
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
  let session = { sessionId: "", cols: 80, rows: 24, cellWidth: 8, cellHeight: 16, unsupported: [] };

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

  // open이 전송되었는지 추적
  let openSent = false;

  // open 전 입력 queue (상한: 1024)
  const inputQueue = [];
  const MAX_QUEUE_SIZE = 1024;

  // 영역 insert 이벤트: 평문 텍스트 입력
  region.on("insert", async (event) => {
    const { text } = event;
    if (!openSent) {
      // open 전이면 queue에 저장
      if (inputQueue.length >= MAX_QUEUE_SIZE) {
        const errorMsg = `Input queue overflow (max ${MAX_QUEUE_SIZE})`;
        console.error(errorMsg);
        session = { ...session, error: errorMsg };
        changed("session");
        return;
      }
      inputQueue.push({ type: "insert", text });
      return;
    }
    await sendInput(text, terminal, id, encoder);
  });

  // 영역 key 이벤트: 특수 키와 수정자
  // 사이드카는 키 이름만 받고 이스케이프 시퀀스를 생성한다
  region.on("key", async (event) => {
    const { key, shift, alt, ctrl } = event;
    // 네이티브 영역은 항상 불린으로 수정자를 보낸다. 아니면 계약 위반이다.
    if (typeof shift !== "boolean" || typeof alt !== "boolean" || typeof ctrl !== "boolean") {
      const errorMsg = `invalid key event from region: modifiers must be boolean, got shift:${typeof shift} alt:${typeof alt} ctrl:${typeof ctrl}`;
      console.error(errorMsg);
      session = { ...session, error: errorMsg };
      changed("session");
      return;
    }
    if (!openSent) {
      // open 전이면 queue에 저장
      if (inputQueue.length >= MAX_QUEUE_SIZE) {
        const errorMsg = `Input queue overflow (max ${MAX_QUEUE_SIZE})`;
        console.error(errorMsg);
        session = { ...session, error: errorMsg };
        changed("session");
        return;
      }
      inputQueue.push({ type: "key", key, shift, alt, ctrl });
      return;
    }
    // 키 이름을 sidecar 메시지 형식으로 변환
    const message = keyToMessage(key, "", { shift, alt, ctrl });
    await terminal.send(id, message);
  });

  // 영역 compose 이벤트: 현재 미구현이므로 추적만 한다
  region.on("compose", (event) => {
    if (!session.unsupported.includes("compose")) {
      console.warn("compose event not yet supported");
      session = { ...session, unsupported: [...session.unsupported, "compose"] };
      changed("session");
    }
  });

  // 포인터 다운 시 focus 호출
  view.addEventListener("pointerdown", () => {
    region.focus().catch((error) => console.error(`focus failed: ${error.message}`));
  });

  // 첫 번째 0보다 큰 크기로 open 전송 여부 추적
  let openSentViaResize = false;

  // 뷰 크기 변경 감지
  const resizeObserver = new ResizeObserver(() => {
    if (region === null) return;
    const width = Math.round(view.clientWidth);
    const height = Math.round(view.clientHeight);

    // 첫 번째로 0보다 큰 크기를 받으면 open을 전송한다
    if (!openSentViaResize && width > 0 && height > 0) {
      openSentViaResize = true;
      openSent = true;
      terminal.send(id, { op: "open", width, height, scale: devicePixelRatio, image: "view" })
        .catch((error) => console.error(`open failed: ${error.message}`));

      // open 후 queue에 저장된 입력들을 순서대로 처리한다
      for (const queuedInput of inputQueue) {
        if (queuedInput.type === "insert") {
          sendInput(queuedInput.text, terminal, id, encoder).catch(
            (error) => console.error(`queued insert failed: ${error.message}`)
          );
        } else if (queuedInput.type === "key") {
          const message = keyToMessage(queuedInput.key, "", {
            shift: queuedInput.shift,
            alt: queuedInput.alt,
            ctrl: queuedInput.ctrl,
          });
          terminal.send(id, message).catch(
            (error) => console.error(`queued key failed: ${error.message}`)
          );
        }
      }
      inputQueue.length = 0; // queue 비우기
      return;
    }

    // 0인 크기는 resize로 보내지 않는다
    if (width === 0 || height === 0) return;

    // 그 뒤의 크기 변화는 resize로 보낸다
    if (openSent) {
      terminal.send(id, { op: "resize", width, height, scale: devicePixelRatio })
        .catch((error) => console.error(`resize failed: ${error.message}`));
    }
  });
  resizeObserver.observe(view);

  // 사이드카 메시지 수신
  await terminal.on(id, (body) => {
    if (body.event === "state") {
      // 숫자 필드의 유효성을 확인한다. 계약 위반이면 오류로 보고한다.
      const errorDetails = [];
      if (typeof body.cols !== "number" || body.cols <= 0) {
        errorDetails.push(`cols: ${typeof body.cols === "number" ? `invalid value ${body.cols}` : `missing or wrong type`}`);
      }
      if (typeof body.rows !== "number" || body.rows <= 0) {
        errorDetails.push(`rows: ${typeof body.rows === "number" ? `invalid value ${body.rows}` : `missing or wrong type`}`);
      }
      if (typeof body.cellWidth !== "number" || body.cellWidth <= 0) {
        errorDetails.push(`cellWidth: ${typeof body.cellWidth === "number" ? `invalid value ${body.cellWidth}` : `missing or wrong type`}`);
      }
      if (typeof body.cellHeight !== "number" || body.cellHeight <= 0) {
        errorDetails.push(`cellHeight: ${typeof body.cellHeight === "number" ? `invalid value ${body.cellHeight}` : `missing or wrong type`}`);
      }

      if (errorDetails.length > 0) {
        const errorMsg = `invalid state from sidecar: ${errorDetails.join("; ")}`;
        console.error(errorMsg);
        session = {
          ...session,
          error: errorMsg,
        };
        changed("session");
        return;
      }

      session = {
        sessionId: typeof body.sessionId === "string" ? body.sessionId : "",
        cols: body.cols,
        rows: body.rows,
        cellWidth: body.cellWidth,
        cellHeight: body.cellHeight,
        unsupported: session.unsupported,
      };
      changed("session");
    } else if (body.event === "error") {
      // error 이벤트를 session 상태에 저장한다
      session = {
        ...session,
        error: typeof body.error === "string" ? body.error : (typeof body.message === "string" ? body.message : "Unknown error"),
      };
      changed("session");
    } else if (body.error) {
      // 호환성을 위해 legacy error 필드도 처리한다
      // 새로운 규약: {"error":"invalidParams",...} 형식
      session = {
        ...session,
        error: body.error,
      };
      changed("session");
    } else if (body.event) {
      // 알 수 없는 이벤트 타입을 보고한다
      console.warn(`sidecar sent unknown event type: ${body.event}`);
      if (!session.unsupported.includes(body.event)) {
        session = { ...session, unsupported: [...session.unsupported, body.event] };
        changed("session");
      }
    }
  });

  // 공개 항목 등록
  await Promise.all([
    expose.status("terminal.session", read.session, watch("session")),
    expose.command("terminal.input", async ({ bytes }) => {
      if (typeof bytes !== "string") throw new Error("terminal.input requires bytes");
      if (!openSent) {
        throw new Error("Terminal not yet open");
      }
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
