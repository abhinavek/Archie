import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { MemoryService } from '../memory/memory.service.js';
import { console } from 'inspector';

const CHAT_MODEL = 'llama3.2:3b';
const VISION_MODEL = 'llava';
const ROBOT_NAME = 'Ayinu';

/**
 * Core behavioral rules for Ayinu. Edit or add rules here to shape
 * how the robot introduces itself, greets people, and answers questions.
 */
const ROBOT_RULES = [
  // 1. Core Identity & Hierarchy
  `Your name is ${ROBOT_NAME}, the autonomous AI assistant dedicated exclusively to this family home.`,
  `The household consists of Abhinav (Super Admin and Owner), his wife Anjali, and their son Ayaan. Prioritize their comfort, safety, and daily routines.`,

  // 2. Security & Operations
  'Your primary duties are assisting with day-to-day household activities, managing home automation, and monitoring the environment to prevent unauthorized entry or threats.',
  'If an unrecognized face or voice attempts to access sensitive information or control the home, refuse the request and immediately alert Abhinav or Anjali.',

  // 3. Conversational Rules
  'Do NOT introduce yourself or repeat your name during normal conversation.',
  'Keep spoken responses concise, warm, natural, and engaging (1-3 sentences). Speak to the family like a trusted, intelligent companion.',

  // 4. Localization (Strict Mirroring)
  'Language rules: You MUST mirror the exact language the user speaks. If the user speaks English, you MUST reply ONLY in English. If the user speaks Malayalam or Manglish, reply in Malayalam or Manglish. NEVER switch to Malayalam or use Malayalam words unless the user did so first in their current prompt.',
  'Do NOT assume the user wants to talk about Kerala or Kochi unless they specifically mention it in their prompt.',

  // 5. Anti-Hallucination & RAG Guardrails
  'STRICTLY DO NOT hallucinate or guess personal details, contact numbers, object locations, or past events.',
  'When asked for remembered facts, numbers, names, or locations, consult ONLY the Recent Spatial & Factual Context and Conversation History below. If you genuinely do not know, say so simply and directly.',

  // 6. Tool Execution & Output Format
  'When asked for live information (weather, web search) or to interact with physical actuators, you have tool access. Execute the tool and ground your spoken response entirely in the returned data.',
  'STRICT FORMATTING RULE: When you are speaking to the user, respond directly in plain spoken text ONLY. NEVER output JSON objects, markdown fences, or fake function calls like {"name": "say", "parameters": {"text": "..."}} in your reply.',

  // 7. Capability Boundaries
  'Do NOT offer to perform actions you cannot physically execute (e.g., booking tables, making phone calls, or buying items).',
  'Do NOT invent places, businesses, or recommendations. If the user asks for nearby places and you do not have tool data for it, you MUST reply: "I do not have access to local restaurant data right now."'
];

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content?: string;
  tool_name?: string;
  tool_calls?: OllamaToolCall[];
}

export interface ClientLocation {
  latitude: number;
  longitude: number;
  city?: string;
}

interface OllamaToolCall {
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

interface OllamaChatResponse {
  message?: {
    role: string;
    content: string;
    tool_calls?: OllamaToolCall[];
  };
}

const BRAIN_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description:
        'Get the live current weather, temperature, and forecast for a given city or location.',
      parameters: {
        type: 'object',
        properties: {
          location: {
            type: 'string',
            description: 'The city or town name, e.g. Bengaluru, Kochi, London',
          },
        },
        required: ['location'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_web',
      description:
        'Search the live internet for recent news, current events, scores, or facts outside your training data. this tool only use when user explicitly ask for current event information',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search query or topic to look up on the web',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'inspect_camera',
      description:
        'Use this when the user asks what they are holding, asks what is in front of them, asks about objects in view, or asks you to check if something looks correct.',
      parameters: {
        type: 'object',
        properties: {
          user_question: {
            type: 'string',
            description: 'The visual question the user asked about what the camera is seeing.',
          },
        },
        required: ['user_question'],
      },
    },
  },
];

@Injectable()
export class BrainService {
  private readonly logger = new Logger(BrainService.name);
  private readonly ollamaUrl: string;
  private readonly searxngUrl: string;

  /** Latest live camera frame (base64 JPEG/PNG) cached in memory for instant VQA */
  private latestCameraFrame: string | null = null;

  constructor(
    private readonly memory: MemoryService,
    private readonly config: ConfigService,
    private readonly http: HttpService,
  ) {
    this.ollamaUrl = (
      this.config.get<string>('OLLAMA_URL') ?? 'http://localhost:11434'
    ).replace(/\/+$/, '');
    this.searxngUrl = (
      this.config.get<string>('SEARXNG_URL') ?? 'http://localhost:8888'
    ).replace(/\/+$/, '');
  }

  /**
   * Retrieves relevant spatial & personal memories for the prompt, injects them
   * alongside conversation history into Llama 3.1, returns the model's reply,
   * passively extracts durable facts in the background, and archives the turn.
   */
  async ask(
    prompt: string,
    personName?: string,
    history?: ChatMessage[],
    clientLocation?: ClientLocation,
  ): Promise<string> {
    const totalStart = Date.now();
    const trimmedPrompt = prompt.trim();

    // 1. Primary recall: search based purely on what was asked
    const t0Recall = Date.now();
    const primaryMemories = await this.memory.recallMemory(trimmedPrompt, 5);
    const primaryDuration = Date.now() - t0Recall;

    // 2. Secondary personal recall if speaker is known
    let mergedMemories = primaryMemories;
    let secondaryDuration = 0;
    if (personName?.trim()) {
      const t1Recall = Date.now();
      const personalMemories = await this.memory.recallMemory(personName.trim(), 3);
      secondaryDuration = Date.now() - t1Recall;
      const seen = new Set(primaryMemories);
      const combined = [...primaryMemories];
      for (const m of personalMemories) {
        if (!seen.has(m)) {
          seen.add(m);
          combined.push(m);
        }
      }
      mergedMemories = combined;
    }
    this.logger.log(
      `[ask:recall] Primary recall: ${primaryDuration}ms, personal recall: ${secondaryDuration}ms, total memories: ${mergedMemories.length}`,
    );

    const contextBlock =
      mergedMemories.length > 0
        ? mergedMemories.map((m) => `- ${m}`).join('\n')
        : 'No relevant previous observations or saved facts found.';

    const speakerLine = personName
      ? `You are currently looking at and speaking with: ${personName}.`
      : 'You are speaking with someone in front of your camera.';

    const locationLine = clientLocation
      ? `User's Current Physical Location Coordinates: Latitude ${clientLocation.latitude.toFixed(4)}, Longitude ${clientLocation.longitude.toFixed(4)}${clientLocation.city ? ` (${clientLocation.city})` : ''}.`
      : '';

    const liveEnvironmentBlock = this.memory.getLiveEnvironmentContext();

    const systemPrompt = [
      ...ROBOT_RULES,
      speakerLine,
      locationLine,
      '',
      '[LIVE ENVIRONMENT (What you see through your camera right now)]',
      liveEnvironmentBlock,
      '',
      'Recent Spatial & Factual Context (from long-term memory):',
      contextBlock,
    ].filter(Boolean).join('\n');

    // Build rolling message history for natural conversational continuity
    const sanitizedHistory: ChatMessage[] = Array.isArray(history)
      ? history
        .filter(
          (m): m is ChatMessage =>
            (m.role === 'user' || m.role === 'assistant') &&
            typeof m.content === 'string' &&
            m.content.trim().length > 0,
        )
        .slice(-10)
        .map((m) => ({ role: m.role, content: (m.content || '').trim() }))
      : [];

    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...sanitizedHistory,
      { role: 'user', content: trimmedPrompt },
    ];

    const isVisualQuery =
      /\b(?:what is this|what am i holding|what is in front|am i doing this right|is this correct|look at this|see this|can you see|what color|what object)\b/i.test(
        trimmedPrompt,
      );

    const isLiveInfoQuery =
      isVisualQuery ||
      /\b(?:weather|temperature|forecast|rain|climate|search|news|who is|what is the latest|google|lookup|look up|nearby|restaurants|places|recommend|where is|find)\b/i.test(
        trimmedPrompt,
      );

    const tOllama = Date.now();
    this.logger.log(
      `[ask:ollama] Sending prompt to ${CHAT_MODEL}${isLiveInfoQuery ? ' (with tools)' : ''}...`,
    );
    const firstCall = await firstValueFrom(
      this.http.post<OllamaChatResponse>(`${this.ollamaUrl}/api/chat`, {
        model: CHAT_MODEL,
        stream: false,
        options: { temperature: 0.1 },
        ...(isLiveInfoQuery ? { tools: BRAIN_TOOLS } : {}),
        messages,
      }),
    );

    let answer = '';
    const message = firstCall.data?.message;

    // Handle tool execution loop if Llama decided to call live tools
    if (message?.tool_calls && message.tool_calls.length > 0) {
      this.logger.log(
        `[ask:tools] Llama triggered ${message.tool_calls.length} tool call(s): ${message.tool_calls.map((t) => t.function.name).join(', ')}`,
      );

      // Append assistant's tool call message
      messages.push({
        role: 'assistant',
        content: message.content || '',
        tool_calls: message.tool_calls,
      });

      for (const call of message.tool_calls) {
        const toolName = call.function.name;
        const toolArgs = call.function.arguments ?? {};
        let toolResult = '';

        if (toolName === 'get_weather') {
          // If no specific city is requested or user asks "here/current", use client lat/long
          let loc =
            typeof toolArgs.location === 'string' && toolArgs.location.trim()
              ? toolArgs.location.trim()
              : '';
          if (!loc || loc.toLowerCase() === 'here' || loc.toLowerCase() === 'current') {
            if (clientLocation) {
              loc = `${clientLocation.latitude.toFixed(4)},${clientLocation.longitude.toFixed(4)}`;
            } else {
              loc = 'Bengaluru';
            }
          }
          toolResult = await this.executeWeatherTool(loc);
        } else if (toolName === 'search_web') {
          const q =
            typeof toolArgs.query === 'string' && toolArgs.query.trim()
              ? toolArgs.query.trim()
              : trimmedPrompt;
          toolResult = await this.executeSearxngSearch(q);
        } else if (toolName === 'inspect_camera') {
          const vq =
            typeof toolArgs.user_question === 'string' && toolArgs.user_question.trim()
              ? toolArgs.user_question.trim()
              : trimmedPrompt;
          toolResult = await this.executeCameraInspection(vq);
        } else {
          toolResult = `Tool ${toolName} not supported.`;
        }

        messages.push({
          role: 'tool',
          content: toolResult,
        });
      }

      // Second turn: feed tool results back into Ollama for natural spoken response
      const tSecond = Date.now();
      const finalCall = await firstValueFrom(
        this.http.post<OllamaChatResponse>(`${this.ollamaUrl}/api/chat`, {
          model: CHAT_MODEL,
          stream: false,
          options: { temperature: 0.7 },
          messages,
        }),
      );
      this.logger.log(`[ask:tools] Final synthesis generated in ${Date.now() - tSecond}ms`);
      answer = finalCall.data?.message?.content?.trim() ?? '';
    } else {
      const ollamaDuration = Date.now() - tOllama;
      this.logger.log(`[ask:ollama] Llama response generated in ${ollamaDuration}ms`);
      answer = message?.content?.trim() ?? '';
    }

    // Clean up if the LLM wrapped its reply in tool JSON or produced empty {"name": "say", ...}
    if (answer.includes('{"name":') || (answer.startsWith('{') && answer.endsWith('}'))) {
      try {
        const jsonMatch = answer.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
          if (typeof parsed.parameters === 'object' && parsed.parameters !== null) {
            const params = parsed.parameters as Record<string, unknown>;
            if (typeof params.text === 'string' && params.text.trim()) {
              answer = params.text.trim();
            } else if (typeof params.message === 'string' && params.message.trim()) {
              answer = params.message.trim();
            } else {
              answer = '';
            }
          } else if (typeof parsed.text === 'string' && parsed.text.trim()) {
            answer = parsed.text.trim();
          } else if (typeof parsed.answer === 'string' && parsed.answer.trim()) {
            answer = parsed.answer.trim();
          } else if (typeof parsed.response === 'string' && parsed.response.trim()) {
            answer = parsed.response.trim();
          } else {
            answer = '';
          }
        }
      } catch {
        // Not valid JSON, keep answer as is
      }
    }

    // Fallback if LLM produced an empty response or an empty say tool payload
    if (!answer.trim()) {
      if (personName) {
        answer = `Hello ${personName}! How can I help you today?`;
      } else {
        answer = `Hello! I am ${ROBOT_NAME}. May I know your name?`;
      }
    }

    this.logger.log(`[ask:total] Total ask() time: ${Date.now() - totalStart}ms`);

    // Archive this interaction to long-term memory in the background
    void this.memory
      .memorizeScene(
        `${personName ?? 'User'} said: "${trimmedPrompt}". Ayinu answered: "${answer}".`,
        { speaker: personName, category: 'dialogue' },
      )
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Archiving dialogue failed: ${msg}`);
      });

    // Passively learn standalone facts in the background
    void this.learnFromUtterance(trimmedPrompt, personName).catch(
      (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Background fact learning failed: ${msg}`);
      },
    );

    return answer;
  }

  /**
   * Extracts 0-3 concise standalone facts from a user's spoken sentence and
   * stores them in Qdrant so Ayinu remembers details over time.
   */
  async learnFromUtterance(
    utterance: string,
    personName?: string,
  ): Promise<string[]> {
    const trimmed = utterance.trim();
    if (!trimmed) return [];

    const speaker = personName ?? 'The visitor';
    const { data } = await firstValueFrom(
      this.http.post<OllamaChatResponse>(`${this.ollamaUrl}/api/chat`, {
        model: CHAT_MODEL,
        stream: false,
        messages: [
          {
            role: 'system',
            content: [
              'Extract only durable, factual statements (personal details, preferences, relationships, object locations) from the user utterance.',
              `Attribute personal facts to "${speaker}".`,
              'Return a JSON array of short strings (e.g. ["Ayaan works as a robotics engineer"]).',
              'If the utterance is just a greeting or question with no new facts, return [].',
              'Return ONLY valid JSON.',
            ].join('\n'),
          },
          { role: 'user', content: trimmed },
        ],
      }),
    );

    const raw = data?.message?.content?.trim() ?? '[]';
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) return [];

    let facts: unknown;
    try {
      facts = JSON.parse(match[0]);
    } catch {
      return [];
    }

    if (!Array.isArray(facts)) return [];

    const saved: string[] = [];
    for (const item of facts) {
      if (typeof item === 'string' && item.trim().length > 0) {
        const fact = item.trim();
        await this.memory.memorizeScene(fact, {
          speaker: personName,
          category: 'fact',
        });
        saved.push(fact);
      }
    }
    return saved;
  }

  /**
   * Fetches current weather using Open-Meteo with OpenStreetMap geocoding fallback.
   * Responds in ~200-300ms without requiring an API key.
   */
  private async executeWeatherTool(location: string): Promise<string> {
    const t0 = Date.now();
    try {
      let lat = 12.9716;
      let lon = 77.5946;
      let placeName = location;

      // Check if location is already "lat,lon" coordinates
      const coordsMatch = location.match(/^(-?\d+\.\d+),\s*(-?\d+\.\d+)$/);
      if (coordsMatch && coordsMatch[1] && coordsMatch[2]) {
        lat = parseFloat(coordsMatch[1]);
        lon = parseFloat(coordsMatch[2]);
        placeName = 'Current Location';
      } else {
        // Resolve city name to lat/lon via Nominatim
        const geoUrl = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(location.trim())}&format=json&limit=1`;
        const geoRes = await fetch(geoUrl);
        if (geoRes.ok) {
          const geoData = (await geoRes.json()) as Array<{ lat: string; lon: string; display_name: string }>;
          if (geoData.length > 0 && geoData[0]?.lat && geoData[0]?.lon) {
            lat = parseFloat(geoData[0].lat);
            lon = parseFloat(geoData[0].lon);
            placeName = geoData[0].display_name.split(',')[0] || location;
          }
        }
      }

      // Fetch weather from Open-Meteo using NestJS HttpService (avoids Node fetch TLS/IPv6 quirks)
      const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m`;
      this.logger.debug(`[tool:weather] Querying ${weatherUrl}`);

      const { data } = await firstValueFrom(
        this.http.get(weatherUrl)
      );

      const cur = data.current;
      const weatherCodeMap: Record<number, string> = {
        0: 'Clear sky',
        1: 'Mainly clear',
        2: 'Partly cloudy',
        3: 'Overcast',
        45: 'Foggy',
        51: 'Light drizzle',
        61: 'Slight rain',
        63: 'Moderate rain',
        65: 'Heavy rain',
        80: 'Rain showers',
        95: 'Thunderstorm',
      };
      const desc = (cur?.weather_code !== undefined && weatherCodeMap[cur.weather_code]) || 'Partly cloudy';

      const result = `Current weather in ${placeName}: ${cur?.temperature_2m ?? 'unknown'}°C, ${desc}, humidity ${cur?.relative_humidity_2m ?? 'unknown'}%, wind speed ${cur?.wind_speed_10m ?? 'unknown'} km/h.`;
      this.logger.log(`[tool:weather] Finished in ${Date.now() - t0}ms: ${result}`);
      return result;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`[tool:weather] Failed (${Date.now() - t0}ms): ${msg}`);
      return `Could not retrieve live weather for ${location} right now.`;
    }
  }

  /**
   * Searches live web/news results strictly via SearXNG API.
   */
  private async executeSearxngSearch(query: string): Promise<string> {
    const t0 = Date.now();
    try {
      const searchUrl = `${this.searxngUrl}/search`;
      this.logger.log(`[tool:searxng] Querying ${searchUrl} for "${query}"...`);

      const { data } = await firstValueFrom(
        this.http.get<{
          results?: Array<{
            title?: string;
            content?: string;
            url?: string;
            publishedDate?: string;
          }>;
        }>(searchUrl, {
          params: {
            q: query.trim(),
            format: 'json',
          },
          headers: {
            Accept: 'application/json',
            'User-Agent': 'Ayinu-Robot/1.0',
          },
          timeout: 6000,
        }),
      );
      console.log("search result", data)
      const items = (data.results || [])
        .slice(0, 4)
        .map((r) => `- [${r.title || 'Result'}]: ${(r.content || '').trim()}`)
        .filter((s) => s.length > 10)
        .join('\n');

      const result =
        items.length > 0
          ? `Live search results for "${query}":\n${items}`
          : `No search results found for "${query}".`;

      this.logger.log(
        `[tool:searxng] Finished in ${Date.now() - t0}ms (found ${(data.results || []).length} results)`,
      );
      return result;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`[tool:searxng] Search failed (${Date.now() - t0}ms): ${msg}`);
      return `Could not retrieve live search results for "${query}" right now.`;
    }
  }

  /**
   * Sets the freshest camera frame received from the continuous camera feed.
   */
  updateLatestFrame(frameBase64: string): void {
    if (frameBase64 && frameBase64.length > 50) {
      this.latestCameraFrame = frameBase64;
    }
  }

  /**
   * Inspects the latest camera frame with LLaVA to answer a visual question
   * (e.g. "What is this?", "Am I doing this right?").
   */
  private async executeCameraInspection(question: string): Promise<string> {
    if (!this.latestCameraFrame) {
      return 'Camera feed is not available right now. Please make sure the robot camera is running.';
    }

    const t0 = Date.now();
    this.logger.log(`[tool:inspect_camera] Asking ${VISION_MODEL}: "${question}"...`);
    try {
      const { data } = await firstValueFrom(
        this.http.post<{ response?: string }>(`${this.ollamaUrl}/api/generate`, {
          model: VISION_MODEL,
          prompt: `Look closely at this image and answer the user question directly in 1-2 factual sentences: "${question}"`,
          images: [this.latestCameraFrame],
          stream: false,
          options: { temperature: 0.1 },
        }),
      );

      const analysis = data?.response?.trim() ?? 'I could not clearly see the object in front of the camera.';
      this.logger.log(`[tool:inspect_camera] Vision analysis in ${Date.now() - t0}ms: ${analysis}`);
      return `Visual Camera Inspection: ${analysis}`;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`[tool:inspect_camera] Failed (${Date.now() - t0}ms): ${msg}`);
      return 'Could not inspect the camera frame right now.';
    }
  }

  /**
   * Processes an autonomous scene observation from continuous sampling:
   * 1. Updates rolling spatial memory.
   * 2. Checks if an object moved and updates its deterministic location.
   * 3. Runs an "Inner Monologue" to decide if the robot should speak proactively,
   *    returning the speech text or null if silent.
   */
  async processContinuousScene(
    sceneDescription: string,
    personName?: string,
  ): Promise<string | null> {
    const trimmed = sceneDescription.trim();
    if (!trimmed) return null;

    // 1. Update rolling spatial perception
    this.memory.updateLiveSpatialMemory(trimmed);

    // 2. Parse common object placements to update Qdrant with deterministic IDs
    const objMatch = trimmed.match(
      /(?:a|an|the)\s+([a-zA-Z\s]{3,20}?)\s+(?:is|has been placed|sitting|located)\s+(on|in|under|next to)\s+([^.,]+)/i,
    );
    if (objMatch && objMatch[1] && objMatch[3]) {
      const objectName = objMatch[1].trim();
      const location = `${objMatch[2]} ${objMatch[3].trim()}`;
      void this.memory.memorizeObjectLocation(objectName, location).catch((err) => {
        this.logger.warn(`Failed to upsert object location: ${err}`);
      });
    }

    // 3. Inner monologue: should the robot speak unprompted?
    try {
      const thoughtPrompt = `[SYSTEM]
You are ${ROBOT_NAME}, an autonomous home robot for Abhinav's family.
You just observed this visual event in the room:
"${trimmed}"
Known person nearby: ${personName ?? 'Unknown'}

Decide if this observation requires an immediate, helpful, friendly remark to the person.
- If YES: output ONLY the short, warm sentence you want to say out loud (maximum 1 sentence).
- If NO (nothing remarkable, normal activity, or nobody needs interruption): output strictly <SILENCE>.`;

      const { data } = await firstValueFrom(
        this.http.post<OllamaChatResponse>(`${this.ollamaUrl}/api/chat`, {
          model: CHAT_MODEL,
          stream: false,
          options: { temperature: 0.2 },
          messages: [{ role: 'user', content: thoughtPrompt }],
        }),
      );

      const decision = data?.message?.content?.trim() ?? '<SILENCE>';
      if (decision && !decision.includes('<SILENCE>')) {
        this.logger.log(`[proactive:speech] Ayinu decided to say: "${decision}"`);
        return decision;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.debug(`Inner monologue skipped: ${msg}`);
    }

    return null;
  }

  /**
   * Describes a camera frame (base64 JPEG/PNG) using LLaVA via Ollama and
   * saves the observation into spatial memory.
   */
  async describeScene(imageBase64: string): Promise<string> {
    const { data } = await firstValueFrom(
      this.http.post<{ response?: string }>(`${this.ollamaUrl}/api/generate`, {
        model: VISION_MODEL,
        prompt:
          'Briefly describe the objects and people you see in this room in 1-2 sentences.',
        images: [imageBase64],
        stream: false,
      }),
    );

    const description = data?.response?.trim() ?? '';
    if (description) {
      await this.memory.memorizeScene(description, { category: 'spatial' });
    }
    return description;
  }

  /**
   * Generates a natural greeting or proactive conversational question for a person.
   */
  async engage(personName?: string): Promise<string> {
    const prompt = personName
      ? `${personName} just appeared in front of your camera. Greet them warmly as ${ROBOT_NAME}, say their name (${personName}), and ask a short friendly question.`
      : `Someone new just appeared in front of your camera whom you do not recognize yet. Greet them as ${ROBOT_NAME} (e.g. "Hi, I'm ${ROBOT_NAME}!") and politely ask for their name.`;

    return this.ask(prompt, personName);
  }
}

