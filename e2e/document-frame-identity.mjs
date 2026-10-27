/** Finds the unique current view generation from its host presentation-join trace rows. */
export function viewGenerationForSurface(rows, surface) {
  if (!Array.isArray(rows)) throw new TypeError("view presentation trace rows must be an array");
  if (typeof surface !== "string" || surface.length === 0) throw new TypeError("view identity surface must be nonempty");
  const relevant = rows.filter((row) => row?.layer === "host" && row.event === "view.presentation-join" && row.surface === surface);
  const requests = new Map();
  const results = [];
  const generations = new Set();
  for (const [index, row] of relevant.entries()) {
    if (!Number.isSafeInteger(row.generation) || row.generation < 1) {
      throw new Error(`view identity trace for ${surface} requires a positive safe integer generation: ${JSON.stringify(row)}`);
    }
    if (!Number.isSafeInteger(row.ticket) || row.ticket < 0) {
      throw new Error(`view identity trace for ${surface} has invalid ticket: ${JSON.stringify(row)}`);
    }
    if (row.phase === "requested") {
      const key = `${row.generation}/${row.ticket}`;
      if (requests.has(key)) throw new Error(`view identity trace for ${surface} repeats request ${key}`);
      requests.set(key, { index, row });
      generations.add(row.generation);
    } else if (row.phase === "result") {
      if (typeof row.joined !== "boolean") {
        throw new Error(`view identity trace for ${surface} result omits joined: ${JSON.stringify(row)}`);
      }
      results.push({ index, row });
      generations.add(row.generation);
    } else if (row.phase === "presented" || row.phase === "abandoned") {
      generations.add(row.generation);
    } else {
      throw new Error(`view identity trace for ${surface} has unknown phase: ${JSON.stringify(row)}`);
    }
  }
  if (generations.size !== 1) {
    throw new Error(`view identity trace for ${surface} must identify one current view generation; found ${JSON.stringify([...generations])}`);
  }
  const successful = [];
  for (const { index, row } of results) {
    const key = `${row.generation}/${row.ticket}`;
    const request = requests.get(key);
    if (!request || request.index >= index) {
      throw new Error(`view identity trace for ${surface} result ${key} has no earlier matching request`);
    }
    if (row.joined) successful.push(row.generation);
  }
  if (successful.length === 0) {
    throw new Error(`view identity trace for ${surface} has no successful presentation join`);
  }
  return successful[0];
}

/** Validates that decoded ScreenCaptureKit pixels match an identity issued to the requested root document. */
export function verifyDocumentFrameIdentityCapture({ start, stop, manifest, decodedRows, surface, generation }) {
  if (typeof surface !== "string" || surface.length === 0) throw new TypeError("document identity surface must be nonempty");
  if (!Number.isSafeInteger(generation) || generation < 1) throw new TypeError("document identity generation must be a positive safe integer");
  if (start?.surface !== surface || start?.generation !== generation) {
    throw new Error(`document identity start does not match ${surface} generation ${generation}: ${JSON.stringify(start)}`);
  }
  if (!Number.isSafeInteger(start.atlasSlots) || start.atlasSlots < 1 || start.atlasSlots > 512) {
    throw new Error(`document identity start has invalid atlasSlots: ${JSON.stringify(start.atlasSlots)}`);
  }
  const startROI = start.roi;
  if (!validROI(startROI, true)) throw new Error(`document identity start has invalid ROI: ${JSON.stringify(startROI)}`);
  if (stop?.frameIdentity?.status !== "complete" || typeof stop.frameIdentity.manifest !== "string"
    || stop.frameIdentity.manifest.length === 0) {
    throw new Error(`document identity stop has no completed manifest: ${JSON.stringify(stop?.frameIdentity)}`);
  }
  if (!manifest || manifest.format !== 1 || manifest.decodedFramesFile !== "decoded-frames.jsonl") {
    throw new Error(`document identity capture has an unsupported manifest: ${JSON.stringify(manifest)}`);
  }
  if (!Array.isArray(decodedRows)) throw new TypeError("document identity decoded rows must be an array");

  const document = manifest.documentFrameIdentity;
  if (!document || document.generation !== String(generation)
    || document.raster !== "18446744073709551615") {
    throw new Error(`document identity manifest does not match generation ${generation}: ${JSON.stringify(document)}`);
  }
  if (typeof document.regionToken !== "string" || !/^[0-9a-f]{32}$/.test(document.regionToken)) {
    throw new Error(`document identity manifest has invalid regionToken: ${JSON.stringify(document.regionToken)}`);
  }
  if (document.atlasFile !== "document-atlas.png") {
    throw new Error(`document identity manifest has invalid atlasFile: ${JSON.stringify(document.atlasFile)}`);
  }
  if (!Number.isSafeInteger(document.atlasSlots) || document.atlasSlots < 1 || document.atlasSlots > 512
    || document.atlasSlots !== start.atlasSlots) {
    throw new Error(`document identity manifest atlasSlots does not match start: ${JSON.stringify(document.atlasSlots)}`);
  }
  if (!Number.isSafeInteger(document.issuedSlots) || document.issuedSlots < 0 || document.issuedSlots > document.atlasSlots
    || stop.frameIdentity.issuedSlots !== document.issuedSlots) {
    throw new Error(`document identity issuedSlots are inconsistent: stop=${JSON.stringify(stop.frameIdentity.issuedSlots)}, manifest=${JSON.stringify(document.issuedSlots)}`);
  }
  if (!validROI(document.screenROI, false)
    || ["x", "y", "width", "height"].some((key) => document.screenROI[key] !== startROI[key])) {
    throw new Error(`document identity screenROI does not match the start ROI: ${JSON.stringify(document.screenROI)}`);
  }
  if (!Array.isArray(document.generatedIdentities) || document.generatedIdentities.length !== document.atlasSlots) {
    throw new Error(`document identity generatedIdentities count does not match atlasSlots: ${JSON.stringify(document.generatedIdentities?.length)}`);
  }
  const issued = new Map();
  for (let index = 0; index < document.generatedIdentities.length; index += 1) {
    const item = document.generatedIdentities[index];
    if (item?.generation !== document.generation || item.raster !== document.raster || item.sequence !== index + 1
      || typeof item.payload !== "string" || item.payload.length === 0) {
      throw new Error(`document identity generatedIdentities[${index}] is invalid: ${JSON.stringify(item)}`);
    }
    issued.set(`${item.generation}/${item.raster}/${item.sequence}`, item.payload);
  }

  const documentRows = decodedRows.filter((row) => row?.sourceKind === "document");
  if (!Number.isSafeInteger(document.decodedRecords) || document.decodedRecords !== documentRows.length) {
    throw new Error(`document identity decodedRecords does not match retained document rows: ${JSON.stringify(document.decodedRecords)} != ${documentRows.length}`);
  }
  let matchedRecords = 0;
  let unknownRecords = 0;
  const matchedFrames = [];
  const seenFrames = new Set();
  for (const row of documentRows) {
    if (!Number.isSafeInteger(row.frame) || row.frame < 1 || seenFrames.has(row.frame)
      || typeof row.displayTime !== "string" || !/^\d+$/.test(row.displayTime)
      || row.region !== document.regionToken || !(row.roi === null || validROI(row.roi, false))) {
      throw new Error(`document identity decoded row has invalid sample fields: ${JSON.stringify(row)}`);
    }
    seenFrames.add(row.frame);
    for (const field of ["decodeEnqueuedTime", "decodeStartTime", "decodeCompleteTime"]) {
      if (!(row[field] === null || (typeof row[field] === "string" && /^\d+$/.test(row[field])))) {
        throw new Error(`document identity decoded row has invalid ${field}: ${JSON.stringify(row)}`);
      }
    }
    if (row.status === "matched") {
      const identity = row.identity;
      const key = `${identity?.generation}/${identity?.raster}/${identity?.sequence}`;
      if (!identity || row.reason !== null || identity.generation !== document.generation || identity.raster !== document.raster
        || !Number.isSafeInteger(identity.sequence) || identity.sequence < 1 || identity.sequence > document.issuedSlots
        || !issued.has(key)) {
        throw new Error(`decoded sample contains an unissued document identity: ${JSON.stringify(row)}`);
      }
      matchedRecords += 1;
      matchedFrames.push(row.frame);
    } else if (row.status === "unknown") {
      if (row.identity !== null || typeof row.reason !== "string" || row.reason.length === 0) {
        throw new Error(`document identity unknown row lost its reason or retained an identity: ${JSON.stringify(row)}`);
      }
      unknownRecords += 1;
    } else {
      throw new Error(`document identity decoded row has unknown status: ${JSON.stringify(row)}`);
    }
  }
  if (!Number.isSafeInteger(document.matchedRecords) || document.matchedRecords !== matchedRecords) {
    throw new Error(`document identity matchedRecords does not match retained rows: ${JSON.stringify(document.matchedRecords)} != ${matchedRecords}`);
  }
  if (!Number.isSafeInteger(document.unknownRecords) || document.unknownRecords !== unknownRecords
    || document.decodedRecords !== document.matchedRecords + document.unknownRecords) {
    throw new Error(`document identity unknownRecords does not match retained rows: ${JSON.stringify(document.unknownRecords)} != ${unknownRecords}`);
  }
  if (!Number.isSafeInteger(document.incompleteSamples) || document.incompleteSamples !== 0) {
    throw new Error(`document identity capture has incomplete samples: ${JSON.stringify(document.incompleteSamples)}`);
  }
  if (matchedRecords === 0) throw new Error("capture contains no decoded document identity in ScreenCaptureKit pixels");
  return {
    generation, issuedSlots: document.issuedSlots, decodedRecords: document.decodedRecords,
    matchedRecords, unknownRecords, matchedFrames, manifest: stop.frameIdentity.manifest,
  };
}

function validROI(value, withScale) {
  if (!value || typeof value !== "object") return false;
  const keys = withScale ? ["x", "y", "width", "height", "scale"] : ["x", "y", "width", "height"];
  return keys.every((key) => Number.isFinite(value[key])) && value.width > 0 && value.height > 0
    && (!withScale || value.scale > 0);
}
