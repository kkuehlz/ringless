require('dotenv').config({path: __dirname + '/../.env'})
const express = require('express')
const path = require('path')
const fsp = require('fs/promises')

const PORT = process.env.PORT || 3000
const CAPTURE_ROOT = path.resolve(process.env.CAPTURE_OUTPUT_DIRECTORY || path.join(__dirname, 'captures'))

async function getFiles(dir) {
  const dirents = await fsp.readdir(dir, { withFileTypes: true });
  const files = await Promise.all(dirents.map((dirent) => {
    const res = path.resolve(dir, dirent.name)
    return dirent.isDirectory() ? getFiles(res) : res
  }))
  return Array.prototype.concat(...files)
}

const app = express()

app.use('/captures', express.static(CAPTURE_ROOT))
app.get('/', (request, response) => {
  response.sendFile(path.join(__dirname, 'index.html'));
})

app.get('/get-captures', async (request, response) => {
  const files = await getFiles(CAPTURE_ROOT)
  response.json(files.map((file) => { return file.split('/').slice(-3).join('/') }))
})

app.listen(PORT, 'localhost', () => {
  console.log(`Serving files from : ${CAPTURE_ROOT}`)
  console.log(`Listening on port  : ${PORT}`)
})
