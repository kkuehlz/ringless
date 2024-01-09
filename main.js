require('dotenv').config()
const assert = require('assert')
const os = require('os')
const { exec } = require('child_process')
const path = require('path')
const fsp = require('fs/promises')
const cv = require('@u4/opencv4nodejs')
const chokidar = require('chokidar')
const { RingApi } = require('ring/packages/ring-client-api/lib')
const { FlatQueue } = require('./flatqueue.js')
const { PngImageUnpacker } = require('./png.js')

const DEBUG = true

const FRAMES_PER_SECOND = process.env.FRAMES_PER_SECOND || String(9)
const TIMEOUT_SECONDS = parseInt(process.env.RECORD_SECONDS_AFTER_MOTION || 4)
const CAPTURE_OUTPUT_DIRECTORY = process.env.CAPTURE_OUTPUT_DIRECTORY || process.cwd()
const FFMPEG_DEMUX_BACKEND = process.env.FFMPEG_DEMUX_BACKEND || 'image2pipe'

assert(FFMPEG_DEMUX_BACKEND == 'image2' || FFMPEG_DEMUX_BACKEND == 'image2pipe', 'Only image2 and image2pipe are supported')

const execShellCommand = (cmd) => {
  return new Promise((resolve, reject) => {
    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        console.warn(error)
      }
      resolve([error, stdout.trim(), stderr.trim()])
    });
  });
}

const getTimestamp = () => {
  iso = (new Date()).toISOString()
  return iso.slice(0, iso.length-5)
}

const nn = cv.readNetFromCaffe(
  'model/MobileNetSSD_deploy.prototxt.txt',
  'model/MobileNetSSD_deploy.caffemodel',
)
isPersonInFrame = (file) => {
  const MOBILENET_CLASS_PERSON = 15;
  const frame = Buffer.isBuffer(file) ? cv.imdecode(file) : cv.imread(file)
  const mean = new cv.Vec3(127.5, 127.5, 127.5)
  const size = new cv.Size(300, 300)
  const blob = cv.blobFromImage(frame.resize(300, 300), 0.007843, size, mean, false, false)
  nn.setInput(blob)
  const output = nn.forward()

  const numDetections = output.sizes[2]
  for (let i = 0; i < numDetections; ++i) {
    const classId = output.at([0, 0, i, 1])
    const confidence = output.at([0, 0, i, 2])
    if (DEBUG) {
      //console.log(`${file}: class=${classId}, confidence=${confidence}`)
    }
    if (classId === MOBILENET_CLASS_PERSON && confidence > 0.30) {
      return true
    }
  }
  return false
}

stitchFramesTogether = async (inputDir, outputDir, outputBasename, ext) => {
ffmpegArgs = [
  'ffmpeg',
  '-y',
  `-framerate ${FRAMES_PER_SECOND}`,
  `-i ${inputDir}/frame_%04d.${ext}`,
  '-c:v libx264',
  '-pix_fmt yuv420p',
  '-loglevel error',
  `${outputDir}/${outputBasename}.mp4`
]
cmdString = ffmpegArgs.join(' ')
  if (DEBUG) {
    console.log("Executing: ", cmdString)
  }
  await execShellCommand(cmdString)
}

const onMotionDetectedImage2 = async (camera) => {
  const cameraNameNormalized = camera.name.replace(/ /g, "_")
  console.log(`${camera.name}: Motion Started`)

  const [liveSession, scratchDir] = await Promise.all([
    camera.startLiveCall(),
    fsp.mkdtemp(path.join(os.tmpdir(), cameraNameNormalized)),
  ])

  if (DEBUG) {
    console.log(`${camera.name}: Created ${scratchDir}`)
  }

  let consecutiveFramesWithoutPerson = 0

  const queue = new FlatQueue();
  let nextExpectedFrame = 1
  const watcher = chokidar.watch(scratchDir, {ignored: /^\./, persistent: true})

  const processFrameQueue = async () => {
    while (queue.length > 0 && queue.peekValue() === nextExpectedFrame) {
      imagePath = queue.pop()
      console.log("Processing ", imagePath)
      ++nextExpectedFrame
      if (isPersonInFrame(imagePath)) {
        consecutiveFramesWithoutPerson = 0
      } else {
        ++consecutiveFramesWithoutPerson
        if (consecutiveFramesWithoutPerson === FRAMES_PER_SECOND*TIMEOUT_SECONDS) {
          const totalCaptureTime = (nextExpectedFrame-1) / FRAMES_PER_SECOND
          console.log(`${camera.name}: Person disappeared. Stopping video after ${totalCaptureTime} seconds`)
          liveSession.stop()
          await watcher.close()
          await stitchFramesTogether(scratchDir, CAPTURE_OUTPUT_DIRECTORY, "detect_" + getTimestamp(), 'jpg')
          await fsp.rm(scratchDir, { recursive: true, force: true })
        }
      }
    }
  }

  watcher.on('add', async (imagePath) => {
    const filename = imagePath.split('/').pop()
    const m = filename.match(/frame_(\d{4,})\.jpg/)
    if (m) {
      const frameIndex = parseInt(m[1])
      queue.push(imagePath, frameIndex)
      await processFrameQueue()
    }
  })

  const ffmpegOptions = {
    video: ['-vcodec', 'mjpeg'],
    output: [
      '-s', '1920x1080',       // resolution
      '-f', 'image2',          // demux videos to sequence of images
      '-r', FRAMES_PER_SECOND, // frame rate
      `${scratchDir}/frame_%04d.jpg`  // output file pattern
    ],
  }
  await liveSession.startTranscoding(ffmpegOptions)
}

const onMotionDetectedImage2Pipe = async (camera) => {
  const cameraNameNormalized = camera.name.replace(/ /g, "_")
  console.log(`${camera.name}: Motion Started`)

  const [liveSession, scratchDir] = await Promise.all([
    camera.startLiveCall(),
    fsp.mkdtemp(path.join(os.tmpdir(), cameraNameNormalized)),
  ])

  if (DEBUG) {
    console.log(`${camera.name}: Created ${scratchDir}`)
  }

  let consecutiveFramesWithoutPerson = 0
  let ioJobs = []
  const unpacker = new PngImageUnpacker()
  const ffmpegOptions = {
    video: ['-vcodec', 'png'],
    output: [
      '-s', '1920x1080',       // resolution
      '-f', 'image2pipe',      // demux videos to stream
      '-r', FRAMES_PER_SECOND, // frame rate
      'pipe:1',                // stream to stdout
    ],
    stdoutCallback: (async (data) => {
      const images = unpacker.addData(data)
      for (const image of images) {
        const imageIndex = String(ioJobs.length+1).padStart(4, 0)
        ioJobs.push(fsp.writeFile(`${scratchDir}/frame_${imageIndex}.png`, image))
        if (isPersonInFrame(image)) {
          consecutiveFramesWithoutPerson = 0
        } else {
          ++consecutiveFramesWithoutPerson
          if (consecutiveFramesWithoutPerson === FRAMES_PER_SECOND*TIMEOUT_SECONDS) {
            const totalCaptureTime = ioJobs.length / FRAMES_PER_SECOND
            console.log(`${camera.name}: Person disappeared. Stopping video after ${totalCaptureTime} seconds`)

            // Tell ring to stop recording
            liveSession.stop()

            // Wait for all write jobs to complete Convert the frames back into
            // a video and delete the scratch directory.
            await Promise.all(ioJobs)
            await stitchFramesTogether(scratchDir, CAPTURE_OUTPUT_DIRECTORY, "detect_" + getTimestamp(), 'png')
            await fsp.rm(scratchDir, { recursive: true, force: true })
          }
        }
      }
    }),
  }
  await liveSession.startTranscoding(ffmpegOptions)
}

(async() => {
  const ringApi = new RingApi({
    refreshToken: process.env.RING_REFRESH_TOKEN
  })

  // Keep our OAUTH refresh token up to date.
  ringApi.onRefreshTokenUpdated.subscribe(
    async ({ newRefreshToken, oldRefreshToken }) => {
      if (!oldRefreshToken) {
        return
      }

      const currentConfig = await fsp.readFile('.env')
      const updatedConfig = currentConfig
        .toString()
        .replace(oldRefreshToken, newRefreshToken)

      await fsp.writeFile('.env', updatedConfig)
    },
  )

  const locations = await ringApi.getLocations()
  for (const location of locations) {
    location.onConnected.subscribe((connected) => {
      const state = connected ? 'Connected' : 'Connecting'
      console.log(`${state} to location ${location.name} - ${location.id}`)
    })
  }

  const cameras = await ringApi.getCameras()
  for (const camera of cameras) {
    camera.onMotionStarted.subscribe(async () => {
      if (FFMPEG_DEMUX_BACKEND == 'image2pipe') {
        await onMotionDetectedImage2Pipe(camera)
      } else {
        await onMotionDetectedImage2(camera)
      }
    })
  }
})()
