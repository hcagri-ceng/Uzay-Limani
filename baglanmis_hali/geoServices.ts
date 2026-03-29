/**
 * Rakım: OpenTopoData (SRTM) → yedek Open Elevation; 5 nokta eğim %.
 * Lojistik: Overpass API (OSM) — Python services ile aynı sorgu şablonları.
 */
import nodeHttp from "node:http";
import nodeHttps from "node:https";
import axios, { AxiosInstance } from "axios";

const EARTH_R_M = 6_371_000;

function toRad(d: number) {
  return (d * Math.PI) / 180;
}

/** Jeodezik hedef nokta (WGS84 küre), bearing derece (0 = Kuzey). */
export function destinationPoint(lat: number, lon: number, distanceM: number, bearingDeg: number): [number, number] {
  const δ = distanceM / EARTH_R_M;
  const θ = toRad(bearingDeg);
  const φ1 = toRad(lat);
  const λ1 = toRad(lon);
  const sinφ1 = Math.sin(φ1);
  const cosφ1 = Math.cos(φ1);
  const sinδ = Math.sin(δ);
  const cosδ = Math.cos(δ);
  const sinφ2 = sinφ1 * cosδ + cosφ1 * sinδ * Math.cos(θ);
  const φ2 = Math.asin(Math.min(1, Math.max(-1, sinφ2)));
  const y = Math.sin(θ) * sinδ * cosφ1;
  const x = cosδ - sinφ1 * sinφ2;
  const λ2 = λ1 + Math.atan2(y, x);
  const lat2 = (φ2 * 180) / Math.PI;
  let lon2 = (λ2 * 180) / Math.PI;
  lon2 = ((lon2 + 540) % 360) - 180;
  return [lat2, lon2];
}

export function buildCardinalSamplePoints(lat: number, lon: number, radiusM: number): [number, number][] {
  const points: [number, number][] = [[lat, lon]];
  for (const b of [0, 90, 180, 270] as const) {
    points.push(destinationPoint(lat, lon, radiusM, b));
  }
  return points;
}

export function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δφ = toRad(lat2 - lat1);
  const Δλ = toRad(lon2 - lon1);
  const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(Math.min(1, a)), Math.sqrt(Math.max(0, 1 - a)));
  return EARTH_R_M * c;
}

export function computeMaxSlopePercent(
  points: [number, number][],
  elevationsM: number[]
): { maxSlope: number; grades: number[] } {
  if (points.length < 5 || elevationsM.length < 5) {
    throw new Error("Need 5 points and 5 elevations");
  }
  const [olat, olon] = points[0];
  const z0 = elevationsM[0];
  const grades: number[] = [];
  for (let i = 1; i < 5; i++) {
    const h = haversineM(olat, olon, points[i][0], points[i][1]);
    if (h <= 1) grades.push(0);
    else grades.push((Math.abs(elevationsM[i] - z0) / h) * 100);
  }
  return { maxSlope: Math.max(...grades), grades };
}

function parseEnvFloat(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function parseEnvBool(key: string, fallback: boolean): boolean {
  const v = process.env[key]?.trim().toLowerCase();
  if (v === "true" || v === "1" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "no") return false;
  return fallback;
}

function overpassUrls(): string[] {
  const raw =
    process.env.OVERPASS_INTERPRETER_URL ||
    "https://overpass-api.de/api/interpreter,https://overpass.kumi.systems/api/interpreter";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const httpClient: AxiosInstance = axios.create({
  headers: { "User-Agent": "SpaceportSim/1.0 (Node; educational)" },
  validateStatus: () => true,
});

/** Overpass: keep-alive kapalı + sıralı istek; ardışık simülasyonlarda 429/az oturum sorununu azaltır. */
const overpassClient: AxiosInstance = axios.create({
  headers: {
    "User-Agent": "SpaceportSim/1.0 (Node; educational)",
    "Content-Type": "application/x-www-form-urlencoded",
  },
  validateStatus: () => true,
  httpAgent: new nodeHttp.Agent({ keepAlive: false }),
  httpsAgent: new nodeHttps.Agent({ keepAlive: false }),
});

async function fetchOpenTopoDataElevations(
  points: [number, number][],
  baseUrl: string,
  dataset: string,
  timeoutMs: number
): Promise<{ elevations: number[] } | { error: string }> {
  const locs = points.map(([la, lo]) => `${la.toFixed(7)},${lo.toFixed(7)}`).join("|");
  const url = `${baseUrl.replace(/\/$/, "")}/${dataset.replace(/^\//, "")}`;
  try {
    const res = await httpClient.get(url, {
      params: { locations: locs },
      timeout: timeoutMs,
    });
    if (res.status !== 200) {
      return { error: `OpenTopoData HTTP ${res.status}` };
    }
    const data = res.data as { results?: { elevation?: number | null }[] };
    const results = data.results;
    if (!Array.isArray(results) || results.length !== points.length) {
      return { error: "OpenTopoData results length mismatch" };
    }
    const elevations: number[] = [];
    for (let i = 0; i < results.length; i++) {
      const ev = results[i]?.elevation;
      if (ev == null || !Number.isFinite(Number(ev))) {
        return { error: `OpenTopoData missing elevation at #${i}` };
      }
      elevations.push(Number(ev));
    }
    return { elevations };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { error: `OpenTopoData network: ${msg}` };
  }
}

async function fetchOpenElevationElevations(
  points: [number, number][],
  baseUrl: string,
  timeoutMs: number
): Promise<{ elevations: number[] } | { error: string }> {
  const url = `${baseUrl.replace(/\/$/, "")}/lookup`;
  const body = {
    locations: points.map(([latitude, longitude]) => ({ latitude, longitude })),
  };
  try {
    const res = await httpClient.post(url, body, {
      timeout: timeoutMs,
      headers: { "Content-Type": "application/json" },
    });
    if (res.status !== 200) {
      return { error: `Open Elevation HTTP ${res.status}` };
    }
    const data = res.data as { results?: { elevation?: number }[] };
    const results = data.results;
    if (!Array.isArray(results) || results.length !== points.length) {
      return { error: "Open Elevation results length mismatch" };
    }
    const elevations = results.map((r, i) => {
      const ev = r?.elevation;
      if (!Number.isFinite(Number(ev))) throw new Error(`bad elev ${i}`);
      return Number(ev);
    });
    return { elevations };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { error: `Open Elevation: ${msg}` };
  }
}

export type ElevationContext = {
  evaluated: boolean;
  mock?: boolean;
  provider?: string | null;
  elevation_m?: number | null;
  slope_percent_max?: number | null;
  slope_per_direction_percent?: number[] | null;
  sample_radius_m?: number;
  sample_points_count?: number;
  error?: string | null;
};

export async function fetchElevationContext(lat: number, lon: number): Promise<ElevationContext> {
  const radius = parseEnvFloat("ELEVATION_SAMPLE_RADIUS_M", 150);
  const timeoutMs = parseEnvFloat("ELEVATION_HTTP_TIMEOUT_S", 28) * 1000;
  const preferOtd = parseEnvBool("ELEVATION_PREFER_OPENTOPODATA", true);
  const baseOtd = process.env.OPENTOPODATA_API_BASE_URL || "https://api.opentopodata.org/v1";
  const dataset = process.env.ELEVATION_OPENTOPODATA_DATASET || "srtm30m";
  const baseOe = process.env.OPEN_ELEVATION_BASE_URL || "https://api.open-elevation.com/api/v1";

  const points = buildCardinalSamplePoints(lat, lon, radius);
  const errors: string[] = [];

  let elevations: number[] | null = null;
  let provider: string | null = null;

  if (preferOtd) {
    const r = await fetchOpenTopoDataElevations(points, baseOtd, dataset, timeoutMs);
    if ("elevations" in r) {
      elevations = r.elevations;
      provider = "opentopodata";
    } else {
      errors.push(r.error);
    }
  }

  if (elevations === null) {
    const r = await fetchOpenElevationElevations(points, baseOe, timeoutMs);
    if ("elevations" in r) {
      elevations = r.elevations;
      provider = "open-elevation.com";
    } else {
      errors.push(r.error);
    }
  }

  if (elevations === null) {
    return {
      evaluated: false,
      mock: false,
      provider: null,
      elevation_m: null,
      slope_percent_max: null,
      slope_per_direction_percent: null,
      sample_radius_m: radius,
      sample_points_count: points.length,
      error: errors.join(" | ") || "Elevation providers failed",
    };
  }

  let maxSlope: number;
  let grades: number[];
  try {
    const s = computeMaxSlopePercent(points, elevations);
    maxSlope = s.maxSlope;
    grades = s.grades;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      evaluated: false,
      mock: false,
      provider: null,
      elevation_m: elevations[0],
      slope_percent_max: null,
      slope_per_direction_percent: null,
      sample_radius_m: radius,
      sample_points_count: points.length,
      error: msg,
    };
  }

  return {
    evaluated: true,
    mock: false,
    provider,
    elevation_m: elevations[0],
    slope_percent_max: Math.round(maxSlope * 10000) / 10000,
    slope_per_direction_percent: grades.map((g) => Math.round(g * 10000) / 10000),
    sample_radius_m: radius,
    sample_points_count: points.length,
    error: null,
  };
}

// --- Overpass ---

function maritimeQuery(lat: number, lon: number, radiusM: number, includePiers: boolean): string {
  const la = lat.toFixed(7);
  const lo = lon.toFixed(7);
  const r = Math.round(radiusM);
  const pierBlock = includePiers ? `\n  nwr["man_made"="pier"](around:${r},${la},${lo});` : "";
  return `[out:json][timeout:45];
(
  nwr["harbour"](around:${r},${la},${lo});
  nwr["landuse"="harbour"](around:${r},${la},${lo});
  nwr["amenity"="ferry_terminal"](around:${r},${la},${lo});${pierBlock}
);
out center;
`;
}

function railQuery(lat: number, lon: number, radiusM: number): string {
  const la = lat.toFixed(7);
  const lo = lon.toFixed(7);
  const r = Math.round(radiusM);
  return `[out:json][timeout:45];
(
  nwr["railway"="rail"](around:${r},${la},${lo});
);
out center;
`;
}

function roadQuery(lat: number, lon: number, radiusM: number): string {
  const la = lat.toFixed(7);
  const lo = lon.toFixed(7);
  const r = Math.round(radiusM);
  return `[out:json][timeout:45];
(
  nwr["highway"="motorway"](around:${r},${la},${lo});
  nwr["highway"="motorway_link"](around:${r},${la},${lo});
  nwr["highway"="trunk"](around:${r},${la},${lo});
  nwr["highway"="trunk_link"](around:${r},${la},${lo});
);
out center;
`;
}

type OsmElement = Record<string, unknown>;

function elementCenterLatLon(el: OsmElement): [number, number] | null {
  const typ = el.type;
  if (typ === "node") {
    const la = el.lat;
    const lo = el.lon;
    if (typeof la === "number" && typeof lo === "number") return [la, lo];
    return null;
  }
  if (typ === "way" || typ === "relation") {
    const c = el.center as Record<string, unknown> | undefined;
    if (c && typeof c.lat === "number" && typeof c.lon === "number") return [c.lat, c.lon];
  }
  return null;
}

function layerMinDistanceM(elements: OsmElement[] | null | undefined, olat: number, olon: number): { minM: number | null; count: number } {
  if (!elements?.length) return { minM: null, count: 0 };
  let best = Infinity;
  let n = 0;
  for (const el of elements) {
    const pt = elementCenterLatLon(el);
    if (!pt) continue;
    n++;
    const d = haversineM(olat, olon, pt[0], pt[1]);
    if (d < best) best = d;
  }
  if (n === 0) return { minM: null, count: 0 };
  return { minM: best, count: n };
}

function parseEnvInt(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined || v === "") return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

async function postOverpass(
  urls: string[],
  query: string,
  timeoutMs: number
): Promise<{ elements: OsmElement[] } | { error: string }> {
  const maxRounds = Math.max(1, parseEnvInt("OVERPASS_MAX_RETRY_ROUNDS", 5));
  let lastErr = "No Overpass URL";

  for (let round = 0; round < maxRounds; round++) {
    if (round > 0) {
      const backoff = 900 * round * round + Math.floor(Math.random() * 600);
      await sleep(backoff);
    }

    for (const url of urls) {
      try {
        const params = new URLSearchParams();
        params.set("data", query);
        const res = await overpassClient.post(url, params.toString(), {
          timeout: timeoutMs,
        });
        if (res.status === 200) {
          const data = res.data as { elements?: OsmElement[]; remark?: string };
          if (!Array.isArray(data.elements)) {
            lastErr = "Invalid Overpass response (no elements array)";
            continue;
          }
          return { elements: data.elements };
        }

        const snippet = typeof res.data === "string" ? res.data.slice(0, 160) : "";
        lastErr = `HTTP ${res.status}${snippet ? `: ${snippet}` : ""}`;

        if ([429, 502, 503, 504].includes(res.status)) {
          continue;
        }
        return { error: lastErr };
      } catch (e: unknown) {
        lastErr = e instanceof Error ? e.message : String(e);
      }
    }
  }

  return { error: lastErr };
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export type LogisticsContext = {
  evaluated: boolean;
  mock?: boolean;
  maritime_min_m: number | null;
  rail_min_m: number | null;
  motorway_min_m: number | null;
  counts: { maritime: number; rail: number; motorway: number };
  port_rail_radius_m: number;
  motorway_radius_m: number;
  maritime_layer_ok: boolean;
  rail_layer_ok: boolean;
  motorway_layer_ok: boolean;
  error: string | null;
};

export async function fetchLogisticsContext(lat: number, lon: number): Promise<LogisticsContext> {
  const rp = Math.round(parseEnvFloat("LOGISTICS_PORT_RAIL_RADIUS_M", 30_000));
  const rm = Math.round(parseEnvFloat("LOGISTICS_MOTORWAY_RADIUS_M", 20_000));
  const timeoutMs = Math.min(55_000, Math.max(35_000, (parseEnvFloat("OVERPASS_TIMEOUT_S", 30) / 3) * 1000));
  /** Ardışık istekler: aynı anda 2 POST çoğu Overpass örneğinde 429 üretir. */
  const gapMs = parseEnvFloat("OVERPASS_REQUEST_GAP_S", 1.25) * 1000;
  const includePiers = parseEnvBool("LOGISTICS_INCLUDE_PIERS", false);
  const urls = overpassUrls();

  const qM = maritimeQuery(lat, lon, rp, includePiers);
  const qR = railQuery(lat, lon, rp);
  const qO = roadQuery(lat, lon, rm);

  const mRes = await postOverpass(urls, qM, timeoutMs);
  await sleep(gapMs);
  const rRes = await postOverpass(urls, qR, timeoutMs);
  await sleep(gapMs);
  const oRes = await postOverpass(urls, qO, timeoutMs);

  const maritimeOk = "elements" in mRes;
  const railOk = "elements" in rRes;
  const roadOk = "elements" in oRes;

  const mEl = maritimeOk ? mRes.elements : null;
  const rEl = railOk ? rRes.elements : null;
  const oEl = roadOk ? oRes.elements : null;

  const mDist = layerMinDistanceM(mEl, lat, lon);
  const rDist = layerMinDistanceM(rEl, lat, lon);
  const oDist = layerMinDistanceM(oEl, lat, lon);

  if (!maritimeOk && !railOk && !roadOk) {
    const parts = [
      "error" in mRes ? mRes.error : "",
      "error" in rRes ? rRes.error : "",
      "error" in oRes ? oRes.error : "",
    ].filter(Boolean);
    return {
      evaluated: false,
      mock: false,
      maritime_min_m: null,
      rail_min_m: null,
      motorway_min_m: null,
      counts: { maritime: 0, rail: 0, motorway: 0 },
      port_rail_radius_m: rp,
      motorway_radius_m: rm,
      maritime_layer_ok: false,
      rail_layer_ok: false,
      motorway_layer_ok: false,
      error: parts.join("; ") || "All Overpass requests failed",
    };
  }

  const partialErrors = [
    !maritimeOk && "error" in mRes ? mRes.error : "",
    !railOk && "error" in rRes ? rRes.error : "",
    !roadOk && "error" in oRes ? oRes.error : "",
  ].filter(Boolean);

  return {
    evaluated: true,
    mock: false,
    maritime_min_m: maritimeOk ? mDist.minM : null,
    rail_min_m: railOk ? rDist.minM : null,
    motorway_min_m: roadOk ? oDist.minM : null,
    counts: {
      maritime: maritimeOk ? mDist.count : 0,
      rail: railOk ? rDist.count : 0,
      motorway: roadOk ? oDist.count : 0,
    },
    port_rail_radius_m: rp,
    motorway_radius_m: rm,
    maritime_layer_ok: maritimeOk,
    rail_layer_ok: railOk,
    motorway_layer_ok: roadOk,
    error: partialErrors.length ? partialErrors.join("; ") : null,
  };
}
