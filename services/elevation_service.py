"""
Rakım ve yaklaşık yerel eğim (grade %).

**Birincil:** OpenTopoData (SRTM 30m) — tek GET ile 5 nokta; genelde ``api.open-elevation.com``’dan
daha stabil (504 daha seyrek).

**Yedek:** Open Elevation POST ``/lookup``.

Eğim: merkez + K/D/G/B örnekleri; yatay mesafe için vektörel haversine (hızlı, kısa mesafede WGS84’e yakın).
"""

from __future__ import annotations

import logging
import re
from typing import Any, Sequence

import httpx
import numpy as np
from geopy import distance as geo_dist

from config import Settings

logger = logging.getLogger(__name__)

_CARDINAL_BEARINGS: tuple[float, ...] = (0.0, 90.0, 180.0, 270.0)
_EARTH_R_M = 6_371_000.0


def _short_http_error(text: str, max_len: int = 180) -> str:
    """HTML gövdeli 504 yanıtlarını okunur kısalt."""
    if "<html" in text.lower() or "<!doctype" in text.lower():
        if "504" in text:
            return "HTTP 504 Gateway Time-out (sunucu aşırı yüklü veya yanıt veremedi)."
        if "502" in text:
            return "HTTP 502 Bad Gateway."
        return "HTTP hata (HTML gövde; ayrıntı logda)."
    t = re.sub(r"<[^>]+>", " ", text)
    t = " ".join(t.split())
    return t[:max_len] + ("…" if len(t) > max_len else "")


def _haversine_m_vec(olat: float, olon: float, lat: np.ndarray, lon: np.ndarray) -> np.ndarray:
    """Merkezden çoklu noktaya jeodezik yaklaşık mesafe (m)."""
    φ1 = np.radians(olat)
    φ2 = np.radians(lat)
    Δφ = np.radians(lat - olat)
    Δλ = np.radians(lon - olon)
    a = np.sin(Δφ / 2.0) ** 2 + np.cos(φ1) * np.cos(φ2) * np.sin(Δλ / 2.0) ** 2
    c = 2.0 * np.arctan2(np.sqrt(np.clip(a, 0.0, 1.0)), np.sqrt(np.clip(1.0 - a, 0.0, 1.0)))
    return _EARTH_R_M * c


def build_cardinal_sample_points(
    latitude: float,
    longitude: float,
    radius_m: float,
) -> list[tuple[float, float]]:
    """Merkez + dört ana yönde ``radius_m`` mesafede noktalar."""
    center = (latitude, longitude)
    points: list[tuple[float, float]] = [center]
    for bearing in _CARDINAL_BEARINGS:
        dest = geo_dist.distance(meters=radius_m).destination(center, bearing=bearing)
        points.append((float(dest.latitude), float(dest.longitude)))
    return points


def compute_max_slope_percent(
    points: Sequence[tuple[float, float]],
    elevations_m: Sequence[float],
) -> tuple[float, list[float]]:
    """Merkez–komşu eğim %; yatay mesafe haversine."""
    if len(points) < 5 or len(elevations_m) < 5:
        raise ValueError("En az 5 nokta ve 5 rakım gerekli.")

    olat, olon = points[0]
    z0 = float(elevations_m[0])
    lat_arr = np.array([points[i][0] for i in range(1, 5)], dtype=np.float64)
    lon_arr = np.array([points[i][1] for i in range(1, 5)], dtype=np.float64)
    horiz = _haversine_m_vec(olat, olon, lat_arr, lon_arr)
    grades: list[float] = []
    for i in range(4):
        h = float(horiz[i])
        if h <= 1.0:
            grades.append(0.0)
        else:
            dz = abs(float(elevations_m[i + 1]) - z0)
            grades.append(float(dz / h * 100.0))
    max_g = float(np.max(np.array(grades, dtype=np.float64)))
    return max_g, grades


def mock_elevation_context(
    latitude: float,
    longitude: float,
    radius_m: float,
) -> dict[str, Any]:
    pts = build_cardinal_sample_points(latitude, longitude, radius_m)
    z = 450.0
    elev = [z] * 5
    max_slope, per = compute_max_slope_percent(pts, elev)
    return {
        "evaluated": True,
        "mock": True,
        "provider": "mock",
        "elevation_m": z,
        "slope_percent_max": round(max_slope, 4),
        "slope_per_direction_percent": [round(x, 4) for x in per],
        "sample_radius_m": radius_m,
        "sample_points_count": len(pts),
        "error": None,
    }


def _failure(
    radius: float,
    npts: int,
    err: str,
) -> dict[str, Any]:
    return {
        "evaluated": False,
        "mock": False,
        "provider": None,
        "elevation_m": None,
        "slope_percent_max": None,
        "slope_per_direction_percent": None,
        "sample_radius_m": radius,
        "sample_points_count": npts,
        "error": err,
    }


async def _fetch_opentopodata(
    client: httpx.AsyncClient,
    settings: Settings,
    points: list[tuple[float, float]],
) -> tuple[list[float] | None, str | None]:
    """OpenTopoData GET; başarıda rakım listesi."""
    ds = settings.elevation_opentopodata_dataset.strip().strip("/")
    base = settings.opentopodata_api_base_url.rstrip("/")
    url = f"{base}/{ds}"
    locs = "|".join(f"{lat:.7f},{lon:.7f}" for lat, lon in points)
    timeout = httpx.Timeout(settings.elevation_http_timeout_s)
    try:
        response = await client.get(url, params={"locations": locs}, timeout=timeout)
    except httpx.RequestError as exc:
        return None, f"OpenTopoData ağ: {exc}"

    if response.status_code != 200:
        return None, f"OpenTopoData HTTP {response.status_code}: {_short_http_error(response.text)}"

    try:
        data = response.json()
    except ValueError as exc:
        return None, f"OpenTopoData JSON: {exc}"

    results = data.get("results")
    if not isinstance(results, list) or len(results) != len(points):
        return None, "OpenTopoData results uzunluğu uyuşmuyor."

    elevations: list[float] = []
    for i, r in enumerate(results):
        if not isinstance(r, dict):
            return None, f"OpenTopoData sonuç #{i} geçersiz."
        ev = r.get("elevation")
        if ev is None:
            return None, f"OpenTopoData nokta #{i} için rakım yok."
        try:
            elevations.append(float(ev))
        except (TypeError, ValueError):
            return None, f"OpenTopoData rakım parse hatası #{i}."
    return elevations, None


async def _fetch_open_elevation(
    client: httpx.AsyncClient,
    settings: Settings,
    points: list[tuple[float, float]],
) -> tuple[list[float] | None, str | None]:
    base = settings.open_elevation_base_url.rstrip("/")
    url = f"{base}/lookup"
    body = {"locations": [{"latitude": lat, "longitude": lon} for lat, lon in points]}
    timeout = httpx.Timeout(settings.elevation_http_timeout_s)
    try:
        response = await client.post(url, json=body, timeout=timeout)
    except httpx.RequestError as exc:
        return None, f"Open Elevation ağ: {exc}"

    if response.status_code != 200:
        return None, f"Open Elevation HTTP {response.status_code}: {_short_http_error(response.text)}"

    try:
        data = response.json()
    except ValueError as exc:
        return None, f"Open Elevation JSON: {exc}"

    results = data.get("results")
    if not isinstance(results, list) or len(results) != len(points):
        return None, "Open Elevation results uyuşmuyor."

    try:
        elevations = [float(r["elevation"]) for r in results]
    except (KeyError, TypeError, ValueError) as exc:
        return None, f"Open Elevation rakım: {exc}"
    return elevations, None


async def fetch_elevation_context(
    client: httpx.AsyncClient,
    settings: Settings,
    latitude: float,
    longitude: float,
) -> dict[str, Any]:
    """
    Önce OpenTopoData, gerekirse Open Elevation ile 5 rakım alır; eğim % üretir.
    """
    radius = float(settings.elevation_sample_radius_m)
    points = build_cardinal_sample_points(latitude, longitude, radius)

    if getattr(settings, "use_mock_elevation", False):
        return mock_elevation_context(latitude, longitude, radius)

    elevations: list[float] | None = None
    provider: str | None = None
    errors: list[str] = []

    if settings.elevation_prefer_opentopodata:
        elevations, err = await _fetch_opentopodata(client, settings, points)
        if elevations is not None:
            provider = "opentopodata"
        else:
            errors.append(err or "OpenTopoData bilinmeyen hata")
            logger.info("OpenTopoData başarısız, Open Elevation deneniyor: %s", err)

    if elevations is None:
        elevations, err = await _fetch_open_elevation(client, settings, points)
        if elevations is not None:
            provider = "open-elevation.com"
        else:
            errors.append(err or "Open Elevation bilinmeyen hata")

    if elevations is None:
        return _failure(radius, len(points), " | ".join(errors))

    try:
        max_slope, per_dir = compute_max_slope_percent(points, elevations)
    except ValueError as exc:
        return _failure(radius, len(points), str(exc))

    return {
        "evaluated": True,
        "mock": False,
        "provider": provider,
        "elevation_m": elevations[0],
        "slope_percent_max": round(max_slope, 4),
        "slope_per_direction_percent": [round(x, 4) for x in per_dir],
        "sample_radius_m": radius,
        "sample_points_count": len(points),
        "error": None,
    }
