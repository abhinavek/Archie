const API_BASE_URL = 'http://localhost:3001';
const MODEL_URL =
  'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.14/model';

const GREET_COOLDOWN_MS = 60_000;
const PRESENCE_COOLDOWN_MS = 30_000;
const FACE_CHANGE_THRESHOLD = 0.6;
const FACE_CHANGE_STREAK_REQUIRED = 3;
const UNKNOWN_CONFIRMATIONS_REQUIRED = 3;
const SCAN_INTERVAL_MS = 1_200;

const video = document.getElementById('webcam');
const overlay = document.getElementById('overlay');
const statusDot = document.getElementById('statusDot');
const robotStateEl = document.getElementById('robotState');
const personBadge = document.getElementById('personBadge');
const toggleCameraBtn = document.getElementById('toggleCameraBtn');
const toggleVoiceBtn = document.getElementById('toggleVoiceBtn');
const toggleSpeechBtn = document.getElementById('toggleSpeechBtn');
const languageSelect = document.getElementById('languageSelect');
const registerForm = document.getElementById('registerForm');
const personNameInput = document.getElementById('personNameInput');
const memorizeForm = document.getElementById('memorizeForm');
const sceneInput = document.getElementById('sceneInput');
const askForm = document.getElementById('askForm');
const promptInput = document.getElementById('promptInput');
const chatLog = document.getElementById('chatLog');

let running = false;
let modelsLoaded = false;
let scanTimer = null;
let speechEnabled = true;
let micEnabled = false;
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

function setState(label, active = running) {
  robotStateEl.textContent = label;
  statusDot.classList.toggle('active', active);
}

function addMessage(role, text) {
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  div.textContent = text;
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
}

async function speak(text) {
  addMessage('robot', text);
  if (!speechEnabled || !('speechSynthesis' in window)) return;

  window.speechSynthesis.cancel();
  isSpeaking = true;
  stopListeningTemp();
  setState('Speaking…');

  await new Promise((resolve) => {
    const utter = new SpeechSynthesisUtterance(text);
    const selectedLang = languageSelect ? languageSelect.value : 'ml-IN';
    utter.lang = selectedLang;
    
    // Choose appropriate voice if available for Malayalam or selected language
    const voices = window.speechSynthesis.getVoices();
    const matchingVoice = voices.find(
      (v) => v.lang.toLowerCase() === selectedLang.toLowerCase() || v.lang.startsWith(selectedLang.split('-')[0]),
    );
    if (matchingVoice) {
      utter.voice = matchingVoice;
    }

    utter.rate = 1.0;
    utter.onend = resolve;
    utter.onerror = resolve;
    window.speechSynthesis.speak(utter);
  });

  isSpeaking = false;
  if (running) {
    setState(micEnabled ? 'Watching & Listening' : 'Watching');
    if (micEnabled) startListening();
  }
}

function initRecognition() {
  if (!SpeechRecognitionCtor) return null;
  const rec = new SpeechRecognitionCtor();
  rec.lang = languageSelect ? languageSelect.value : 'ml-IN';
  rec.interimResults = false;
  rec.continuous = true;

  rec.onresult = async (event) => {
    const last = event.results[event.results.length - 1];
    if (!last?.isFinal) return;
    const transcript = last[0].transcript.trim();
    if (!transcript || isSpeaking) return;

    if (awaitingName && pendingDescriptor) {
      // Look for intentional name statements like "my name is abhinav" or Malayalam "എന്റെ പേര് ..."
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
      // If it's short (1-2 words, under 20 chars), accept it directly as a spoken name
      const words = transcript.split(/\s+/).filter(Boolean);
      if (words.length <= 2 && transcript.length <= 20) {
        const cleaned = transcript.replace(/[^\w\s\u0D00-\u0D7F]/gi, '').trim();
        if (cleaned.length >= 2) {
          await completeRegistration(cleaned);
          return;
        }
      }
      // Otherwise ignore random background conversation while waiting for the name
      console.log('[Registration] Ignored background speech while waiting for name:', transcript);
      return;
    }

    // Allow user to correct/rename at any time
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
      try {
        rec.start();
      } catch {
        // Ignore if already started
      }
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
    // Ignore duplicate start
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

async function loadFaceModels() {
  if (modelsLoaded) return;
  if (!window.faceapi) {
    throw new Error('face-api.js failed to load from CDN.');
  }
  setState('Loading vision models…', false);
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
    // If no face is detected, do NOT clear activePerson if we already recognized someone.
    // Keep them locked in until a completely different face appears.
    if (presenceCache.lastSeenName && presenceCache.lastSeenName !== 'Unknown') {
      personBadge.textContent = `Present: ${presenceCache.lastSeenName}`;
      return;
    }

    // Only clear if an unknown person dropped out past cooldown
    if (
      presenceCache.lastSeenName === 'Unknown' &&
      now - presenceCache.lastSeenTimestamp > PRESENCE_COOLDOWN_MS
    ) {
      presenceCache.lastSeenName = null;
      presenceCache.lastDescriptor = null;
      presenceCache.differentFaceStreak = 0;
      presenceCache.unmatchedConfirmations = 0;
      activePerson = null;
      awaitingName = false;
      pendingDescriptor = null;
      registerForm.hidden = true;
      personBadge.textContent = 'No person detected';
    } else if (presenceCache.lastSeenName === 'Unknown') {
      personBadge.textContent = 'Waiting for name…';
    } else {
      personBadge.textContent = 'No person detected';
    }
    return;
  }

  const box = detection.detection.box;
  ctx.strokeStyle = activePerson ? '#22c55e' : '#f59e0b';
  ctx.lineWidth = 3;
  ctx.strokeRect(box.x, box.y, box.width, box.height);

  // Person is in frame — refresh presence clock
  presenceCache.lastSeenTimestamp = now;

  // Keep latest descriptor fresh in case we are waiting for an unknown user's name
  const descriptor = Array.from(detection.descriptor);
  if (awaitingName) {
    pendingDescriptor = descriptor;
    return;
  }

  // Once a person is identified, never call /recognize again unless a different face shows up
  if (
    presenceCache.lastSeenName &&
    presenceCache.lastSeenName !== 'Unknown' &&
    presenceCache.lastDescriptor
  ) {
    const dist = euclideanDistance(descriptor, presenceCache.lastDescriptor);
    if (dist < FACE_CHANGE_THRESHOLD) {
      presenceCache.differentFaceStreak = 0;
      return;
    }
    presenceCache.differentFaceStreak += 1;
    if (presenceCache.differentFaceStreak < FACE_CHANGE_STREAK_REQUIRED) {
      return;
    }
  }

  // Suspend vision API calls if another API call (e.g. ask/register/memorize) started
  if (isBusy || isSpeaking) return;

  isBusy = true;
  try {
    const result = await postJson('/brain/faces/recognize', { descriptor });

    if (result.matched && result.name) {
      presenceCache.unmatchedConfirmations = 0;
      presenceCache.differentFaceStreak = 0;
      presenceCache.lastDescriptor = descriptor;
      const isNewArrival = presenceCache.lastSeenName !== result.name;
      presenceCache.lastSeenName = result.name;

      activePerson = result.name;
      awaitingName = false;
      pendingDescriptor = null;
      registerForm.hidden = true;
      personBadge.textContent = `Recognized: ${result.name}`;

      const lastGreet = lastGreetedAt.get(result.name) ?? 0;
      if (isNewArrival && now - lastGreet > GREET_COOLDOWN_MS) {
        lastGreetedAt.set(result.name, now);
        setState(`Greeting ${result.name}…`);
        let greeting = `Hello ${result.name}! My name is Ayinu. Good to see you again—what can I help you with?`;
        try {
          const { answer } = await postJson('/brain/engage', {
            personName: result.name,
          });
          if (answer?.trim()) greeting = answer;
        } catch {
          // Fall back to instant spoken greeting if Ollama is unavailable
        }
        await speak(greeting);
      }
    } else {
      // Require 3 consecutive unmatched frames before declaring someone "not in db".
      // This prevents bad angles/lighting from triggering "Who is this?" on registered users.
      presenceCache.unmatchedConfirmations += 1;
      console.log(
        `[Vision] Unmatched face confirmation ${presenceCache.unmatchedConfirmations}/${UNKNOWN_CONFIRMATIONS_REQUIRED}`,
      );

      if (presenceCache.unmatchedConfirmations < UNKNOWN_CONFIRMATIONS_REQUIRED) {
        // Keep previous recognized state while confirming
        if (presenceCache.lastSeenName && presenceCache.lastSeenName !== 'Unknown') {
          personBadge.textContent = `Verifying… (${presenceCache.lastSeenName})`;
        } else {
          personBadge.textContent = 'Verifying face…';
        }
        return;
      }

      // 3 consecutive unmatched confirmations reached — this is genuinely a new/unregistered face
      const isNewUnknown = presenceCache.lastSeenName !== 'Unknown';
      presenceCache.lastSeenName = 'Unknown';
      presenceCache.lastDescriptor = null;
      presenceCache.differentFaceStreak = 0;
      activePerson = null;
      pendingDescriptor = descriptor;
      personBadge.textContent = 'Unknown person';
      registerForm.hidden = false;

      if (isNewUnknown && !awaitingName) {
        awaitingName = true;
        await speak('Hello, my name is Ayinu. Who is this?');
      }
    }
  } catch (err) {
    const hint = err.message.includes('(404)')
      ? ' — restart the NestJS backend (npm run start:dev) so /brain/faces/recognize is loaded.'
      : '';
    addMessage('system', `Vision error: ${err.message}${hint}`);
  } finally {
    isBusy = false;
  }
}

async function completeRegistration(name) {
  if (!pendingDescriptor || isBusy) return;
  isBusy = true;
  console.time('[Registration Flow]');
  console.log('[Registration] Sending /brain/faces/register for:', name);
  try {
    const t0 = performance.now();
    await postJson('/brain/faces/register', {
      name,
      descriptor: pendingDescriptor,
      audioBase64: lastAudioBase64 || undefined,
    });
    console.log(`[Registration] /brain/faces/register took ${(performance.now() - t0).toFixed(1)}ms`);

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
    personBadge.textContent = `Recognized: ${name}`;
    console.log('[Registration] Starting speech response...');
    await speak(`Nice to meet you, ${name}! I'll remember your face. How can I help you today?`);
    console.timeEnd('[Registration Flow]');
  } catch (err) {
    console.error('[Registration] Failed:', err);
    addMessage('system', `Registration failed: ${err.message}`);
  } finally {
    isBusy = false;
  }
}

async function handleUserPrompt(prompt) {
  if (isBusy) return;
  const cleanPrompt = prompt.trim();
  if (!cleanPrompt) return;

  const promptStart = performance.now();
  console.log(`%c[Prompt Start] "${cleanPrompt}"`, 'color: #38bdf8; font-weight: bold;');
  addMessage('user', cleanPrompt);
  isBusy = true;
  setState('Thinking…');
  try {
    const t0 = performance.now();
    const { answer, identifiedSpeaker } = await postJson('/brain/ask', {
      prompt: cleanPrompt,
      personName: activePerson ?? undefined,
      audioBase64: lastAudioBase64 || undefined,
      location: clientLocation || undefined,
      history: conversationHistory,
    });
    console.log(`%c[Prompt API] /brain/ask returned in ${(performance.now() - t0).toFixed(1)}ms`, 'color: #22c55e;');

    // If voice recognition identified the speaker, lock them in as activePerson
    if (identifiedSpeaker && !activePerson) {
      activePerson = identifiedSpeaker;
      presenceCache.lastSeenName = identifiedSpeaker;
      presenceCache.lastSeenTimestamp = Date.now();
      personBadge.textContent = `Recognized by Voice: ${identifiedSpeaker}`;
    }

    // Record turn in rolling local history for immediate conversational context
    conversationHistory.push({ role: 'user', content: cleanPrompt });
    conversationHistory.push({ role: 'assistant', content: answer });
    while (conversationHistory.length > MAX_HISTORY_TURNS * 2) {
      conversationHistory.shift();
    }

    const tSpeech = performance.now();
    await speak(answer);
    console.log(`%c[Prompt Total] End-to-end turn took ${(performance.now() - promptStart).toFixed(1)}ms (TTS: ${(performance.now() - tSpeech).toFixed(1)}ms)`, 'color: #f59e0b; font-weight: bold;');
  } catch (err) {
    addMessage('system', `Brain error: ${err.message}`);
    setState(running ? 'Watching' : 'Idle');
  } finally {
    isBusy = false;
  }
}

toggleCameraBtn.addEventListener('click', async () => {
  if (running) {
    running = false;
    clearInterval(scanTimer);
    stopListeningTemp();
    const stream = video.srcObject;
    if (stream) stream.getTracks().forEach((t) => t.stop());
    video.srcObject = null;
    toggleCameraBtn.textContent = 'Start Robot';
    toggleVoiceBtn.disabled = true;
    setState('Stopped', false);
    return;
  }

  try {
    // Unlock browser speech synthesis on direct user click
    if (speechEnabled && 'speechSynthesis' in window) {
      window.speechSynthesis.speak(new SpeechSynthesisUtterance(''));
    }
    await loadFaceModels();
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user' },
      audio: true,
    });
    video.srcObject = stream;

    // Acquire client geolocation coordinates (lat/long) for location-based tools
    if ('geolocation' in navigator) {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          clientLocation = {
            latitude: pos.coords.latitude,
            longitude: pos.coords.longitude,
          };
          console.log(`[Geo] Location acquired: ${clientLocation.latitude.toFixed(4)}, ${clientLocation.longitude.toFixed(4)}`);
        },
        (err) => {
          console.warn('[Geo] Location access skipped or denied:', err.message);
        },
        { enableHighAccuracy: false, timeout: 5000, maximumAge: 300000 },
      );
    }
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
        audioMediaRecorder.start(2000); // 2-second audio chunks
      }
    } catch (audioErr) {
      console.warn('Audio recorder setup note:', audioErr);
    }
    running = true;
    toggleCameraBtn.textContent = 'Stop Robot';
    toggleVoiceBtn.disabled = !SpeechRecognitionCtor;
    if (SpeechRecognitionCtor) {
      micEnabled = true;
      toggleVoiceBtn.textContent = 'Mic: On';
      startListening();
    } else {
      addMessage('system', 'Web SpeechRecognition not supported in this browser; use the text box below.');
    }
    setState(micEnabled ? 'Watching & Listening' : 'Watching');
    scanTimer = setInterval(scanFrame, SCAN_INTERVAL_MS);
  } catch (err) {
    addMessage('system', `Startup error: ${err.message}`);
    setState('Error', false);
  }
});

toggleVoiceBtn.addEventListener('click', () => {
  micEnabled = !micEnabled;
  toggleVoiceBtn.textContent = micEnabled ? 'Mic: On' : 'Mic: Off';
  if (micEnabled) startListening();
  else stopListeningTemp();
  setState(micEnabled ? 'Watching & Listening' : 'Watching');
});

toggleSpeechBtn.addEventListener('click', () => {
  speechEnabled = !speechEnabled;
  toggleSpeechBtn.textContent = speechEnabled ? 'Voice: On' : 'Voice: Off';
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
  addMessage('system', `Speech language switched to ${languageSelect.options[languageSelect.selectedIndex].text}`);
});

registerForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = personNameInput.value.trim();
  if (name) await completeRegistration(name);
});

memorizeForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (isBusy) return;
  const sceneText = sceneInput.value.trim();
  if (!sceneText) return;
  sceneInput.value = '';
  isBusy = true;
  try {
    await postJson('/brain/memorize', { sceneText });
    addMessage('system', `Memorized: "${sceneText}"`);
  } catch (err) {
    addMessage('system', `Memorize failed: ${err.message}`);
  } finally {
    isBusy = false;
  }
});

askForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const prompt = promptInput.value.trim();
  if (!prompt) return;
  promptInput.value = '';
  await handleUserPrompt(prompt);
});

setState('Ready — click Start Robot', false);
