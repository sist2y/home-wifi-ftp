const http = require('http')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { exec, execSync } = require('child_process')
const { crc32 } = require('zlib')

const PORT = 8787
const MIME = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.m4v': 'video/x-m4v',
  '.mkv': 'video/x-matroska',
}
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.avif'])
const THUMB_MAX = 256 * 1024

function resolveUnder(root, rel) {
  const rootR = fs.realpathSync(path.resolve(root))
  const raw = String(rel || '').replace(/\\/g, '/')
  if (raw.includes('\0') || path.isAbsolute(raw)) throw new Error('path')
  const parts = raw.split('/').filter((p) => p && p !== '.')
  if (parts.some((p) => p === '..')) throw new Error('path')
  const out = path.resolve(rootR, ...parts)
  if (out !== rootR && !out.startsWith(rootR + path.sep)) throw new Error('path')
  let current = rootR
  for (const part of parts) {
    current = path.join(current, part)
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error('path')
    } catch (err) {
      if (err.message === 'path') throw err
      if (err.code === 'ENOENT') break
      throw err
    }
  }
  return out
}

function lanIp(interfaces = os.networkInterfaces()) {
  const candidates = Object.entries(interfaces).flatMap(([name, addrs]) =>
    (addrs || [])
      .filter((a) => (a.family === 'IPv4' || a.family === 4) && !a.internal)
      .map((a) => ({ name, address: a.address })),
  )
  const wireless = candidates.find(({ name }) => /wi[\s-]?fi|wireless|wlan/i.test(name))
  if (wireless) return wireless.address

  const physical = candidates.find(({ name }) => !/vEthernet|WSL|Hyper-V|virtual/i.test(name))
  return (physical || candidates[0])?.address || '127.0.0.1'
}

function ssid() {
  try {
    if (process.platform === 'win32') {
      const out = execSync('netsh wlan show interfaces', {
        encoding: 'utf8',
        windowsHide: true,
      })
      const line = out.split(/\r?\n/).find((l) => /^\s*SSID\s*:/.test(l))
      return line ? line.split(':').slice(1).join(':').trim() : '—'
    }
    if (process.platform === 'darwin') {
      for (const dev of ['en0', 'en1']) {
        try {
          const out = execSync(`networksetup -getairportnetwork ${dev}`, {
            encoding: 'utf8',
          })
          if (out.includes('Current Wi-Fi Network:')) {
            return out.split(':').slice(1).join(':').trim()
          }
        } catch {
          /* try next */
        }
      }
    }
  } catch {
    /* offline / no wifi */
  }
  return '—'
}

function send(res, code, body, headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body)
  res.writeHead(code, {
    'content-length': buf.length,
    ...headers,
  })
  res.end(buf)
}

function sendJson(res, code, obj) {
  send(res, code, JSON.stringify(obj), {
    'content-type': 'application/json; charset=utf-8',
  })
}

function openBrowser(url) {
  const cmd =
    process.platform === 'win32'
      ? `cmd /c start "" "${url}"`
      : process.platform === 'darwin'
        ? `open "${url}"`
        : `xdg-open "${url}"`
  exec(cmd)
}

function zipLocal(name, size, time, date, flags, zip64) {
  const extra = zip64
    ? Buffer.concat([Buffer.from([0x01, 0x00, 0x10, 0x00]), Buffer.alloc(16)])
    : Buffer.alloc(0)
  const h = Buffer.alloc(30)
  h.writeUInt32LE(0x04034b50, 0)
  h.writeUInt16LE(zip64 ? 45 : 20, 4)
  h.writeUInt16LE(flags, 6)
  h.writeUInt16LE(time, 10)
  h.writeUInt16LE(date, 12)
  h.writeUInt32LE(0, 14)
  h.writeUInt32LE(zip64 ? 0xffffffff : 0, 18)
  h.writeUInt32LE(zip64 ? 0xffffffff : 0, 22)
  h.writeUInt16LE(name.length, 26)
  h.writeUInt16LE(extra.length, 28)
  return Buffer.concat([h, name, extra])
}

function u64(n) {
  const b = Buffer.alloc(8)
  b.writeBigUInt64LE(BigInt(n))
  return b
}

function zipCentral(r) {
  const zip64Size = r.size >= 0xffffffffn
  const zip64Offset = r.offset > 0xffffffffn
  const zip64Values = []
  if (zip64Size) zip64Values.push(u64(r.size), u64(r.size))
  if (zip64Offset) zip64Values.push(u64(r.offset))
  const extra = zip64Values.length
    ? Buffer.concat([
        Buffer.from([0x01, 0x00, zip64Values.length * 8, 0x00]),
        ...zip64Values,
      ])
    : Buffer.alloc(0)
  const zip64 = zip64Size || zip64Offset
  const h = Buffer.alloc(46)
  h.writeUInt32LE(0x02014b50, 0)
  h.writeUInt16LE(zip64 ? 45 : 20, 4)
  h.writeUInt16LE(zip64 ? 45 : 20, 6)
  h.writeUInt16LE(r.flags, 8)
  h.writeUInt16LE(r.time, 12)
  h.writeUInt16LE(r.date, 14)
  h.writeUInt32LE(r.crc, 16)
  h.writeUInt32LE(zip64Size ? 0xffffffff : Number(r.size), 20)
  h.writeUInt32LE(zip64Size ? 0xffffffff : Number(r.size), 24)
  h.writeUInt16LE(r.name.length, 28)
  h.writeUInt16LE(extra.length, 30)
  h.writeUInt32LE(r.dir ? 0x10 : 0, 38)
  h.writeUInt32LE(zip64Offset ? 0xffffffff : Number(r.offset), 42)
  return Buffer.concat([h, r.name, extra])
}

async function* collectZip(dir, prefix) {
  for (const e of await fs.promises.readdir(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue
    if (e.isSymbolicLink()) continue
    const rel = prefix + '/' + e.name
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      yield { rel, full, dir: true }
      yield* collectZip(full, rel)
    } else if (e.isFile()) {
      yield { rel, full, dir: false }
    }
  }
}

function dosTime(ms) {
  const d = new Date(ms)
  const year = Math.max(1980, Math.min(d.getFullYear(), 2107))
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  }
}

function writeZipChunk(res, chunk) {
  if (res.destroyed || res.writableEnded) {
    return Promise.reject(new Error('download cancelled'))
  }
  if (res.write(chunk)) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      res.off('drain', onDrain)
      res.off('error', onError)
      res.off('close', onClose)
    }
    const onDrain = () => {
      cleanup()
      resolve()
    }
    const onError = (err) => {
      cleanup()
      reject(err)
    }
    const onClose = () => {
      cleanup()
      reject(new Error('download cancelled'))
    }
    res.once('drain', onDrain)
    res.once('error', onError)
    res.once('close', onClose)
  })
}

async function zipDir(dir, res) {
  const base = path.basename(dir)
  const records = []
  let offset = 0n
  const items = (async function* () {
    yield { rel: base, full: dir, dir: true }
    yield* collectZip(dir, base)
  })()
  for await (const it of items) {
    if (res.destroyed || res.writableEnded) throw new Error('download cancelled')
    const name = Buffer.from(it.dir ? it.rel + '/' : it.rel)
    const st = await fs.promises.stat(it.full, { bigint: true })
    const { time, date } = dosTime(Number(st.mtimeMs))
    if (it.dir) {
      const loc = zipLocal(name, 0n, time, date, 0x800, false)
      await writeZipChunk(res, loc)
      records.push({ name, crc: 0, size: 0n, time, date, offset, flags: 0x800, dir: true })
      offset += BigInt(loc.length)
      continue
    }
    const zip64 = st.size >= 0xffffffffn
    const loc = zipLocal(name, st.size, time, date, 0x808, zip64)
    await writeZipChunk(res, loc)
    let crc = 0
    let size = 0n
    const rs = fs.createReadStream(it.full)
    const stopOnClose = () => rs.destroy(new Error('download cancelled'))
    res.once('close', stopOnClose)
    try {
      for await (const chunk of rs) {
        crc = crc32(chunk, crc)
        size += BigInt(chunk.length)
        await writeZipChunk(res, chunk)
      }
    } finally {
      res.off('close', stopOnClose)
    }
    const desc = Buffer.alloc(zip64 ? 24 : 16)
    desc.writeUInt32LE(0x08074b50, 0)
    desc.writeUInt32LE(crc, 4)
    if (zip64) {
      desc.writeBigUInt64LE(size, 8)
      desc.writeBigUInt64LE(size, 16)
    } else {
      desc.writeUInt32LE(Number(size), 8)
      desc.writeUInt32LE(Number(size), 12)
    }
    await writeZipChunk(res, desc)
    records.push({ name, crc, size, time, date, offset, flags: 0x808, dir: false })
    offset += BigInt(loc.length) + size + BigInt(desc.length)
  }
  const cdStart = offset
  let cdSize = 0n
  for (const r of records) {
    const cen = zipCentral(r)
    await writeZipChunk(res, cen)
    cdSize += BigInt(cen.length)
  }
  if (cdStart > 0xffffffffn || cdSize > 0xffffffffn || records.length > 65535) {
    const eocd64 = Buffer.alloc(56)
    eocd64.writeUInt32LE(0x06064b50, 0)
    eocd64.writeBigUInt64LE(44n, 4)
    eocd64.writeUInt16LE(45, 12)
    eocd64.writeUInt16LE(45, 14)
    eocd64.writeBigUInt64LE(BigInt(records.length), 24)
    eocd64.writeBigUInt64LE(BigInt(records.length), 32)
    eocd64.writeBigUInt64LE(cdSize, 40)
    eocd64.writeBigUInt64LE(cdStart, 48)
    await writeZipChunk(res, eocd64)
    const loc = Buffer.alloc(20)
    loc.writeUInt32LE(0x07064b50, 0)
    loc.writeBigUInt64LE(cdStart + cdSize, 8)
    loc.writeUInt32LE(1, 16)
    await writeZipChunk(res, loc)
  }
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(Math.min(records.length, 0xffff), 8)
  eocd.writeUInt16LE(Math.min(records.length, 0xffff), 10)
  eocd.writeUInt32LE(Number(cdSize > 0xffffffffn ? 0xffffffffn : cdSize), 12)
  eocd.writeUInt32LE(Number(cdStart > 0xffffffffn ? 0xffffffffn : cdStart), 16)
  res.end(eocd)
}

function u16(buf, o, le) {
  return le ? buf.readUInt16LE(o) : buf.readUInt16BE(o)
}

function u32(buf, o, le) {
  return le ? buf.readUInt32LE(o) : buf.readUInt32BE(o)
}

function exifThumbFromIfd(seg, tiff, ifd, le) {
  if (ifd < 0 || ifd + 2 > seg.length) return null
  const n = u16(seg, ifd, le)
  if (ifd + 2 + n * 12 + 4 > seg.length) return null
  let off = 0
  let len = 0
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12
    const tag = u16(seg, e, le)
    if (tag === 0x0201) off = u32(seg, e + 8, le)
    else if (tag === 0x0202) len = u32(seg, e + 8, le)
  }
  if (!off || !len) return null
  const start = tiff + off
  if (start < 0 || start + len > seg.length) return null
  const thumb = seg.subarray(start, start + len)
  if (thumb.length < 2 || thumb[0] !== 0xff || thumb[1] !== 0xd8) return null
  return Buffer.from(thumb)
}

function parseExifThumb(seg) {
  if (seg.length < 16 || seg.toString('latin1', 0, 4) !== 'Exif') return null
  const tiff = 6
  const le = seg[tiff] === 0x49
  if (!le && seg[tiff] !== 0x4d) return null
  const ifd0 = tiff + u32(seg, tiff + 4, le)
  const from0 = exifThumbFromIfd(seg, tiff, ifd0, le)
  if (from0) return from0
  if (ifd0 + 2 > seg.length) return null
  const n0 = u16(seg, ifd0, le)
  const nextPtr = ifd0 + 2 + n0 * 12
  if (nextPtr + 4 > seg.length) return null
  const ifd1off = u32(seg, nextPtr, le)
  return ifd1off ? exifThumbFromIfd(seg, tiff, tiff + ifd1off, le) : null
}

function parseMpfEntry(seg) {
  if (seg.length < 16 || seg.toString('latin1', 0, 4) !== 'MPF\0') return null
  const tiff = 4
  const le = seg[tiff] === 0x49
  if (!le && seg[tiff] !== 0x4d) return null
  const ifd = tiff + u32(seg, tiff + 4, le)
  if (ifd + 2 > seg.length) return null
  const n = u16(seg, ifd, le)
  if (ifd + 2 + n * 12 + 4 > seg.length) return null
  let num = 0
  let ents = 0
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12
    const tag = u16(seg, e, le)
    if (tag === 0xb001) num = u32(seg, e + 8, le)
    if (tag === 0xb002) ents = tiff + u32(seg, e + 8, le)
  }
  if (num < 2 || ents + num * 16 > seg.length) return null
  let best = null
  for (let i = 0; i < num; i++) {
    const e = ents + i * 16
    const size = u32(seg, e + 4, le)
    const off = u32(seg, e + 8, le)
    if (!off || !size) continue
    if (!best || size < best.size) best = { off, size }
  }
  return best
}

function imageThumb(file) {
  const fd = fs.openSync(file, 'r')
  try {
    const size = fs.fstatSync(fd).size
    if (size < 4) return null
    const head = Buffer.alloc(Math.min(256 * 1024, size))
    const n = fs.readSync(fd, head, 0, head.length, 0)
    if (head[0] !== 0xff || head[1] !== 0xd8) return null
    let mpf = null
    let i = 2
    while (i + 4 <= n) {
      if (head[i] !== 0xff) break
      const marker = head[i + 1]
      if (marker === 0xda || marker === 0xd9) break
      const len = head.readUInt16BE(i + 2)
      if (len < 2 || i + 2 + len > n) break
      const seg = head.subarray(i + 4, i + 2 + len)
      if (marker === 0xe1) {
        const thumb = parseExifThumb(seg)
        if (thumb) return thumb
      } else if (marker === 0xe2 && !mpf) {
        mpf = parseMpfEntry(seg)
        if (mpf) mpf.off += i + 8
      }
      i += 2 + len
    }
    if (mpf && mpf.size <= 2 * 1024 * 1024 && mpf.off + mpf.size <= size) {
      const buf = Buffer.alloc(mpf.size)
      fs.readSync(fd, buf, 0, mpf.size, mpf.off)
      if (buf[0] === 0xff && buf[1] === 0xd8) return buf
    }
    return null
  } catch {
    return null
  } finally {
    fs.closeSync(fd)
  }
}

function pipeFile(req, res, file, type, headers = {}) {
  const size = fs.statSync(file).size
  const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '')
  if (m) {
    const start = +m[1]
    const end = m[2] ? Math.min(+m[2], size - 1) : size - 1
    if (start >= size || start > end) {
      res.writeHead(416, { 'content-range': `bytes */${size}` })
      res.end()
      return
    }
    res.writeHead(206, {
      'content-type': type,
      'content-length': end - start + 1,
      'content-range': `bytes ${start}-${end}/${size}`,
      'accept-ranges': 'bytes',
      ...headers,
    })
    fs.createReadStream(file, { start, end }).pipe(res)
    return
  }
  res.writeHead(200, {
    'content-type': type,
    'content-length': size,
    'accept-ranges': 'bytes',
    ...headers,
  })
  fs.createReadStream(file).pipe(res)
}

function listDir(root, rel) {
  const dir = resolveUnder(root, rel)
  if (!fs.statSync(dir).isDirectory()) throw new Error('not dir')
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => !e.name.startsWith('.'))
    .map((e) => {
      const st = fs.statSync(path.join(dir, e.name))
      return {
        name: e.name,
        dir: e.isDirectory(),
        size: st.size,
        mtime: st.mtimeMs,
      }
    })
    .sort((a, b) => b.dir - a.dir || a.name.localeCompare(b.name, 'zh'))
}

function makeServer(root) {
  const indexFile = path.join(__dirname, 'index.html')
  return http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x')
    try {
      if (req.method === 'GET' && u.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        fs.createReadStream(indexFile).pipe(res)
        return
      }
      if (req.method === 'GET' && u.pathname === '/api/status') {
        sendJson(res, 200, {
          ssid: ssid(),
          ip: lanIp(),
          port: PORT,
          folder: root,
        })
        return
      }
      if (req.method === 'GET' && u.pathname === '/api/list') {
        sendJson(res, 200, { path: u.searchParams.get('path') || '', items: listDir(root, u.searchParams.get('path')) })
        return
      }
      if (req.method === 'GET' && u.pathname === '/view') {
        const p = resolveUnder(root, u.searchParams.get('path'))
        const st = fs.statSync(p)
        if (!st.isFile()) throw new Error('path')
        pipeFile(req, res, p, MIME[path.extname(p).toLowerCase()] || 'application/octet-stream')
        return
      }
      // ponytail: EXIF/MPF embedded thumbs only. sharp if PNG/HEIC need decode.
      if (req.method === 'GET' && u.pathname === '/thumb') {
        const p = resolveUnder(root, u.searchParams.get('path'))
        const st = fs.statSync(p)
        if (!st.isFile()) throw new Error('path')
        const ext = path.extname(p).toLowerCase()
        if (!IMAGE_EXT.has(ext)) {
          send(res, 404, '')
          return
        }
        if (ext === '.jpg' || ext === '.jpeg') {
          const thumb = imageThumb(p)
          if (thumb) {
            send(res, 200, thumb, {
              'content-type': 'image/jpeg',
              'cache-control': 'private, max-age=86400',
            })
            return
          }
        }
        if (st.size <= THUMB_MAX) {
          res.writeHead(200, {
            'content-type': MIME[ext],
            'content-length': st.size,
            'cache-control': 'private, max-age=86400',
          })
          fs.createReadStream(p).pipe(res)
          return
        }
        send(res, 404, '')
        return
      }
      if (req.method === 'GET' && u.pathname === '/dl') {
        const p = resolveUnder(root, u.searchParams.get('path'))
        const st = fs.statSync(p)
        if (st.isDirectory()) {
          const name = (path.basename(p) || 'folder') + '.zip'
          res.writeHead(200, {
            'content-type': 'application/zip',
            'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
          })
          zipDir(p, res).catch((err) => {
            if (!res.destroyed) console.error('[download] ZIP creation failed:', err)
            if (!res.writableEnded) res.destroy()
          })
          return
        }
        const name = path.basename(p)
        pipeFile(req, res, p, 'application/octet-stream', {
          'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
        })
        return
      }
      if (req.method === 'POST' && u.pathname === '/up') {
        const name = path.basename(u.searchParams.get('name') || '')
        if (!name || name === '.' || name === '..') {
          sendJson(res, 400, { error: 'name' })
          return
        }
        const relativeDir = u.searchParams.get('path') || ''
        const { name: stem, ext } = path.parse(name)
        let suffix = 0
        let ws
        while (!ws) {
          const fileName = suffix ? `${stem} (${suffix})${ext}` : name
          const dest = resolveUnder(root, path.posix.join(relativeDir, fileName))
          try {
            const fd = fs.openSync(dest, 'wx')
            ws = fs.createWriteStream(dest, { fd })
          } catch (err) {
            if (err.code !== 'EEXIST') throw err
            suffix++
          }
        }
        req.pipe(ws)
        ws.on('finish', () => sendJson(res, 200, { ok: true }))
        ws.on('error', () => sendJson(res, 500, { error: 'write' }))
        return
      }
      send(res, 404, 'not found', { 'content-type': 'text/plain' })
    } catch (err) {
      const code = err.message === 'path' || err.code === 'ENOENT' ? 400 : 500
      sendJson(res, code, { error: err.message || 'fail' })
    }
  })
}

function main() {
  const root = path.resolve(process.argv[2] || path.join(__dirname, 'shared'))
  fs.mkdirSync(root, { recursive: true })
  const server = makeServer(root)
  server.listen(PORT, '0.0.0.0', () => {
    const url = `http://${lanIp()}:${PORT}`
    console.log(url)
    console.log(`Wi-Fi: ${ssid()}`)
    console.log(root)
    console.log('If others cannot open: allow inbound TCP ' + PORT + ' in the firewall')
    openBrowser(`http://127.0.0.1:${PORT}`)
  })
}

module.exports = { resolveUnder, makeServer, lanIp }

if (require.main === module) main()
