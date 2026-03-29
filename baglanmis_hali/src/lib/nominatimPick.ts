/**
 * Nominatim sonuçlarından idari sınır (şehir/il vb.) seçer; ülke ve kıta ölçeğini elemez.
 * OSM poligonu varsa ve bbox makul ise gerçek sınırlar kullanılır (ör. Konya ili geniş, İstanbul daha dar).
 */
import { bboxToPolygonGeometry, normalizeSelectionGeometry, type GeoJsonPolygonLike } from "./polygon";

/** Bu bbox alanından büyükleri ülke/kıta sayılır; poligon gösterilmez, yerel kutu kullanılır. */
export const MAX_ADMIN_SELECTION_BBOX_DEG2 = 420;

const MIN_MEANINGFUL_BBOX_DEG2 = 1e-8;

/** Son çare: merkez etrafında küçük kutu (~11 km yarıçap). */
export const LOCAL_FALLBACK_HALF_DEG = 0.32;

export function bboxAreaSqDeg(boundingbox: string[]): number {
  const minLat = parseFloat(boundingbox[0]);
  const maxLat = parseFloat(boundingbox[1]);
  const minLng = parseFloat(boundingbox[2]);
  const maxLng = parseFloat(boundingbox[3]);
  return Math.abs(maxLat - minLat) * Math.abs(maxLng - minLng);
}

function importanceOf(d: Record<string, unknown>): number {
  const v = d.importance;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const n = parseFloat(String(v ?? 0));
  return Number.isFinite(n) ? n : 0;
}

/**
 * addressdetails=1 ile gelen sonuçlarda addresstype kullanılır.
 * Ülke ve aşırı geniş bbox elenir; mümkünse geojson’lu, yüksek importance’lı idari sonuç seçilir.
 */
export function pickBestNominatimResult(data: unknown[]): Record<string, unknown> | null {
  if (!Array.isArray(data) || data.length === 0) return null;
  const rows = data.filter((d): d is Record<string, unknown> => d != null && typeof d === "object");

  const withBox = rows.filter(
    (d) => Array.isArray(d.boundingbox) && (d.boundingbox as string[]).length >= 4
  ) as (Record<string, unknown> & { boundingbox: string[] })[];

  if (!withBox.length) return rows[0] ?? null;

  const inRange = withBox.filter((d) => {
    if (d.addresstype === "country") return false;
    const area = bboxAreaSqDeg(d.boundingbox);
    if (area > MAX_ADMIN_SELECTION_BBOX_DEG2) return false;
    if (area < MIN_MEANINGFUL_BBOX_DEG2) return false;
    return true;
  });

  const candidates = inRange.length ? inRange : withBox.filter((d) => d.addresstype !== "country");
  if (!candidates.length) return null;

  const scored = candidates.map((d) => {
    const geo = normalizeSelectionGeometry(d.geojson);
    return {
      d,
      geo,
      imp: importanceOf(d),
      area: bboxAreaSqDeg(d.boundingbox),
    };
  });

  const withGeo = scored.filter((s) => s.geo != null);
  const pool = withGeo.length ? withGeo : scored;

  pool.sort((a, b) => {
    if (b.imp !== a.imp) return b.imp - a.imp;
    return b.area - a.area;
  });

  return pool[0]?.d ?? candidates[0] ?? null;
}

export function buildCitySelectionGeometry(
  targetArea: Record<string, unknown>,
  la: number,
  lo: number
): {
  boundingBox: { minLat: number; maxLat: number; minLng: number; maxLng: number } | null;
  selectionGeometry: GeoJsonPolygonLike;
} {
  const bbRaw = targetArea.boundingbox as string[] | undefined;
  const boundingBox =
    bbRaw && bbRaw.length >= 4
      ? {
          minLat: parseFloat(bbRaw[0]),
          maxLat: parseFloat(bbRaw[1]),
          minLng: parseFloat(bbRaw[2]),
          maxLng: parseFloat(bbRaw[3]),
        }
      : null;

  const areaDeg2 = boundingBox
    ? (boundingBox.maxLat - boundingBox.minLat) * (boundingBox.maxLng - boundingBox.minLng)
    : Infinity;

  const fromGeo = normalizeSelectionGeometry(targetArea.geojson);

  if (
    fromGeo &&
    boundingBox &&
    areaDeg2 <= MAX_ADMIN_SELECTION_BBOX_DEG2 &&
    areaDeg2 >= MIN_MEANINGFUL_BBOX_DEG2
  ) {
    return { boundingBox, selectionGeometry: fromGeo };
  }

  if (
    boundingBox &&
    areaDeg2 <= MAX_ADMIN_SELECTION_BBOX_DEG2 &&
    areaDeg2 >= MIN_MEANINGFUL_BBOX_DEG2
  ) {
    return {
      boundingBox,
      selectionGeometry: bboxToPolygonGeometry(
        boundingBox.minLat,
        boundingBox.maxLat,
        boundingBox.minLng,
        boundingBox.maxLng
      ),
    };
  }

  const h = LOCAL_FALLBACK_HALF_DEG;
  return {
    boundingBox,
    selectionGeometry: bboxToPolygonGeometry(la - h, la + h, lo - h, lo + h),
  };
}
