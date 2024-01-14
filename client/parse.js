const assert = require('assert')
const { spawn } = require('child_process')
const { Buffer } = require('node:buffer')
const { BufferList } = require('bl')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { createBoundedImage } = require('./detect')

const runOnAppTermination = (callback) => {
  const exitHandler = (options, exitCode) => {
    callback(exitCode)
    if (options.exit) {
      process.exit();
    }
  }

  // process runs to completion
  process.on('exit', exitHandler.bind(null,{cleanup:true}));

  // catches ctrl+c event
  process.on('SIGINT', exitHandler.bind(null, {exit:true}));

  // catches "kill pid" (for example: nodemon restart)
  process.on('SIGUSR1', exitHandler.bind(null, {exit:true}));
  process.on('SIGUSR2', exitHandler.bind(null, {exit:true}));

  // catches uncaught exceptions
  process.on('uncaughtException', exitHandler.bind(null, {exit:true}));
}

const PngStreamState = {
  IMAGE_START: 0,
  READING_CHUNK_METADATA: 1,
  READING_CHUNK_DATA: 2,
  IMAGE_END: 3,
}
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])

class LegacyPngStreamParser {
  constructor() {
    this.buf = Buffer.alloc(0)
    this._resetStateMachine()
  }

  addData(data) {
    this.buf = Buffer.concat([this.buf, data])
    let outputImages = []

    let currentState, currentOffset
    do {
        currentState = this.state
        currentOffset = this.offset

        switch (this.state) {
          case PngStreamState.IMAGE_START:
            this._processImageStart()
            break
          case PngStreamState.READING_CHUNK_METADATA:
            this._processChunkMetadata()
            break
          case PngStreamState.READING_CHUNK_DATA:
            this._processChunkData()
            break
          case PngStreamState.IMAGE_END:
            outputImages.push(this._finalizeImage())
            break
        }
    } while(currentState !== this.state || currentOffset !== this.offset)
    return outputImages
  }

  _resetStateMachine() {
    this.offset = 0
    this.state = PngStreamState.IMAGE_START
    this.currentChunkLength = 0
    this.currentChunkIsEnd = false
    this.processedPNG = null
  }

  _processImageStart() {
    if (this.buf.length - this.offset >= 8) {
      assert (this.buf.subarray(this.offset, this.offset + 8).equals(PNG_SIGNATURE), "Bad PNG signature")
      this.state = PngStreamState.READING_CHUNK_METADATA
      this.offset += 8
    }
  }

  _processChunkMetadata() {
    const IEND_CHUNK_TYPE = 0x49454E44
    if (this.buf.length - this.offset >= 8) {
      this.currentChunkLength = this.buf.readUint32BE(this.offset)    // length is first 4 bytes
      this.currentChunkIsEnd = (this.buf.readUInt32BE(this.offset + 4) == IEND_CHUNK_TYPE)
      this.state = PngStreamState.READING_CHUNK_DATA
      this.offset += 8
    }
  }

  _processChunkData() {
    // wait until we have total length + crc
    if (this.buf.length - this.offset >= this.currentChunkLength + 4) {
      this.state = this.currentChunkIsEnd ? PngStreamState.IMAGE_END : PngStreamState.READING_CHUNK_METADATA
      this.offset += this.currentChunkLength + 4
    }
  }

  _finalizeImage() {
    const finalImage = Buffer.from(this.buf.subarray(0, this.offset))
    this.buf = Buffer.from(this.buf.subarray(this.offset))
    this._resetStateMachine()
    return finalImage
  }
}

class PngStreamUnpacker {
  constructor() {
    this.buf = new BufferList()
    this._resetStateMachine()
  }

  addData(data) {
    this.buf.append(data)
    let outputImages = []

    let currentState, currentOffset
    do {
        currentState = this.state
        currentOffset = this.offset

        switch (this.state) {
          case PngStreamState.IMAGE_START:
            this._processImageStart()
            break
          case PngStreamState.READING_CHUNK_METADATA:
            this._processChunkMetadata()
            break
          case PngStreamState.READING_CHUNK_DATA:
            this._processChunkData()
            break
          case PngStreamState.IMAGE_END:
            outputImages.push(this._finalizeImage())
            break
        }
    } while(currentState !== this.state || currentOffset !== this.offset)
    return outputImages
  }

  _ptr() {
    return this.buf.shallowSlice(this.offset)
  }

  _consume(numBytes) {
    this.offset += numBytes
  }

  _resetStateMachine() {
    this.offset = 0
    this.state = PngStreamState.IMAGE_START
    this.currentChunkLength = 0
    this.currentChunkIsEnd = false
    this.processedPNG = null
  }

  _processImageStart() {
    if (this._ptr().length >= 8) {
      assert (PNG_SIGNATURE.equals(this._ptr().slice(0, 8)), "Bad PNG signature")
      this.state = PngStreamState.READING_CHUNK_METADATA
      this._consume(8)
    }
  }

  _processChunkMetadata() {
    const IEND_CHUNK_TYPE = 0x49454E44
    if (this._ptr().length >= 8) {
      // parse [length, chunk_type]
      this.currentChunkLength = this._ptr().readUInt32BE()
      this._consume(4)
      this.currentChunkIsEnd = (this._ptr().readUInt32BE() == IEND_CHUNK_TYPE)
      this._consume(4)
      this.state = PngStreamState.READING_CHUNK_DATA
    }
  }

  _processChunkData() {
    // Wait until we have total length + crc
    if (this._ptr().length >= this.currentChunkLength + 4) {
      this.state = this.currentChunkIsEnd ? PngStreamState.IMAGE_END : PngStreamState.READING_CHUNK_METADATA
      this._consume(this.currentChunkLength + 4)
    }
  }

  _finalizeImage() {
    // Extract the final image
    const finalImage = this.buf.slice(0, this.offset)

    // Remove the final image from the scratch space
    this.buf.consume(this.offset)
    this._resetStateMachine()
    return finalImage
  }
}

const appdir = fs.mkdtempSync(path.join(os.tmpdir(), `parse-appdir-${process.pid}`))
console.log(`${appdir}`)
runOnAppTermination((exitCode) => {
  console.log(`on exit: ${exitCode} ${appdir}`)
  fs.rmSync(appdir, {recursive: true, force: true})
})

const outputDir = path.join(appdir, "output")
fs.mkdirSync(outputDir)
console.log(`Printing to ${outputDir}`)

const pngParser = new PngStreamParser

const inputVideo = "edmonton_canada.mp4"
const ffmpegProc = spawn('ffmpeg', [
    '-i', inputVideo,      // Input file
    '-f', 'image2pipe',    // Output format
    '-vcodec', 'png',      // Video codec (PNG for frames)
    '-',              // Output to stdout
])

let totalTime = 0n;
let numCalls = 0
const printTimes = () => {
  const averageTime = totalTime / BigInt(numCalls);
  console.log(`total time per addData call: ${totalTime} nanoseconds`);
  console.log(`Average time per addData call: ${averageTime} nanoseconds`);
}

let count = 0
ffmpegProc.stdout.on('data', (data) => {
  const start = process.hrtime.bigint()
  let output = pngParser.addData(data)
  const end = process.hrtime.bigint()
  ++numCalls
  totalTime += end - start;
  ///printTimes()
  for (const pngImageData of output) {
    ++count
    const imageIndex = String(count).padStart(4, 0)
    createBoundedImage(pngImageData, `${outputDir}/image_${imageIndex}.png`)
  }
})

ffmpegProc.on('close', () => {
  printTimes()
})

// Handle any errors
ffmpegProc.stderr.on('error', (err) => {
  console.error('Error reading from the pipe:', err);
});
