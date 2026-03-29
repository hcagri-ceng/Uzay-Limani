/**
 * Ülke seçimi: Nominatim’den bbox → düzgün dikdörtgen sınır (dev multipolygon yok).
 */
import { bboxToPolygonGeometry, type GeoJsonPolygonLike } from "./polygon";

export type CountryBbox = {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
};

/** Bbox büyüklüğüne göre globe `alt` (yakınlaşma). */
export function altitudeForCountryBbox(bb: CountryBbox): number {
  const latSpan = Math.abs(bb.maxLat - bb.minLat);
  const lngSpan = Math.abs(bb.maxLng - bb.minLng);
  const span = Math.max(latSpan, lngSpan * 0.65);
  if (span > 45) return 0.58;
  if (span > 28) return 0.42;
  if (span > 14) return 0.3;
  if (span > 7) return 0.22;
  if (span > 3) return 0.14;
  if (span > 1.2) return 0.09;
  return 0.06;
}

export function bboxCenter(bb: CountryBbox): { lat: number; lng: number } {
  return {
    lat: (bb.minLat + bb.maxLat) / 2,
    lng: (bb.minLng + bb.maxLng) / 2,
  };
}

export async function fetchCountryBboxAndPolygon(
  countryName: string
): Promise<{ geometry: GeoJsonPolygonLike; bbox: CountryBbox } | null> {
  try {
    const q = encodeURIComponent(countryName);
    const url =
      `https://nominatim.openstreetmap.org/search?q=${q}&format=json&limit=10` +
      `&addressdetails=1&email=burakkaradas71@gmail.com`;
    const res = await fetch(url);
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) return null;

    const row =
      (data as any[]).find((d) => d.addresstype === "country") ||
      (data as any[]).find((d) => d.class === "boundary" && d.type === "administrative") ||
      data[0];

    const bb = row?.boundingbox;
    if (!Array.isArray(bb) || bb.length < 4) return null;

    const bbox: CountryBbox = {
      minLat: parseFloat(bb[0]),
      maxLat: parseFloat(bb[1]),
      minLng: parseFloat(bb[2]),
      maxLng: parseFloat(bb[3]),
    };

    if (
      !Number.isFinite(bbox.minLat) ||
      !Number.isFinite(bbox.maxLat) ||
      !Number.isFinite(bbox.minLng) ||
      !Number.isFinite(bbox.maxLng)
    ) {
      return null;
    }

    return {
      geometry: bboxToPolygonGeometry(bbox.minLat, bbox.maxLat, bbox.minLng, bbox.maxLng),
      bbox,
    };
  } catch {
    return null;
  }
}
