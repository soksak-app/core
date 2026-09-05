// 식별자를 내는 곳.
//
// 형식은 `<세 글자>-<base32 여섯>`. 세 글자인 이유는 한두 글자가 이 제품의
// 종류들을 가르지 못하기 때문이다 — `s-` 는 space 와 split 과 session 에 모두
// 맞는다.
//
// 카운터가 아니다. 카운터는 새로 시작할 때마다 1로 돌아가므로 같은 값이 다른
// 것을 가리키게 된다.
//
// id 는 주소이고, 정체는 자연키가 답한다. 프로젝트가 이미 열려 있는지는 id 가
// 아니라 root 로 답한다 — 두 번 열어도 같은 프로젝트인 이유가 그것이다.

/** 0 과 1 이 없다. o 와 l 로 잘못 읽을 값이 나오지 않는다. */
const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const LEN = 6;

const PREFIX = {
  project: "prj-",
  space: "spc-",
  tab: "tab-",
};

/** 새 식별자 하나. */
export function issueId(kind) {
  const prefix = PREFIX[kind];
  if (!prefix) throw new Error(`unknown id kind: ${kind}`);
  const buf = new Uint8Array(LEN);
  crypto.getRandomValues(buf);
  let body = "";
  for (const b of buf) body += ALPHABET[b % 32];
  return prefix + body;
}
