import assert from 'node:assert/strict';
import test from 'node:test';
import { crashFault } from '../crash-fault.mjs';

// A crash report in the form of the system: one JSON header line and the JSON body.
const report = (body) => `${JSON.stringify({ app_name: 'probe', bug_type: '309' })}\n${JSON.stringify(body)}`;
const images = [
  { name: 'probe', path: '/Applications/probe.app/Contents/MacOS/probe', arch: 'arm64', base: 0x100000000, size: 0x1000000 },
  { name: 'JavaScriptCore', path: '/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/JavaScriptCore', arch: 'arm64e',
    base: 0x1aadd2000, size: 0x2000000 },
];

test('a breakpoint that a signal handler raised again is named by the instruction address of its exception', { timeout: 1000 }, () => {
  const fault = crashFault(report({
    exception: { type: 'EXC_BREAKPOINT', signal: 'SIGTRAP', rawCodes: [1, 0x1ac4e5dec] },
    faultingThread: 1,
    threads: [{ name: 'main' }, { name: 'JSC Heap Collector Thread', threadState: { pc: { value: 0x18c21a288 } } }],
    usedImages: images,
  }), 'probe.ips');
  assert.deepEqual(fault, {
    thread: 'JSC Heap Collector Thread',
    image: 'JavaScriptCore',
    path: '/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/JavaScriptCore',
    arch: 'arm64e',
    load: '0x1aadd2000',
    address: '0x1ac4e5dec',
  });
});

test('another exception is named by the program counter of its faulting thread', { timeout: 1000 }, () => {
  const fault = crashFault(report({
    exception: { type: 'EXC_BAD_ACCESS', signal: 'SIGSEGV', rawCodes: [1, 8] },
    faultingThread: 0,
    threads: [{ threadState: { pc: { value: 0x100000040 } } }],
    usedImages: images,
  }), 'probe.ips');
  assert.deepEqual(fault, { thread: 'thread 0', image: 'probe', path: '/Applications/probe.app/Contents/MacOS/probe', arch: 'arm64',
    load: '0x100000000', address: '0x100000040' });
});

test('a report outside the form is refused with the file and what it found', { timeout: 1000 }, () => {
  assert.throws(() => crashFault('{}', 'a.ips'), /a\.ips: the report has no body after its header line/);
  assert.throws(() => crashFault('{}\nnot json', 'a.ips'), /a\.ips: the body is not JSON/);
  assert.throws(() => crashFault(report({ exception: { type: 'EXC_BREAKPOINT', rawCodes: [1, 0x5] }, faultingThread: 0,
    threads: [{}], usedImages: images }), 'a.ips'), /a\.ips: no image of the report holds the fault address 0x5/);
  assert.throws(() => crashFault(report({ exception: { type: 'EXC_BREAKPOINT', rawCodes: [1] }, faultingThread: 0,
    threads: [{}], usedImages: images }), 'a.ips'), /a\.ips: EXC_BREAKPOINT has no instruction address in its codes/);
  assert.throws(() => crashFault(report({ exception: { type: 'EXC_CRASH' }, faultingThread: 3, threads: [{}], usedImages: images }),
    'a.ips'), /a\.ips: the report has no faulting thread 3/);
});
