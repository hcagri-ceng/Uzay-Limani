"""
Uygulama yapılandırması.

Ortam değişkenleri `.env` dosyasından veya sistem ortamından yüklenir.
API anahtarları asla kaynak koda gömülmemelidir; geliştirme için `.env` kullanın.
"""

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

# Proje kökü (config.py ile aynı dizin); uvicorn nereden başlatılırsa başlatılsın .env bulunur.
_ENV_DIR = Path(__file__).resolve().parent
_ENV_FILE = _ENV_DIR / ".env"


class Settings(BaseSettings):
    """Pydantic Settings ile tip güvenli env okuma."""

    model_config = SettingsConfigDict(
        env_file=str(_ENV_FILE),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # WeatherAPI.com — https://www.weatherapi.com/
    weather_api_key: str = ""
    weather_api_base_url: str = "https://api.weatherapi.com/v1"
    # True ise gerçek API çağrılmaz; arayüz / entegrasyon testi için sabit hava verisi döner.
    use_mock_weather: bool = False

    # Open Elevation — https://open-elevation.com/ (genelde API anahtarı gerekmez)
    open_elevation_base_url: str = "https://api.open-elevation.com/api/v1"
    opentopodata_api_base_url: str = "https://api.opentopodata.org/v1"
    elevation_opentopodata_dataset: str = "srtm30m"
    elevation_prefer_opentopodata: bool = True
    elevation_http_timeout_s: float = 28.0
    # Merkezden dört ana yöne örnek mesafesi (metre); eğim grade tahmini için.
    elevation_sample_radius_m: float = 150.0
    # İş kuralı: tahmini max eğim % bu değeri aşarsa arazi uygunsuz (tablo: ~1–2 %).
    max_terrain_slope_percent: float = 15.0
    # True ise düz arazi mock’u (rakım sabit); Open Elevation çağrılmaz.
    use_mock_elevation: bool = False

    # Yüzey rüzgarı (kt) — tablo: kalkış < 30; iniş < 15–20 (varsayılan orta değer 18).
    wind_takeoff_max_knots: float = 30.0
    wind_landing_max_knots: float = 18.0
    # Suya iniş dalga yüksekliği üst sınırı (m) — tablo: < 2–3 m (varsayılan 2.5).
    max_wave_height_m: float = 2.5
    # Kalkış verimliliği için ideal enlem bandı (°) — tablo: 0–28.
    ideal_equator_latitude_max_deg: float = 28.0

    # Overpass API — virgülle birden fazla URL: ilki başarısız olursa (429/504) sıradakiler denenir.
    overpass_interpreter_url: str = (
        "https://overpass-api.de/api/interpreter,"
        "https://overpass.kumi.systems/api/interpreter"
    )
    # Liman/kıyı vektörü + demiryolu tarama yarıçapı (m) — tablo: 50 km.
    logistics_port_rail_radius_m: float = 30_000.0
    # Otoyol / ana yol tarama yarıçapı (m) — tablo: 20 km.
    logistics_motorway_radius_m: float = 20_000.0
    overpass_timeout_s: float = 30.0
    # İlk Overpass ile rail+road paralel grubu arası bekleme (s) — 429 azaltmak için.
    overpass_request_gap_s: float = 0.
    # True ise OSM sorgusu yapılmaz; sabit “iyi” lojistik mock’u döner.
    use_mock_logistics: bool = False
    # True ise ``man_made=pier`` de aranır (kıyı şehirlerinde çok sonuç → Overpass yavaşlayabilir).
    logistics_include_piers: bool = False


@lru_cache
def get_settings() -> Settings:
    """Tekil Settings örneği (FastAPI Depends ile enjekte edilebilir)."""
    return Settings()
