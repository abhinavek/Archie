/**
 * Standalone Camera Daemon for Ayinu Robotics (FFmpeg Scene/Motion Detection)
 * 
 * Uses FFmpeg's native `select='gt(scene,0.03)'` filter on Linux/v4l2 devices.
 * FFmpeg decodes the camera feed at 30 FPS and ONLY emits a JPEG buffer when
 * visual movement occurs, preventing redundant VLM processing.
 */
import { spawn } from 'node:child_process';
import { io } from 'socket.io-client';

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3001';
const CAMERA_DEVICE = process.env.CAMERA_DEVICE || '/dev/video0';
const MOTION_SENSITIVITY = process.env.MOTION_SENSITIVITY || '0.03'; // 0.01 - 0.1

console.log(`[Daemon] Connecting to Ayinu WebSocket at ${BACKEND_URL}...`);

const socket = io(BACKEND_URL, {
  transports: ['websocket'],
  reconnection: true,
});

let aiStatus = 'idle';

socket.on('connect', () => {
  console.log(`[Daemon] Connected to backend! Socket ID: ${socket.id}`);
  startFFmpegMotionPipeline();
});

socket.on('ai-status', (status) => {
  aiStatus = status;
  console.log(`[Daemon] Backend AI status: ${status}`);
});

socket.on('speak', (text) => {
  console.log(`\n🗣️ [Ayinu Proactive Speech]: "${text}"\n`);
});

socket.on('disconnect', () => {
  console.warn('[Daemon] Disconnected from backend.');
});

function startFFmpegMotionPipeline() {
  console.log(`[Daemon] Spawning FFmpeg motion pipeline on ${CAMERA_DEVICE}...`);

  // FFmpeg command: Captures camera and outputs single JPEG frames on stdout ONLY on scene changes
  const ffmpeg = spawn('ffmpeg', [
    '-f', 'v4l2',
    '-video_size', '640x480',
    '-framerate', '30',
    '-i', CAMERA_DEVICE,
    '-vf', `select='gt(scene,${MOTION_SENSITIVITY})'`,
    '-vsync', 'vfr',
    '-f', 'image2pipe',
    '-vcodec', 'mjpeg',
    '-q:v', '3',
    'pipe:1',
  ], { stdio: ['ignore', 'pipe', 'ignore'] });

  let bufferChunks = [];

  ffmpeg.stdout.on('data', (chunk) => {
    bufferChunks.push(chunk);

    // Look for JPEG End of Image marker (0xFF, 0xD9)
    if (chunk.length >= 2 && chunk[chunk.length - 2] === 0xff && chunk[chunk.length - 1] === 0xd9) {
      const fullFrame = Buffer.concat(bufferChunks);
      bufferChunks = [];

      // Gatekeeper: Only transmit if the AI backend is currently idle
      if (socket.connected && aiStatus === 'idle') {
        console.log(`[Daemon] Motion event detected! Streaming frame (${fullFrame.length} bytes)...`);
        socket.emit('stream-frame', fullFrame);
      } else {
        console.log('[Daemon] Motion detected, but AI is thinking. Frame dropped.');
      }
    }
  });

  ffmpeg.on('error', (err) => {
    console.warn('[Daemon] FFmpeg error (normal if no physical camera attached in sandbox):', err.message);
  });

  ffmpeg.on('close', (code) => {
    console.log(`[Daemon] FFmpeg exited with code ${code}.`);
  });
}
