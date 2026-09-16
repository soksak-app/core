/**
 * Put the DOM lib reference back into `dist/dom.d.ts`.
 *
 * `src/dom.ts` carries `/// <reference lib="dom" />` and the build needs it —
 * `lib` in tsconfig.json is `ES2019` alone. tsc does not copy the directive
 * into the declaration file, so a consumer that compiles without the DOM lib
 * reads `HTMLElement` in the public types and fails. The core runs and
 * typechecks with no DOM; only the view needs one.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const file = new URL('../dist/dom.d.ts', import.meta.url);
const line = '/// <reference lib="dom" />';
const text = readFileSync(file, 'utf8');
if (!text.startsWith(line)) writeFileSync(file, `${line}\n${text}`);
