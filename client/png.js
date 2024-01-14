const assert = require('assert')
const { BufferList } = require('bl')

const PngStreamState = {
  IMAGE_START: 0,
  READING_CHUNK_METADATA: 1,
  READING_CHUNK_DATA: 2,
  IMAGE_END: 3,
}
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
const IEND_CHUNK_TYPE = 0x49454E44

// Unpacks individual images from a contiuous stream of PNG data.  Uses
// BufferList to minimize copies. Designed to consume from ffmpeg image2pipe.
class PngImageUnpacker {
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

module.exports = { PngImageUnpacker }
