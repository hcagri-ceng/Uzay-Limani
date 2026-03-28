"""
OpenStreetMap — Overpass API (httpx, asenkron).

Performans:
- Liman sorgusu sıralı; **demiryolu** ve **otoyol** istekleri **paralel** (toplam süre kısalır).
- Binlerce öğede mesafe: vektörel **haversine** (numpy); ``geodesic`` döngüsü yok.

504/429 için çoklu interpreter URL sırası korunur.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

import httpx
import numpy as np

from config import Settings

logger = logging.getLogger(__name__)

_EARTH_R_M = 6_371_000.0


def _maritime_query(lat: float, lon: float, radius_m: int, include_piers: bool) -> str:
    la, lo = f"{lat:.7f}", f"{lon:.7f}"
    r = int(radius_m)
    pier_block = ""
    if include_piers:
        pier_block = f"""
  nwr["man_made"="pier"](around:{r},{la},{lo});"""
    return f"""[out:json][timeout:45];
(
  nwr["harbour"](around:{r},{la},{lo});
  nwr["landuse"="harbour"](around:{r},{la},{lo});
  nwr["amenity"="ferry_terminal"](around:{r},{la},{lo});{pier_block}
);
out center;
"""


def _rail_query(lat: float, lon: float, radius_m: int) -> str:
    la, lo = f"{lat:.7f}", f"{lon:.7f}"
    r = int(radius_m)
    return f"""[out:json][timeout:45];
(
  nwr["railway"="rail"](around:{r},{la},{lo});
);
out center;
"""


def _road_query(lat: float, lon: float, radius_m: int) -> str:
    la, lo = f"{lat:.7f}", f"{lon:.7f}"
    r = int(radius_m)
    return f"""[out:json][timeout:45];
(
  nwr["highway"="motorway"](around:{r},{la},{lo});
  nwr["highway"="motorway_link"](around:{r},{la},{lo});
  nwr["highway"="trunk"](around:{r},{la},{lo});
  nwr["highway"="trunk_link"](around:{r},{la},{lo});
);
out center;
"""


def _element_center_latlon(el: dict[str, Any]) -> tuple[float, float] | None:
    typ = el.get("type")
    if typ == "node":
        la = el.get("lat")
        lo = el.get("lon")
        if la is not None and lo is not None:
            return float(la), float(lo)
        return None
    if typ in ("way", "relation"):
        c = el.get("center")
        if isinstance(c, dict):
            la = c.get("lat")
            lo = c.get("lon")
            if la is not None and lo is not None:
                return float(la), float(lo)
    return None


def _haversine_m_vec(olat: float, olon: float, lat: np.ndarray, lon: np.ndarray) -> np.ndarray:
    φ1 = np.radians(olat)
    φ2 = np.radians(lat)
    Δφ = np.radians(lat - olat)
    Δλ = np.radians(lon - olon)
    a = np.sin(Δφ / 2.0) ** 2 + np.cos(φ1) * np.cos(φ2) * np.sin(Δλ / 2.0) ** 2
    c = 2.0 * np.arctan2(np.sqrt(np.clip(a, 0.0, 1.0)), np.sqrt(np.clip(1.0 - a, 0.0, 1.0)))
    return _EARTH_R_M * c


def _layer_min_distance_m(
    elements: list[dict[str, Any]] | None,
    olat: float,
    olon: float,
) -> tuple[float | None, int]:
    """
    Katmandaki tüm öğelerin merkezine göre minimum mesafe (m) ve öğe sayısı.
    """
    if not elements:
        return None, 0
    lats: list[float] = []
    lons: list[float] = []
    for el in elements:
        if not isinstance(el, dict):
            continue
        pt = _element_center_latlon(el)
        if pt is None:
            continue
        lats.append(pt[0])
        lons.append(pt[1])
    n = len(lats)
    if n == 0:
        return None, 0
    d = _haversine_m_vec(olat, olon, np.array(lats, dtype=np.float64), np.array(lons, dtype=np.float64))
    return float(np.min(d)), n


def _overpass_urls(settings: Settings) -> list[str]:
    raw = settings.overpass_interpreter_url.replace("\n", "").strip()
    return [u.strip() for u in raw.split(",") if u.strip()]


async def _post_overpass(
    client: httpx.AsyncClient,
    urls: list[str],
    query: str,
    timeout_s: float,
) -> tuple[list[dict[str, Any]] | None, str | None]:
    last_err: str | None = None
    for url in urls:
        try:
            response = await client.post(
                url,
                data={"data": query},
                timeout=httpx.Timeout(timeout_s),
            )
        except httpx.RequestError as exc:
            last_err = str(exc)
            continue
        if response.status_code != 200:
            snippet = response.text[:220]
            last_err = f"HTTP {response.status_code}: {snippet}"
            if response.status_code in (429, 502, 503, 504):
                logger.info("Overpass %s → yedek URL deneniyor", response.status_code)
                continue
            return None, last_err
        try:
            data = response.json()
        except ValueError as exc:
            last_err = str(exc)
            continue
        el = data.get("elements")
        if not isinstance(el, list):
            last_err = "elements yok"
            continue
        return el, None
    return None, last_err or "Tüm Overpass uç noktaları başarısız"


def mock_logistics_context(settings: Settings) -> dict[str, Any]:
    rp = int(settings.logistics_port_rail_radius_m)
    rm = int(settings.logistics_motorway_radius_m)
    return {
        "evaluated": True,
        "mock": True,
        "maritime_min_m": 8000.0,
        "rail_min_m": 12000.0,
        "motorway_min_m": 5000.0,
        "counts": {"maritime": 2, "rail": 5, "motorway": 8},
        "port_rail_radius_m": rp,
        "motorway_radius_m": rm,
        "maritime_layer_ok": True,
        "rail_layer_ok": True,
        "motorway_layer_ok": True,
        "error": None,
    }


async def fetch_logistics_context(
    client: httpx.AsyncClient,
    settings: Settings,
    latitude: float,
    longitude: float,
) -> dict[str, Any]:
    rp = int(settings.logistics_port_rail_radius_m)
    rm = int(settings.logistics_motorway_radius_m)
    urls = _overpass_urls(settings)
    per_timeout = min(55.0, max(35.0, settings.overpass_timeout_s / 3))

    if getattr(settings, "use_mock_logistics", False):
        return mock_logistics_context(settings)

    q_m = _maritime_query(
        latitude,
        longitude,
        rp,
        include_piers=bool(getattr(settings, "logistics_include_piers", False)),
    )
    q_r = _rail_query(latitude, longitude, rp)
    q_o = _road_query(latitude, longitude, rm)

    m_el, m_err = await _post_overpass(client, urls, q_m, per_timeout)
    await asyncio.sleep(settings.overpass_request_gap_s)

    async def rail_task() -> tuple[list[dict[str, Any]] | None, str | None]:
        return await _post_overpass(client, urls, q_r, per_timeout)

    async def road_task() -> tuple[list[dict[str, Any]] | None, str | None]:
        return await _post_overpass(client, urls, q_o, per_timeout)

    (r_el, r_err), (o_el, o_err) = await asyncio.gather(rail_task(), road_task())

    olat, olon = latitude, longitude

    maritime_ok = m_err is None and m_el is not None
    rail_ok_layer = r_err is None and r_el is not None
    road_ok_layer = o_err is None and o_el is not None

    mm, mc = _layer_min_distance_m(m_el if maritime_ok else None, olat, olon)
    rm, rc = _layer_min_distance_m(r_el if rail_ok_layer else None, olat, olon)
    om, oc = _layer_min_distance_m(o_el if road_ok_layer else None, olat, olon)

    if not maritime_ok and not rail_ok_layer and not road_ok_layer:
        err_parts = [e for e in (m_err, r_err, o_err) if e]
        return {
            "evaluated": False,
            "mock": False,
            "maritime_min_m": None,
            "rail_min_m": None,
            "motorway_min_m": None,
            "counts": {"maritime": 0, "rail": 0, "motorway": 0},
            "port_rail_radius_m": rp,
            "motorway_radius_m": rm,
            "maritime_layer_ok": maritime_ok,
            "rail_layer_ok": rail_ok_layer,
            "motorway_layer_ok": road_ok_layer,
            "error": "; ".join(err_parts) if err_parts else "Tüm Overpass istekleri başarısız",
        }

    merged = {
        "maritime_min_m": mm if maritime_ok else None,
        "rail_min_m": rm if rail_ok_layer else None,
        "motorway_min_m": om if road_ok_layer else None,
        "counts": {"maritime": mc if maritime_ok else 0, "rail": rc if rail_ok_layer else 0, "motorway": oc if road_ok_layer else 0},
        "evaluated": True,
        "mock": False,
        "port_rail_radius_m": rp,
        "motorway_radius_m": rm,
        "maritime_layer_ok": maritime_ok,
        "rail_layer_ok": rail_ok_layer,
        "motorway_layer_ok": road_ok_layer,
    }
    partial_errors = [e for e in (m_err, r_err, o_err) if e]
    merged["error"] = "; ".join(partial_errors) if partial_errors else None
    if partial_errors:
        logger.info("Overpass kısmi hata: %s", merged["error"])
    return merged
