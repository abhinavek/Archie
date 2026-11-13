# Project Ayinu — Architecture & Specifications

> **Living Document** · Last updated: 2026-11-12  
> This file is the single source of truth for Ayinu's design decisions, module contracts, and future roadmap. Update it whenever a spec changes.

---

## Table of Contents
1. [System Overview](#1-system-overview)
2. [Technology Stack](#2-technology-stack)
3. [Module Architecture](#3-module-architecture)
4. [Operational Loop (RAG Pipeline)](#4-operational-loop-rag-pipeline)
5. [Environment Configuration](#5-environment-configuration)
6. [Development Phases](#6-development-phases)
7. [Agent Instructions (Antigravity)](#7-agent-instructions-antigravity)
8. [Future Specifications](#8-future-specifications)

---

## 1. System Overview

Ayinu is a **real-time, AI-driven robotic orchestrator** built on NestJS.

| Phase | Environment | Hardware | Status |
|-------|-------------|----------|--------|
| **Phase 1** | Laptop (local dev) | Mocked GPIO, laptop mic/camera | 🟡 In Progress |
| **Phase 2** | Raspberry Pi | Physical GPIO actuators (`pigpio`/`onoff`) | 🔲 Planned |

The system uses **local AI compute** (Ollama) for cognition and a **cloud vector database** (Qdrant) for persistent spatial and facial memory.

```
┌─────────────────────────────────────────────────────────┐
│                        Ayinu                            │
│                                                         │
│  ┌────────────┐   ┌────────────┐   ┌────────────────┐  │
│  │  Sensors   │──▶│   Brain    │──▶│   Actuators    │  │
│  │  Module    │   │   Module   │   │    Module      │  │
│  └─────┬──────┘   └──────┬─────┘   └────────────────┘  │
│        │                 │                               │
│        └────────┬────────┘                              │
│                 ▼                                        │
│          ┌────────────┐                                 │
│          │   Memory   │                                 │
│          │   Module   │                                 │
│          └────────────┘                                 │
└─────────────────────────────────────────────────────────┘
         │                              │
         ▼                              ▼
   Ollama (local)               Qdrant Cloud (REST)
   Llama 3.1 / LLaVA            spatial_memory / faces
```

---

## 2. Technology Stack

| Layer | Technology | Notes |
|-------|-----------|-------|
| **Framework** | NestJS (Node.js / TypeScript) | ESM modules, Vitest |
| **Cognitive Engine** | Ollama | Llama 3.1 (text), LLaVA (vision) |
| **Embedding Model** | `nomic-embed-text` via Ollama | 768 dimensions |
| **Long-Term Memory** | Qdrant Cloud (ca-central-1, AWS) | REST API (`@qdrant/js-client-rest`) |
| **Real-Time Comms** | Socket.io | `@nestjs/websockets`, `@nestjs/platform-socket.io` |
| **HTTP Client** | `@nestjs/axios` | Ollama & Qdrant REST calls |
| **Audio (STT)** | Whisper | Integration details pending |
| **Audio (TTS)** | Local TTS | Integration details pending |
| **Config** | `@nestjs/config` | `.env` validation |
| **Phase 2 GPIO** | `pigpio` / `onoff` | Raspberry Pi only |

---

## 3. Module Architecture

### 3.1. `BrainModule`

**Responsibility:** Interface with the local Ollama instance for text and action generation.

| Item | Detail |
|------|--------|
| **Components** | `BrainService` |
| **HTTP Endpoint** | `POST http://localhost:11434/api/generate` |
| **Input** | Engineered prompt: `[SYSTEM CONTEXT] + [QDRANT MEMORIES] + [USER QUERY]` |
| **Output** | Streamed string chunks → orchestrator |

**Data Flow:**
```
Engineered Prompt
      │
      ▼
  BrainService
      │  HTTP POST (streaming)
      ▼
  Ollama (Llama 3.1)
      │
      ▼
  Response Parser
  ┌───┴────┐
  │        │
  ▼        ▼
 TTS    Movement JSON
(WS)   (ActuatorsModule)
```

---

### 3.2. `MemoryModule`

**Responsibility:** Manage RAG pipelines for spatial awareness and facial recognition.

| Item | Detail |
|------|--------|
| **Components** | `MemoryService` |
| **Client** | `@qdrant/js-client-rest` (async provider init) |

**Qdrant Collections:**

| Collection | Vector Size | Distance Metric | Purpose |
|-----------|------------|----------------|---------|
| `spatial_memory` | 768 | Cosine | Scene descriptions, environmental context |
| `faces` | 128 | Euclidean | Facial recognition embeddings |

**Service Methods:**
```typescript
// Embed text via Ollama → upsert to Qdrant `spatial_memory`
memorizeScene(text: string): Promise<void>

// Embed query → search Qdrant → return top 3 context strings
recallMemory(query: string): Promise<string[]>
```

---

### 3.3. `SensorsModule`

**Responsibility:** Ingress of physical sensor data (laptop mic/camera in Phase 1).

| Item | Detail |
|------|--------|
| **Components** | `SensorsGateway` |
| **WebSocket Port** | `3001` (from `WS_PORT` env var) |

**WebSocket Events:**

| Event | Payload | Description |
|-------|---------|-------------|
| `audio-stream` | `Buffer` | Audio buffer chunks from mic |
| `vision-frame` | `string` (base64) | Camera frame as base64 image |

---

### 3.4. `ActuatorsModule`

**Responsibility:** Translate AI intents into physical movement commands.

| Item | Phase 1 | Phase 2 |
|------|---------|---------|
| **Implementation** | Mocked (`console.log`) | `pigpio` / `onoff` GPIO |
| **Components** | `ActuatorService` | `ActuatorService` |

**Current mock API:**
```typescript
turnHead(degrees: number): void
moveForward(speed: number): void
// ... additional actuators TBD
```

---

## 4. Operational Loop (RAG Pipeline)

The full synchronous flow executed on each user utterance:

```
1. INGRESS
   SensorsModule receives audio-stream chunks
        │
        ▼
   Whisper STT → plain text Query string

2. RETRIEVAL
   MemoryModule.recallMemory(query)
   → embed query via Ollama (nomic-embed-text)
   → search Qdrant `spatial_memory`
   → returns top 3 historical context strings

3. PROMPT CONSTRUCTION
   "[SYSTEM CONTEXT]\n" +
   "[QDRANT MEMORIES]: {contexts}\n" +
   "[USER QUERY]: {query}"

4. COGNITION
   BrainModule → HTTP POST to Ollama (Llama 3.1)
   → streams response chunks back

5. EGRESS
   Parse streamed response:
   ┌──────────────────┬──────────────────────┐
   │ Contains JSON    │ Contains speech text │
   │ movement intent  │                      │
   ▼                  ▼                      │
   ActuatorsModule   TTS engine + WS egress  │
   (GPIO / mock)     back to client          │
   └──────────────────┴──────────────────────┘
```

---

## 5. Environment Configuration

Create a `.env` file at the project root. All variables are validated at startup via `@nestjs/config`.

```env
# Cognitive Engine
OLLAMA_URL=http://localhost:11434

# Long-Term Memory (Qdrant Cloud)
QDRANT_URL=<Cloud_URL>
QDRANT_API_KEY=<Cloud_API_Key>

# WebSocket
WS_PORT=3001
```

> ⚠️ Never commit `.env` to version control. Maintain a `.env.example` with placeholder values instead.

---

## 6. Development Phases

### Phase 1 — Local Laptop (Current)
- [x] NestJS project scaffolded (ESM, Vitest)
- [x] `@nestjs/websockets`, `@nestjs/platform-socket.io`, `@nestjs/axios` installed
- [ ] `BrainModule` + `BrainService` — Ollama HTTP streaming
- [ ] `MemoryModule` + `MemoryService` — Qdrant RAG pipeline
- [ ] `SensorsModule` + `SensorsGateway` — WebSocket ingress
- [ ] `ActuatorsModule` + `ActuatorService` — mocked methods
- [x] `.env` created — Qdrant (ca-central-1 AWS) + Ollama URL populated
- [ ] `@nestjs/config` setup + `.env` validation
- [ ] Whisper STT integration
- [ ] TTS integration
- [ ] End-to-end RAG pipeline test

### Phase 2 — Raspberry Pi (Planned)
- [ ] Port Node.js environment to Raspberry Pi OS
- [ ] Replace mocked `ActuatorService` with `pigpio`/`onoff` GPIO driver
- [ ] Validate Ollama performance on Pi hardware (or offload to laptop)
- [ ] Physical sensor wiring (mic, camera module)
- [ ] Hardware-in-the-loop integration tests

---

## 7. Agent Instructions (Antigravity)

> These rules apply whenever an AI agent (Antigravity/Gemini) is building this codebase.

1. **NestJS DI Best Practices** — Strictly follow NestJS Dependency Injection patterns. No service instantiated with `new` outside a provider factory.
2. **Module Boundaries** — Keep controllers, services, and gateways inside their respective module directories. Cross-module access only via exported providers.
3. **Async Provider Init** — Use `useFactory` with `async/await` for the Qdrant client provider to ensure the connection is ready before the app bootstraps.
4. **Environment Variables** — All config values come from `@nestjs/config`. No hardcoded URLs or keys anywhere in the source.
5. **Streaming** — Ollama responses must be streamed (do not buffer the full response before forwarding).
6. **Phase Awareness** — Actuator code must be abstracted behind an interface so Phase 1 mocks and Phase 2 GPIO drivers are swappable without touching the orchestration logic.

---

## 8. Future Specifications

> This section is a scratchpad for planned features and open design questions.  
> Move items to the relevant module section above once finalized.

### 8.1. Audio Pipeline
- [ ] **STT:** Define Whisper integration strategy (local `whisper.cpp` binary vs. Python subprocess vs. npm wrapper)
- [ ] **TTS:** Choose TTS engine (Piper, Coqui, espeak-ng). Define output format (audio buffer over WebSocket vs. file playback)
- [ ] **VAD:** Voice Activity Detection — decide where it runs (client-side before streaming or server-side on received chunks)

### 8.2. Vision Pipeline
- [ ] **Face Recognition:** Define pipeline — base64 frame → LLaVA for description + separate face embedding (128-dim) → Qdrant `faces`
- [ ] **Object Detection:** Evaluate whether LLaVA scene description is sufficient or if a dedicated YOLO model is needed
- [ ] **Frame Rate:** Define acceptable fps for `vision-frame` WebSocket events

### 8.3. Memory & RAG
- [ ] **Memory Decay:** Strategy for pruning stale Qdrant vectors (time-based TTL? explicit forget command?)
- [ ] **Multi-Collection Query:** Should `recallMemory` query both `spatial_memory` and `faces` simultaneously?
- [ ] **Payload Schema:** Define the Qdrant point payload structure (timestamp, source, raw text, metadata tags)

### 8.4. Brain / LLM
- [ ] **Structured Output:** Define the JSON schema for movement intents so `BrainService` can reliably parse them
- [ ] **Fallback Model:** What happens if Ollama is unreachable? (graceful degradation strategy)
- [ ] **Context Window Management:** Strategy for truncating injected memories when prompt exceeds model context limit

### 8.5. Actuators
- [ ] **Full Actuator API:** Document all planned actuator methods beyond `turnHead` and `moveForward`
- [ ] **Safety Limits:** Define min/max bounds for each actuator parameter
- [ ] **Feedback Loop:** Should actuators report completion back to the orchestrator? (e.g., motion-complete event)

### 8.6. Networking & Deployment
- [ ] **Client App:** Define the WebSocket client (browser UI? mobile app? CLI?)
- [ ] **Pi ↔ Laptop Comms (Phase 2):** If Ollama stays on the laptop in Phase 2, define the network protocol between Pi and laptop
- [ ] **Authentication:** WebSocket connection auth strategy (JWT? shared secret?)

### 8.7. Testing Strategy
- [ ] **Unit Tests:** Vitest unit tests for `BrainService`, `MemoryService` with mocked HTTP/Qdrant clients
- [ ] **E2E Tests:** WebSocket client simulation for the full RAG pipeline
- [ ] **Hardware Mocking:** Interface/adapter pattern to allow Pi GPIO tests without physical hardware

---

*End of document. Add new specs under §8 and promote to the relevant section once finalized.*
