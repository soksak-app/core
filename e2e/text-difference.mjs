// 두 텍스트가 처음 달라지는 자리와 그 주변. 긴 요청이 다를 때 실패 메시지가 차이를 밝힌다(F40).

const AROUND = 40;

/** a 와 b 가 같으면 null, 다르면 처음 달라지는 글자 번호와 그 앞뒤 AROUND 글자. */
export function textDifference(a, b) {
  if (a === b) return null;
  let index = 0;
  while (index < a.length && index < b.length && a[index] === b[index]) index++;
  const start = Math.max(0, index - AROUND);
  const part = (text) => `…${text.slice(start, index + AROUND)}`;
  return `first difference at character ${index}: ${part(a)} instead of ${part(b)}`;
}
