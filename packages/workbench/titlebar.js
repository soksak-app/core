// 창 제목줄을 페이지의 첫 행 높이에 맞춘다(docs/spec/hosts.md#window-buttons).
//
// 페이지가 첫 행의 높이를 정한다. 행은 app.css 의 --chrome-row 이고 프레임 글자 배율로만 바뀐다. 창의 답은 행을
// 바꾸지 않으므로, 요청 한 번으로 제목줄과 행이 같아지고 다음 맞춤은 요청하지 않는다.

/**
 * 창 제목줄이 row() 와 다르면 그 높이를 요청하고, 창 단추 영역과 제목줄 높이를 다시 읽어 반환한다.
 * 전체 화면처럼 제목줄이 없는 창(row 0)에는 요청하지 않는다. 창이 나오면 크기가 바뀌므로 다음 맞춤이 요청한다.
 *
 *   chrome  {controls(), titlebar(height)} — host.js 의 chrome
 *   row     첫 행의 높이(px)를 반환하는 함수
 */
export async function fitTitlebar(chrome, row) {
  const height = row();
  const answer = await chrome.controls();
  if (!(answer.row > 0) || answer.row === height) return answer;
  await chrome.titlebar(height);
  const fitted = await chrome.controls();
  // 그 사이에 전체 화면이 되었으면 제목줄이 없다(0).
  if (fitted.row > 0 && fitted.row !== height) {
    throw new Error(`window title bar is ${fitted.row}pt after the page requested ${height}pt`);
  }
  return fitted;
}
