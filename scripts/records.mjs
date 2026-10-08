// 기록이 저장소에 관한 사실만 적는지 검사한다(AGENTS.md Documentation). 문서는 코드 블록 밖의 모든 줄을, 설정
// 파일(workflow, Makefile)은 주석 줄만 검사한다.

/** 기록에 쓰지 않는 표현과 그 범주. 색 코드와 UUID 같은 16진수 값은 커밋 참조가 아니다. */
export const RECORD_PATTERNS = [
  ["commit reference", /\((?:[0-9a-f]{7,40})\)|\bcommit [0-9a-f]{7,40}\b|\b[0-9a-f]{7,40}\.\.[0-9a-f]{7,40}\b/i],
  ["pull request number", /\bPR #?\d+\b|\bpull request #?\d+\b/i],
  ["CI run number", /\brun \d{8,}\b/i],
  ["personal path", /\/Users\/|~\/backup/],
  ["account of who found or requested", /\bFound (?:on|while)\b|\bRequested by\b|\bas the user asked\b|\bthe user (?:asked|decided|requested)\b|사용자 요청|사용자가 요청|발견:|\d{4}-\d{2}-\d{2}[^.\n]{0,80}?발견했/i],
  // macOS 는 운영 체제 이름이다. "Mac" 은 뒤에 글자가 없을 때만 그 컴퓨터를 가리킨다.
  ["local environment", /\b[Tt]his (?:machine|Mac)(?![A-Za-z])|이 (?:머신|Mac)(?![A-Za-z])/],
];

// 마크다운 코드 블록을 같은 수의 빈 줄로 바꾼다. 위반의 줄 번호가 원본과 같게 유지된다.
const withoutCode = (text) => text.replace(/^(`{3,}|~{3,}).*\n[\s\S]*?^\1\s*$/gm, (block) => block.replace(/[^\n]/g, ""));

/** text 에서 기록 규칙을 어기는 줄을 `file:line: category: match` 로 돌려준다. kind 는 `document` 또는 `config`. */
export function recordViolations(text, file, kind = "document") {
  const lines = (kind === "document" ? withoutCode(text) : text).split("\n");
  const errors = [];
  lines.forEach((line, index) => {
    if (kind === "config" && !/^\s*#/.test(line)) return;
    for (const [category, pattern] of RECORD_PATTERNS) {
      const match = pattern.exec(line);
      if (match) errors.push(`${file}:${index + 1}: ${category}: ${match[0]}`);
    }
  });
  return errors;
}

/** 검사할 파일의 종류. 문서는 `.md`, 설정은 workflow 와 Makefile 이다. 그 밖의 파일은 null. */
export function recordKind(file) {
  if (file.endsWith(".md")) return "document";
  if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(file) || /(?:^|\/)Makefile$/.test(file)) return "config";
  return null;
}

const COMMIT_TYPES = ["feat", "fix", "docs", "style", "refactor", "test", "chore"];
const FOOTER = /^(?:Refs|Co-Authored-By|Signed-off-by|Generated(?: with| by)?|Reviewed-by)\b|^🤖|claude\.ai\/code/i;

/** 커밋 메시지가 `type(scope): Subject (#ID)`, 빈 줄, 72자에서 줄을 바꾼 본문, 꼬리말 없음의 형식인지 검사한다. */
export function commitMessageErrors(message) {
  const lines = message.replace(/\n+$/, "").split("\n");
  const errors = [];
  const subject = /^([a-z]+)\(([a-z0-9-]+)\): (.+) \(#([A-Z][A-Za-z0-9]*(?:[.-][A-Za-z0-9]+)*)\)$/.exec(lines[0]);
  if (!subject) errors.push(`subject must be "type(scope): Subject (#ID)": ${lines[0]}`);
  else {
    const [, type, , text] = subject;
    if (!COMMIT_TYPES.includes(type)) errors.push(`type must be one of ${COMMIT_TYPES.join(", ")}: ${type}`);
    if (text.length > 50) errors.push(`subject is ${text.length} characters, above 50: ${text}`);
    if (!/^[A-Z]/.test(text)) errors.push(`subject must start with a capital letter: ${text}`);
    if (text.endsWith(".")) errors.push(`subject must not end with a period: ${text}`);
  }
  if (lines.length < 3 || lines[1] !== "" || !lines.slice(2).some((line) => line.trim())) {
    errors.push("a blank line and a non-empty body must follow the subject");
  }
  lines.slice(2).forEach((line, index) => {
    if (line.length > 72) errors.push(`body line ${index + 3} is ${line.length} characters, above 72`);
    if (FOOTER.test(line)) errors.push(`body line ${index + 3} is a footer: ${line}`);
  });
  for (const error of recordViolations(lines.join("\n"), "message")) errors.push(error.replace(/^message:/, "line "));
  return errors;
}
