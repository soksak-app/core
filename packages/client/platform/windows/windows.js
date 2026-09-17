// Windows 의 로컬 엔드포인트 전송: named pipe.
export const name = "windows";
export const transport = "pipe";

/** 프로세스별 named pipe 이름을 만든다. 파이프는 서버가 닫히면 제거되므로 remove 는 할 일이 없다. */
export function createAddress(label) {
  return { address: `\\\\.\\pipe\\${label}-${process.pid}`, remove: () => {} };
}
