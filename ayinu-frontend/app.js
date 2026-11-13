// Determine backend host & scheme dynamically
const API_PORT = 3001;
const API_BASE_URL = window.location.protocol === 'https:'
  ? `https://${window.location.hostname}:${API_PORT}`
  : `http://${window.location.hostname}:${API_PORT}`;
const MODEL_URL =
  'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.14/model';

const GREET_COOLDOWN_MS = 60_000;
const PRESENCE_COOLDOWN_MS = 30_000;
const FACE_CHANGE_THRESHOLD = 0.6;
const FACE_CHANGE_STREAK_REQUIRED = 3;
const UNKNOWN_CONFIRMATIONS_REQUIRED = 3;
const SCAN_INTERVAL_MS = 1_200;

// DOM Elements
const video = document.getElementById('webcam');
const overlay = document.getElementById('overlay');
const cameraOffOverlay = document.getElementById('cameraOffOverlay');
const previewTarget = document.getElementById('previewTarget');
const previewStatus = document.getElementById('previewStatus');

const listeningPill = document.getElementById('listeningPill');
const listeningText = document.getElementById('listeningText');
const dockCaption = document.getElementById('dockCaption');

const latestUserText = document.getElementById('latestUserText');
const latestRobotText = document.getElementById('latestRobotText');

const toggleCameraBtn = document.getElementById('toggleCameraBtn');
const toggleVoiceBtn = document.getElementById('toggleVoiceBtn');
const toggleSpeechBtn = document.getElementById('toggleSpeechBtn');
const languageSelect = document.getElementById('languageSelect');

const openChatBtn = document.getElementById('openChatBtn');
const closeChatBtn = document.getElementById('closeChatBtn');
const chatPopupBackdrop = document.getElementById('chatPopupBackdrop');
const chatLog = document.getElementById('chatLog');
const askForm = document.getElementById('askForm');
const promptInput = document.getElementById('promptInput');

const registerForm = document.getElementById('registerForm');
const personNameForm = document.getElementById('personNameForm');
const personNameInput = document.getElementById('personNameInput');

// Canvas Waveform Animation
const waveCanvas = document.getElementById('waveCanvas');
let waveCtx = null;
if (waveCanvas) {
  waveCtx = waveCanvas.getContext('2d');
}

// Pre-warm SpeechSynthesis on user interaction (mandatory for iOS WebKit)
function primeSpeechSynthesis() {
  if ('speechSynthesis' in window) {
    const warmUtter = new SpeechSynthesisUtterance(' ');
    warmUtter.volume = 0.01;
    window.speechSynthesis.speak(warmUtter);
  }
}
document.addEventListener('touchstart', primeSpeechSynthesis, { once: true });
document.addEventListener('click', primeSpeechSynthesis, { once: true });

let running = false;
let modelsLoaded = false;
let scanTimer = null;
let continuousVisionTimer = null;
let lastContinuousAnalysisAt = 0;
const CONTINUOUS_SAMPLE_INTERVAL_MS = 6000;

let speechEnabled = true;
let micEnabled = true;
let isSpeaking = false;
let isBusy = false;

let activePerson = null;
let pendingDescriptor = null;
let awaitingName = false;
let audioMediaRecorder = null;
let lastAudioBase64 = null;
let clientLocation = null;
const lastGreetedAt = new Map();
const conversationHistory = [];
const MAX_HISTORY_TURNS = 10;

const presenceCache = {
  lastSeenName: null,
  lastSeenTimestamp: 0,
  lastDescriptor: null,
  differentFaceStreak: 0,
  unmatchedConfirmations: 0,
};

function euclideanDistance(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) {
    const diff = a[i] - b[i];
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}

const SpeechRecognitionCtor =
  window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;

// ==========================================================================
// Waveform & Heartbeat Animation (Figma Voice frequency lines / Heartbeat)
// ==========================================================================
let wavePhase = 0;
let heartPhase = 0;

function drawHeartbeat(ctx, cx, cy) {
  heartPhase += 0.06;

  // Double pulse heartbeat rhythm (lub-dub)
  const cycle = (heartPhase % (Math.PI * 2));
  let pulse = 0;
  if (cycle < 0.6) {
    pulse = Math.sin((cycle / 0.6) * Math.PI) * 12; // First beat (lub)
  } else if (cycle > 0.8 && cycle < 1.4) {
    pulse = Math.sin(((cycle - 0.8) / 0.6) * Math.PI) * 8; // Second beat (dub)
  }

  const baseRadius = 38 + pulse;

  // Glowing outer halos
  const rings = [
    { radius: baseRadius + 22, color: 'rgba(180, 160, 230, 0.15)', width: 1.5 },
    { radius: baseRadius + 11, color: 'rgba(150, 130, 215, 0.28)', width: 2 },
    { radius: baseRadius,      color: 'rgba(125, 95, 200, 0.85)',  width: 2.5 },
  ];

  rings.forEach((r) => {
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(2, r.radius), 0, Math.PI * 2);
    ctx.strokeStyle = r.color;
    ctx.lineWidth = r.width;
    ctx.stroke();
  });

  // Soft glowing center core
  const grad = ctx.createRadialGradient(cx, cy, 2, cx, cy, baseRadius);
  grad.addColorStop(0, 'rgba(195, 175, 245, 0.7)');
  grad.addColorStop(0.5, 'rgba(145, 120, 215, 0.35)');
  grad.addColorStop(1, 'rgba(110, 80, 185, 0)');

  ctx.beginPath();
  ctx.arc(cx, cy, baseRadius, 0, Math.PI * 2);
  ctx.fillStyle = grad;
  ctx.fill();

  // Subtle circular pulsating ring markers
  for (let i = 0; i < 4; i++) {
    const angle = (heartPhase * 0.8) + (i * (Math.PI / 2));
    const dotX = cx + Math.cos(angle) * (baseRadius + 6);
    const dotY = cy + Math.sin(angle) * (baseRadius + 6);

    ctx.beginPath();
    ctx.arc(dotX, dotY, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(125, 95, 200, 0.9)';
    ctx.fill();
  }
}

function drawWave() {
  if (!waveCtx || !waveCanvas) return;
  const w = waveCanvas.width;
  const h = waveCanvas.height;
  waveCtx.clearRect(0, 0, w, h);

  // If an API request is currently pending, morph the wave into a round pulsing heartbeat
  if (isBusy) {
    drawHeartbeat(waveCtx, w / 2, h / 2);
    requestAnimationFrame(drawWave);
    return;
  }

  const colors = [
    'rgba(215, 200, 240, 0.35)',
    'rgba(190, 175, 230, 0.45)',
    'rgba(170, 150, 220, 0.55)',
    'rgba(145, 120, 210, 0.65)',
    'rgba(125, 95, 200, 0.75)',
    'rgba(110, 80, 185, 0.85)',
    'rgba(95, 65, 170, 0.95)',
  ];

  const isActive = running && (micEnabled || isSpeaking);
  const amplitudeBase = isSpeaking ? 34 : (isActive ? 16 : 6);
  wavePhase += isSpeaking ? 0.08 : (isActive ? 0.04 : 0.015);

  colors.forEach((col, idx) => {
    waveCtx.beginPath();
    waveCtx.strokeStyle = col;
    waveCtx.lineWidth = 2.0;

    const offset = idx * 0.45;
    const amp = amplitudeBase * (0.6 + (idx * 0.12));

    for (let x = 0; x < w; x += 4) {
      const normalX = x / w;
      // Bell envelope so edges taper to zero
      const envelope = Math.sin(normalX * Math.PI);
      const y = (h / 2) + Math.sin((normalX * 4 * Math.PI) + wavePhase + offset) * amp * envelope;

      if (x === 0) waveCtx.moveTo(x, y);
      else waveCtx.lineTo(x, y);
    }
    waveCtx.stroke();
  });

  requestAnimationFrame(drawWave);
}
requestAnimationFrame(drawWave);

// ==========================================================================
// Status & UI Updaters
// ==========================================================================
function setListeningState(text, active = false) {
  if (listeningText) listeningText.textContent = text;
  if (listeningPill) listeningPill.classList.toggle('active', active);
  if (dockCaption) dockCaption.textContent = text;
}

function updateLatestExchange(speaker, text) {
  if (speaker === 'user' && latestUserText) {
    latestUserText.textContent = text;
  } else if (speaker === 'robot' && latestRobotText) {
    latestRobotText.textContent = text;
  }
}

function appendChatBubble(role, text) {
  if (!chatLog) return;
  const isUser = role === 'user';
  const group = document.createElement('div');
  group.className = `chat-bubble-group ${isUser ? 'user-group' : 'aura-group'}`;

  const label = document.createElement('span');
  label.className = 'bubble-role-label';
  label.textContent = isUser ? (activePerson ? activePerson.toUpperCase() : 'YOU') : 'AURA';

  const bubble = document.createElement('div');
  bubble.className = `chat-bubble ${isUser ? 'user-bubble' : 'aura-bubble'}`;
  bubble.textContent = text;

  group.appendChild(label);
  group.appendChild(bubble);
  chatLog.appendChild(group);
  chatLog.scrollTop = chatLog.scrollHeight;
}

// ==========================================================================
// Speech Synthesis
// ==========================================================================
async function speak(text) {
  updateLatestExchange('robot', text);
  appendChatBubble('robot', text);

  if (!speechEnabled || !('speechSynthesis' in window)) return;

  isSpeaking = true;
  stopListeningTemp();
  setListeningState('Speaking…', true);

  await new Promise((resolve) => {
    try {
      const utter = new SpeechSynthesisUtterance(text);
      const selectedLang = languageSelect ? languageSelect.value : 'en-IN';
      
      const voices = window.speechSynthesis.getVoices() || [];
      const exactVoice = voices.find((v) => v.lang.toLowerCase() === selectedLang.toLowerCase());
      const prefixVoice = voices.find((v) => v.lang.toLowerCase().startsWith(selectedLang.split('-')[0].toLowerCase()));
      
      if (exactVoice) {
        utter.voice = exactVoice;
        utter.lang = exactVoice.lang;
      } else if (prefixVoice) {
        utter.voice = prefixVoice;
        utter.lang = prefixVoice.lang;
      } else {
        utter.lang = selectedLang;
      }

      utter.rate = 1.0;
      utter.pitch = 1.0;
      utter.volume = 1.0;

      let timer = null;
      const finish = () => {
        if (timer) clearTimeout(timer);
        resolve();
      };

      const estimatedDurationMs = Math.max(3000, (text.length / 10) * 1000);
      timer = setTimeout(() => {
        finish();
      }, estimatedDurationMs);

      utter.onend = finish;
      utter.onerror = (e) => {
        finish();
      };

      if (window.speechSynthesis.paused) {
        window.speechSynthesis.resume();
      }

      window.speechSynthesis.speak(utter);
    } catch (err) {
      resolve();
    }
  });

  isSpeaking = false;
  if (running) {
    setListeningState(micEnabled ? 'Listening' : 'Ready', micEnabled);
    if (micEnabled) startListening();
  }
}

// ==========================================================================
// Speech Recognition (Web Speech API)
// ==========================================================================
function initRecognition() {
  if (!SpeechRecognitionCtor) return null;
  const rec = new SpeechRecognitionCtor();
  rec.lang = languageSelect ? languageSelect.value : 'en-IN';
  rec.interimResults = false;
  rec.continuous = true;

  rec.onstart = () => {
    console.log('[SpeechRecognition] Active in:', rec.lang);
  };

  rec.onerror = (e) => {
    console.warn('[SpeechRecognition] Error:', e.error);
    if (e.error === 'not-allowed') {
      appendChatBubble('robot', 'Microphone permission denied.');
    }
  };

  rec.onresult = async (event) => {
    const last = event.results[event.results.length - 1];
    if (!last?.isFinal) return;
    const transcript = last[0].transcript.trim();
    if (!transcript || isSpeaking) return;

    if (awaitingName && pendingDescriptor) {
      const explicitMatch = transcript.match(
        /\b(?:my name is|i am|i'm|call me|name's|എന്റെ പേര്|പേര്)\s+([a-zA-Z\u0D00-\u0D7F\s]{2,30})/i,
      );
      if (explicitMatch && explicitMatch[1]) {
        const cleaned = explicitMatch[1].trim().replace(/[.!?]+$/, '');
        if (cleaned) {
          await completeRegistration(cleaned);
          return;
        }
      }
      const words = transcript.split(/\s+/).filter(Boolean);
      if (words.length <= 2 && transcript.length <= 20) {
        const cleaned = transcript.replace(/[^\w\s\u0D00-\u0D7F]/gi, '').trim();
        if (cleaned.length >= 2) {
          await completeRegistration(cleaned);
          return;
        }
      }
      return;
    }

    const renameMatch = transcript.match(
      /\b(?:actually\s+)?(?:my name is|call me|change my name to|എന്റെ പേര്|പേര് മാറ്റുക)\s+([a-zA-Z\u0D00-\u0D7F\s]{2,30})/i,
    );
    if (renameMatch && renameMatch[1] && presenceCache.lastDescriptor) {
      const newName = renameMatch[1].trim().replace(/[.!?]+$/, '');
      if (newName && newName.toLowerCase() !== (activePerson || '').toLowerCase()) {
        pendingDescriptor = presenceCache.lastDescriptor;
        await completeRegistration(newName);
        return;
      }
    }

    await handleUserPrompt(transcript);
  };

  rec.onend = () => {
    if (running && micEnabled && !isSpeaking) {
      setTimeout(() => {
        try {
          rec.start();
        } catch {
          // Ignore if already active
        }
      }, 200);
    }
  };

  return rec;
}

function startListening() {
  if (!recognition) recognition = initRecognition();
  if (!recognition) return;
  try {
    recognition.start();
  } catch {
    // Ignore duplicate
  }
}

function stopListeningTemp() {
  if (!recognition) return;
  try {
    recognition.stop();
  } catch {
    // Ignore
  }
}

// ==========================================================================
// Vision Models & Face Recognition
// ==========================================================================
async function loadFaceModels() {
  if (modelsLoaded) return;
  if (!window.faceapi) throw new Error('face-api.js failed to load.');
  setListeningState('Loading vision models…', false);
  await Promise.all([
    faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
    faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
    faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
  ]);
  modelsLoaded = true;
}

async function postJson(path, body) {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`${path} failed (${res.status}): ${errText}`);
  }
  return res.json();
}

// WebSocket Client with Backpressure (Decoupled Vision Pipeline)
let socket = null;
let aiStatus = 'idle';

function initWebSocket() {
  if (typeof io !== 'function') {
    console.warn('[WebSocket] socket.io client not loaded.');
    return;
  }
  socket = io(API_BASE_URL, {
    transports: ['websocket', 'polling'],
    reconnection: true,
  });

  socket.on('connect', () => {
    console.log('[WebSocket] Connected to backend! ID:', socket.id);
  });

  socket.on('ai-status', (status) => {
    aiStatus = status;
    console.log('[WebSocket] Backend AI status:', status);
    if (status === 'thinking' && !isSpeaking) {
      setListeningState('Thinking… (Observing room)', true);
    } else if (status === 'idle' && running && !isSpeaking) {
      setListeningState(micEnabled ? 'Listening · Always on' : 'Ready', micEnabled);
    }
  });

  socket.on('speak', async (text) => {
    console.log('[WebSocket Proactive Speech]:', text);
    if (!isSpeaking && !isBusy) {
      await speak(text);
    }
  });

  socket.on('disconnect', () => {
    console.warn('[WebSocket] Disconnected from backend.');
  });
}
initWebSocket();

function captureCurrentFrameBlob(callback) {
  if (!video || video.readyState < 2) return;
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth || 640;
  canvas.height = video.videoHeight || 480;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  canvas.toBlob((blob) => {
    if (blob) callback(blob);
  }, 'image/jpeg', 0.6);
}

// Motion Detection Gatekeeper Configuration
let previousImageData = null;
const PIXEL_DIFF_THRESHOLD = 30; // Color deviation threshold (0-255)
const MOTION_THRESHOLD = 1500;   // Minimum changed pixels to trigger AI vision send

function streamContinuousVision() {
  if (!running || isSpeaking || isBusy || awaitingName || video.readyState < 2) return;

  // Use a dedicated offscreen canvas for high-performance pixel diffing
  const motionCanvas = document.createElement('canvas');
  motionCanvas.width = 320; // Downscale to 320x240 for ultra-fast zero-lag pixel checks
  motionCanvas.height = 240;
  const mCtx = motionCanvas.getContext('2d', { willReadFrequently: true });
  mCtx.drawImage(video, 0, 0, motionCanvas.width, motionCanvas.height);

  const currentImageData = mCtx.getImageData(0, 0, motionCanvas.width, motionCanvas.height);
  let hasMotion = false;

  if (!previousImageData) {
    hasMotion = true; // Always transmit initial frame
  } else {
    let changedPixels = 0;
    const curr = currentImageData.data;
    const prev = previousImageData.data;

    // Sample every 4th pixel (step by 16) to conserve CPU cycles
    for (let i = 0; i < curr.length; i += 16) {
      const rDiff = Math.abs(curr[i] - prev[i]);
      const gDiff = Math.abs(curr[i + 1] - prev[i + 1]);
      const bDiff = Math.abs(curr[i + 2] - prev[i + 2]);

      if (rDiff + gDiff + bDiff > PIXEL_DIFF_THRESHOLD * 3) {
        changedPixels++;
      }
    }

    // Scale threshold relative to downsampled frame size
    if (changedPixels > (MOTION_THRESHOLD / 8)) {
      hasMotion = true;
      console.log(`[Motion Gatekeeper] Motion detected (${changedPixels * 4} pixels shifted)`);
    }
  }

  if (hasMotion) {
    previousImageData = currentImageData;

    // Gatekeeper: Only compress and stream frame to server if AI backend is idle
    if (socket && socket.connected && aiStatus === 'idle') {
      // Capture full-res frame for AI inspection
      captureCurrentFrameBlob((blob) => {
        if (!blob) return;
        blob.arrayBuffer().then((buffer) => {
          socket.emit('stream-frame', buffer);
        }).catch(() => {});
      });
    }
  }
}

async function scanFrame() {
  if (!running || isBusy || isSpeaking || video.readyState < 2) return;

  const detection = await faceapi
    .detectSingleFace(
      video,
      new faceapi.TinyFaceDetectorOptions({ scoreThreshold: 0.4 }),
    )
    .withFaceLandmarks()
    .withFaceDescriptor();

  const ctx = overlay.getContext('2d');
  overlay.width = video.videoWidth || 640;
  overlay.height = video.videoHeight || 480;
  ctx.clearRect(0, 0, overlay.width, overlay.height);

  const now = Date.now();

  if (!detection) {
    if (presenceCache.lastSeenName && presenceCache.lastSeenName !== 'Unknown') {
      previewTarget.textContent = presenceCache.lastSeenName;
      previewStatus.textContent = 'In view';
      return;
    }

    if (
      presenceCache.lastSeenName === 'Unknown' &&
      now - presenceCache.lastSeenTimestamp > PRESENCE_COOLDOWN_MS
    ) {
      presenceCache.lastSeenName = null;
      presenceCache.lastDescriptor = null;
      presenceCache.differentFaceStreak = 0;
      presenceCache.unmatchedConfirmations = 0;
      activePerson = null;
      pendingDescriptor = null;
      awaitingName = false;
      registerForm.hidden = true;
      previewTarget.textContent = 'You';
      previewStatus.textContent = 'Camera active';
    }
    return;
  }

  // Draw face bounding box
  const box = detection.detection.box;
  ctx.strokeStyle = '#817096';
  ctx.lineWidth = 2;
  ctx.strokeRect(box.x, box.y, box.width, box.height);

  const descriptor = Array.from(detection.descriptor);

  if (presenceCache.lastDescriptor) {
    const dist = euclideanDistance(presenceCache.lastDescriptor, descriptor);
    if (dist < FACE_CHANGE_THRESHOLD) {
      presenceCache.differentFaceStreak = 0;
      presenceCache.unmatchedConfirmations = 0;
      presenceCache.lastSeenTimestamp = now;
      if (presenceCache.lastSeenName && presenceCache.lastSeenName !== 'Unknown') {
        previewTarget.textContent = presenceCache.lastSeenName;
        previewStatus.textContent = 'Recognized';
      }
      return;
    } else {
      presenceCache.differentFaceStreak += 1;
      if (presenceCache.differentFaceStreak < FACE_CHANGE_STREAK_REQUIRED) {
        return;
      }
    }
  }

  isBusy = true;
  try {
    const result = await postJson('/brain/faces/recognize', { descriptor });
    presenceCache.lastDescriptor = descriptor;
    presenceCache.lastSeenTimestamp = now;
    presenceCache.differentFaceStreak = 0;

    if (result.matched && result.name) {
      presenceCache.unmatchedConfirmations = 0;
      const isNewPerson = presenceCache.lastSeenName !== result.name;
      presenceCache.lastSeenName = result.name;
      activePerson = result.name;
      awaitingName = false;
      pendingDescriptor = null;
      registerForm.hidden = true;
      previewTarget.textContent = result.name;
      previewStatus.textContent = 'Verified';

      const lastGreet = lastGreetedAt.get(result.name) ?? 0;
      if (isNewPerson || now - lastGreet > GREET_COOLDOWN_MS) {
        lastGreetedAt.set(result.name, now);
        setListeningState(`Greeting ${result.name}…`, true);
        let greeting = `Hello ${result.name}! Good to see you again—what can I help you with?`;
        try {
          const { answer } = await postJson('/brain/engage', {
            personName: result.name,
          });
          if (answer?.trim()) greeting = answer;
        } catch {
          // Fall back to local greeting
        }
        await speak(greeting);
      }
    } else {
      presenceCache.unmatchedConfirmations += 1;
      if (presenceCache.unmatchedConfirmations < UNKNOWN_CONFIRMATIONS_REQUIRED) {
        previewStatus.textContent = 'Verifying…';
        return;
      }

      const isNewUnknown = presenceCache.lastSeenName !== 'Unknown';
      presenceCache.lastSeenName = 'Unknown';
      presenceCache.lastDescriptor = null;
      presenceCache.differentFaceStreak = 0;
      activePerson = null;
      pendingDescriptor = descriptor;
      previewTarget.textContent = 'Unknown';
      previewStatus.textContent = 'New person';
      registerForm.hidden = false;

      if (isNewUnknown && !awaitingName) {
        awaitingName = true;
        await speak('Hello, my name is Ayinu. Who is this?');
      }
    }
  } catch (err) {
    console.warn('Vision scan error:', err);
  } finally {
    isBusy = false;
  }
}

async function completeRegistration(name) {
  if (!pendingDescriptor || isBusy) return;
  isBusy = true;
  try {
    await postJson('/brain/faces/register', {
      name,
      descriptor: pendingDescriptor,
      audioBase64: lastAudioBase64 || undefined,
    });

    const now = Date.now();
    presenceCache.lastSeenName = name;
    presenceCache.lastSeenTimestamp = now;
    presenceCache.lastDescriptor = pendingDescriptor;
    presenceCache.differentFaceStreak = 0;
    activePerson = name;
    awaitingName = false;
    pendingDescriptor = null;
    registerForm.hidden = true;
    personNameInput.value = '';
    lastGreetedAt.set(name, now);
    previewTarget.textContent = name;
    previewStatus.textContent = 'Registered';
    await speak(`Nice to meet you, ${name}! I will remember you. How can I help you today?`);
  } catch (err) {
    appendChatBubble('robot', `Registration error: ${err.message}`);
  } finally {
    isBusy = false;
  }
}

// ==========================================================================
// Prompt & Dialogue Pipeline
// ==========================================================================
async function handleUserPrompt(prompt) {
  if (isBusy) return;
  const cleanPrompt = prompt.trim();
  if (!cleanPrompt) return;

  updateLatestExchange('user', cleanPrompt);
  appendChatBubble('user', cleanPrompt);

  isBusy = true;
  setListeningState('Thinking…', true);
  try {
    const { answer, identifiedSpeaker } = await postJson('/brain/ask', {
      prompt: cleanPrompt,
      personName: activePerson ?? undefined,
      audioBase64: lastAudioBase64 || undefined,
      location: clientLocation || undefined,
      history: conversationHistory,
    });

    if (identifiedSpeaker && !activePerson) {
      activePerson = identifiedSpeaker;
      presenceCache.lastSeenName = identifiedSpeaker;
      presenceCache.lastSeenTimestamp = Date.now();
      previewTarget.textContent = identifiedSpeaker;
    }

    conversationHistory.push({ role: 'user', content: cleanPrompt });
    conversationHistory.push({ role: 'assistant', content: answer });
    while (conversationHistory.length > MAX_HISTORY_TURNS * 2) {
      conversationHistory.shift();
    }

    await speak(answer);
  } catch (err) {
    appendChatBubble('robot', `Brain error: ${err.message}`);
    setListeningState(running ? 'Listening' : 'Ready', false);
  } finally {
    isBusy = false;
  }
}

// ==========================================================================
// Event Listeners & Controls
// ==========================================================================
toggleCameraBtn.addEventListener('click', async () => {
  if (running) {
    running = false;
    clearInterval(scanTimer);
    if (continuousVisionTimer) clearInterval(continuousVisionTimer);
    stopListeningTemp();

    const stream = video.srcObject;
    if (stream) stream.getTracks().forEach((t) => t.stop());
    video.srcObject = null;

    cameraOffOverlay.classList.remove('hidden');
    previewTarget.textContent = 'You';
    previewStatus.textContent = 'Camera off';
    setListeningState('Ready · Tap Camera to start', false);
    return;
  }

  try {
    if (speechEnabled && 'speechSynthesis' in window) {
      window.speechSynthesis.speak(new SpeechSynthesisUtterance(''));
    }
    await loadFaceModels();

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
        audio: true,
      });
    } catch (mediaErr) {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
      });
    }

    video.srcObject = stream;
    video.setAttribute('playsinline', 'true');
    video.setAttribute('webkit-playsinline', 'true');
    await video.play().catch(() => {});

    cameraOffOverlay.classList.add('hidden');
    previewStatus.textContent = 'Camera active';

    // Geolocation
    if ('geolocation' in navigator) {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          clientLocation = {
            latitude: pos.coords.latitude,
            longitude: pos.coords.longitude,
          };
        },
        () => {},
        { enableHighAccuracy: false, timeout: 5000, maximumAge: 300000 },
      );
    }

    // Audio capture for voice descriptors
    try {
      const audioTrack = stream.getAudioTracks()[0];
      if (audioTrack && window.MediaRecorder) {
        const audioStream = new MediaStream([audioTrack]);
        audioMediaRecorder = new MediaRecorder(audioStream);
        audioMediaRecorder.ondataavailable = async (e) => {
          if (e.data && e.data.size > 0) {
            const reader = new FileReader();
            reader.onloadend = () => {
              const res = reader.result;
              if (typeof res === 'string') {
                lastAudioBase64 = res.split(',')[1] || null;
              }
            };
            reader.readAsDataURL(e.data);
          }
        };
        audioMediaRecorder.start(2000);
      }
    } catch {}

    running = true;
    if (SpeechRecognitionCtor && micEnabled) {
      startListening();
    }
    setListeningState('Listening · Always on', true);
    scanTimer = setInterval(scanFrame, SCAN_INTERVAL_MS);
    // Stream at high frame-rate cadence (every 300ms) with WebSocket backpressure
    continuousVisionTimer = setInterval(streamContinuousVision, 300);
  } catch (err) {
    appendChatBubble('robot', `Startup error: ${err.message}`);
    setListeningState('Error starting camera', false);
  }
});

toggleVoiceBtn.addEventListener('click', () => {
  micEnabled = !micEnabled;
  toggleVoiceBtn.classList.toggle('active-state', micEnabled);
  if (micEnabled && running) {
    startListening();
    setListeningState('Listening · Mic on', true);
  } else {
    stopListeningTemp();
    setListeningState('Muted · Mic off', false);
  }
});

toggleSpeechBtn.addEventListener('click', () => {
  speechEnabled = !speechEnabled;
  toggleSpeechBtn.classList.toggle('active-state', speechEnabled);
  toggleSpeechBtn.setAttribute('aria-pressed', String(speechEnabled));
  if (!speechEnabled) window.speechSynthesis?.cancel();
});

languageSelect.addEventListener('change', () => {
  const newLang = languageSelect.value;
  if (recognition) {
    recognition.lang = newLang;
    if (micEnabled && running && !isSpeaking) {
      stopListeningTemp();
      startListening();
    }
  }
});

// Chat Popup Toggle
openChatBtn.addEventListener('click', () => {
  chatPopupBackdrop.hidden = false;
  if (promptInput) promptInput.focus();
});

closeChatBtn.addEventListener('click', () => {
  chatPopupBackdrop.hidden = true;
});

chatPopupBackdrop.addEventListener('click', (e) => {
  if (e.target === chatPopupBackdrop) {
    chatPopupBackdrop.hidden = true;
  }
});

// Chat Form Submit
askForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const prompt = promptInput.value.trim();
  if (!prompt) return;
  promptInput.value = '';
  await handleUserPrompt(prompt);
});

// Registration Form Submit
personNameForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = personNameInput.value.trim();
  if (name) await completeRegistration(name);
});

setListeningState('Ready · Tap Camera icon to start', false);
