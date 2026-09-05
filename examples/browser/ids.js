// 식별자 생성.
//
// 형식은 `<세 글자>-<base32 여섯>`. 한두 글자로는 종류가 겹친다: `s-` 는 space,
// split, session 에 모두 해당한다.
//
// 카운터를 사용하지 않는다. 재시작할 때마다 1 로 돌아가 같은 값이 다른 대상에
// 할당된다.
//
// id 는 주소이고 정체성은 자연키가 결정한다. 프로젝트 중복 여부는 id 가 아니라
// root 로 판정한다.

/** 0 과 1 을 제외한다. o, l 과 혼동되는 문자를 생성하지 않는다. */
const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const LEN = 6;

const PREFIX = {
  project: "prj-",
  space: "spc-",
  tab: "tab-",
};

/** 식별자 하나를 생성해 반환한다. */
export function issueId(kind) {
  const prefix = PREFIX[kind];
  if (!prefix) throw new Error(`unknown id kind: ${kind}`);
  const buf = new Uint8Array(LEN);
  crypto.getRandomValues(buf);
  let body = "";
  for (const b of buf) body += ALPHABET[b % 32];
  return prefix + body;
}
