'use strict';
/* ============================================================
   WORK RADAR — icon generator
   Renders the radar motif to build/icon.png with zero external
   dependencies (no SVG rasteriser is guaranteed on the box), then
   best-effort derives build/icon.icns on macOS via sips + iconutil.
   Run via `npm run icon` (also invoked by `prebuild`).
   ============================================================ */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const SIZE = 1024;
const CX = SIZE / 2;
const CY = SIZE / 2;
const MAXR = SIZE * 0.46;
const OUT_DIR = path.join(__dirname, '..', 'build');

// Palette mirrors the renderer theme.
const BG = [1, 8, 5];
const GRID = [12, 31, 14];
const RING = [26, 61, 34];
const SWEEP = [0, 230, 118];
const BLIPS = [
  [244, 67, 54], // critical
  [255, 145, 0], // high
  [0, 230, 118], // medium
  [38, 198, 218], // low
];

const buf = Buffer.alloc(SIZE * SIZE * 4);

function blend(x, y, [r, g, b], a) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE || a <= 0) return;
  const i = (y * SIZE + x) * 4;
  const ba = buf[i + 3] / 255;
  const oa = a + ba * (1 - a);
  if (oa <= 0) return;
  buf[i] = Math.round((r * a + buf[i] * ba * (1 - a)) / oa);
  buf[i + 1] = Math.round((g * a + buf[i + 1] * ba * (1 - a)) / oa);
  buf[i + 2] = Math.round((b * a + buf[i + 2] * ba * (1 - a)) / oa);
  buf[i + 3] = Math.round(oa * 255);
}

// Smooth 1px edge for anti-aliasing a target distance.
function aa(value, edge) {
  return Math.max(0, Math.min(1, 1 - Math.abs(value) / edge));
}

function fillBackground() {
  for (let i = 0; i < SIZE * SIZE; i++) {
    buf[i * 4] = BG[0];
    buf[i * 4 + 1] = BG[1];
    buf[i * 4 + 2] = BG[2];
    buf[i * 4 + 3] = 255;
  }
}

function ring(radius, width, color, alpha) {
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const d = Math.hypot(x - CX, y - CY);
      const cov = aa(Math.abs(d - radius) - width / 2, 1.5);
      if (cov > 0) blend(x, y, color, cov * alpha);
    }
  }
}

function disc(cxp, cyp, radius, color, alpha) {
  const x0 = Math.max(0, Math.floor(cxp - radius - 2));
  const x1 = Math.min(SIZE, Math.ceil(cxp + radius + 2));
  const y0 = Math.max(0, Math.floor(cyp - radius - 2));
  const y1 = Math.min(SIZE, Math.ceil(cyp + radius + 2));
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const d = Math.hypot(x - cxp, y - cyp);
      // Filled coverage: 1 inside, anti-aliased to 0 across the edge.
      const cov = Math.max(0, Math.min(1, 1 - (d - radius) / 1.5));
      if (cov > 0) blend(x, y, color, cov * alpha);
    }
  }
}

function line(x1, y1, x2, y2, width, color, alpha) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let t = ((x - x1) * dx + (y - y1) * dy) / len2;
      t = Math.max(0, Math.min(1, t));
      const px = x1 + t * dx;
      const py = y1 + t * dy;
      const cov = aa(Math.hypot(x - px, y - py) - width / 2, 1.5);
      if (cov > 0) blend(x, y, color, cov * alpha);
    }
  }
}

// Rotating sweep wedge: a glow that fades behind a bright leading edge.
function sweep(leadingDeg, spanDeg) {
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const d = Math.hypot(x - CX, y - CY);
      if (d > MAXR) continue;
      // Angle clockwise from north (up).
      const ang = (Math.atan2(x - CX, -(y - CY)) * 180) / Math.PI;
      const diff = (leadingDeg - ang + 360) % 360;
      if (diff <= spanDeg) {
        const trail = 1 - diff / spanDeg;
        const radial = 1 - (d / MAXR) * 0.25;
        blend(x, y, SWEEP, trail * radial * 0.45);
      }
    }
  }
}

function blip(angleDeg, radiusFrac, color) {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  const px = CX + Math.cos(rad) * MAXR * radiusFrac;
  const py = CY + Math.sin(rad) * MAXR * radiusFrac;
  disc(px, py, 26, color, 0.25); // glow
  disc(px, py, 14, color, 0.95); // core
}

function render() {
  fillBackground();
  // Grid: crosshair + diagonals.
  line(CX, CY - MAXR, CX, CY + MAXR, 3, GRID, 1);
  line(CX - MAXR, CY, CX + MAXR, CY, 3, GRID, 1);
  const diag = MAXR * 0.71;
  line(CX - diag, CY - diag, CX + diag, CY + diag, 2, GRID, 0.7);
  line(CX + diag, CY - diag, CX - diag, CY + diag, 2, GRID, 0.7);
  // Range rings.
  ring(MAXR, 4, RING, 1);
  ring(MAXR * 0.61, 3, GRID, 1);
  ring(MAXR * 0.31, 3, GRID, 1);
  // Sweep, blips, hub.
  sweep(60, 70);
  blip(35, 0.31, BLIPS[2]);
  blip(150, 0.61, BLIPS[1]);
  blip(255, 0.85, BLIPS[3]);
  blip(310, 0.45, BLIPS[0]);
  disc(CX, CY, 10, SWEEP, 0.9);
}

/* ---------- PNG encoding (RGBA, no filtering) ---------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(data) {
  let c = ~0;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePNG() {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  // 10..12 already 0 (compression / filter / interlace)

  const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
  for (let y = 0; y < SIZE; y++) {
    raw[y * (SIZE * 4 + 1)] = 0; // filter: none
    buf.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------- macOS .icns (best effort) ---------- */
function tryMakeIcns(pngPath) {
  if (process.platform !== 'darwin') return;
  const iconset = path.join(OUT_DIR, 'icon.iconset');
  try {
    fs.rmSync(iconset, { recursive: true, force: true });
    fs.mkdirSync(iconset, { recursive: true });
    const sizes = [16, 32, 64, 128, 256, 512];
    for (const s of sizes) {
      execFileSync(
        'sips',
        ['-z', String(s), String(s), pngPath, '--out', path.join(iconset, `icon_${s}x${s}.png`)],
        { stdio: 'ignore' }
      );
      execFileSync(
        'sips',
        [
          '-z',
          String(s * 2),
          String(s * 2),
          pngPath,
          '--out',
          path.join(iconset, `icon_${s}x${s}@2x.png`),
        ],
        { stdio: 'ignore' }
      );
    }
    execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(OUT_DIR, 'icon.icns')], {
      stdio: 'ignore',
    });
    fs.rmSync(iconset, { recursive: true, force: true });
    console.log('wrote build/icon.icns');
  } catch (err) {
    console.warn('icns generation skipped:', err.message);
  }
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  render();
  const pngPath = path.join(OUT_DIR, 'icon.png');
  fs.writeFileSync(pngPath, encodePNG());
  console.log(`wrote build/icon.png (${SIZE}x${SIZE})`);
  tryMakeIcns(pngPath);
}

main();
