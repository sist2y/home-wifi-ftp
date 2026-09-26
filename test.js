const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')
const { resolveUnder, makeServer } = require('./server')

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wifi-ftp-'))
fs.writeFileSync(path.join(root, 'a.txt'), 'x')
fs.mkdirSync(path.join(root, 'sub'))
fs.writeFileSync(path.join(root, 'sub', 'a.txt'), 'hello')

const ok = ['', 'a.txt', 'sub/file']
const bad = ['../x', '..\\x', '/etc/passwd', 'C:\\Windows', 'a/../../b', 'foo\0bar']

for (const rel of ok) {
  resolveUnder(root, rel)
}
for (const rel of bad) {
  let threw = false
  try {
    resolveUnder(root, rel)
  } catch {
    threw = true
  }
  if (!threw) {
    console.error('should reject', rel)
    process.exit(1)
  }
}

const server = makeServer(root)
server.listen(0, '127.0.0.1', () => {
  const port = server.address().port
  http.get(`http://127.0.0.1:${port}/dl?path=sub`, (res) => {
    const chunks = []
    res.on('data', (c) => chunks.push(c))
    res.on('end', () => {
      server.close()
      const buf = Buffer.concat(chunks)
      if (buf.slice(0, 2).toString() !== 'PK') {
        console.error('not zip')
        process.exit(1)
      }
      if (!buf.includes(Buffer.from('sub/a.txt'))) {
        console.error('missing file')
        process.exit(1)
      }
      if (res.headers['content-type'] !== 'application/zip') {
        console.error('bad type')
        process.exit(1)
      }
      console.log('ok')
    })
  }).on('error', (err) => {
    server.close()
    console.error(err)
    process.exit(1)
  })
})
