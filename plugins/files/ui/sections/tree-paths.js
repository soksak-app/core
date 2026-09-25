// 파일 트리 섹션의 규칙. files.tree 의 행을 트리 라이브러리의 경로 목록으로 옮기고, 라이브러리에서
// 사람이 연 폴더와 닫은 폴더를 files.tree.toggle 요청으로 바꾼다.

/** 보이지 않는 자식. 목록이 없는 폴더도 열 수 있게 한다. 실제 파일 이름과 겹치지 않는다. */
export const PLACEHOLDER = "​";

/** 행의 경로 목록. 파일은 그 경로, 나열된 자식이 없는 폴더는 자리 표시 자식이다. */
export function treePaths(rows) {
  const parents = new Set(rows.map((row) => row.path.slice(0, row.path.lastIndexOf("/"))).filter(Boolean));
  return rows.flatMap((row) => {
    if (!row.directory) return [row.path];
    return parents.has(row.path) ? [] : [`${row.path}/${PLACEHOLDER}`];
  });
}

/** before 에서 after 로 가는 일괄 작업. 더하기가 먼저 온다. 폴더는 마지막 자식이 빠지는 사이에도 남는다. */
export function pathDiff(before, after) {
  const had = new Set(before);
  const has = new Set(after);
  return [
    ...after.filter((path) => !had.has(path)).map((path) => ({ type: "add", path })),
    ...before.filter((path) => !has.has(path)).map((path) => ({ type: "remove", path })),
  ];
}

/**
 * 라이브러리의 펼침(isExpanded)이 상태의 펼침과 다른 폴더. 요청한 폴더는 pending 에 두어 상태가 따라올 때까지
 * 다시 요청하지 않고, 따라온 폴더는 pending 에서 뺀다.
 */
export function expansionRequests(rows, isExpanded, pending) {
  const requests = [];
  for (const row of rows) {
    if (!row.directory) continue;
    const open = isExpanded(row.path);
    if (open === row.expanded) {
      pending.delete(row.path);
      continue;
    }
    if (pending.has(row.path)) continue;
    pending.add(row.path);
    requests.push(row.path);
  }
  return requests;
}
