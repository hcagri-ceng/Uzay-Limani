export enum GoNoGoStatus {
  GO = "go",
  NO_GO = "no_go",
  CONDITIONAL = "conditional",
}

export enum LandingSurface {
  LAND = "land",
  WATER = "water",
}

export interface SimulationRequest {
  latitude: number;
  longitude: number;
  landing_surface: LandingSurface;
  wave_height_m?: number;
}

export interface PhaseSuitability {
  status: GoNoGoStatus;
  messages: string[];
}

export interface WeatherRawSnapshot {
  source: string;
  location_name?: string;
  temp_c?: number;
  wind_kph?: number;
  wind_gust_kph?: number;
  wind_knots_effective?: number;
  condition_code?: number;
  condition_text?: string;
}

export interface WeatherAssessment {
  exceeds_takeoff_wind_limit: boolean;
  exceeds_landing_wind_limit: boolean;
  temp_pressure_warning: boolean;
  lightning_detected: boolean;
  lightning_halt_scoring: boolean;
  messages: string[];
  raw?: WeatherRawSnapshot;
}

export interface ElevationAssessment {
  evaluated: boolean;
  elevation_m?: number;
  slope_percent?: number;
  terrain_unsuitable?: boolean;
  sample_radius_m?: number;
  slope_per_direction_percent?: number[];
  messages: string[];
}

export interface LogisticsAssessment {
  evaluated: boolean;
  deep_water_port_within_50km?: boolean;
  heavy_rail_within_50km?: boolean;
  motorway_within_20km?: boolean;
  nearest_maritime_like_m?: number;
  nearest_rail_m?: number;
  nearest_motorway_m?: number;
  osm_feature_counts?: Record<string, number>;
  port_lock_warning?: boolean;
  rail_cost_multiplier_note?: string;
  messages: string[];
}

export interface PayloadCapacityHint {
  evaluated: boolean;
  latitude_abs?: number;
  score_hint?: number;
  messages: string[];
}

export interface SimulationReport {
  latitude: number;
  longitude: number;
  landing_surface: LandingSurface;
  overall_status: GoNoGoStatus;
  overall_messages: string[];
  takeoff: PhaseSuitability;
  landing: PhaseSuitability;
  weather: WeatherAssessment;
  elevation: ElevationAssessment;
  logistics: LogisticsAssessment;
  payload_hint: PayloadCapacityHint;
  meta: Record<string, any>;
}
