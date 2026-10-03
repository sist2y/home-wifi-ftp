const http = require('http')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { exec, execSync } = require('child_process')

const PORT = 8787

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

function lanIp() {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      const v4 = a.family === 'IPv4' || a.family === 4
      if (v4 && !a.internal) return a.address
    }
  }
  return '127.0.0.1'
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

const CRC_TABLE = new Uint32Array(256)
for (let i = 0; i < 256; i++) {
  let c = i
  for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  CRC_TABLE[i] = c
}

function crc32(buf, crc = 0) {
  crc ^= 0xffffffff
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 255] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function zipLocal(name, crc, size, time, date, flags) {
  const h = Buffer.alloc(30)
  h.writeUInt32LE(0x04034b50, 0)
  h.writeUInt16LE(20, 4)
  h.writeUInt16LE(flags, 6)
  h.writeUInt16LE(time, 10)
  h.writeUInt16LE(date, 12)
  h.writeUInt32LE(crc, 14)
  h.writeUInt32LE(size, 18)
  h.writeUInt32LE(size, 22)
  h.writeUInt16LE(name.length, 26)
  return Buffer.concat([h, name])
}

function zipCentral(r) {
  const h = Buffer.alloc(46)
  h.writeUInt32LE(0x02014b50, 0)
  h.writeUInt16LE(20, 4)
  h.writeUInt16LE(20, 6)
  h.writeUInt16LE(r.flags, 8)
  h.writeUInt16LE(r.time, 12)
  h.writeUInt16LE(r.date, 14)
  h.writeUInt32LE(r.crc, 16)
  h.writeUInt32LE(r.size, 20)
  h.writeUInt32LE(r.size, 24)
  h.writeUInt16LE(r.name.length, 28)
  h.writeUInt32LE(r.dir ? 0x10 : 0, 38)
  h.writeUInt32LE(r.offset, 42)
  return Buffer.concat([h, r.name])
}

function collectZip(dir, prefix, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue
    const rel = prefix + '/' + e.name
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      out.push({ rel, full, dir: true })
      collectZip(full, rel, out)
    } else if (e.isFile()) {
      out.push({ rel, full, dir: false })
    }
  }
}

function dosTime(ms) {
  const d = new Date(ms)
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  }
}

// ponytail: STORE zip, no zip64. Split if a file >4GB.
async function zipDir(dir, res) {
  const base = path.basename(dir)
  const items = [{ rel: base, full: dir, dir: true }]
  collectZip(dir, base, items)
  const records = []
  let offset = 0
  for (const it of items) {
    const name = Buffer.from(it.dir ? it.rel + '/' : it.rel)
    const { time, date } = dosTime(fs.statSync(it.full).mtimeMs)
    if (it.dir) {
      const loc = zipLocal(name, 0, 0, time, date, 0x800)
      res.write(loc)
      records.push({ name, crc: 0, size: 0, time, date, offset, flags: 0x800, dir: true })
      offset += loc.length
      continue
    }
    const loc = zipLocal(name, 0, 0, time, date, 0x808)
    res.write(loc)
    let crc = 0
    let size = 0
    await new Promise((resolve, reject) => {
      const rs = fs.createReadStream(it.full)
      const onDrain = () => rs.resume()
      res.on('drain', onDrain)
      rs.on('data', (c) => {
        crc = crc32(c, crc)
        size += c.length
        if (!res.write(c)) rs.pause()
      })
      rs.on('end', () => {
        res.off('drain', onDrain)
        resolve()
      })
      rs.on('error', (e) => {
        res.off('drain', onDrain)
        reject(e)
      })
    })
    const desc = Buffer.alloc(16)
    desc.writeUInt32LE(0x08074b50, 0)
    desc.writeUInt32LE(crc, 4)
    desc.writeUInt32LE(size, 8)
    desc.writeUInt32LE(size, 12)
    res.write(desc)
    records.push({ name, crc, size, time, date, offset, flags: 0x808, dir: false })
    offset += loc.length + size + 16
  }
  const cdStart = offset
  let cdSize = 0
  for (const r of records) {
    const cen = zipCentral(r)
    res.write(cen)
    cdSize += cen.length
  }
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(records.length, 8)
  eocd.writeUInt16LE(records.length, 10)
  eocd.writeUInt32LE(cdSize, 12)
  eocd.writeUInt32LE(cdStart, 16)
  res.end(eocd)
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
      if (req.method === 'GET' && u.pathname === '/dl') {
        const p = resolveUnder(root, u.searchParams.get('path'))
        const st = fs.statSync(p)
        if (st.isDirectory()) {
          const name = (path.basename(p) || 'folder') + '.zip'
          res.writeHead(200, {
            'content-type': 'application/zip',
            'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
          })
          zipDir(p, res).catch(() => {
            if (!res.writableEnded) res.destroy()
          })
          return
        }
        const name = path.basename(p)
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': st.size,
          'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
        })
        fs.createReadStream(p).pipe(res)
        return
      }
      if (req.method === 'POST' && u.pathname === '/up') {
        const name = path.basename(u.searchParams.get('name') || '')
        if (!name || name === '.' || name === '..') {
          sendJson(res, 400, { error: 'name' })
          return
        }
        const dest = resolveUnder(root, path.posix.join(u.searchParams.get('path') || '', name))
        const ws = fs.createWriteStream(dest)
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

module.exports = { resolveUnder, makeServer }

if (require.main === module) main()
