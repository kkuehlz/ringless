# Ringless

Self-hosted ring camera capture infrastructure. Hooks into motion detected
events emitted by the Ring API and records while there is a person in the
frame.

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

