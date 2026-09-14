import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { TerminalError } from "../../../src/core/errors.ts";
import { defineWorkflow } from "../../../src/core/types.ts";
import type { Json, WorkflowContext } from "../../../src/core/types.ts";

/**
 * Acceptance application (design doc §17 Phase 7).
 *
 * Every external call lives inside `ctx.run()`, so a crash between two steps
 * replays the completed ones from the journal instead of re-calling the API.
 * The notification carries a deterministic idempotency key derived from the
 * invocation id, because external side effects are at-least-once.
 */

export interface FishingAdvisorInput {
  location?: string;
  latitude?: number;
  longitude?: number;
  timezone?: string;
  /** JSONL outbox; the notifier appends one line per advice. */
  outboxPath?: string;
}

export interface WeatherSnapshot {
  observedAt: string;
  temperature: number;
  precipitation: number;
  windSpeed: number;
  windGust: number;
  attribution: string;
}

export interface MarineSnapshot {
  observedAt: string;
  waveHeight: number;
  wavePeriod: number;
  attribution: string;
}

export interface FishingAdvice {
  location: string;
  recommendation: "good" | "acceptable" | "poor" | "avoid";
  score: number;
  reasons: string[];
  weather: WeatherSnapshot;
  marine: MarineSnapshot;
  evaluatedAt: string;
}

const DEFAULTS = {
  location: "Hakata Bay",
  latitude: 33.6,
  longitude: 130.35,
  timezone: "Asia/Tokyo",
  outboxPath: ".duex/fishing-outbox.jsonl",
};

interface ResolvedConfig {
  location: string;
  latitude: number;
  longitude: number;
  timezone: string;
  outboxPath: string;
}

export const fishingAdvisor = defineWorkflow<FishingAdvisorInput, FishingAdvice>({
  name: "fishing-advisor",
  version: "1",
  async run(ctx: WorkflowContext, input: FishingAdvisorInput): Promise<FishingAdvice> {
    const config = (await ctx.run("config.snapshot", () =>
      resolveConfig(input),
    )) as unknown as ResolvedConfig;

    const externalRetry = {
      retry: { maxAttempts: 5, initialDelayMs: 250, factor: 2, maxDelayMs: 5000 },
    };

    const weather = await ctx.run(
      "weather.fetch",
      () => fetchWeather(config),
      externalRetry,
    );
    const marine = await ctx.run(
      "marine.fetch",
      () => fetchMarine(config),
      externalRetry,
    );

    const evaluatedAt = await ctx.now("agent.clock");
    const advice = await ctx.run("agent.evaluate", () =>
      evaluate(config, weather, marine, evaluatedAt),
    );

    await ctx.run("notification.send", () =>
      notify(config, advice, `${ctx.invocationId}:notification.send`),
    );

    return advice;
  },
});

export function resolveConfig(input: FishingAdvisorInput | null): ResolvedConfig {
  return {
    location: input?.location ?? DEFAULTS.location,
    latitude: input?.latitude ?? DEFAULTS.latitude,
    longitude: input?.longitude ?? DEFAULTS.longitude,
    timezone: input?.timezone ?? DEFAULTS.timezone,
    outboxPath: input?.outboxPath ?? DEFAULTS.outboxPath,
  };
}

async function fetchJson(url: string): Promise<Record<string, unknown>> {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (response.status >= 400 && response.status < 500 && response.status !== 429) {
    // 4xx (other than rate limiting) will not fix itself on retry.
    throw new TerminalError(`${url} responded ${response.status} ${response.statusText}`);
  }
  if (!response.ok) {
    throw new Error(`${url} responded ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as Record<string, unknown>;
}

export async function fetchWeather(config: ResolvedConfig): Promise<WeatherSnapshot> {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${config.latitude}` +
    `&longitude=${config.longitude}&timezone=${encodeURIComponent(config.timezone)}` +
    `&current=temperature_2m,precipitation,wind_speed_10m,wind_gusts_10m`;
  const payload = await fetchJson(url);
  const current = (payload.current ?? {}) as Record<string, number | string>;
  return {
    observedAt: String(current.time ?? new Date().toISOString()),
    temperature: Number(current.temperature_2m ?? 0),
    precipitation: Number(current.precipitation ?? 0),
    windSpeed: Number(current.wind_speed_10m ?? 0),
    windGust: Number(current.wind_gusts_10m ?? 0),
    attribution: "Open-Meteo",
  };
}

export async function fetchMarine(config: ResolvedConfig): Promise<MarineSnapshot> {
  const url =
    `https://marine-api.open-meteo.com/v1/marine?latitude=${config.latitude}` +
    `&longitude=${config.longitude}&timezone=${encodeURIComponent(config.timezone)}` +
    `&current=wave_height,wave_period`;
  const payload = await fetchJson(url);
  const current = (payload.current ?? {}) as Record<string, number | string>;
  return {
    observedAt: String(current.time ?? new Date().toISOString()),
    waveHeight: Number(current.wave_height ?? 0),
    wavePeriod: Number(current.wave_period ?? 0),
    attribution: "Open-Meteo Marine",
  };
}

/** Pure scoring: deterministic given its inputs, so replay-safe. */
export function evaluate(
  config: ResolvedConfig,
  weather: WeatherSnapshot,
  marine: MarineSnapshot,
  evaluatedAt: Date,
): FishingAdvice {
  const reasons: string[] = [];
  let score = 100;

  if (weather.windSpeed > 25) {
    score -= 45;
    reasons.push(`wind ${weather.windSpeed} km/h is too strong`);
  } else if (weather.windSpeed > 15) {
    score -= 20;
    reasons.push(`wind ${weather.windSpeed} km/h is brisk`);
  }

  if (weather.precipitation > 2) {
    score -= 30;
    reasons.push(`precipitation ${weather.precipitation} mm`);
  } else if (weather.precipitation > 0) {
    score -= 10;
    reasons.push("light precipitation");
  }

  if (marine.waveHeight > 1.5) {
    score -= 40;
    reasons.push(`waves ${marine.waveHeight} m are high`);
  } else if (marine.waveHeight > 0.8) {
    score -= 15;
    reasons.push(`waves ${marine.waveHeight} m are moderate`);
  }

  if (reasons.length === 0) reasons.push("calm wind, dry sky and low waves");

  const clamped = Math.max(0, Math.min(100, score));
  const recommendation =
    clamped >= 80 ? "good" : clamped >= 60 ? "acceptable" : clamped >= 35 ? "poor" : "avoid";

  return {
    location: config.location,
    recommendation,
    score: clamped,
    reasons,
    weather,
    marine,
    evaluatedAt: evaluatedAt.toISOString(),
  };
}

/**
 * Append-only JSONL outbox. The idempotency key lets a downstream consumer
 * de-duplicate a line that a crash-and-replay wrote twice.
 */
export function notify(
  config: ResolvedConfig,
  advice: FishingAdvice,
  idempotencyKey: string,
): { idempotencyKey: string; outboxPath: string } {
  const path = resolve(config.outboxPath);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(
    path,
    `${JSON.stringify({
      idempotencyKey,
      sentAt: new Date().toISOString(),
      advice: advice as unknown as Json,
    })}\n`,
    "utf8",
  );
  return { idempotencyKey, outboxPath: path };
}
