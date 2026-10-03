const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')
const assert = require('assert/strict')
const { resolveUnder, makeServer } = require('./server')

const ok = ['', 'a.txt', 'sub/file']
const bad = ['../x', '..\\x', '/etc/passwd', 'C:\\Windows', 'a/../../b', 'foo\0bar']

function request(port, method, route, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method, path: route }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }))
    })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

function readZipEntry(zip, entryName) {
  let eocd = -1
  for (let offset = zip.length - 22; offset >= 0; offset--) {
    if (zip.readUInt32LE(offset) === 0x06054b50) {
      eocd = offset
      break
    }
  }
  assert.notEqual(eocd, -1, 'ZIP end record missing')

  const entryCount = zip.readUInt16LE(eocd + 10)
  let offset = zip.readUInt32LE(eocd + 16)
  for (let i = 0; i < entryCount; i++) {
    assert.equal(zip.readUInt32LE(offset), 0x02014b50, 'ZIP central entry missing')
    const size = zip.readUInt32LE(offset + 24)
    const nameLength = zip.readUInt16LE(offset + 28)
    const extraLength = zip.readUInt16LE(offset + 30)
    const commentLength = zip.readUInt16LE(offset + 32)
    const localOffset = zip.readUInt32LE(offset + 42)
    const name = zip.subarray(offset + 46, offset + 46 + nameLength).toString('utf8')
    if (name === entryName) {
      assert.equal(zip.readUInt16LE(offset + 10), 0, 'expected stored ZIP entry')
      assert.equal(zip.readUInt32LE(localOffset), 0x04034b50, 'ZIP local entry missing')
      const localNameLength = zip.readUInt16LE(localOffset + 26)
      const localExtraLength = zip.readUInt16LE(localOffset + 28)
      const dataOffset = localOffset + 30 + localNameLength + localExtraLength
      return zip.subarray(dataOffset, dataOffset + size)
    }
    offset += 46 + nameLength + extraLength + commentLength
  }
  assert.fail(`ZIP entry not found: ${entryName}`)
}

async function main() {
  const fixtureBase = process.platform === 'win32' ? 'D:\\home-wifi-ftp' : os.tmpdir()
  fs.mkdirSync(fixtureBase, { recursive: true })
  const root = fs.mkdtempSync(path.join(fixtureBase, 'wifi-ftp-'))
  let outside
  let server
  try {
    const testFilePath = path.join(root, 'test.txt')
    const testFile = Buffer.from('download fixture: verified')
    fs.writeFileSync(testFilePath, testFile)
    const testDir = fs.mkdtempSync(path.join(root, 'wifi-ftp-case-'))
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'wifi-ftp-outside-'))
    fs.mkdirSync(path.join(testDir, 'sub'))
    fs.writeFileSync(path.join(testDir, 'sub', 'a.txt'), 'hello')
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside data')
    fs.symlinkSync(outside, path.join(testDir, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
    console.log('[test] temporary fixtures created')

    for (const rel of ok) resolveUnder(root, rel)
    for (const rel of bad) {
      assert.throws(() => resolveUnder(root, rel), undefined, `should reject ${rel}`)
    }
    console.log('[test] path validation passed')

    server = makeServer(root)
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = server.address().port

    const download = await request(port, 'GET', '/dl?path=test.txt')
    assert.equal(download.status, 200)
    assert.deepEqual(download.body, testFile)
    assert.match(download.headers['content-disposition'], /test\.txt/)
    console.log('[test] file download passed')

    const relativeTestDir = path.basename(testDir)
    const folderDownload = await request(port, 'GET', `/dl?path=${relativeTestDir}`)
    assert.equal(folderDownload.status, 200)
    assert.equal(folderDownload.headers['content-type'], 'application/zip')
    assert.match(folderDownload.headers['content-disposition'], new RegExp(`${relativeTestDir}\\.zip`))
    assert.deepEqual(readZipEntry(folderDownload.body, `${relativeTestDir}/sub/a.txt`), Buffer.from('hello'))

    const zipDownload = await request(port, 'GET', `/dl?path=${relativeTestDir}/sub`)
    assert.equal(zipDownload.status, 200)
    assert.equal(zipDownload.headers['content-type'], 'application/zip')
    assert.match(zipDownload.headers['content-disposition'], /sub\.zip/)
    assert.deepEqual(readZipEntry(zipDownload.body, 'sub/a.txt'), Buffer.from('hello'))
    console.log('[test] folder and ZIP downloads passed')

    const uploadFile = Buffer.from([0, 1, 2, 255, 10])
    const upload = await request(port, 'POST', `/up?path=${relativeTestDir}/sub&name=uploaded.bin`, uploadFile)
    assert.equal(upload.status, 200)
    assert.deepEqual(JSON.parse(upload.body.toString()), { ok: true })
    assert.deepEqual(fs.readFileSync(path.join(testDir, 'sub', 'uploaded.bin')), uploadFile)
    console.log('[test] file upload passed')

    const escapedDownload = await request(port, 'GET', `/dl?path=${relativeTestDir}/escape/secret.txt`)
    assert.equal(escapedDownload.status, 400)
    const escapedUpload = await request(port, 'POST', `/up?path=${relativeTestDir}/escape&name=secret.txt`, Buffer.from('overwrite'))
    assert.equal(escapedUpload.status, 400)
    assert.equal(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'), 'outside data')
    console.log('[test] symlink protection passed')
  } finally {
    if (server?.listening) await new Promise((resolve) => server.close(resolve))
    fs.rmSync(root, { recursive: true, force: true })
    if (outside) fs.rmSync(outside, { recursive: true, force: true })
    console.log('[test] temporary fixtures removed')
  }
  console.log('[test] all tests passed')
}

main().catch((err) => {
  console.error('[test] failed:', err)
  process.exitCode = 1
})
