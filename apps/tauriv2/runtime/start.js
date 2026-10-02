// main page 의 시작 문서(docs/spec/native-host.md#page-start). 요청한 webview 를 아는 custom scheme 처리기가 만든다.
// main page 만 가져온다. 이 요청이 그 창의 page 를 시작한다.
export { default } from "soksak://localhost/start.json" with { type: "json" };
