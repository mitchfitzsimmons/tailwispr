// src/qrcode.js — Minimal QR code generator for terminal display
// No dependencies. Supports byte-mode encoding, versions 1-4, EC level L.
// Outputs half-height Unicode block art (▀ ▄ █ and space).

'use strict';

// ---------------------------------------------------------------------------
// GF(256) arithmetic for Reed-Solomon (primitive polynomial 0x11d)
// ---------------------------------------------------------------------------
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(function initGF() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x >= 256) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

// Multiply polynomial (array of coefficients, high-degree first) by (x - GF_EXP[e])
function polyMulLinear(poly, e) {
  const result = new Uint8Array(poly.length + 1);
  const factor = GF_EXP[e];
  for (let i = 0; i < poly.length; i++) {
    result[i] ^= poly[i];
    result[i + 1] ^= gfMul(poly[i], factor);
  }
  return result;
}

function rsGeneratorPoly(n) {
  let g = new Uint8Array([1]);
  for (let i = 0; i < n; i++) g = polyMulLinear(g, i);
  return g;
}

function rsEncode(data, ecCount) {
  const gen = rsGeneratorPoly(ecCount);
  const msg = new Uint8Array(data.length + ecCount);
  msg.set(data);
  for (let i = 0; i < data.length; i++) {
    const coef = msg[i];
    if (coef !== 0) {
      for (let j = 0; j < gen.length; j++) {
        msg[i + j] ^= gfMul(gen[j], coef);
      }
    }
  }
  return msg.slice(data.length); // EC codewords only
}

// ---------------------------------------------------------------------------
// QR code parameters (versions 1-4, EC level L only)
// ---------------------------------------------------------------------------
// [totalCodewords, ecCodewordsPerBlock, numBlocks, dataCodewords]
const VERSION_INFO = {
  1: { size: 21, totalCW: 26,  ecPerBlock: 7,  blocks: 1, dataCW: 19 },
  2: { size: 25, totalCW: 44,  ecPerBlock: 10, blocks: 1, dataCW: 34 },
  3: { size: 29, totalCW: 70,  ecPerBlock: 15, blocks: 1, dataCW: 55 },
  4: { size: 33, totalCW: 100, ecPerBlock: 20, blocks: 1, dataCW: 80 },
};

// Alignment pattern center positions per version
const ALIGNMENT = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
};

// ---------------------------------------------------------------------------
// Data encoding (byte mode only — sufficient for URLs)
// ---------------------------------------------------------------------------
function encodeData(text, version) {
  const info = VERSION_INFO[version];
  const dataBits = info.dataCW * 8;
  const bytes = Buffer.from(text, 'utf-8');
  if (bytes.length > info.dataCW - 3) {
    throw new Error(`Text too long for QR version ${version} (need ${bytes.length + 3} data codewords, have ${info.dataCW})`);
  }

  const bits = [];
  function pushBits(val, count) {
    for (let i = count - 1; i >= 0; i--) bits.push((val >> i) & 1);
  }

  // Mode indicator: 0100 = byte mode
  pushBits(0b0100, 4);
  // Character count (8 bits for versions 1-9 in byte mode)
  pushBits(bytes.length, 8);
  // Data
  for (const b of bytes) pushBits(b, 8);
  // Terminator (up to 4 zero bits)
  const termLen = Math.min(4, dataBits - bits.length);
  pushBits(0, termLen);
  // Pad to byte boundary
  while (bits.length % 8 !== 0) bits.push(0);
  // Pad codewords (0xEC, 0x11 alternating)
  const pads = [0xEC, 0x11];
  let pi = 0;
  while (bits.length < dataBits) {
    pushBits(pads[pi % 2], 8);
    pi++;
  }

  // Convert bits to codewords
  const codewords = new Uint8Array(info.dataCW);
  for (let i = 0; i < info.dataCW; i++) {
    let val = 0;
    for (let b = 0; b < 8; b++) val = (val << 1) | bits[i * 8 + b];
    codewords[i] = val;
  }
  return codewords;
}

// ---------------------------------------------------------------------------
// Matrix construction
// ---------------------------------------------------------------------------
function createMatrix(version) {
  const info = VERSION_INFO[version];
  const size = info.size;
  // matrix: 0=light, 1=dark; reserved: tracks which cells are fixed (not data)
  const matrix = Array.from({ length: size }, () => new Uint8Array(size));
  const reserved = Array.from({ length: size }, () => new Uint8Array(size));

  function setModule(r, c, val) {
    matrix[r][c] = val ? 1 : 0;
    reserved[r][c] = 1;
  }

  // Finder patterns (7x7) at three corners
  function drawFinder(row, col) {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const r = row + dr, c = col + dc;
        if (r < 0 || r >= size || c < 0 || c >= size) continue;
        const inOuter = dr === 0 || dr === 6 || dc === 0 || dc === 6;
        const inInner = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
        const dark = inOuter || inInner;
        // Separator ring is the -1 and 7 ring → always light
        const isSep = dr === -1 || dr === 7 || dc === -1 || dc === 7;
        setModule(r, c, isSep ? 0 : dark);
      }
    }
  }

  drawFinder(0, 0);
  drawFinder(0, size - 7);
  drawFinder(size - 7, 0);

  // Alignment patterns
  const centers = ALIGNMENT[version];
  if (centers.length > 0) {
    for (const cr of centers) {
      for (const cc of centers) {
        // Skip if overlapping finder
        if (cr <= 8 && cc <= 8) continue;
        if (cr <= 8 && cc >= size - 8) continue;
        if (cr >= size - 8 && cc <= 8) continue;
        for (let dr = -2; dr <= 2; dr++) {
          for (let dc = -2; dc <= 2; dc++) {
            const dark = Math.abs(dr) === 2 || Math.abs(dc) === 2 || (dr === 0 && dc === 0);
            setModule(cr + dr, cc + dc, dark);
          }
        }
      }
    }
  }

  // Timing patterns
  for (let i = 8; i < size - 8; i++) {
    setModule(6, i, i % 2 === 0);
    setModule(i, 6, i % 2 === 0);
  }

  // Dark module
  setModule(size - 8, 8, 1);

  // Reserve format info areas (will be written after masking)
  // Around top-left finder
  for (let i = 0; i <= 8; i++) {
    if (!reserved[8][i]) reserved[8][i] = 1;
    if (!reserved[i][8]) reserved[i][8] = 1;
  }
  // Around top-right finder
  for (let i = 0; i <= 7; i++) {
    if (!reserved[8][size - 1 - i]) reserved[8][size - 1 - i] = 1;
  }
  // Around bottom-left finder
  for (let i = 0; i <= 7; i++) {
    if (!reserved[size - 1 - i][8]) reserved[size - 1 - i][8] = 1;
  }

  return { matrix, reserved, size };
}

function placeData(matrix, reserved, size, dataBits) {
  let bitIdx = 0;
  // Data is placed in 2-column strips, right-to-left.
  // Direction alternates: first strip goes upward, next downward, etc.
  // Within each row of a strip, the right column is placed before the left.
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // skip timing column
    for (let i = 0; i < size; i++) {
      const r = upward ? (size - 1 - i) : i;
      for (let dc = 0; dc <= 1; dc++) {
        const c = right - dc;
        if (c < 0 || c >= size) continue;
        if (reserved[r][c]) continue;
        if (bitIdx < dataBits.length) {
          matrix[r][c] = dataBits[bitIdx];
          bitIdx++;
        }
        // else module stays 0 (light) which is correct for remainder bits
      }
    }
    upward = !upward;
  }
}

// ---------------------------------------------------------------------------
// Masking
// ---------------------------------------------------------------------------
const MASK_FNS = [
  (r, c) => (r + c) % 2 === 0,
  (r, c) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2 + (r * c) % 3) === 0,
  (r, c) => ((r * c) % 2 + (r * c) % 3) % 2 === 0,
  (r, c) => ((r + c) % 2 + (r * c) % 3) % 2 === 0,
];

function applyMask(matrix, reserved, size, maskIdx) {
  const fn = MASK_FNS[maskIdx];
  const masked = matrix.map(row => new Uint8Array(row));
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!reserved[r][c] && fn(r, c)) {
        masked[r][c] ^= 1;
      }
    }
  }
  return masked;
}

// ---------------------------------------------------------------------------
// Format information (EC level L = 01, masks 0-7)
// ---------------------------------------------------------------------------
// Pre-computed format strings for EC level L (01) with each mask pattern
// Format: 5 data bits (2 EC + 3 mask) → 10 EC bits → XOR with 101010000010010
const FORMAT_STRINGS = [
  0x77C4, // L, mask 0
  0x72F3, // L, mask 1
  0x7DAA, // L, mask 2
  0x789D, // L, mask 3
  0x662F, // L, mask 4
  0x6318, // L, mask 5
  0x6C41, // L, mask 6
  0x6976, // L, mask 7
];

function writeFormatInfo(matrix, size, maskIdx) {
  const fmt = FORMAT_STRINGS[maskIdx];
  const bits = [];
  for (let i = 14; i >= 0; i--) bits.push((fmt >> i) & 1);

  // Horizontal strip (row 8) and vertical strip (col 8)
  // Horizontal: bits 0-7 go left-to-right in row 8 (skipping col 6)
  const hCols = [0, 1, 2, 3, 4, 5, 7, 8, size - 8, size - 7, size - 6, size - 5, size - 4, size - 3, size - 2];
  const vRows = [size - 1, size - 2, size - 3, size - 4, size - 5, size - 6, size - 7, size - 8, 7, 5, 4, 3, 2, 1, 0];

  for (let i = 0; i < 15; i++) {
    matrix[8][hCols[i]] = bits[i];
    matrix[vRows[i]][8] = bits[i];
  }
}

// ---------------------------------------------------------------------------
// Penalty scoring (simplified — we just pick mask 0 for simplicity, but let's
// do a basic score to pick a reasonable mask)
// ---------------------------------------------------------------------------
function penaltyScore(matrix, size) {
  let score = 0;
  // Rule 1: runs of same color in rows and columns
  for (let r = 0; r < size; r++) {
    let run = 1;
    for (let c = 1; c < size; c++) {
      if (matrix[r][c] === matrix[r][c - 1]) {
        run++;
      } else {
        if (run >= 5) score += run - 2;
        run = 1;
      }
    }
    if (run >= 5) score += run - 2;
  }
  for (let c = 0; c < size; c++) {
    let run = 1;
    for (let r = 1; r < size; r++) {
      if (matrix[r][c] === matrix[r - 1][c]) {
        run++;
      } else {
        if (run >= 5) score += run - 2;
        run = 1;
      }
    }
    if (run >= 5) score += run - 2;
  }
  // Rule 2: 2x2 blocks of same color
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = matrix[r][c];
      if (v === matrix[r][c + 1] && v === matrix[r + 1][c] && v === matrix[r + 1][c + 1]) {
        score += 3;
      }
    }
  }
  return score;
}

// ---------------------------------------------------------------------------
// Main QR generation
// ---------------------------------------------------------------------------
function generateQRMatrix(text) {
  // Pick the smallest version that fits
  const textBytes = Buffer.from(text, 'utf-8');
  let version = 0;
  for (let v = 1; v <= 4; v++) {
    // Byte mode: 4 mode bits + 8 count bits + data + up to 4 terminator = overhead ~2 codewords
    if (textBytes.length <= VERSION_INFO[v].dataCW - 3) {
      version = v;
      break;
    }
  }
  if (version === 0) throw new Error(`Text too long for QR versions 1-4 (${textBytes.length} bytes)`);

  const info = VERSION_INFO[version];

  // Encode data
  const dataCW = encodeData(text, version);
  const ecCW = rsEncode(dataCW, info.ecPerBlock);

  // Interleave (single block for versions 1-4 L, so just concatenate)
  const allCW = new Uint8Array(info.totalCW);
  allCW.set(dataCW);
  allCW.set(ecCW, dataCW.length);

  // Convert to bit stream
  const dataBits = [];
  for (const cw of allCW) {
    for (let i = 7; i >= 0; i--) dataBits.push((cw >> i) & 1);
  }

  // Build matrix
  const { matrix, reserved, size } = createMatrix(version);

  // Place data bits
  placeData(matrix, reserved, size, dataBits);

  // Try all masks, pick best
  let bestMask = 0;
  let bestScore = Infinity;
  let bestMatrix = null;
  for (let m = 0; m < 8; m++) {
    const masked = applyMask(matrix, reserved, size, m);
    const score = penaltyScore(masked, size);
    if (score < bestScore) {
      bestScore = score;
      bestMask = m;
      bestMatrix = masked;
    }
  }

  // Write format info
  writeFormatInfo(bestMatrix, size, bestMask);

  return { matrix: bestMatrix, size };
}

// ---------------------------------------------------------------------------
// Terminal rendering — half-height using Unicode block characters
// ---------------------------------------------------------------------------
// Each output line encodes TWO rows of modules.
// Top row pixel + bottom row pixel → character:
//   dark + dark  → █ (full block)
//   dark + light → ▀ (upper half)
//   light + dark → ▄ (lower half)
//   light + light → ' ' (space)
//
// We add a 1-module "quiet zone" border (rendered as spaces/half blocks).

function renderSmall(qr) {
  const { matrix, size } = qr;
  const quiet = 2; // quiet zone modules on each side
  const totalW = size + quiet * 2;
  const totalH = size + quiet * 2;

  // Helper: get module value with quiet zone (0 = light outside QR)
  function mod(r, c) {
    const qr_r = r - quiet;
    const qr_c = c - quiet;
    if (qr_r < 0 || qr_r >= size || qr_c < 0 || qr_c >= size) return 0;
    return matrix[qr_r][qr_c];
  }

  const lines = [];
  for (let r = 0; r < totalH; r += 2) {
    let line = '';
    for (let c = 0; c < totalW; c++) {
      const top = mod(r, c);
      const bot = (r + 1 < totalH) ? mod(r + 1, c) : 0;
      if (top && bot) line += '\u2588';       // █
      else if (top && !bot) line += '\u2580';  // ▀
      else if (!top && bot) line += '\u2584';  // ▄
      else line += ' ';
    }
    lines.push(line);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a QR code for the given text and return it as a terminal-friendly
 * string using half-height Unicode block characters.
 *
 * Supports text up to ~77 bytes (version 4-L byte mode).
 * Returns null if text is too long or generation fails.
 *
 * @param {string} text - The text to encode (typically a URL)
 * @returns {string|null} The QR code as a multi-line string, or null on failure
 */
function generateQR(text) {
  try {
    const qr = generateQRMatrix(text);
    return renderSmall(qr);
  } catch (e) {
    // If our built-in encoder can't handle it, try external tools
    return generateQRExternal(text);
  }
}

/**
 * Fallback: shell out to qrencode CLI or Python.
 * Returns null if neither is available.
 */
function generateQRExternal(text) {
  const { execFileSync } = require('child_process');

  // Try qrencode CLI (common on Linux, available via Homebrew)
  try {
    const out = execFileSync('qrencode', ['-t', 'UTF8', '-m', '2', text], {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (out && out.trim()) return out.trim();
  } catch (_) { /* not available */ }

  // Try Python qrcode module — pass text via argv, no shell interpolation
  try {
    const pyScript = 'import sys,qrcode;q=qrcode.QRCode(border=2,error_correction=qrcode.constants.ERROR_CORRECT_L);q.add_data(sys.argv[1]);q.make(fit=True);q.print_ascii(invert=True)';
    const out = execFileSync('python3', ['-c', pyScript, text], {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (out && out.trim()) return out.trim();
  } catch (_) { /* not available */ }

  return null;
}

module.exports = { generateQR };
