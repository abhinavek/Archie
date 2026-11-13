import { randomUUID } from 'node:crypto';
import { HttpService } from '@nestjs/axios';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { QdrantClient } from '@qdrant/js-client-rest';
import { firstValueFrom } from 'rxjs';

/** Names of the Qdrant collections used by Ayinu. */
const COLLECTIONS = {
  SPATIAL_MEMORY: 'spatial_memory',
  FACES: 'faces',
  VOICES: 'voices',
} as const;

const EMBEDDING_MODEL = 'nomic-embed-text';
const RECALL_LIMIT = 5;
const FACE_MATCH_THRESHOLD = 0.6;
const VOICE_MATCH_THRESHOLD = 0.8;

interface OllamaEmbeddingsResponse {
  embedding: number[];
}

interface SpatialMemoryPayload {
  sceneText?: string;
  timestamp?: string;
  speaker?: string;
  category?: string;
}

interface FacePayload {
  personId?: string;
  name?: string;
  registeredAt?: string;
  details?: Record<string, unknown>;
}

export interface FaceRecognitionResult {
  matched: boolean;
  personId?: string;
  name?: string;
  distance?: number;
  details?: Record<string, unknown>;
}

export interface VoiceRecognitionResult {
  matched: boolean;
  personId?: string;
  name?: string;
  score?: number;
}

@Injectable()
export class MemoryService implements OnModuleInit {
  private readonly logger = new Logger(MemoryService.name);
  private client: QdrantClient;
  private readonly ollamaUrl: string;

  constructor(
    private readonly config: ConfigService,
    private readonly http: HttpService,
  ) {
    this.ollamaUrl = (
      this.config.get<string>('OLLAMA_URL') ?? 'http://localhost:11434'
    ).replace(/\/+$/, '');
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  async onModuleInit(): Promise<void> {
    // Initialise the Qdrant client for Qdrant Cloud (REST over HTTPS/443).
    //
    // The @qdrant/js-client-rest library ignores the port embedded in a bare
    // `url` string and falls back to its default of 6333 (self-hosted gRPC).
    // Parsing the URL and passing `host`, `port`, and `https` explicitly is
    // the only reliable way to force HTTPS/443 for cloud clusters.
    const rawUrl = this.config.getOrThrow<string>('QDRANT_URL');

    this.client = new QdrantClient({
      url: rawUrl,
      apiKey: this.config.getOrThrow<string>('QDRANT_API_KEY'),
      checkCompatibility: false,
      timeout: 30_000,
    });

    this.logger.log('QdrantClient initialised.');
    try {
      await this.ensureCollections();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Could not verify Qdrant collections on startup (${msg}). Server will continue, but memory calls may fail until Qdrant is reachable.`,
      );
    }
  }

  // ─── Collection bootstrap ─────────────────────────────────────────────────

  /**
   * Checks whether each required collection exists in Qdrant and creates it
   * if it does not. Called once during application startup.
   */
  private async ensureCollections(): Promise<void> {
    await Promise.all([
      this.ensureCollection(COLLECTIONS.SPATIAL_MEMORY, {
        size: 768,
        distance: 'Cosine',
      }),
      this.ensureCollection(COLLECTIONS.FACES, {
        size: 128,
        distance: 'Euclid',
      }),
      this.ensureCollection(COLLECTIONS.VOICES, {
        size: 512,
        distance: 'Cosine',
      }),
    ]);
  }

  /**
   * Creates a single Qdrant collection if it does not already exist.
   *
   * @param name     - Collection name.
   * @param params   - Vector configuration (size + distance metric).
   */
  private async ensureCollection(
    name: string,
    params: { size: number; distance: 'Cosine' | 'Euclid' | 'Dot' },
  ): Promise<void> {
    const { exists } = await this.client.collectionExists(name);
    if (exists) {
      this.logger.log(`Collection "${name}" already exists — skipping.`);
      return;
    }

    this.logger.log(`Collection "${name}" not found — creating…`);
    try {
      await this.client.createCollection(name, {
        vectors: {
          size: params.size,
          distance: params.distance,
        },
      });
      this.logger.log(
        `Collection "${name}" created (size=${params.size}, distance=${params.distance}).`,
      );
    } catch (err: unknown) {
      const status =
        typeof err === 'object' && err !== null && 'status' in err
          ? (err as { status?: number }).status
          : undefined;
      if (status === 409) {
        this.logger.log(`Collection "${name}" already exists — skipping.`);
        return;
      }
      throw err;
    }
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  /**
   * Converts a scene description to a 768-dim embedding (via Ollama) and
   * upserts it into the `spatial_memory` collection with a timestamp payload.
   *
   * @param sceneText - Plain-text scene description.
   */
  async memorizeScene(
    sceneText: string,
    metadata?: { speaker?: string; category?: string },
  ): Promise<void> {
    const trimmed = sceneText.trim();
    if (!trimmed) {
      return;
    }

    const vector = await this.embed(trimmed);
    await this.client.upsert(COLLECTIONS.SPATIAL_MEMORY, {
      wait: true,
      points: [
        {
          id: randomUUID(),
          vector,
          payload: {
            sceneText: trimmed,
            timestamp: new Date().toISOString(),
            ...(metadata?.speaker ? { speaker: metadata.speaker } : {}),
            ...(metadata?.category ? { category: metadata.category } : {}),
          },
        },
      ],
    });

    this.logger.debug(`Memorized scene: "${trimmed.slice(0, 60)}"`);
  }

  /**
   * Embeds a query string and returns the top matching memories from
   * the `spatial_memory` collection. Optionally accepts a custom limit.
   *
   * @param query - The user's question, keywords, or observation.
   * @param limit - Optional custom number of results (defaults to 5).
   * @returns     - Recalled context strings.
   */
  async recallMemory(query: string, limit = RECALL_LIMIT): Promise<string[]> {
    const trimmed = query.trim();
    if (!trimmed) {
      return [];
    }

    const t0 = Date.now();
    const vector = await this.embed(trimmed);
    const tEmbed = Date.now() - t0;

    const tQ = Date.now();
    const results = await this.client.query(COLLECTIONS.SPATIAL_MEMORY, {
      query: vector,
      limit,
      with_payload: true,
    });
    const tQuery = Date.now() - tQ;
    this.logger.debug(
      `[recallMemory] "${trimmed.slice(0, 30)}..." -> embed: ${tEmbed}ms, qdrant: ${tQuery}ms, points: ${results.points.length}`,
    );

    return results.points
      .map((point) => {
        const payload = (point.payload ?? {}) as SpatialMemoryPayload;
        if (!payload.sceneText) {
          return null;
        }
        return payload.timestamp
          ? `[${payload.timestamp}] ${payload.sceneText}`
          : payload.sceneText;
      })
      .filter((entry): entry is string => entry !== null);
  }

  /**
   * Searches the `faces` collection (128-dim Euclidean) for a matching person.
   */
  async recognizeFace(descriptor: number[]): Promise<FaceRecognitionResult> {
    if (!Array.isArray(descriptor) || descriptor.length !== 128) {
      throw new Error('Face descriptor must be a 128-dimensional array.');
    }

    const t0 = Date.now();
    const results = await this.client.query(COLLECTIONS.FACES, {
      query: descriptor,
      limit: 1,
      with_payload: true,
    });
    const duration = Date.now() - t0;

    const best = results.points[0];
    if (!best) {
      this.logger.debug(`[recognizeFace] No face match found (${duration}ms)`);
      return { matched: false };
    }

    const payload = (best.payload ?? {}) as FacePayload;
    const distance = best.score;
    if (distance <= FACE_MATCH_THRESHOLD && payload.name) {
      this.logger.log(
        `[recognizeFace] Matched "${payload.name}" in ${duration}ms (dist: ${distance?.toFixed(3)})`,
      );
      return {
        matched: true,
        personId: payload.personId,
        name: payload.name,
        distance,
        details: payload.details,
      };
    }

    this.logger.debug(
      `[recognizeFace] Unmatched face (dist: ${distance?.toFixed(3)} > ${FACE_MATCH_THRESHOLD}, ${duration}ms)`,
    );
    return { matched: false, distance };
  }

  /**
   * Searches the `voices` collection (512-dim Cosine) for a matching speaker.
   */
  async recognizeVoice(descriptor: number[]): Promise<VoiceRecognitionResult> {
    if (!Array.isArray(descriptor) || descriptor.length !== 512) {
      throw new Error('Voice descriptor must be a 512-dimensional array.');
    }

    const results = await this.client.query(COLLECTIONS.VOICES, {
      query: descriptor,
      limit: 1,
      score_threshold: VOICE_MATCH_THRESHOLD,
      with_payload: true,
    });

    const best = results.points[0];
    if (!best) {
      return { matched: false };
    }

    const payload = (best.payload ?? {}) as FacePayload;
    if (payload.name) {
      return {
        matched: true,
        personId: payload.personId,
        name: payload.name,
        score: best.score,
      };
    }

    return { matched: false, score: best.score };
  }

  /**
   * Registers a person's 128-dim face descriptor and (optionally) their
   * 512-dim voiceprint together under a shared `personId`.
   */
  async registerFace(
    name: string,
    descriptor: number[],
    details?: Record<string, unknown>,
    voiceDescriptor?: number[],
  ): Promise<{ personId: string; voiceSaved: boolean }> {
    const cleanName = name.trim();
    if (!cleanName) {
      throw new Error('Person name is required.');
    }
    if (!Array.isArray(descriptor) || descriptor.length !== 128) {
      throw new Error('Face descriptor must be a 128-dimensional array.');
    }
    if (
      voiceDescriptor !== undefined &&
      (!Array.isArray(voiceDescriptor) || voiceDescriptor.length !== 512)
    ) {
      throw new Error('Voice descriptor must be a 512-dimensional array.');
    }

    const personId = randomUUID();
    const registeredAt = new Date().toISOString();

    // Check if this face already exists in Qdrant so we update/rename rather than duplicating
    const existing = await this.recognizeFace(descriptor).catch(() => null);
    const targetId = existing?.matched && existing.personId ? existing.personId : personId;

    const tFace = Date.now();
    this.logger.log(`[registerFace] Upserting to "faces" collection for "${cleanName}" (${targetId})...`);
    await this.client.upsert(COLLECTIONS.FACES, {
      wait: true,
      points: [
        {
          id: targetId,
          vector: descriptor,
          payload: {
            personId: targetId,
            name: cleanName,
            registeredAt,
            ...(details ? { details } : {}),
          },
        },
      ],
    });
    this.logger.log(`[registerFace] "faces" upsert took ${Date.now() - tFace}ms`);

    let voiceSaved = false;
    if (voiceDescriptor) {
      const tVoice = Date.now();
      this.logger.log(`[registerFace] Upserting to "voices" collection...`);
      await this.client.upsert(COLLECTIONS.VOICES, {
        wait: true,
        points: [
          {
            id: targetId,
            vector: voiceDescriptor,
            payload: {
              personId: targetId,
              name: cleanName,
              registeredAt,
            },
          },
        ],
      });
      this.logger.log(`[registerFace] "voices" upsert took ${Date.now() - tVoice}ms`);
      voiceSaved = true;
    }

    this.logger.log(
      `Registered face${voiceSaved ? ' + voice' : ''} for "${cleanName}" (${targetId}).`,
    );
    return { personId: targetId, voiceSaved };
  }

  // ─── Embeddings ──────────────────────────────────────────────────────────

  /**
   * Requests a 768-dimensional embedding from the local Ollama server.
   */
  private async embed(text: string): Promise<number[]> {
    const url = `${this.ollamaUrl}/api/embeddings`;
    const { data } = await firstValueFrom(
      this.http.post<OllamaEmbeddingsResponse>(url, {
        model: EMBEDDING_MODEL,
        prompt: text,
      }),
    );

    if (!Array.isArray(data?.embedding) || data.embedding.length === 0) {
      throw new Error(
        `Ollama returned an invalid embedding for model "${EMBEDDING_MODEL}".`,
      );
    }

    return data.embedding;
  }
}
