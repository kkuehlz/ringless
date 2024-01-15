# Ringless

Ringless is a self-hosted solution for managing Ring camera captures. Hooks into motion detected events emitted by the Ring API and records while there is a person in the frame.

##### Key Features
* **Self-hosted data storage**: Keep your own local copies of camera footage.
* **High signal, low noise**: Only saves footage when a person is in the camera view.
* **Customizable Capture Settings**: Adjust resolution, frame rate, and recording duration to suit your needs.
* **Intuitive Timeline View**: Easily access and review captured footage through a user-friendly web interface.

## Project Overview
Consists of two services: (1) the **monitor daemon** (client), which connects the to the camera livestream, performs person detection, and saves videos to disk. The **web server** is a minimal timeline app for accessing camera footage. Each service runs as a separate process. Each capture will show up as an event on the timeline, and clicking the event will play that video.

![Ringless Timeline View](https://i.fluffy.cc/Q76SzpmlqJKThfTVdWkV8VnZMQQwrBCB.png)

## Setup

### Prerequisites

Requires NodeJS 18+. Run `npm i` in both the client and server directories.

### OpenCV

Ringless uses OpenCV for real-time person detection. When building the client, `npm i` will not be enough to bootstrap all the dependencies. You will also need to install OpenCV and generate node-gyp bindings so that NodeJS knows how to call OpenCV functions. Detailed installation instructions [can be found here](https://github.com/UrielCh/opencv4nodejs?tab=readme-ov-file#to-use-your-own-opencv-build). `opencv4nodejs` supports both local installations and system-wide installations. I recommend installing OpenCV system-wide and following the instructions where autobuild is disabled.

### Ring OAuth Token

Follow [these instructions](https://github.com/dgreif/ring/wiki/Refresh-Tokens) to get a Ring OAuth token. It is necessary for the monitor service to authenticate with Ring servers to listen for events and get a video stream.

## Configuration

Create a `.env` file in the project root. This same environment variables are shared by both the monitor service and the web server.

```
RING_REFRESH_TOKEN=<Required|Token from Ring API>
CAPTURE_OUTPUT_DIRECTORY=<Optional|Default $PROJECT_ROOT/server/captures
PORT=<Optional|Default "3000">
RESOLUTION=<Optional|Default "1920x1080">
FRAMES_PER_SECOND=<Optional|Default "9">
TIMEOUT_SECONDS=<Optional|Default "4">
```

## Running

### Monitor Service
```
$ node client/monitor.js
```

### Web server
```
$ node server/serve.js
```

