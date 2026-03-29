/** GeoJSON [lon, lat] */
export type LonLat = [number, number];

export type GeoJsonPolygonLike = {
  type: "Polygon" | "MultiPolygon";
  coordinates: unknown;
};

/** Dikdörtgen sınır (GeoJSON Polygon, tek halka). */
export function bboxToPolygonGeometry(
  minLat: number,
  maxLat: number,
  minLng: number,
  maxLng: number
): GeoJsonPolygonLike {
  return {
    type: "Polygon",
    coordinates: [
      [
        [minLng, minLat],
        [maxLng, minLat],
        [maxLng, maxLat],
        [minLng, maxLat],
        [minLng, minLat],
      ],
    ],
  };
}

function pointInRing(lng: number, lat: number, ring: LonLat[]): boolean {
  let inside = false;
  const n = ring.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i]![0];
    const yi = ring[i]![1];
    const xj = ring[j]![0];
    const yj = ring[j]![1];
    const denom = yj - yi || 1e-15;
    const intersect =
      yi !== yj && (yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / denom + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function pointInPolygonRings(lng: number, lat: number, coordinates: LonLat[][]): boolean {
  const outer = coordinates[0];
  if (!outer?.length) return false;
  if (!pointInRing(lng, lat, outer)) return false;
  for (let h = 1; h < coordinates.length; h++) {
    const hole = coordinates[h];
    if (hole?.length && pointInRing(lng, lat, hole)) return false;
  }
  return true;
}

/** lat/lng WGS84; geometry Polygon veya MultiPolygon */
export function pointInGeometry(lat: number, lng: number, g: GeoJsonPolygonLike): boolean {
  if (g.type === "Polygon") {
    const coords = g.coordinates as LonLat[][];
    return pointInPolygonRings(lng, lat, coords);
  }
  if (g.type === "MultiPolygon") {
    const multi = g.coordinates as LonLat[][][];
    return multi.some((poly) => pointInPolygonRings(lng, lat, poly));
  }
  return false;
}

/** Nominatim geojson veya ham koordinatları normalize et (sadece Polygon / MultiPolygon). */
export function normalizeSelectionGeometry(raw: unknown): GeoJsonPolygonLike | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as { type?: string; coordinates?: unknown };
  if (o.type === "Polygon" && Array.isArray(o.coordinates)) {
    return { type: "Polygon", coordinates: o.coordinates };
  }
  if (o.type === "MultiPolygon" && Array.isArray(o.coordinates)) {
    return { type: "MultiPolygon", coordinates: o.coordinates };
  }
  return null;
}
