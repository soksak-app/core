// Names the fault of a system crash report (`.ips`) of an application, so the window-check job resolves it on the machine
// that crashed (docs/operations/examples.md#window-checks):
//   node scripts/crash-fault.mjs <report.ips>
// The report is one JSON header line followed by the JSON body. The output is one JSON line {thread, image, path, arch, load,
// address}: the faulting thread, the image that holds the fault address with its path, architecture and load address, and
// the address, both as hexadecimal text. `atos -o <path> -arch <arch> -l <load> <address>` resolves the address against the
// library of that machine. A trap that a signal handler raised again leaves no frame of the trapping code on the stack of
// the thread, so the address is read from the exception: for EXC_BREAKPOINT and EXC_BAD_INSTRUCTION the second exception code
// is the address of the instruction, and for another exception it is the program counter of the faulting thread.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const INSTRUCTION_EXCEPTIONS = new Set(['EXC_BREAKPOINT', 'EXC_BAD_INSTRUCTION']);

const hex = (value) => `0x${value.toString(16)}`;

/** The fault of the crash report text; a report outside the form is an error that names the file and what it found. */
export function crashFault(text, file) {
  const newline = text.indexOf('\n');
  if (newline < 0) throw new Error(`${file}: the report has no body after its header line`);
  let body;
  try {
    body = JSON.parse(text.slice(newline + 1));
  } catch (error) {
    throw new Error(`${file}: the body is not JSON: ${error.message}`, { cause: error });
  }
  const { exception, faultingThread, threads, usedImages } = body;
  if (typeof exception?.type !== 'string') throw new Error(`${file}: the report names no exception type`);
  const thread = threads?.[faultingThread];
  if (thread === undefined) throw new Error(`${file}: the report has no faulting thread ${JSON.stringify(faultingThread)}`);
  let address;
  if (INSTRUCTION_EXCEPTIONS.has(exception.type)) {
    const code = exception.rawCodes?.[1];
    if (!Number.isSafeInteger(code)) throw new Error(`${file}: ${exception.type} has no instruction address in its codes: ${JSON.stringify(exception.rawCodes)}`);
    address = code;
  } else {
    address = thread.threadState?.pc?.value;
    if (!Number.isSafeInteger(address)) throw new Error(`${file}: the faulting thread has no program counter`);
  }
  const image = (usedImages ?? []).find((item) => Number.isSafeInteger(item.base) && Number.isSafeInteger(item.size)
    && address >= item.base && address < item.base + item.size);
  if (image === undefined) throw new Error(`${file}: no image of the report holds the fault address ${hex(address)}`);
  return {
    // default: an unnamed thread is named by its index, which the report lists it under.
    thread: thread.name ?? `thread ${faultingThread}`,
    image: image.name,
    path: image.path,
    arch: image.arch,
    load: hex(image.base),
    address: hex(address),
  };
}

function main(argv) {
  if (argv.length !== 1) throw new Error('usage: node scripts/crash-fault.mjs <report.ips>');
  process.stdout.write(`${JSON.stringify(crashFault(readFileSync(argv[0], 'utf8'), argv[0]))}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
