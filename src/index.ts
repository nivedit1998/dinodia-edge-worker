// Architecture: Cloudflare edge-worker module src/index.ts; handles ingress/routing or scheduled monitoring around the platform deployment targets. Keep Vercel/AWS selection and worker bindings aligned with the architecture map.
export interface Env {
  AWS_API_ORIGIN: string;
  VERCEL_APP_ORIGIN: string;
  DEFAULT_BACKEND: "vercel" | "aws";
  ENABLE_AWS_CANARY: "true" | "false";
  CANARY_IPS: string;
  CRON_SECRET: string;
  CRON_TARGET_URL?: string;
  HUB_AVAILABILITY_CRON_TARGET_URL?: string;
}

const DEFAULT_CRON_TARGET_URL =
  "https://app.dinodiasmartliving.com/api/cron/monitoring-snapshot";
const DEFAULT_HUB_AVAILABILITY_CRON_TARGET_URL =
  "https://app.dinodiasmartliving.com/api/cron/hub-availability";

interface ScheduledEventLike {
  cron: string;
  scheduledTime: number;
}

function parseAllowlist(raw: string): Set<string> {
  return new Set(
    raw
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
}

function getClientIp(request: Request): string | null {
  return (
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    null
  );
}

function pickBackend(request: Request, env: Env): "vercel" | "aws" {
  const awsCanaryEnabled = (env.ENABLE_AWS_CANARY || "").toLowerCase() === "true";
  if (!awsCanaryEnabled) return "vercel";

  const defaultBackend = env.DEFAULT_BACKEND === "aws" ? "aws" : "vercel";
  const clientIp = getClientIp(request);
  if (!clientIp) return defaultBackend;

  const allow = parseAllowlist(env.CANARY_IPS || "");
  if (allow.has(clientIp)) return "aws";

  return defaultBackend;
}

function buildUpstreamUrl(origin: string, requestUrl: URL): string {
  const upstream = new URL(origin);
  upstream.pathname = requestUrl.pathname;
  upstream.search = requestUrl.search;
  return upstream.toString();
}

function getCronTargetUrl(env: Env): string {
  const targetRaw = (env.CRON_TARGET_URL || "").trim() || DEFAULT_CRON_TARGET_URL;
  let url: URL;
  try {
    url = new URL(targetRaw);
  } catch {
    throw new Error(`[cron] Invalid CRON_TARGET_URL: ${targetRaw}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`[cron] Unsupported CRON_TARGET_URL protocol: ${url.protocol}`);
  }
  return url.toString();
}

function getHubAvailabilityCronTargetUrl(env: Env): string {
  const targetRaw = (env.HUB_AVAILABILITY_CRON_TARGET_URL || "").trim() || DEFAULT_HUB_AVAILABILITY_CRON_TARGET_URL;
  let url: URL;
  try {
    url = new URL(targetRaw);
  } catch {
    throw new Error(`[cron] Invalid HUB_AVAILABILITY_CRON_TARGET_URL: ${targetRaw}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`[cron] Unsupported HUB_AVAILABILITY_CRON_TARGET_URL protocol: ${url.protocol}`);
  }
  return url.toString();
}

function getRequestId(response: Response): string | null {
  return (
    response.headers.get("x-request-id") ||
    response.headers.get("cf-ray") ||
    response.headers.get("x-vercel-id") ||
    null
  );
}

function summarizeText(text: string, maxLen = 2048): string {
  const compact = (text || "").replace(/\s+/g, " ").trim();
  if (compact.length <= maxLen) return compact;
  return `${compact.slice(0, maxLen)}…`;
}

type SnapshotResponse = {
  ok?: boolean;
  degraded?: boolean;
  boiler?: {
    connections?: number;
    totalDevices?: number;
    boilerCount?: number;
    insertedCount?: number;
    failedConnections?: number;
  };
  connections?: number;
  skippedConnections?: number;
  totalDevices?: number;
  monitoredCount?: number;
  insertedCount?: number;
  failedConnections?: number;
  cleanup?: { ok?: boolean; error?: string | null };
};

async function triggerMonitoringSnapshot(env: Env): Promise<void> {
  const cronSecret = (env.CRON_SECRET || "").trim();
  if (!cronSecret) {
    throw new Error("[cron] Missing CRON_SECRET");
  }

  const targetUrl = getCronTargetUrl(env);
  const response = await fetch(targetUrl, {
    method: "GET",
    headers: {
      authorization: `Bearer ${cronSecret}`,
      "x-dinodia-cron-source": "cloudflare-worker",
    },
  });
  const requestId = getRequestId(response);

  if (!response.ok) {
    throw new Error(`[cron] Snapshot request failed (${response.status}) requestId=${requestId || "none"}`);
  }

  let parsed: SnapshotResponse | null = null;
  let rawText: string | null = null;
  try {
    rawText = await response.clone().text();
  } catch {
    rawText = null;
  }

  if (rawText) {
    try {
      parsed = JSON.parse(rawText) as SnapshotResponse;
    } catch {
      parsed = null;
    }
  }

  console.log("[cron] Snapshot request succeeded", {
    status: response.status,
    requestId,
  });

  if (parsed) {
    const summary = {
      ok: parsed.ok ?? null,
      degraded: parsed.degraded ?? null,
      requestId,
      boiler: {
        connections: parsed.boiler?.connections ?? null,
        boilerCount: parsed.boiler?.boilerCount ?? null,
        insertedCount: parsed.boiler?.insertedCount ?? null,
        failedConnections: parsed.boiler?.failedConnections ?? null,
      },
      monitoring: {
        connections: parsed.connections ?? null,
        skippedConnections: parsed.skippedConnections ?? null,
        insertedCount: parsed.insertedCount ?? null,
        failedConnections: parsed.failedConnections ?? null,
      },
      cleanupOk: parsed.cleanup?.ok ?? null,
    };

    if (parsed.degraded) {
      console.warn("[cron] Snapshot completed degraded", summary);
    } else {
      console.log("[cron] Snapshot summary", summary);
    }
  } else if (rawText) {
    console.warn("[cron] Snapshot response was not JSON", {
      requestId,
      body: summarizeText(rawText),
    });
  }
}

async function triggerHubAvailabilityCheck(env: Env): Promise<void> {
  const cronSecret = (env.CRON_SECRET || "").trim();
  if (!cronSecret) throw new Error("[cron] Missing CRON_SECRET");
  const targetUrl = getHubAvailabilityCronTargetUrl(env);
  const response = await fetch(targetUrl, {
    method: "GET",
    headers: {
      authorization: `Bearer ${cronSecret}`,
      "x-dinodia-cron-source": "cloudflare-worker",
    },
  });
  const requestId = getRequestId(response);
  if (!response.ok) {
    throw new Error(`[cron] Hub availability request failed (${response.status}) requestId=${requestId || "none"}`);
  }
  console.log("[cron] Hub availability check succeeded", { status: response.status, requestId });
}

export default {
  async scheduled(controller: ScheduledEventLike, env: Env): Promise<void> {
    console.log("[cron] Scheduled trigger started", {
      cron: controller.cron,
      scheduledTime: new Date(controller.scheduledTime).toISOString(),
    });
    if (controller.cron === "*/15 * * * *") {
      await triggerHubAvailabilityCheck(env);
    } else {
      await triggerMonitoringSnapshot(env);
    }
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (!url.pathname.startsWith("/api/")) {
      return fetch(request);
    }

    const backend = pickBackend(request, env);
    const origin = backend === "aws" ? env.AWS_API_ORIGIN : env.VERCEL_APP_ORIGIN;
    const upstreamUrl = buildUpstreamUrl(origin, url);

    const headers = new Headers(request.headers);
    // Ensure upstream app logic sees the original public host/proto (important for auth redirects).
    const originalHost = url.host;
    headers.set("host", originalHost);
    headers.set("x-forwarded-host", originalHost);
    headers.set("x-forwarded-proto", url.protocol.replace(":", ""));
    const clientIp = getClientIp(request);
    if (clientIp) headers.set("x-forwarded-for", clientIp);

    const upstreamRequest = new Request(upstreamUrl, {
      method: request.method,
      headers,
      body: request.body,
      redirect: "manual",
    });

    const upstreamResponse = await fetch(upstreamRequest);
    const responseHeaders = new Headers(upstreamResponse.headers);
    responseHeaders.set("x-dinodia-api-backend", backend);
    responseHeaders.set("x-dinodia-canary", backend === "aws" ? "1" : "0");
    responseHeaders.set("x-dinodia-worker", "phase5-v1");

    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: responseHeaders,
    });
  },
};
