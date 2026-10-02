// main page 의 시작 문서(docs/spec/native-host.md#page-start). Wails 의 asset server 가 요청한 창을 위해 만든다.
// main page 만 가져온다. 이 요청이 그 창의 page 를 시작한다.
export { default } from "/start.json" with { type: "json" };
