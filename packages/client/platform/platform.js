// 로컬 엔드포인트의 운영체제별 전송을 선택한다.
//
// 각 운영체제 모듈은 같은 이름의 값을 내보낸다.
//   name                   운영체제 이름
//   transport              전송 이름("unix" 또는 "pipe")
//   createAddress(label)   사용자 전용 주소를 만들고 { address, remove } 를 반환한다
const modules = {
  darwin: "./darwin/darwin.js",
  linux: "./linux/linux.js",
  win32: "./windows/windows.js",
};

const selected = modules[process.platform];
if (!selected) throw new Error(`no endpoint transport for ${process.platform}`);

export const { name, transport, createAddress } = await import(selected);
