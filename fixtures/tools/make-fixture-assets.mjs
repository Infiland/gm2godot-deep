#!/usr/bin/env node
// Deterministic binary asset generator for the synthetic GameMaker fixture
// `fixtures/gm-projects/counter`.
//
// It writes exactly two 2x2 RGBA PNG files, matching the real GameMaker 2.3+
// sprite layout (verified against
// `GM2Godot/tests/test_resource_matrix_godot.py`, which writes
// `sprites/<name>/layers/<frame_guid>/<layer_guid>.png`, and against
// `GM2Godot/src/conversion/tilesets.py:462`):
//
//   sprites/spr_counter/<FRAME_GUID>.png                       (composite frame)
//   sprites/spr_counter/layers/<FRAME_GUID>/<LAYER_GUID>.png   (image layer)
//
// `spr_counter.yy` references the same two GUIDs.
//
// Only Node built-ins are used: `node:zlib` for the IDAT deflate stream and a
// fixed CRC-32 table for the PNG chunk checksums. The encoder takes no input
// from the environment, emits no timestamp chunk, and compresses with a fixed
// level, so the bytes are reproducible across runs (asserted by running this
// script twice and comparing sha256 sums).

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

/** @type {readonly string} */
const FRAME_GUID = "8f0a1c6e-3d2b-4f57-9a41-2c7b5e9d0a13";
/** @type {readonly string} */
const LAYER_GUID = "b3d9e2a7-5c14-4e88-a6f0-71d4c2b8e5f9";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/**
 * @param {Buffer} bytes
 * @returns {number}
 */
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    const index = (crc ^ byte) & 0xff;
    crc = (CRC_TABLE[index] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * @param {string} type
 * @param {Buffer} data
 * @returns {Buffer}
 */
function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, checksum]);
}

/**
 * Encode an 8-bit RGBA PNG from raw pixel bytes.
 *
 * @param {number} width
 * @param {number} height
 * @param {readonly number[]} pixels row-major RGBA, `width * height * 4` bytes
 * @returns {Buffer}
 */
function encodePng(width, height, pixels) {
  if (pixels.length !== width * height * 4) {
    throw new Error(
      `pixel buffer is ${pixels.length} bytes; expected ${width * height * 4}`,
    );
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.writeUInt8(8, 8); // bit depth
  header.writeUInt8(6, 9); // colour type: truecolour with alpha
  header.writeUInt8(0, 10); // compression method: deflate
  header.writeUInt8(0, 11); // filter method: adaptive
  header.writeUInt8(0, 12); // interlace method: none

  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter type 0 (None) for every scanline
    Buffer.from(pixels).copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const spriteDir = join(repoRoot, "fixtures", "gm-projects", "counter", "sprites", "spr_counter");

// Composite frame image: a single opaque red pixel colour.
const compositePixels = [
  220, 80, 80, 255,
  220, 80, 80, 255,
  220, 80, 80, 255,
  220, 80, 80, 255,
];

// Image layer: an opaque black/white checker so a 2x2 frame is visually
// distinguishable from its composite.
const layerPixels = [
  255, 255, 255, 255,
  0, 0, 0, 255,
  0, 0, 0, 255,
  255, 255, 255, 255,
];

const outputs = [
  {
    path: join(spriteDir, `${FRAME_GUID}.png`),
    bytes: encodePng(2, 2, compositePixels),
  },
  {
    path: join(spriteDir, "layers", FRAME_GUID, `${LAYER_GUID}.png`),
    bytes: encodePng(2, 2, layerPixels),
  },
];

for (const output of outputs) {
  mkdirSync(dirname(output.path), { recursive: true });
  writeFileSync(output.path, output.bytes);
  const relative = output.path.slice(repoRoot.length + 1);
  const digest = createHash("sha256").update(output.bytes).digest("hex");
  console.log(`${digest}  ${output.bytes.length}B  ${relative}`);
}
