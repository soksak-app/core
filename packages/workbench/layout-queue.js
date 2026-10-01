// 표시를 한 번에 하나씩 실행하고, 그 뒤에는 가장 새 배치 하나만 기다리게 한다.
// 표시 하나는 화면 한 프레임 이상 걸리므로 포인터 입력이 표시보다 빨리 도착할 수 있다.
// 기다리는 배치를 모두 차례로 실행하면 화면이 밀린 배치 수만큼 포인터보다 늦는다.
// 가장 새 배치는 앞선 입력을 모두 담으므로, 기다리던 이전 배치를 대신하고 그 배치의
// 준비와 그리기는 실행되지 않는다. 대신한 배치는 superseded 로 알린다.
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
        item.reject(error);
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
      const result = new Promise((resolve, reject) => {
        const item = { work, resolve, reject };
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
    wait: () => latest,
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
