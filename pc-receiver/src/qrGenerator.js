/**
 * Pure JavaScript ISO/IEC 18004 QR Code Generator (Byte Mode, ECC Level L, Versions 1-10)
 * Produces standards-compliant scannable SVG QR codes for pairing URLs & payloads.
 */

// Version 1..10 specs for ECC Level L: [totalCodewords, ecCodewordsPerBlock, numBlocks, alignmentCenters]
const VERSION_SPECS_L = [
  null,
  { total: 26, ecPerBlock: 7, blocks: 1, align: [] },
  { total: 44, ecPerBlock: 10, blocks: 1, align: [6, 18] },
  { total: 70, ecPerBlock: 15, blocks: 1, align: [6, 22] },
  { total: 100, ecPerBlock: 20, blocks: 1, align: [6, 26] },
  { total: 134, ecPerBlock: 26, blocks: 1, align: [6, 30] },
  { total: 172, ecPerBlock: 18, blocks: 2, align: [6, 34] },
  { total: 196, ecPerBlock: 20, blocks: 2, align: [6, 22, 38] },
  { total: 242, ecPerBlock: 24, blocks: 2, align: [6, 24, 42] },
  { total: 292, ecPerBlock: 30, blocks: 2, align: [6, 26, 46] },
  { total: 346, ecPerBlock: 18, blocks: 4, align: [6, 28, 50] }
];

// GF(256) lookup tables with polynomial 0x11d
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) {
    GF_EXP[i] = GF_EXP[i - 255];
  }
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function rsGeneratorPoly(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    const root = GF_EXP[i];
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], root);
    }
    poly = next;
  }
  return poly;
}

function rsEncode(data, ecLen) {
  const gen = rsGeneratorPoly(ecLen);
  const rem = new Uint8Array(ecLen);
  for (let i = 0; i < data.length; i++) {
    const factor = data[i] ^ rem[0];
    rem.copyWithin(0, 1);
    rem[ecLen - 1] = 0;
    for (let j = 0; j < ecLen; j++) {
      rem[j] ^= gfMul(gen[j + 1], factor);
    }
  }
  return Array.from(rem);
}

function selectVersion(byteLength) {
  for (let v = 1; v <= 10; v++) {
    const spec = VERSION_SPECS_L[v];
    const dataCodewords = spec.total - spec.ecPerBlock * spec.blocks;
    const headerBits = 4 + (v < 10 ? 8 : 16);
    const maxBytes = Math.floor((dataCodewords * 8 - headerBits) / 8);
    if (byteLength <= maxBytes) return v;
  }
  throw new Error(`QR payload too long (${byteLength} bytes, max supported is ~271 bytes)`);
}

function encodeDataCodewords(bytes, version) {
  const spec = VERSION_SPECS_L[version];
  const totalDataCodewords = spec.total - spec.ecPerBlock * spec.blocks;
  const bits = [];

  const pushBits = (val, len) => {
    for (let i = len - 1; i >= 0; i--) {
      bits.push((val >>> i) & 1);
    }
  };

  // Byte mode indicator (0100)
  pushBits(0b0100, 4);
  pushBits(bytes.length, version < 10 ? 8 : 16);

  for (const b of bytes) {
    pushBits(b, 8);
  }

  const maxBits = totalDataCodewords * 8;
  const terminator = Math.min(4, maxBits - bits.length);
  pushBits(0, terminator);

  while (bits.length % 8 !== 0) {
    bits.push(0);
  }

  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) {
      byte = (byte << 1) | bits[i + j];
    }
    codewords.push(byte);
  }

  const pads = [0xec, 0x11];
  let padIdx = 0;
  while (codewords.length < totalDataCodewords) {
    codewords.push(pads[padIdx % 2]);
    padIdx++;
  }

  // Split into blocks & compute Reed-Solomon EC
  const numBlocks = spec.blocks;
  const blockSize = Math.floor(totalDataCodewords / numBlocks);
  const extraBlocks = totalDataCodewords % numBlocks;

  const dataBlocks = [];
  const ecBlocks = [];
  let offset = 0;

  for (let b = 0; b < numBlocks; b++) {
    const len = blockSize + (b >= numBlocks - extraBlocks ? 1 : 0);
    const block = codewords.slice(offset, offset + len);
    offset += len;
    dataBlocks.push(block);
    ecBlocks.push(rsEncode(block, spec.ecPerBlock));
  }

  // Interleave data and EC codewords
  const finalCodewords = [];
  const maxDataBlockLen = blockSize + (extraBlocks > 0 ? 1 : 0);
  for (let i = 0; i < maxDataBlockLen; i++) {
    for (let b = 0; b < numBlocks; b++) {
      if (i < dataBlocks[b].length) {
        finalCodewords.push(dataBlocks[b][i]);
      }
    }
  }
  for (let i = 0; i < spec.ecPerBlock; i++) {
    for (let b = 0; b < numBlocks; b++) {
      finalCodewords.push(ecBlocks[b][i]);
    }
  }

  return finalCodewords;
}

function buildMatrix(text) {
  const bytes = Buffer.from(String(text), 'utf8');
  const version = selectVersion(bytes.length);
  const spec = VERSION_SPECS_L[version];
  const size = version * 4 + 17;

  const modules = Array.from({ length: size }, () => new Array(size).fill(false));
  const isFunction = Array.from({ length: size }, () => new Array(size).fill(false));

  const setFunctionModule = (r, c, dark) => {
    if (r >= 0 && r < size && c >= 0 && c < size) {
      modules[r][c] = Boolean(dark);
      isFunction[r][c] = true;
    }
  };

  // Finder patterns + separators
  const drawFinder = (row, col) => {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const r = row + dr;
        const c = col + dc;
        if (r < 0 || r >= size || c < 0 || c >= size) continue;
        const inOuter = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
        const onBorder = dr === 0 || dr === 6 || dc === 0 || dc === 6;
        const inInner = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
        setFunctionModule(r, c, inOuter && (onBorder || inInner));
      }
    }
  };

  drawFinder(0, 0);
  drawFinder(0, size - 7);
  drawFinder(size - 7, 0);

  // Timing patterns
  for (let i = 8; i < size - 8; i++) {
    setFunctionModule(6, i, i % 2 === 0);
    setFunctionModule(i, 6, i % 2 === 0);
  }

  // Alignment patterns
  const centers = spec.align;
  for (let i = 0; i < centers.length; i++) {
    for (let j = 0; j < centers.length; j++) {
      if (
        (i === 0 && j === 0) ||
        (i === 0 && j === centers.length - 1) ||
        (i === centers.length - 1 && j === 0)
      ) {
        continue;
      }
      const cr = centers[i];
      const cc = centers[j];
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const dark = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
          setFunctionModule(cr + dr, cc + dc, dark);
        }
      }
    }
  }

  // Reserve format info areas + Dark module
  for (let i = 0; i <= 8; i++) {
    if (i !== 6) {
      setFunctionModule(8, i, false);
      setFunctionModule(i, 8, false);
    }
  }
  for (let i = 0; i < 8; i++) {
    setFunctionModule(8, size - 1 - i, false);
    setFunctionModule(size - 1 - i, 8, false);
  }
  setFunctionModule(size - 8, 8, true); // Dark module

  // Reserve version info for version >= 7
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) {
      rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    }
    const verBits = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const bit = ((verBits >>> i) & 1) !== 0;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setFunctionModule(b, a, bit);
      setFunctionModule(a, b, bit);
    }
  }

  // Place data bits in upward/downward 2-column zig-zag
  const codewords = encodeDataCodewords(bytes, version);
  let bitIdx = 0;
  const totalBits = codewords.length * 8;

  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      const r = upward ? size - 1 - vert : vert;
      for (let j = 0; j < 2; j++) {
        const c = right - j;
        if (!isFunction[r][c]) {
          let dark = false;
          if (bitIdx < totalBits) {
            const byte = codewords[bitIdx >>> 3];
            dark = ((byte >>> (7 - (bitIdx & 7))) & 1) !== 0;
            bitIdx++;
          }
          // Apply Mask 0: (r + c) % 2 === 0
          if ((r + c) % 2 === 0) {
            dark = !dark;
          }
          modules[r][c] = dark;
        }
      }
    }
    upward = !upward;
  }

  // Write Format Information for Level L (01) and Mask 0 (000) -> data = 0b01000 = 8
  const formatData = (0b01 << 3) | 0b000;
  let rem = formatData;
  for (let i = 0; i < 10; i++) {
    rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  }
  const formatBits = ((formatData << 10) | rem) ^ 0x5412;
  const getFmtBit = (i) => ((formatBits >>> i) & 1) !== 0;

  for (let i = 0; i <= 5; i++) setFunctionModule(i, 8, getFmtBit(i));
  setFunctionModule(7, 8, getFmtBit(6));
  setFunctionModule(8, 8, getFmtBit(7));
  setFunctionModule(8, 7, getFmtBit(8));
  for (let i = 9; i < 15; i++) setFunctionModule(8, 14 - i, getFmtBit(i));

  for (let i = 0; i < 8; i++) setFunctionModule(8, size - 1 - i, getFmtBit(i));
  for (let i = 8; i < 15; i++) setFunctionModule(size - 15 + i, 8, getFmtBit(i));

  return { version, size, modules, isFunction };
}

/**
 * Decodes a QR matrix generated by buildMatrix() back into its UTF-8 string
 * by reading ISO/IEC 18004 Format Information (Copy 1 & Copy 2), verifying BCH & RS ECC,
 * unmasking the zig-zag data modules, and decoding the Byte-mode stream.
 */
function decodeMatrix({ version, size, modules, isFunction }) {
  // 1. Read Format Information Copy 1 (around top-left finder)
  let fmt1 = 0;
  for (let i = 0; i <= 5; i++) if (modules[i][8]) fmt1 |= 1 << i;
  if (modules[7][8]) fmt1 |= 1 << 6;
  if (modules[8][8]) fmt1 |= 1 << 7;
  if (modules[8][7]) fmt1 |= 1 << 8;
  for (let i = 9; i < 15; i++) if (modules[8][14 - i]) fmt1 |= 1 << i;

  // 2. Read Format Information Copy 2 (top-right & bottom-left finders)
  let fmt2 = 0;
  for (let i = 0; i < 8; i++) if (modules[8][size - 1 - i]) fmt2 |= 1 << i;
  for (let i = 8; i < 15; i++) if (modules[size - 15 + i][8]) fmt2 |= 1 << i;

  if (fmt1 !== fmt2) {
    throw new Error(`Format info mismatch between Copy 1 (0x${fmt1.toString(16)}) and Copy 2 (0x${fmt2.toString(16)})`);
  }

  const unmaskedFmt = fmt1 ^ 0x5412;
  const formatData = unmaskedFmt >>> 10;
  const eccLevel = (formatData >>> 3) & 0b11;
  const maskPattern = formatData & 0b111;

  // Verify BCH(15, 5) remainder is 0
  let rem = unmaskedFmt;
  for (let i = 14; i >= 10; i--) {
    if ((rem >>> i) & 1) {
      rem ^= 0x537 << (i - 10);
    }
  }
  if (rem !== 0) {
    throw new Error(`Invalid Format Information BCH remainder: ${rem}`);
  }
  if (eccLevel !== 0b01 || maskPattern !== 0b000) {
    throw new Error(`Unexpected ECC level (${eccLevel}) or mask (${maskPattern})`);
  }

  // 3. Read & unmask data bits in 2-column upward/downward zig-zag
  const bits = [];
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      const r = upward ? size - 1 - vert : vert;
      for (let j = 0; j < 2; j++) {
        const c = right - j;
        if (!isFunction[r][c]) {
          let dark = modules[r][c];
          if (maskPattern === 0 && (r + c) % 2 === 0) {
            dark = !dark;
          }
          bits.push(dark ? 1 : 0);
        }
      }
    }
    upward = !upward;
  }

  const interleaved = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
    interleaved.push(byte);
  }

  // 4. De-interleave blocks and verify Reed-Solomon EC codewords match
  const spec = VERSION_SPECS_L[version];
  const totalDataCodewords = spec.total - spec.ecPerBlock * spec.blocks;
  const numBlocks = spec.blocks;
  const blockSize = Math.floor(totalDataCodewords / numBlocks);
  const extraBlocks = totalDataCodewords % numBlocks;

  const dataBlocks = Array.from({ length: numBlocks }, (_, b) =>
    new Array(blockSize + (b >= numBlocks - extraBlocks ? 1 : 0)).fill(0)
  );
  const ecBlocks = Array.from({ length: numBlocks }, () => new Array(spec.ecPerBlock).fill(0));

  let idx = 0;
  const maxDataBlockLen = blockSize + (extraBlocks > 0 ? 1 : 0);
  for (let i = 0; i < maxDataBlockLen; i++) {
    for (let b = 0; b < numBlocks; b++) {
      if (i < dataBlocks[b].length) {
        dataBlocks[b][i] = interleaved[idx++];
      }
    }
  }
  for (let i = 0; i < spec.ecPerBlock; i++) {
    for (let b = 0; b < numBlocks; b++) {
      ecBlocks[b][i] = interleaved[idx++];
    }
  }

  const dataCodewords = [];
  for (let b = 0; b < numBlocks; b++) {
    const expectedEc = rsEncode(dataBlocks[b], spec.ecPerBlock);
    for (let i = 0; i < spec.ecPerBlock; i++) {
      if (expectedEc[i] !== ecBlocks[b][i]) {
        throw new Error(`Reed-Solomon EC mismatch in block ${b} at byte ${i}`);
      }
    }
    dataCodewords.push(...dataBlocks[b]);
  }

  // 5. Parse Byte-mode bitstream
  const dataBits = [];
  for (const cw of dataCodewords) {
    for (let i = 7; i >= 0; i--) dataBits.push((cw >>> i) & 1);
  }

  let bitPtr = 0;
  const readBits = (n) => {
    let val = 0;
    for (let i = 0; i < n; i++) val = (val << 1) | (dataBits[bitPtr++] || 0);
    return val;
  };

  const mode = readBits(4);
  if (mode !== 0b0100) {
    throw new Error(`Unsupported QR mode indicator: ${mode}`);
  }
  const byteCount = readBits(version < 10 ? 8 : 16);
  const outBytes = Buffer.alloc(byteCount);
  for (let i = 0; i < byteCount; i++) {
    outBytes[i] = readBits(8);
  }

  return outBytes.toString('utf8');
}

function generateQrSvg(text, { margin = 4, darkColor = '#0f172a', lightColor = '#ffffff' } = {}) {
  const { size, modules } = buildMatrix(text);
  const viewSize = size + margin * 2;
  const paths = [];

  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (modules[r][c]) {
        paths.push(`M${c + margin},${r + margin}h1v1h-1z`);
      }
    }
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${viewSize} ${viewSize}" shape-rendering="crispEdges" role="img" aria-label="QR Code สำหรับจับคู่มือถือ">`,
    `<rect width="${viewSize}" height="${viewSize}" fill="${lightColor}" rx="2"/>`,
    `<path d="${paths.join('')}" fill="${darkColor}"/>`,
    `</svg>`
  ].join('');
}

function createPairingPayload({ ip, port, token, serverName }) {
  const safeName = serverName || 'PC-Receiver';
  const query = `ip=${encodeURIComponent(ip)}&port=${encodeURIComponent(port)}&token=${encodeURIComponent(token)}&name=${encodeURIComponent(safeName)}`;
  const uri = `gamemirror://connect?${query}`;
  const webUrl = `http://${ip}:${port}/connect?${query}`;
  const wsUrl = `ws://${ip}:${port}/ws?token=${encodeURIComponent(token)}`;
  // Encode standard HTTP URL in QR so iPhone/Android native Camera app always recognizes it
  // (never shows "No usable data found"), while native apps & web page both parse the same query parameters.
  const qrSvg = generateQrSvg(webUrl);

  return {
    uri,
    webUrl,
    wsUrl,
    ip,
    port,
    token,
    serverName: safeName,
    qrSvg
  };
}

module.exports = {
  buildMatrix,
  decodeMatrix,
  generateQrSvg,
  createPairingPayload
};
