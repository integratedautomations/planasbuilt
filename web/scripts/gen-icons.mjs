// Generates public/icon-192.png, icon-512.png and icon-maskable-512.png (no dependencies).
// Run: node scripts/gen-icons.mjs   (outputs are committed; rerun only to change the artwork)
import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
const crc = b => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type), data])
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td))
  return Buffer.concat([len, td, c])
}
function png(size, pix) {
  const raw = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; pix(y).copy(raw, y * (size * 4 + 1) + 1) }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

// Dark rounded square (#1f2937) with an orange (#e8590c) location pin ring and a white centre dot.
function icon(size, { rounded, scale }) {
  return png(size, y => {
    const row = Buffer.alloc(size * 4)
    for (let x = 0; x < size; x++) {
      const nx = (x + 0.5) / size - 0.5, ny = (y + 0.5) / size - 0.5
      let rgba = [0x1f, 0x29, 0x37, 255]
      if (rounded) { // transparent corners
        const r = 0.22, ax = Math.abs(nx) - (0.5 - r), ay = Math.abs(ny) - (0.5 - r)
        if (ax > 0 && ay > 0 && Math.hypot(ax, ay) > r) rgba = [0, 0, 0, 0]
      }
      const d = Math.hypot(nx, ny + 0.03 * scale) / scale
      if (rgba[3] && d < 0.27 && d > 0.17) rgba = [0xe8, 0x59, 0x0c, 255]
      else if (rgba[3] && d <= 0.09) rgba = [255, 255, 255, 255]
      row.set(rgba, x * 4)
    }
    return row
  })
}
writeFileSync('public/icon-192.png', icon(192, { rounded: true, scale: 1 }))
writeFileSync('public/icon-512.png', icon(512, { rounded: true, scale: 1 }))
writeFileSync('public/icon-maskable-512.png', icon(512, { rounded: false, scale: 0.8 })) // art inside the 80% safe zone
console.log('icons written')
