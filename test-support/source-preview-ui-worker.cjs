// Test-only code-native cover. No web request, browser, image decoder or account.
const { deflateSync, crc32 } = require('node:zlib');
const { startWorker } = require('../src/source-preview-worker');
const width = 800, height = 420, raw = Buffer.alloc((width * 3 + 1) * height);
for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
  let rgb = [26 + Math.floor(x / 20), 70 + Math.floor(y / 8), 135 + Math.floor(x / 14)];
  if (x > 84 && x < 716 && y > 64 && y < 356) rgb = [244, 248, 255];
  if (x > 84 && x < 716 && y > 64 && y < 105) rgb = [220, 231, 247];
  if (x > 110 && x < 145 && y > 76 && y < 92) rgb = [80, 126, 191];
  if (x > 122 && x < 420 && y > 140 && y < 166) rgb = [39, 78, 135];
  if (x > 122 && x < 520 && ((y > 190 && y < 201) || (y > 222 && y < 233) || (y > 254 && y < 265))) rgb = [168, 191, 220];
  if (x > 575 && x < 675 && y > 140 && y < 284) rgb = [191, 212, 240];
  const p = y * (width * 3 + 1) + 1 + x * 3; raw.set(rgb, p);
}
function chunk(type, data) { const body = Buffer.concat([Buffer.from(type), data]), length = Buffer.alloc(4), sum = Buffer.alloc(4);
  length.writeUInt32BE(data.length); sum.writeUInt32BE(crc32(body)); return Buffer.concat([length, body, sum]); }
const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
const bytes = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
startWorker({ async fetchImpl(_url, { permit }) {
  if (!await permit() || !await permit()) throw Object.assign(new Error('budget'), { code: 'budget' });
  return { bytes, type: 'image/png' };
} });
