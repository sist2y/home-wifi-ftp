const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')
const assert = require('assert/strict')
const { resolveUnder, makeServer } = require('./server')

const ok = ['', 'a.txt', 'sub/file']
const bad = ['../x', '..\\x', '/etc/passwd', 'C:\\Windows', 'a/../../b', 'foo\0bar']

function request(port, method, route, body, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method, path: route, headers }, (res) => {
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

function jpegWithExifThumb(thumb) {
  const tiff = Buffer.alloc(44)
  tiff.write('II')
  tiff.writeUInt16LE(42, 2)
  tiff.writeUInt32LE(8, 4)
  tiff.writeUInt16LE(0, 8)
  tiff.writeUInt32LE(14, 10)
  tiff.writeUInt16LE(2, 14)
  tiff.writeUInt16LE(0x0201, 16)
  tiff.writeUInt16LE(4, 18)
  tiff.writeUInt32LE(1, 20)
  tiff.writeUInt32LE(44, 24)
  tiff.writeUInt16LE(0x0202, 28)
  tiff.writeUInt16LE(4, 30)
  tiff.writeUInt32LE(1, 32)
  tiff.writeUInt32LE(thumb.length, 36)
  tiff.writeUInt32LE(0, 40)
  const payload = Buffer.concat([Buffer.from('Exif\0\0'), tiff, thumb])
  const app1 = Buffer.alloc(4 + payload.length)
  app1[0] = 0xff
  app1[1] = 0xe1
  app1.writeUInt16BE(payload.length + 2, 2)
  payload.copy(app1, 4)
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, Buffer.from([0xff, 0xd9])])
}

function jpegWithMpfThumb(thumb) {
  const tiff = Buffer.alloc(70)
  tiff.write('II')
  tiff.writeUInt16LE(42, 2)
  tiff.writeUInt32LE(8, 4)
  tiff.writeUInt16LE(2, 8)
  tiff.writeUInt16LE(0xb001, 10)
  tiff.writeUInt16LE(4, 12)
  tiff.writeUInt32LE(1, 14)
  tiff.writeUInt32LE(2, 18)
  tiff.writeUInt16LE(0xb002, 22)
  tiff.writeUInt16LE(7, 24)
  tiff.writeUInt32LE(32, 26)
  tiff.writeUInt32LE(38, 30)
  tiff.writeUInt32LE(0, 34)
  tiff.writeUInt32LE(0x010001, 54)
  tiff.writeUInt32LE(thumb.length, 58)
  const headLen = 2 + 4 + 4 + 70 + 2
  tiff.writeUInt32LE(headLen - 10, 62)
  const payload = Buffer.concat([Buffer.from('MPF\0'), tiff])
  const app2 = Buffer.alloc(4 + payload.length)
  app2[0] = 0xff
  app2[1] = 0xe2
  app2.writeUInt16BE(payload.length + 2, 2)
  payload.copy(app2, 4)
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app2, Buffer.from([0xff, 0xd9]), thumb])
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

    const duplicateUpload = Buffer.from('second upload')
    const duplicate = await request(port, 'POST', `/up?path=${relativeTestDir}/sub&name=uploaded.bin`, duplicateUpload)
    assert.equal(duplicate.status, 200)
    assert.deepEqual(fs.readFileSync(path.join(testDir, 'sub', 'uploaded.bin')), uploadFile)
    assert.deepEqual(fs.readFileSync(path.join(testDir, 'sub', 'uploaded (1).bin')), duplicateUpload)

    const thirdUpload = Buffer.from('third upload')
    const thirdDuplicate = await request(port, 'POST', `/up?path=${relativeTestDir}/sub&name=uploaded.bin`, thirdUpload)
    assert.equal(thirdDuplicate.status, 200)
    assert.deepEqual(fs.readFileSync(path.join(testDir, 'sub', 'uploaded (2).bin')), thirdUpload)
    console.log('[test] file upload passed')

    const tinyJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9])
    const innerThumb = Buffer.from([0xff, 0xd8, 0x00, 0x01, 0xff, 0xd9])
    const exifJpeg = jpegWithExifThumb(innerThumb)
    fs.writeFileSync(path.join(root, 'photo.jpg'), exifJpeg)
    fs.writeFileSync(path.join(root, 'plain.jpg'), tinyJpeg)
    fs.writeFileSync(path.join(root, 'note.txt'), 'nope')
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    )
    fs.writeFileSync(path.join(root, 'dot.png'), png)

    const thumbExif = await request(port, 'GET', '/thumb?path=photo.jpg')
    assert.equal(thumbExif.status, 200)
    assert.equal(thumbExif.headers['content-type'], 'image/jpeg')
    assert.deepEqual(thumbExif.body, innerThumb)

    const thumbPlain = await request(port, 'GET', '/thumb?path=plain.jpg')
    assert.equal(thumbPlain.status, 200)
    assert.deepEqual(thumbPlain.body, tinyJpeg)

    const thumbPng = await request(port, 'GET', '/thumb?path=dot.png')
    assert.equal(thumbPng.status, 200)
    assert.equal(thumbPng.headers['content-type'], 'image/png')
    assert.deepEqual(thumbPng.body, png)

    const bigNoExif = Buffer.alloc(256 * 1024 + 1)
    bigNoExif[0] = 0xff
    bigNoExif[1] = 0xd8
    fs.writeFileSync(path.join(root, 'huge.jpg'), bigNoExif)
    const thumbHuge = await request(port, 'GET', '/thumb?path=huge.jpg')
    assert.equal(thumbHuge.status, 404)

    fs.writeFileSync(path.join(root, 'huge-exif.jpg'), Buffer.concat([exifJpeg, Buffer.alloc(256 * 1024)]))
    const thumbHugeExif = await request(port, 'GET', '/thumb?path=huge-exif.jpg')
    assert.equal(thumbHugeExif.status, 200)
    assert.deepEqual(thumbHugeExif.body, innerThumb)

    fs.writeFileSync(path.join(root, 'mpf.jpg'), jpegWithMpfThumb(innerThumb))
    const thumbMpf = await request(port, 'GET', '/thumb?path=mpf.jpg')
    assert.equal(thumbMpf.status, 200)
    assert.deepEqual(thumbMpf.body, innerThumb)

    const thumbTxt = await request(port, 'GET', '/thumb?path=note.txt')
    assert.equal(thumbTxt.status, 404)
    const thumbEscape = await request(port, 'GET', `/thumb?path=${relativeTestDir}/escape/secret.txt`)
    assert.equal(thumbEscape.status, 400)

    const viewJpeg = await request(port, 'GET', '/view?path=photo.jpg')
    assert.equal(viewJpeg.status, 200)
    assert.equal(viewJpeg.headers['content-type'], 'image/jpeg')
    assert.deepEqual(viewJpeg.body, exifJpeg)

    const ranged = await request(port, 'GET', '/view?path=photo.jpg', null, { range: 'bytes=0-3' })
    assert.equal(ranged.status, 206)
    assert.equal(ranged.headers['content-range'], `bytes 0-3/${exifJpeg.length}`)
    assert.deepEqual(ranged.body, exifJpeg.subarray(0, 4))

    const viewEscape = await request(port, 'GET', `/view?path=${relativeTestDir}/escape/secret.txt`)
    assert.equal(viewEscape.status, 400)
    console.log('[test] thumb and view passed')

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
