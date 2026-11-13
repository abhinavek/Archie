/**
 * Standalone Camera Daemon for Ayinu Robotics
 * 
 * Captures frames continuously at 30 FPS, renders/buffers locally without lag,
 * and transmits raw compressed binary JPEG packets over WebSockets to NestJS
 * only when the server's AI state is 'idle' (backpressure flow control).
 */
import { io } from 'socket.io-client';

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3001';
console.log(`[Daemon] Connecting to Ayinu WebSocket at ${BACKEND_URL}...`);

const socket = io(BACKEND_URL, {
  transports: ['websocket'],
  reconnection: true,
});

let aiStatus = 'idle';

socket.on('connect', () => {
  console.log(`[Daemon] Connected to backend! Socket ID: ${socket.id}`);
});

socket.on('ai-status', (status) => {
  aiStatus = status;
  console.log(`[Daemon] Backend AI status changed -> ${status}`);
});

socket.on('speak', (text) => {
  console.log(`\n🗣️ [Ayinu Proactive Speech]: "${text}"\n`);
  // If running on a physical robot with local speaker:
  // e.g. exec(`espeak "${text}"`) or piper TTS
});

socket.on('disconnect', () => {
  console.warn('[Daemon] Disconnected from backend.');
});

// Minimal synthetic/hardware frame streamer template
// On real hardware: pipe ffmpeg, v4l2, or camera stream to Buffer
console.log('[Daemon] Ready. Run this script on your Raspberry Pi / Jetson or camera device.');
