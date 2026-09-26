const fs = require('fs')
const os = require('os')
const path = require('path')
const { resolveUnder } = require('./server')

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wifi-ftp-'))
fs.writeFileSync(path.join(root, 'a.txt'), 'x')

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
console.log('ok')
