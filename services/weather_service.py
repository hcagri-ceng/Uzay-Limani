"""
WeatherAPI.com ile asenkron hava durumu çekimi.

Endpoint: GET /v1/current.json?q={lat},{lon}&key={key}

Rüzgar knot cinsinden: WeatherAPI `wind_kph` / `gust_kph` döner;
1 knot ≈ 1.852 km/h → knot = kph / 1.852.

Doc: https://www.weatherapi.com/docs/
"""

from __future__ import annotations

import logging
from typing import Any, Optional

import httpx

from config import Settings

logger = logging.getLogger(__name__)

# WeatherAPI “condition” kodları: gök gürültülü / yıldırımlı fırtına örnekleri.
# Tam liste dokümanda; burada tipik thunderstorm kodları kullanılır.
_THUNDERSTORM_CONDITION_CODES: frozenset[int] = frozenset(
    {
        1087,  # Thundery outbreaks possible
        1273,  # Patchy light rain with thunder
        1276,  # Moderate or heavy rain with thunder
        1279,  # Patchy light snow with thunder
        1282,  # Moderate or heavy snow with thunder
    }
)


def _kph_to_knots(kph: float) -> float:
    """Kilometre/saat → knot dönüşümü."""
    if kph <= 0:
        return 0.0
    return round(kph / 1.852, 2)


class WeatherServiceError(Exception):
    """Hava servisi erişim veya yanıt hatası."""

    def __init__(self, message: str, status_code: Optional[int] = None) -> None:
        super().__init__(message)
        self.status_code = status_code


def mock_current_weather_payload(latitude: float, longitude: float) -> dict[str, Any]:
    """
    WeatherAPI `current.json` ile uyumlu yapay yanıt.

    Amaç: API anahtarı doğrulanana veya kotaya takılmadan UI ve iş kurallarını test etmek.
    Üretimde `USE_MOCK_WEATHER=false` tutulmalıdır.
    """
    return {
        "location": {
            "name": f"Mock ({latitude:.4f}, {longitude:.4f})",
            "region": "Test",
            "country": "Simulated",
        },
        "current": {
            "temp_c": 22.0,
            "wind_kph": 18.0,
            "gust_kph": 24.0,
            "condition": {"code": 1000, "text": "Clear"},
        },
    }


async def fetch_current_weather(
    client: httpx.AsyncClient,
    settings: Settings,
    latitude: float,
    longitude: float,
) -> dict[str, Any]:
    """
    Verilen koordinat için anlık hava verisini çeker.

    Args:
        client: Paylaşılan httpx.AsyncClient (connection pooling için).
        settings: WEATHER_API_KEY içeren ayarlar.
        latitude: Enlem.
        longitude: Boylam.

    Returns:
        WeatherAPI `current.json` kök JSON sözlüğü.

    Raises:
        WeatherServiceError: Anahtar eksik, HTTP hata veya beklenmeyen gövde.
    """
    if getattr(settings, "use_mock_weather", False):
        return mock_current_weather_payload(latitude, longitude)

    key = (settings.weather_api_key or "").strip()
    if not key:
        raise WeatherServiceError(
            "WEATHER_API_KEY tanımlı değil. `.env` dosyasına ekleyin.",
            status_code=None,
        )

    url = f"{settings.weather_api_base_url.rstrip('/')}/current.json"
    params = {"key": key, "q": f"{latitude},{longitude}"}

    try:
        response = await client.get(url, params=params, timeout=httpx.Timeout(20.0))
    except httpx.RequestError as exc:
        logger.exception("WeatherAPI ağ hatası: %s", exc)
        raise WeatherServiceError(f"Hava servisine ulaşılamadı: {exc}") from exc

    if response.status_code != 200:
        # WeatherAPI hata gövdesi genelde JSON içinde message taşır
        detail = response.text[:500]
        try:
            err_json = response.json()
            detail = str(err_json.get("error", {}).get("message", detail))
        except Exception:
            pass
        raise WeatherServiceError(
            f"WeatherAPI HTTP {response.status_code}: {detail}",
            status_code=response.status_code,
        )

    try:
        data = response.json()
    except ValueError as exc:
        raise WeatherServiceError("WeatherAPI geçersiz JSON döndü.") from exc

    if "current" not in data:
        raise WeatherServiceError("WeatherAPI yanıtında 'current' alanı yok.")

    return data


def parse_weather_for_simulator(data: dict[str, Any]) -> dict[str, Any]:
    """
    Ham WeatherAPI yanıtını simülatörün anlayacağı düz yapıya indirger.

    Returns:
        temp_c, wind_kph, gust_kph, wind_knots_effective, condition_code, condition_text,
        location_name, lightning_from_api
    """
    loc = data.get("location") or {}
    cur = data.get("current") or {}
    cond = cur.get("condition") or {}

    temp_c = cur.get("temp_c")
    wind_kph = float(cur.get("wind_kph") or 0)
    gust_raw = cur.get("gust_kph")
    gust_kph = float(gust_raw) if gust_raw is not None else None

    wind_for_rule = max(wind_kph, gust_kph or 0.0)
    wind_knots_effective = _kph_to_knots(wind_for_rule)

    code = cond.get("code")
    try:
        condition_code = int(code) if code is not None else None
    except (TypeError, ValueError):
        condition_code = None

    text = cond.get("text")
    condition_text = str(text) if text is not None else None

    lightning_from_api = (
        condition_code in _THUNDERSTORM_CONDITION_CODES if condition_code is not None else False
    )

    return {
        "location_name": loc.get("name"),
        "temp_c": float(temp_c) if temp_c is not None else None,
        "wind_kph": wind_kph,
        "wind_gust_kph": gust_kph,
        "wind_knots_effective": wind_knots_effective,
        "condition_code": condition_code,
        "condition_text": condition_text,
        "lightning_from_api": lightning_from_api,
    }
