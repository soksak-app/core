// Finds the inline links of a markdown text outside code blocks and code spans, with their positions, for the documentation
// check and the release notes.

/**
 * Replaces each character of a code block or a code span with a space, so positions in the result match the source. A code span
 * ends at the next run of exactly as many backticks, and it does not cross the end of its block: a blank line or the start of a
 * list item, a heading, a table row or a quote. A backtick that no run closes in its block is text, so it hides no later link.
 */
function maskCode(text) {
  const blank = (part) => part.replace(/[^\n]/g, " ");
  return text
    .replace(/^(`{3,}|~{3,}).*\n[\s\S]*?^\1\s*$/gm, blank)
    .replace(/(?<!`)(`+)(?!`)(?:(?!\n[ \t]*(?:\n|[-*+] |\d+\. |#|\||>))[\s\S])+?(?<!`)\1(?!`)/g, blank);
}

/** The inline links of text as { start, end, target }, where start and end bound the target inside its parentheses. */
export function markdownLinks(text) {
  const links = [];
  for (const match of maskCode(text).matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const start = match.index + match[0].length - 1 - match[1].length;
    links.push({ start, end: start + match[1].length, target: text.slice(start, start + match[1].length) });
  }
  return links;
}

/** Whether target names a scheme, such as https:, and is therefore not relative. */
export const absolute = (target) => /^[a-z][a-z\d+.-]*:/i.test(target);
