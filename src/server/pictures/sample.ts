import zlib from "node:zlib";

// The demo's one sample picture, drawn here in code: a dark settings panel whose labels are
// dark grey bars on near black, too faint to read, as the sample ticket describes. It is a
// plain PNG built with Node's own zlib, so nothing is copied from anywhere.

const WIDTH = 480;
const HEIGHT = 300;

type Colour = [number, number, number];
type Box = { x: number; y: number; width: number; height: number; colour: Colour };

const BACKGROUND: Colour = [18, 18, 18];
const PANEL: Colour = [28, 28, 28];
const HEADING: Colour = [80, 80, 80];
const FAINT_LABEL: Colour = [44, 44, 44];
const SWITCH: Colour = [52, 52, 52];

/** The boxes of the drawing, back to front. */
function boxes(): Box[] {
  const drawn: Box[] = [
    { x: 40, y: 30, width: 400, height: 240, colour: PANEL },
    { x: 64, y: 52, width: 150, height: 14, colour: HEADING },
  ];
  const labelWidths = [180, 130, 210, 150, 170];
  labelWidths.forEach((width, row) => {
    const y = 96 + row * 34;
    drawn.push({ x: 64, y, width, height: 10, colour: FAINT_LABEL });
    drawn.push({ x: 372, y: y - 3, width: 40, height: 16, colour: SWITCH });
  });
  return drawn;
}

/** One PNG chunk: its length, type, data and checksum. */
function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(zlib.crc32(typeAndData));
  return Buffer.concat([length, typeAndData, checksum]);
}

/** The sample picture as PNG bytes. */
export function samplePicture(): Buffer {
  // Each row of pixels starts with a filter byte, 0 for none, then three bytes a pixel.
  const rowLength = 1 + WIDTH * 3;
  const pixels = Buffer.alloc(rowLength * HEIGHT);
  const paint = (x: number, y: number, [red, green, blue]: Colour) => {
    const at = y * rowLength + 1 + x * 3;
    pixels[at] = red;
    pixels[at + 1] = green;
    pixels[at + 2] = blue;
  };
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) paint(x, y, BACKGROUND);
  }
  for (const box of boxes()) {
    for (let y = box.y; y < box.y + box.height; y += 1) {
      for (let x = box.x; x < box.x + box.width; x += 1) paint(x, y, box.colour);
    }
  }

  // The header: width, height, 8 bits a channel, colour type 2 (red, green, blue), then the
  // standard compression, filter and interlace methods, all 0.
  const header = Buffer.alloc(13);
  header.writeUInt32BE(WIDTH, 0);
  header.writeUInt32BE(HEIGHT, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
