import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import axios from "axios";
import {
  fetchElevationContext,
  fetchLogisticsContext,
  type ElevationContext,
  type LogisticsContext,
} from "./geoServices";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, ".env") });

enum GoNoGoStatus {
  GO = "go",
  NO_GO = "no_go",
  CONDITIONAL = "conditional",
}

enum LandingSurface {
  LAND = "land",
  WATER = "water",
}

function envFloat(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

async function fetchWeather(lat: number, lon: number) {
  const apiKey = process.env.WEATHER_API_KEY;
  if (!apiKey) {
    return { mock: true, temp_c: 25, wind_kph: 10, condition_text: "Mock Mode (No API Key)" };
  }
  try {
    const res = await axios.get(`https://api.weatherapi.com/v1/current.json?key=${apiKey}&q=${lat},${lon}`);
    return res.data.current;
  } catch (e) {
    console.error("Weather API Error:", e);
    return { error: true, messages: ["Weather service unavailable"] };
  }
}

function severityRank(s: GoNoGoStatus): number {
  return s === GoNoGoStatus.NO_GO ? 0 : s === GoNoGoStatus.CONDITIONAL ? 1 : 2;
}

function mergePhase(a: GoNoGoStatus, b: GoNoGoStatus): GoNoGoStatus {
  return severityRank(a) <= severityRank(b) ? a : b;
}

function liftToConditional(s: GoNoGoStatus): GoNoGoStatus {
  if (s === GoNoGoStatus.NO_GO) return s;
  return GoNoGoStatus.CONDITIONAL;
}

function buildElevationAssessment(ctx: ElevationContext, maxTerrainSlopePercent: number) {
  if (!ctx.evaluated) {
    return {
      evaluated: false,
      elevation_m: ctx.elevation_m ?? undefined,
      slope_percent: undefined as number | undefined,
      terrain_unsuitable: undefined as boolean | undefined,
      sample_radius_m: ctx.sample_radius_m,
      slope_per_direction_percent: undefined as number[] | undefined,
      messages: [`Elevation / slope unavailable: ${ctx.error || "unknown"}.`],
    };
  }
  const s = ctx.slope_percent_max ?? 0;
  const terrainBad = s > maxTerrainSlopePercent;
  const prov = ctx.provider || "elevation API";
  const messages = [
    `Center elevation ${ctx.elevation_m != null ? Math.round(ctx.elevation_m) : "—"} m; max grade ~${s.toFixed(2)} % (sample radius ${ctx.sample_radius_m} m, ${prov}).`,
  ];
  if (terrainBad) {
    messages.push(`Terrain exceeds ${maxTerrainSlopePercent} % slope threshold for land pad / runway assumptions.`);
  }
  return {
    evaluated: true,
    elevation_m: ctx.elevation_m ?? undefined,
    slope_percent: s,
    terrain_unsuitable: terrainBad,
    sample_radius_m: ctx.sample_radius_m,
    slope_per_direction_percent: ctx.slope_per_direction_percent ?? undefined,
    messages,
  };
}

function buildLogisticsAssessment(logCtx: LogisticsContext) {
  if (!logCtx.evaluated) {
    return {
      evaluated: false,
      deep_water_port_within_50km: null as boolean | null,
      heavy_rail_within_50km: null as boolean | null,
      motorway_within_20km: null as boolean | null,
      nearest_maritime_like_m: undefined as number | undefined,
      nearest_rail_m: undefined as number | undefined,
      nearest_motorway_m: undefined as number | undefined,
      osm_feature_counts: undefined as Record<string, number> | undefined,
      port_lock_warning: undefined as boolean | undefined,
      rail_cost_multiplier_note: undefined as string | undefined,
      messages: [`Logistics (OpenStreetMap / Overpass) unavailable: ${logCtx.error || "unknown"}.`],
    };
  }

  const mmin = logCtx.maritime_min_m;
  const rmin = logCtx.rail_min_m;
  const omin = logCtx.motorway_min_m;
  const mlOk = logCtx.maritime_layer_ok;
  const rlOk = logCtx.rail_layer_ok;
  const rdOk = logCtx.motorway_layer_ok;

  const port_ok: boolean | null = mmin != null ? true : mlOk ? false : null;
  const rail_ok: boolean | null = rmin != null ? true : rlOk ? false : null;
  const mot_ok: boolean | null = omin != null ? true : rdOk ? false : null;

  const messages: string[] = [];
  if (!mlOk) messages.push("Maritime / harbour OSM layer failed (rate limit or network).");
  if (!rlOk) messages.push("Railway OSM layer failed — rail distance rule skipped.");
  if (!rdOk) messages.push("Motorway OSM layer failed — road access rule skipped.");

  if (port_ok === true && mmin != null) {
    messages.push(
      `Coast / harbour: nearest OSM feature ~${Math.round(mmin)} m (${logCtx.port_rail_radius_m} m search).`
    );
  } else if (port_ok === false) {
    messages.push(
      "No harbour / ferry terminal features in search radius — sea logistics / construction lock risk per playbook."
    );
  }

  let rail_note: string | undefined;
  if (rail_ok === true && rmin != null) {
    messages.push(`Heavy rail (railway=rail): nearest line ~${Math.round(rmin)} m.`);
  } else if (rail_ok === false) {
    rail_note = "No railway=rail in radius — assume ~2× logistics cost uplift.";
    messages.push(rail_note);
  }

  if (mot_ok === true && omin != null) {
    messages.push(`Motorway / trunk: nearest ~${Math.round(omin)} m (${logCtx.motorway_radius_m} m search).`);
  } else if (mot_ok === false) {
    messages.push("No motorway or trunk in radius — emergency crew access time risk.");
  }

  if (logCtx.error) messages.push(`Partial Overpass errors: ${logCtx.error}`);

  return {
    evaluated: true,
    deep_water_port_within_50km: port_ok,
    heavy_rail_within_50km: rail_ok,
    motorway_within_20km: mot_ok,
    nearest_maritime_like_m: mmin ?? undefined,
    nearest_rail_m: rmin ?? undefined,
    nearest_motorway_m: omin ?? undefined,
    osm_feature_counts: logCtx.counts,
    port_lock_warning: port_ok === false,
    rail_cost_multiplier_note: rail_ok === false ? rail_note : undefined,
    messages,
  };
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  app.post("/api/v1/simulate", async (req, res) => {
    const { latitude, longitude, landing_surface, wave_height_m } = req.body;

    const lat = Number(latitude);
    const lon = Number(longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return res.status(400).json({ error: "Invalid latitude or longitude" });
    }

    const maxTerrainSlope = envFloat("MAX_TERRAIN_SLOPE_PERCENT", 15);
    const takeoffWindLimit = envFloat("WIND_TAKEOFF_MAX_KNOTS", 30);
    const landingWindLimit = envFloat("WIND_LANDING_MAX_KNOTS", 18);
    const maxWaveM = envFloat("MAX_WAVE_HEIGHT_M", 2.5);

    try {
      const [weather, elevCtx, logCtx] = await Promise.all([
        fetchWeather(lat, lon),
        fetchElevationContext(lat, lon),
        fetchLogisticsContext(lat, lon),
      ]);

      const windKnot = (weather.wind_kph || 0) / 1.852;
      const temp = weather.temp_c;
      const tempOk = temp != null && Number.isFinite(Number(temp));
      const tempNum = tempOk ? Number(temp) : null;
      const temp_pressure_warning = tempNum != null && (tempNum < 0 || tempNum > 35);

      const elevation = buildElevationAssessment(elevCtx, maxTerrainSlope);
      const logistics = buildLogisticsAssessment(logCtx);

      const terrainBad = elevation.terrain_unsuitable === true;

      let takeoffStatus: GoNoGoStatus;
      const takeoffMsgs: string[] = [];
      const takeoffNoGo =
        windKnot >= takeoffWindLimit || terrainBad;
      if (takeoffNoGo) {
        takeoffStatus = GoNoGoStatus.NO_GO;
        if (windKnot >= takeoffWindLimit) {
          takeoffMsgs.push(`Takeoff No-Go: surface wind ~${windKnot.toFixed(1)} kt exceeds ${takeoffWindLimit} kt limit.`);
        }
        if (terrainBad) takeoffMsgs.push("Takeoff No-Go: terrain slope over limit for land operations.");
      } else if (temp_pressure_warning) {
        takeoffStatus = GoNoGoStatus.CONDITIONAL;
        takeoffMsgs.push("Takeoff conditional: temperature outside 0–35 °C band (fuel / pressure caution).");
      } else {
        takeoffStatus = GoNoGoStatus.GO;
        takeoffMsgs.push("Takeoff: wind and terrain within current thresholds.");
      }
      if (!elevation.evaluated && elevCtx.error) {
        takeoffMsgs.push("Note: elevation unavailable — terrain No-Go rule not fully applied.");
      }

      let landingStatus: GoNoGoStatus;
      const landingMsgs: string[] = [];
      let landingNoGo = windKnot >= landingWindLimit;

      if (landing_surface === LandingSurface.LAND) {
        landingNoGo = landingNoGo || terrainBad;
        if (windKnot >= landingWindLimit) {
          landingMsgs.push(`Landing No-Go: wind ~${windKnot.toFixed(1)} kt exceeds ${landingWindLimit} kt landing limit.`);
        }
        if (terrainBad) landingMsgs.push("Landing No-Go: slope unsuitable for land touchdown.");
        if (!landingNoGo && temp_pressure_warning) {
          landingStatus = GoNoGoStatus.CONDITIONAL;
          landingMsgs.push("Landing conditional: temperature band warning.");
        } else if (landingNoGo) {
          landingStatus = GoNoGoStatus.NO_GO;
        } else {
          landingStatus = GoNoGoStatus.GO;
          landingMsgs.push("Landing (land): wind and slope within thresholds.");
        }
      } else {
        if (wave_height_m != null && Number(wave_height_m) > maxWaveM) {
          landingNoGo = true;
          landingMsgs.push(`Landing No-Go: wave height ${Number(wave_height_m).toFixed(2)} m > ${maxWaveM} m limit.`);
        } else if (wave_height_m != null) {
          landingMsgs.push(`Water landing: wave ${Number(wave_height_m).toFixed(2)} m within limit.`);
        } else {
          landingMsgs.push("Water landing: no wave height supplied — treat as conditional until verified.");
        }
        if (windKnot >= landingWindLimit) {
          landingNoGo = true;
          landingMsgs.push(`Landing No-Go: wind exceeds ${landingWindLimit} kt.`);
        }
        if (landingNoGo) landingStatus = GoNoGoStatus.NO_GO;
        else if (wave_height_m == null || temp_pressure_warning) {
          landingStatus = GoNoGoStatus.CONDITIONAL;
          if (temp_pressure_warning) landingMsgs.push("Landing conditional: temperature warning.");
        } else {
          landingStatus = GoNoGoStatus.GO;
          landingMsgs.push("Landing (water): wind and wave within thresholds.");
        }
        landingMsgs.push("Terrain slope rule not applied for water landing.");
      }

      if (logistics.evaluated) {
        if (logistics.port_lock_warning) {
          takeoffStatus = liftToConditional(takeoffStatus);
          takeoffMsgs.push(
            "Logistics: no harbour / coast vector in radius — takeoff lifted to conditional (sea transport / build lock risk)."
          );
        }
        if (logistics.heavy_rail_within_50km === false) {
          takeoffStatus = liftToConditional(takeoffStatus);
          takeoffMsgs.push("Logistics: no heavy rail in radius — takeoff conditional (~2× cost assumption).");
        }
        if (logistics.motorway_within_20km === false) {
          landingStatus = liftToConditional(landingStatus);
          landingMsgs.push("Logistics: no motorway/trunk in radius — landing conditional (emergency access).");
        }
      }

      const overall = mergePhase(takeoffStatus, landingStatus);
      const overall_messages = [
        `Summary: takeoff=${takeoffStatus}, landing=${landingStatus} → combined=${overall}.`,
        overall === GoNoGoStatus.NO_GO
          ? "At least one phase is No-Go."
          : overall === GoNoGoStatus.CONDITIONAL
            ? "One or more phases conditional — manual review recommended."
            : "Both phases Go under current data and thresholds.",
      ];

      const elevSource = !elevCtx.evaluated
        ? "unavailable"
        : elevCtx.provider === "opentopodata"
          ? "opentopodata"
          : "open-elevation.com";

      const report = {
        latitude: lat,
        longitude: lon,
        landing_surface,
        overall_status: overall,
        overall_messages,
        takeoff: { status: takeoffStatus, messages: takeoffMsgs },
        landing: { status: landingStatus, messages: landingMsgs },
        weather: {
          exceeds_takeoff_wind_limit: windKnot >= takeoffWindLimit,
          exceeds_landing_wind_limit: windKnot >= landingWindLimit,
          temp_pressure_warning,
          lightning_detected: false,
          lightning_halt_scoring: false,
          messages: [
            `Surface wind: ${windKnot.toFixed(1)} kt`,
            tempOk ? `Temp: ${tempNum}°C` : "Temp: —",
          ],
          raw: {
            source: weather.mock ? "mock" : "weatherapi.com",
            temp_c: tempNum ?? undefined,
            wind_knots_effective: windKnot,
            condition_text: weather.condition?.text || weather.condition_text,
          },
        },
        elevation,
        logistics,
        payload_hint: {
          evaluated: true,
          latitude_abs: Math.abs(lat),
          score_hint: Math.max(0, 100 - Math.abs(lat) * 2),
          messages: ["Payload efficiency (latitude band heuristic)."],
        },
        meta: {
          weather_source: weather.mock ? "mock" : "weatherapi.com",
          elevation_source: elevSource,
          elevation_provider: elevCtx.provider,
          elevation_error: elevCtx.evaluated ? undefined : elevCtx.error,
          logistics_source: logCtx.evaluated ? "overpass-osm" : "unavailable",
          logistics_error: logCtx.evaluated ? logCtx.error : logCtx.error,
          logistics_port_rail_radius_m: logCtx.port_rail_radius_m,
          logistics_motorway_radius_m: logCtx.motorway_radius_m,
          max_terrain_slope_percent: maxTerrainSlope,
          wind_takeoff_max_knots: takeoffWindLimit,
          wind_landing_max_knots: landingWindLimit,
          max_wave_height_m: maxWaveM,
        },
      };

      res.json(report);
    } catch (error) {
      console.error("Simulation Error:", error);
      res.status(500).json({ error: "Internal Simulation Error" });
    }
  });

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Mission Control Server running on http://localhost:${PORT}`);
  });
}

startServer();
