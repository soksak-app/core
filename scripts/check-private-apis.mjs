// Checks that the private native API inventory (docs/operations/private-native-apis.md and its translation) agrees with the
// private framework declarations and with the sources that use them:
//   node scripts/check-private-apis.mjs
// The declarations are the headers of native/darwin/src/private/ and native/darwin/process-identity/src/private/launch_services.h.
// The sources are the C, Objective-C, Go and Rust files of native/darwin and of the hosts (packages/host), without those headers.
//
// A declared API is a function, a variable, a constant, a type (a typedef, an enum, a class or a protocol), or a method or
// property of a category, class or protocol. Its names: the identifier; `Owner.selector` for an instance member and
// `+[Owner selector]` for a class member, where a property has the name of its getter and, unless it is readonly, of its setter.
// A row names an API when a code span of its first column is one of the API's names.
//
// A source uses an identifier where it writes the identifier outside comments, and a type also where it uses a declared API
// whose declaration writes the type or a member of the type. A source uses a selector where it sends it, names it (`@selector`,
// a string) or defines a method with it, and a property also through its dot syntax name. Source text does not show the class of
// a receiver: the members of several categories that declare one selector are used together, and a member of a class or
// protocol that a header declares is used where a source that uses the type sends, names or defines its selector; an optional
// member of a protocol, which the framework calls on an object of the application, is also used where any source defines a
// method with its selector. In a Go file, the comment directly before `import "C"` is C source (cgo).
//
// The check fails when a declared API has no use (a dead declaration), when it has no row, when a source that uses an API is not linked in a row that names the API, when
// a source that a row links uses no API that the row names (for a row that names a declared API), and when a code span of the
// second column (callers) that is an identifier, a call or a selector is not a function, method or class that a file that the
// row links defines.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { posix } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { markdownLinks } from './markdown-links.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const DOCUMENTS = ['docs/operations/private-native-apis.md', 'docs/operations/private-native-apis.ko.md'];
const HEADER = /^(native\/darwin\/src\/private\/[^/]+\.h|native\/darwin\/process-identity\/src\/private\/launch_services\.h)$/;
const SOURCE = /^(native\/darwin|packages\/host)\/.*\.(m|mm|c|h|go|rs)$/;
const IDENTIFIER = /^[A-Za-z_]\w*$/;

const blank = (text) => text.replace(/[^\n]/g, ' ');
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * `text` with each comment replaced by spaces, line breaks kept, for the language of `path` (C and Objective-C, Go, Rust).
 * Strings and character literals are kept; Rust block comments nest. In Go, a block comment that `import "C"` follows is C source
 * and keeps its code without its own comments.
 */
export function withoutComments(path, text) {
  const go = path.endsWith('.go');
  const rust = path.endsWith('.rs');
  let out = '';
  let i = 0;
  const literal = (pattern) => {
    pattern.lastIndex = i;
    return pattern.exec(text)?.[0] ?? null;
  };
  const rest = text.startsWith.bind(text);
  while (i < text.length) {
    if (rest('//', i)) {
      const end = text.indexOf('\n', i);
      const stop = end < 0 ? text.length : end;
      out += blank(text.slice(i, stop));
      i = stop;
      continue;
    }
    if (rest('/*', i)) {
      let depth = 1;
      let j = i + 2;
      while (j < text.length && depth > 0) {
        if (rust && rest('/*', j)) { depth++; j += 2; } else if (rest('*/', j)) { depth--; j += 2; } else j++;
      }
      if (depth > 0) throw new Error(`${path}: a block comment is not closed`);
      if (go && /^\s*import\s+"C"/.test(text.slice(j))) out += `  ${withoutComments(`${path}.c`, text.slice(i + 2, j - 2))}  `;
      else out += blank(text.slice(i, j));
      i = j;
      continue;
    }
    const previous = i > 0 ? text[i - 1] : '';
    const token =
      (rust && (text[i] === 'r' || text[i] === 'b') && !/\w/.test(previous) && literal(/b?r(#*)"[\s\S]*?"\1/y)) ||
      (text[i] === '"' && literal(/"(?:\\[\s\S]|[^"\\\n])*"/y)) ||
      (go && text[i] === '`' && literal(/`[^`]*`/y)) ||
      (text[i] === "'" && literal(rust ? /'(?:\\(?:u\{[0-9a-fA-F]+\}|x[0-9a-fA-F]{2}|.)|[^\\'\n])'/y : /'(?:\\.|[^\\'\n])*'/y)) ||
      text[i];
    out += token;
    i += token.length;
  }
  return out;
}

/** The text up to the parenthesis that closes the one at `start`. */
function balanced(text, start) {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')' && --depth === 0) return i + 1;
  }
  throw new Error(`unbalanced parentheses in: ${text.trim()}`);
}

/** The selector of a method declaration after its `-` or `+`, and the text that remains after its last part. */
function selectorOf(text) {
  let i = text.indexOf('(');
  if (i < 0 || text.slice(0, i).trim() !== '') return null;
  i = balanced(text, i);
  const word = /^\s*([A-Za-z_]\w*)/;
  let match = word.exec(text.slice(i));
  if (!match) return null;
  i += match[0].length;
  if (!/^\s*:/.test(text.slice(i))) return match[1];
  let selector = '';
  for (;;) {
    selector += `${match[1]}:`;
    i = text.indexOf(':', i) + 1;
    const type = /^\s*\(/.exec(text.slice(i));
    if (type) i = balanced(text, i + type[0].length - 1);
    const argument = word.exec(text.slice(i));
    if (!argument) return null;
    i += argument[0].length;
    match = word.exec(text.slice(i));
    if (!match || !/^\s*:/.test(text.slice(i + match[0].length))) return selector;
    i += match[0].length;
  }
}

/** The declared API of one member of a category, class or protocol. */
function member(statement, owner, category) {
  const property = /^@property\s*(?:\(([^)]*)\))?\s*([\s\S]+)$/.exec(statement);
  let selector;
  let names;
  let dot = null;
  let setter = null;
  if (property) {
    const declarator = property[2].replace(/\s+[A-Z_]+\((?:[^()]|\([^()]*\))*\)\s*$/, '');
    const name = /([A-Za-z_]\w*)\s*$/.exec(declarator)?.[1];
    if (!name) return null;
    const attributes = property[1] ?? '';
    selector = /\bgetter\s*=\s*(\w+)/.exec(attributes)?.[1] ?? name;
    if (!/\breadonly\b/.test(attributes)) setter = /\bsetter\s*=\s*([\w:]+)/.exec(attributes)?.[1] ?? `set${name[0].toUpperCase()}${name.slice(1)}:`;
    dot = name;
    names = [`${owner}.${selector}`, ...(setter ? [`${owner}.${setter}`] : [])];
  } else {
    const method = /^([-+])\s*([\s\S]+)$/.exec(statement);
    selector = method && selectorOf(method[2]);
    if (!selector) return null;
    names = [method[1] === '+' ? `+[${owner} ${selector}]` : `${owner}.${selector}`];
  }
  return { kind: 'member', names, owner, selector, setter, dot, key: category ? `selector ${selector}` : `${owner}.${selector}`, type: category ? null : owner };
}

/** The names that one top-level statement of a header declares, each with its kind (`type` or `name`). */
function topLevel(statement) {
  let match = /^typedef\s+NS_(?:ENUM|OPTIONS)\(\s*\w+\s*,\s*(\w+)\s*\)\s*\{([\s\S]*)\}$/.exec(statement) ?? /^enum\s*(\w*)\s*\{([\s\S]*)\}$/.exec(statement);
  if (match) {
    const constants = match[2].split(',').map((part) => part.trim()).filter(Boolean).map((part) => /^([A-Za-z_]\w*)\s*(?:=[\s\S]*)?$/.exec(part)?.[1]);
    if (constants.includes(undefined)) return null;
    return [...(match[1] ? [{ name: match[1], kind: 'type' }] : []), ...constants.map((name) => ({ name, kind: 'name' }))];
  }
  match = /^typedef\s[\s\S]*?\b([A-Za-z_]\w*)$/.exec(statement) ?? /^typedef\s[^()]*\(\s*\*?\s*([A-Za-z_]\w*)\s*\)\s*\([^()]*\)$/.exec(statement);
  if (match) return [{ name: match[1], kind: 'type' }];
  match = /^static\s+const\s[\s\S]*?\b([A-Za-z_]\w*)\s*=[^=][\s\S]*$/.exec(statement) ??
    /^extern\s[\s\S]*?\b([A-Za-z_]\w*)\s*\([^()]*\)$/.exec(statement) ?? /^extern\s[^()]*?\b([A-Za-z_]\w*)$/.exec(statement);
  return match ? [{ name: match[1], kind: 'name' }] : null;
}

/** The text of `code` from `start`, split at `;` outside braces, with the offset of each part. */
function statements(code, start, end) {
  const parts = [];
  let depth = 0;
  let from = start;
  for (let i = start; i < end; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}') depth--;
    else if (code[i] === ';' && depth === 0) {
      parts.push({ text: code.slice(from, i), offset: from });
      from = i + 1;
    }
  }
  parts.push({ text: code.slice(from, end), offset: from });
  return parts
    .map(({ text, offset }) => ({ text: text.trim().replace(/\s+/g, ' '), offset: offset + text.length - text.trimStart().length }))
    .filter(({ text }) => text !== '');
}

/**
 * The APIs that `headers` (a map of path to text) declare, in the order of their declarations:
 * `{names, path, line, declaration, key, kind, type, selector, setter, dot}`. A declaration of another form is an error that
 * names its header and line.
 */
export function declaredApis(headers) {
  const apis = [];
  for (const [path, text] of headers) {
    const first = apis.length;
    const code = withoutComments(path, text).replace(/^[ \t]*#.*$/gm, blank);
    const lineAt = (offset) => code.slice(0, offset).split('\n').length;
    const unread = (offset, statement) => new Error(`${path}:${lineAt(offset)}: the check reads no declaration of this form: ${statement}`);
    let outside = code;
    for (const block of code.matchAll(/@(interface|protocol)\s+(\w+)([^\n]*)\n([\s\S]*?)@end/g)) {
      const [whole, keyword, owner, head, body] = block;
      const category = keyword === 'interface' && /^\s*\(/.test(head);
      if (!category) apis.push({ kind: 'type', names: [owner], key: `name ${owner}`, path, line: lineAt(block.index), declaration: whole.slice(0, whole.indexOf('\n')) });
      const bodyStart = block.index + whole.length - body.length - '@end'.length;
      const members = code.slice(0, bodyStart + body.length).replace(/@(optional|required)\b/g, blank);
      const markers = [...body.matchAll(/@(optional|required)\b/g)].map((marker) => ({ offset: bodyStart + marker.index, optional: marker[1] === 'optional' }));
      for (const { text: statement, offset } of statements(members, bodyStart, bodyStart + body.length)) {
        const declared = member(statement, owner, category);
        if (!declared) throw unread(offset, statement);
        const callback = keyword === 'protocol' && markers.filter((marker) => marker.offset < offset).at(-1)?.optional === true;
        apis.push({ ...declared, callback, path, line: lineAt(offset), declaration: statement });
      }
      outside = outside.slice(0, block.index) + blank(whole) + outside.slice(block.index + whole.length);
    }
    for (const { text: statement, offset } of statements(outside, 0, outside.length)) {
      const declared = topLevel(statement);
      if (!declared) throw unread(offset, statement);
      for (const { name, kind } of declared) apis.push({ kind, names: [name], key: `name ${name}`, path, line: lineAt(offset), declaration: statement });
    }
    apis.push(...apis.splice(first).sort((a, b) => a.line - b.line));
  }
  const types = apis.filter(({ kind }) => kind === 'type').map(({ names }) => names[0]);
  for (const api of apis) api.mentions = types.filter((type) => type !== api.names[0] && new RegExp(`\\b${escape(type)}\\b`).test(api.declaration));
  return apis;
}

/** A pattern that finds the uses of `selector`: a message, `@selector`, a string or a definition. */
function selectorPattern(selector) {
  const parts = selector.split(':').slice(0, -1);
  if (parts.length === 0) return `(?:[\\w\\])]\\s+|,\\s*)${escape(selector)}\\s*\\]|\\.\\s*${escape(selector)}\\b(?!\\s*\\()|@selector\\(\\s*${escape(selector)}\\s*\\)|"${escape(selector)}"|^[ \\t]*[-+][ \\t]*\\((?:[^()\\n]|\\([^()\\n]*\\))*\\)[ \\t]*${escape(selector)}\\b(?!\\s*:)`;
  return parts.map((part) => `\\b${escape(part)}\\s*:(?!:)`).join('[^;{}]*?');
}

const patterns = new WeakMap();

/** The patterns of the uses of `api`: `use` finds its selector, its dot syntax name or its identifier, `definition` a method. */
function patternsOf(api) {
  if (!patterns.has(api)) {
    if (api.kind === 'type' || api.kind === 'name') patterns.set(api, { use: new RegExp(`\\b${escape(api.names[0])}\\b`) });
    else {
      const uses = [selectorPattern(api.selector), ...(api.setter ? [selectorPattern(api.setter)] : []), ...(api.dot ? [`\\.\\s*${escape(api.dot)}\\b(?!\\s*\\()`] : [])];
      const first = escape(api.selector.split(':')[0]);
      patterns.set(api, {
        use: new RegExp(uses.join('|'), 'm'),
        method: new RegExp(`^[ \\t]*[-+][ \\t]*\\((?:[^()\\n]|\\([^()\\n]*\\))*\\)[ \\t]*${first}\\b`, 'm'),
        selector: new RegExp(selectorPattern(api.selector), 'm'),
      });
    }
  }
  return patterns.get(api);
}

/** Whether `code` uses `api` by its selector, its dot syntax name, or its identifier. */
const writes = (code, api) => patternsOf(api).use.test(code);

/** Whether `code` defines a method with the selector of `api`. */
const definesMethod = (code, api) => patternsOf(api).method.test(code) && patternsOf(api).selector.test(code);

const isSource = (path) => SOURCE.test(path) && !HEADER.test(path);

/** The declared APIs that each source of `sources` (a map of path to text) uses: a map of path to a set of the first API names. */
export function apiUses(apis, sources) {
  const uses = new Map();
  for (const [path, text] of sources) {
    if (!isSource(path)) continue;
    const code = withoutComments(path, text);
    const used = new Set();
    const memberOfDeclaredType = (api) => api.kind === 'member' && api.type;
    for (const api of apis) {
      if (memberOfDeclaredType(api) ? api.callback && definesMethod(code, api) : writes(code, api)) used.add(api);
    }
    for (let changed = true; changed;) {
      changed = false;
      const typesInUse = new Set([...used].flatMap((api) => [...api.mentions, ...(api.type ? [api.type] : []), ...(api.kind === 'type' ? [api.names[0]] : [])]));
      for (const api of apis) {
        if (used.has(api)) continue;
        if ((api.kind === 'type' && typesInUse.has(api.names[0])) || (memberOfDeclaredType(api) && typesInUse.has(api.type) && writes(code, api))) {
          used.add(api);
          changed = true;
        }
      }
    }
    for (const api of used) for (const other of apis) if (other.key === api.key) used.add(other);
    if (used.size > 0) uses.set(path, new Set([...used].map((api) => api.names[0])));
  }
  return uses;
}

/** The cells of a table row, split at `|` outside code spans. */
function cells(line) {
  const parts = [];
  let current = '';
  let ticks = 0;
  for (let i = 1; i < line.length; i++) {
    const c = line[i];
    if (c === '`') {
      let run = 1;
      while (line[i + run] === '`') run++;
      ticks = ticks === 0 ? run : ticks === run ? 0 : ticks;
      current += line.slice(i, i + run);
      i += run - 1;
    } else if (c === '\\' && line[i + 1] === '|') {
      current += '|';
      i++;
    } else if (c === '|' && ticks === 0) {
      parts.push(current.trim());
      current = '';
    } else current += c;
  }
  if (current.trim() !== '') throw new Error(`the table row does not end with |: ${line.slice(0, 80)}`);
  return parts;
}

const codeSpans = (text) => [...text.matchAll(/(`+)([^`][\s\S]*?)\1/g)].map((match) => match[2].trim());

/** The rows of the inventory table of `markdown`: `{line, names, links, callers}`; `links` are paths from the repository root. */
export function inventoryRows(markdown, document) {
  const lines = markdown.split('\n');
  const heading = lines.findIndex((line) => /^## (Current inventory|현재 목록)$/.test(line));
  if (heading < 0) throw new Error(`${document}: no current inventory section`);
  const separator = lines.findIndex((line, index) => index > heading && /^\|\s*---/.test(line));
  if (separator < 0 || lines.slice(heading + 1, separator).some((line) => line.startsWith('## '))) throw new Error(`${document}: the current inventory section has no table`);
  const rows = [];
  for (let index = separator + 1; index < lines.length && lines[index].startsWith('|'); index++) {
    const line = lines[index];
    const parts = cells(line);
    if (parts.length !== 3) throw new Error(`${document}:${index + 1}: the row has ${parts.length} cells, not 3`);
    const links = markdownLinks(line)
      .map(({ target }) => target)
      .filter((target) => !/^[a-z][a-z\d+.-]*:/i.test(target) && !target.startsWith('#'))
      .map((target) => posix.normalize(posix.join(posix.dirname(document), decodeURIComponent(target.split('#')[0]))));
    const callers = codeSpans(parts[1]).filter((span) => /^[A-Za-z_]\w*(\(.*\))?$/.test(span) || /^([A-Za-z_]\w*:)+$/.test(span))
      .map((span) => span.replace(/\(.*\)$/, ''));
    rows.push({ line: index + 1, names: codeSpans(parts[0]), links: [...new Set(links)], callers });
  }
  return rows;
}

/** Whether the source `text` at `path` defines a function, method or class named `name` (a selector names a method). */
function defines(path, text, name) {
  const code = withoutComments(path, text);
  const n = escape(name.split(':')[0]);
  const method = name.includes(':') ? new RegExp(selectorPattern(name), 'm') : null;
  const extension = posix.extname(path);
  if (['.m', '.mm', '.c', '.h'].includes(extension)) {
    if (method) return new RegExp(`^[ \\t]*[-+][ \\t]*\\((?:[^()\\n]|\\([^()\\n]*\\))*\\)[ \\t]*${n}\\s*:`, 'm').test(code) && method.test(code);
    return new RegExp(`^[A-Za-z_][\\w \\t*]*?[ \\t*]${n}[ \\t]*\\([^;{}]*\\)\\s*(?:__attribute__\\(\\([^;{]*\\)\\)\\s*)?\\{`, 'm').test(code) ||
      new RegExp(`^[ \\t]*[-+][ \\t]*\\((?:[^()\\n]|\\([^()\\n]*\\))*\\)[ \\t]*${n}\\b(?!\\s*:)`, 'm').test(code) ||
      new RegExp(`^@(?:implementation|interface)\\s+${n}\\b`, 'm').test(code);
  }
  if (method) return false;
  if (extension === '.go') return new RegExp(`^func\\s+(?:\\([^)]*\\)\\s*)?${n}\\s*[[(]|^type\\s+${n}\\b`, 'm').test(code);
  if (extension === '.rs') return new RegExp(`\\bfn\\s+${n}\\b|\\b(?:struct|enum|trait|type)\\s+${n}\\b`).test(code);
  if (['.js', '.mjs'].includes(extension)) return new RegExp(`\\bfunction\\s*\\*?\\s*${n}\\s*\\(|\\b(?:const|let|var|class)\\s+${n}\\b`).test(code);
  return false;
}

/**
 * The findings of the inventory `markdown` at `document` against `apis` and `sources` (a map of path to text that holds the
 * sources and the files that rows link; `uses` are the uses of `apis` in those sources): declared APIs without a row, sources that use an API and that no row naming it links,
 * linked sources that use no API of their row, and names of the caller column that no linked file defines.
 */
export function inventoryFindings({ apis, sources, document, markdown, uses = apiUses(apis, sources) }) {
  const rows = inventoryRows(markdown, document);
  const users = (api) => [...uses].filter(([, used]) => used.has(api.names[0])).map(([path]) => path);
  const namesApi = (row, api) => api.names.some((name) => row.names.includes(name));
  const findings = [];
  for (const api of apis) {
    if (rows.some((row) => namesApi(row, api))) continue;
    const used = users(api);
    findings.push(`${api.path}:${api.line}: \`${api.names[0]}\` has no row in ${document}${used.length ? ` (used by ${used.join(', ')})` : ''}`);
  }
  for (const api of apis) {
    const naming = rows.filter((row) => apis.some((other) => other.key === api.key && namesApi(row, other)));
    if (naming.length === 0) continue;
    for (const path of users(api)) {
      if (naming.some((row) => row.links.includes(path))) continue;
      const finding = `${document}:${naming[0].line}: ${path} uses \`${api.names[0]}\`, and no row that names it links the file`;
      if (!findings.includes(finding)) findings.push(finding);
    }
  }
  for (const row of rows) {
    const named = apis.filter((api) => namesApi(row, api)).map((api) => api.names[0]);
    if (named.length === 0) continue;
    for (const path of row.links) {
      if (!isSource(path) || !sources.has(path)) continue;
      if (!named.some((name) => uses.get(path)?.has(name))) findings.push(`${document}:${row.line}: the row links ${path}, which uses no API that the row names`);
    }
  }
  for (const row of rows) {
    const linked = row.links.filter((path) => sources.has(path));
    for (const name of row.callers) {
      if (linked.some((path) => defines(path, sources.get(path), name))) continue;
      const finding = `${document}:${row.line}: the row names \`${name}\`, which no file that the row links defines (${linked.join(', ') || 'no file'})`;
      if (!findings.includes(finding)) findings.push(finding);
    }
  }
  return findings;
}

/** The declarations of `apis` that no source uses, given their `uses` (`apiUses`): each is dead code of its header. */
export function unusedDeclarations(apis, uses) {
  const used = new Set([...uses.values()].flatMap((names) => [...names]));
  return apis.filter((api) => !used.has(api.names[0])).map((api) => `${api.path}:${api.line}: \`${api.names[0]}\` is declared, and no source uses it`);
}

/** The tracked and new files of this repository whose paths `select` accepts, by path. */
function repositoryFiles(select) {
  const listed = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0');
  return new Map([...new Set(listed)].filter((path) => path && select(path) && existsSync(`${ROOT}${path}`)).map((path) => [path, readFileSync(`${ROOT}${path}`, 'utf8')]));
}

/** The declarations that no source uses, and the findings of the inventory and its translation, in this repository. */
export function trackedInventoryFindings() {
  const apis = declaredApis(repositoryFiles((path) => HEADER.test(path)));
  const sources = repositoryFiles(isSource);
  const uses = apiUses(apis, sources);
  const findings = unusedDeclarations(apis, uses);
  for (const document of DOCUMENTS) {
    const markdown = readFileSync(`${ROOT}${document}`, 'utf8');
    for (const row of inventoryRows(markdown, document)) {
      for (const path of row.links) {
        if (!sources.has(path) && existsSync(`${ROOT}${path}`) && statSync(`${ROOT}${path}`).isFile()) sources.set(path, readFileSync(`${ROOT}${path}`, 'utf8'));
      }
    }
    findings.push(...inventoryFindings({ apis, sources, document, markdown, uses }));
  }
  return findings;
}

function main() {
  const findings = trackedInventoryFindings();
  for (const finding of findings) process.stderr.write(`${finding}\n`);
  process.stdout.write(findings.length === 0 ? 'Private API inventory checks passed\n' : `Private API inventory checks failed: ${findings.length} findings\n`);
  return findings.length === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
