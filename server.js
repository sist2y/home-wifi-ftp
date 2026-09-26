const http = require('http')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { exec, execSync } = require('child_process')

const PORT = 8787

function resolveUnder(root, rel) {
  const rootR = path.resolve(root)
  const raw = String(rel || '').replace(/\\/g, '/')
  if (raw.includes('\0') || path.isAbsolute(raw)) throw new Error('path')
  const parts = raw.split('/').filter((p) => p && p !== '.')
  if (parts.some((p) => p === '..')) throw new Error('path')
  const out = path.resolve(rootR, ...parts)
  if (out !== rootR && !out.startsWith(rootR + path.sep)) throw new Error('path')
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
          sendJson(res, 400, { error: 'dir' })
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
