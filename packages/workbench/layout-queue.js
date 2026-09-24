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
