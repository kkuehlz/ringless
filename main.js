require('dotenv').config()
const os = require('os')
const { exec } = require('child_process')
const path = require('path')
const fs = require('fs/promises')
const cv = require('@u4/opencv4nodejs')
const chokidar = require('chokidar')
const { RingApi } = require('ring/packages/ring-client-api/lib')
const { FlatQueue } = require('./flatqueue.js')

const DEBUG = true

const FRAMES_PER_SECOND = process.env.FRAMES_PER_SECOND || String(9)
const TIMEOUT_SECONDS = parseInt(process.env.RECORD_SECONDS_AFTER_MOTION || 3)
const CAPTURE_OUTPUT_DIRECTORY = process.env.CAPTURE_OUTPUT_DIRECTORY || process.cwd()

//////////////////////////////////////////////////////////
// Utils
//////////////////////////////////////////////////////////
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

//////////////////////////////////////////////////////////
// Person detection
//////////////////////////////////////////////////////////
isPersonInFrame = (file) => {
  const nn = cv.readNetFromCaffe(
    'model/MobileNetSSD_deploy.prototxt.txt',
    'model/MobileNetSSD_deploy.caffemodel',
  )
  const MOBILENET_CLASS_PERSON = 15;
  const frame = cv.imread(file)
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

stitchFramesTogether = async (inputDir, outputDir, outputBasename) => {
	ffmpegArgs = [
	  "ffmpeg",
	  "-y",
    `-framerate ${FRAMES_PER_SECOND}`,
    "-pattern_type glob",
    `-i ${inputDir}/*.jpg`,
    "-c:v libx264",
    "-pix_fmt yuv420p",
    "-loglevel error",
    `${outputDir}/${outputBasename}.mp4`
  ]
	cmdString = ffmpegArgs.join(' ')
  if (DEBUG) {
    console.log("Executing: ", cmdString)
  }
	await execShellCommand(cmdString)
}

const onMotionDetected = async (camera) => {
  const cameraNameNormalized = camera.name.replace(/ /g, "_")
  console.log(`${camera.name}: Motion Started`)

  const [liveSession, scratchDir] = await Promise.all([
    camera.startLiveCall(),
    fs.mkdtemp(path.join(os.tmpdir(), cameraNameNormalized)),
  ])

  if (DEBUG) {
    console.log(`${camera.name}: Created ${scratchDir}`)
  }

  // Create a temporary directory demuxed frames
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
          await stitchFramesTogether(scratchDir, CAPTURE_OUTPUT_DIRECTORY, "detect_" + getTimestamp())
          await fs.rm(scratchDir, { recursive: true, force: true })
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

      const currentConfig = await fs.readFile('.env'),
        updatedConfig = currentConfig
          .toString()
          .replace(oldRefreshToken, newRefreshToken)

      await fs.writeFile('.env', updatedConfig)
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
      await onMotionDetected(camera)
    })
  }
})()
