// 표시를 한 번에 하나씩 실행하고, 그 뒤에는 가장 새 배치 하나만 기다리게 한다.
// 표시 하나는 화면 한 프레임 이상 걸리므로 포인터 입력이 표시보다 빨리 도착할 수 있다.
// 기다리는 배치를 모두 차례로 실행하면 화면이 밀린 배치 수만큼 포인터보다 늦는다.
// 가장 새 배치는 앞선 입력을 모두 담으므로, 기다리던 이전 배치를 대신하고 그 배치의
// 준비와 그리기는 실행되지 않는다. 대신한 배치는 superseded 로 알린다.
//
// 실패한 배치는 failed 가 받아 보고하고, run 의 답은 { status: "failed" } 로 이행한다. 그 실패를 받은 요청자는 대기열이므로
// 배치를 예약하거나 기다린 쪽은 같은 실패를 거절로 다시 받지 않는다(docs/spec/hosts.md#application-log).
export function createLayoutQueue({ failed, superseded }) {
  let active = null;
  let pending = null;
  let latest = Promise.resolve();

  function start(item) {
    active = item;
    Promise.resolve()
      .then(item.work)
      .then(item.resolve, (error) => {
        failed(error);
        item.resolve({ status: "failed" });
      })
      .finally(() => {
        active = null;
        if (pending) {
          const next = pending;
          pending = null;
          start(next);
        }
      });
  }

  return {
    run(work) {
      const result = new Promise((resolve) => {
        const item = { work, resolve };
        if (pending) {
          superseded(pending.work);
          pending.resolve({ status: "superseded" });
        }
        pending = item;
        if (!active) {
          const next = pending;
          pending = null;
          start(next);
        }
      });
      latest = result;
      return latest;
    },
    /**
     * 가장 새 배치가 끝날 때까지 기다리고, 그 배치가 끝까지 실행되었으면 true, 실패했으면 false 를 반환한다. 기다리는
     * 동안 더 새 배치가 예약되면 그 배치를 다시 기다린다. 대신된 배치는 그리지 않고 끝나므로, 그 끝에서 멈추면 그 배치가
     * 지우려던 슬롯이 문서에 남아 있다. 실패는 failed 가 이미 보고했다(docs/spec/hosts.md#application-log).
     */
    async wait() {
      for (;;) {
        const awaited = latest;
        const outcome = await awaited;
        // 기본값: 끝까지 실행된 배치의 답은 그 일의 반환값이며 drawPrepared 는 값을 반환하지 않는다.
        if (awaited === latest) return outcome?.status !== "failed";
      }
    },
  };
}

/**
 * 배치 하나를 그린다. 네이티브 준비 응답(prepare)이 트랜잭션의 시작과 적용을 확인한 뒤 DOM 을 그린다(draw). 요청
 * 시작만으로 준비를 확정하면 새 DOM 이 이전 네이티브 영역 아래에 먼저 표시된다. 그린 뒤에는 draw 가 예약한 렌더(frame)와
 * 해당 호스트 표시(presented)까지 기다려, 다음 배치가 DOM 을 먼저 교체하지 못하게 한다. 준비하는 동안 current() 가
 * epoch 와 달라지면 그리지 않는다.
 */
export async function drawPrepared({ epoch, current, prepare, draw, frame, presented }) {
  if (epoch !== current()) return;
  await prepare();
  if (epoch !== current()) return;
  draw();
  await frame();
  await presented();
}

/** 문서가 animation frame 하나를 실행하기를 기다리는 시간(ms). 호스트의 표시 한도와 같다(docs/spec/native-surfaces.md). */
const FRAME_TIMEOUT = 10_000;

/**
 * 다음 animation frame 을 기다린다. 문서가 frame 을 실행하지 않으면(WebKit 이 렌더링을 멈춘 경우) 이 기다림의
 * 오류로 실패하여, 배치와 그 배치를 기다리는 명령이 끝없이 기다리지 않게 한다.
 */
export function animationFrame(request = requestAnimationFrame) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`the main document ran no animation frame within ${FRAME_TIMEOUT}ms`)), FRAME_TIMEOUT);
    request((time) => {
      clearTimeout(timer);
      resolve(time);
    });
  });
}
