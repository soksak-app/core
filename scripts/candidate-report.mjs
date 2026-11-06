import { gzipSync, gunzipSync } from 'node:zlib';

const INPUT_LIMIT = 60000;
export const MAX_REPORT_BYTES = 1024 * 1024;

/** The complete named outcomes are compressed for the bounded workflow input, never omitted to fit it. */
export function encodeAcceptanceReport(report) {
  const bytes = Buffer.from(JSON.stringify(report));
  if (bytes.length > MAX_REPORT_BYTES) throw new Error('candidate report exceeds 1048576 decoded bytes');
  const text = JSON.stringify({ schema: 1, encoding: 'gzip-base64', payload: gzipSync(bytes).toString('base64') });
  if (Buffer.byteLength(text) > INPUT_LIMIT) throw new Error('candidate report exceeds 60000 transport bytes');
  return text;
}

/** Accepts only the current transport form and bounds decompression before parsing the report. */
export function decodeAcceptanceReport(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > INPUT_LIMIT) throw new Error('candidate report exceeds 60000 transport bytes');
  const envelope = JSON.parse(text);
  if (envelope?.schema !== 1 || envelope.encoding !== 'gzip-base64' || typeof envelope.payload !== 'string'
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(envelope.payload)) throw new Error('unsupported candidate report transport');
  const bytes = Buffer.from(envelope.payload, 'base64');
  if (bytes.toString('base64') !== envelope.payload) throw new Error('invalid candidate report base64');
  return JSON.parse(gunzipSync(bytes, { maxOutputLength: MAX_REPORT_BYTES }).toString('utf8'));
}
