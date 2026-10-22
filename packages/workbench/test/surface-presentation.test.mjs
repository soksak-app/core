import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { JSDOM } from "jsdom";
import { clockAnswer, recordsOf, settled, shownRecord } from "./support/records.mjs";
