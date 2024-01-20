const envPath = __dirname + '/../.env'
require('dotenv').config({path: envPath})
const os = require('os')
const { exec } = require('child_process')
const path = require('path')
const fsp = require('fs/promises')
const cv = require('@u4/opencv4nodejs')
const { RingApi } = require('@keur/ring-client-api')
const { PngImageUnpacker } = require('./png.js')

const DEBUG = (process.env.DEBUG || 'false').toLowerCase() === 'true'
const RESOLUTION = process.env.RESOLUTION || '1920x1080'
const FRAMES_PER_SECOND = process.env.FRAMES_PER_SECOND || String(9)
const SAMPLE_CV_DETECTION = process.env.SAMPLE_CV_DETECTION || false
const TIMEOUT_SECONDS = parseInt(process.env.RECORD_SECONDS_AFTER_MOTION || 4)
const CAPTURE_OUTPUT_DIRECTORY = path.resolve(process.env.CAPTURE_OUTPUT_DIRECTORY || path.join(__dirname, '../server/captures'))

console.log("Configuration Options")
console.log("---------------------")
console.log(`Capture Resolution              : ${RESOLUTION}`)
console.log(`Capture FPS                     : ${FRAMES_PER_SECOND} FPS`)
console.log(`Capture Directory               : ${CAPTURE_OUTPUT_DIRECTORY}`)
console.log(`Timeout after person disappears : ${TIMEOUT_SECONDS} seconds`)
console.log(`Sample CV Detection             : ${SAMPLE_CV_DETECTION}`)
console.log(`DEBUG MODE                      : ${DEBUG}`)

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

const mkdir = async (path, createParent=true) => {
  try {
    await fsp.mkdir(path, {recursive:createParent})
  } catch (e) {
    if (e.code != "EEXIST") {
      throw e
    }
  }
}

const getYYYYMMDD = (date) => {
  return date.toISOString().split('T')[0]
}

const nn = cv.readNetFromCaffe(
  path.join(__dirname, 'model/MobileNetSSD_deploy.prototxt.txt'),
  path.join(__dirname, 'model/MobileNetSSD_deploy.caffemodel'),
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

const cameraIsRecording = {}
const onMotionDetectedImage2Pipe = async (camera) => {
  if (cameraIsRecording[camera.id]) {
    // In case ring sends us multiple motion detected events on the same device
    // while we are already recording...
    return
  }
  cameraIsRecording[camera.id] = true
  const recordingStartTimestamp = Date.now()

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
      '-s', RESOLUTION,        // resolution
      '-f', 'image2pipe',      // demux videos to stream
      '-r', FRAMES_PER_SECOND, // frame rate
      'pipe:1',                // stream to stdout
    ],
    stdoutCallback: (async (data) => {
      const images = unpacker.addData(data)
      for (const image of images) {
        const imageIndex = String(ioJobs.length+1).padStart(4, 0)
        ioJobs.push(fsp.writeFile(`${scratchDir}/frame_${imageIndex}.png`, image))
	if (!SAMPLE_CV_DETECTION || (ioJobs.length % FRAMES_PER_SECOND === 0)) {
          if (isPersonInFrame(image)) {
            consecutiveFramesWithoutPerson = 0
          } else {
            ++consecutiveFramesWithoutPerson
            if (consecutiveFramesWithoutPerson === TIMEOUT_SECONDS) {
              const totalCaptureTime = ioJobs.length / FRAMES_PER_SECOND
              console.log(`${camera.name}: Person disappeared. Stopping video after ${totalCaptureTime} seconds`)

              // Tell ring to stop recording
              liveSession.stop()
              cameraIsRecording[camera.id] = false
              const recordingEndTime = Date.now()
              const outDir = path.join(CAPTURE_OUTPUT_DIRECTORY, getYYYYMMDD(new Date(recordingStartTimestamp)))
              const basename = `${recordingStartTimestamp}_${recordingEndTime}`

              // First, wait for all write jobs to complete. Convert the frames
              // back into a video, and remove the scratch directory.
              await Promise.all(ioJobs)
              await mkdir(outDir)
              await stitchFramesTogether(scratchDir, outDir, basename, 'png')
              await fsp.rm(scratchDir, { recursive: true, force: true })
            }
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

      const currentConfig = await fsp.readFile(envPath)
      const updatedConfig = currentConfig
        .toString()
        .replace(oldRefreshToken, newRefreshToken)

      await fsp.writeFile(envPath, updatedConfig)
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
      await onMotionDetectedImage2Pipe(camera)
    })
  }
})()
