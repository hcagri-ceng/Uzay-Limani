"""
Pydantic istek/yanıt modelleri: Uzay Limanı simülasyon API sözleşmesi.

Kurallar; kalkış (Kalkış) ve iniş (Karaya / Suya) fazları ayrı değerlendirilir
(tablo: yüzey rüzgarı, yıldırım, sıcaklık, eğim, dalga vb.).
"""

from enum import Enum
from typing import Any, Optional

from pydantic import BaseModel, Field, field_validator


class GoNoGoStatus(str, Enum):
    """Tek bir faz veya genel özet için karar."""

    GO = "go"
    NO_GO = "no_go"
    CONDITIONAL = "conditional"


class LandingSurface(str, Enum):
    """İniş yüzeyi senaryosu (karaya iniş vs suya iniş)."""

    LAND = "land"
    WATER = "water"


class SimulationRequest(BaseModel):
    """POST /api/v1/simulate gövdesi."""

    latitude: float = Field(..., ge=-90, le=90, description="Enlem (WGS84).")
    longitude: float = Field(..., ge=-180, le=180, description="Boylam (WGS84).")
    landing_surface: LandingSurface = Field(
        LandingSurface.LAND,
        description="Karaya iniş: eğim kuralları uygulanır. Suya iniş: dalga kuralı (veri varsa).",
    )
    wave_height_m: Optional[float] = Field(
        None,
        ge=0,
        description=(
            "Suya iniş için anlık dalga yüksekliği (m). Boşsa dalga verisi yok sayılır ve "
            "iniş koşullu uyarısı üretilir. Tablo: ideal < 2–3 m."
        ),
    )

    @field_validator("latitude", "longitude")
    @classmethod
    def finites_only(cls, v: float) -> float:
        """NaN/inf reddi."""
        if not isinstance(v, (int, float)) or v != v or abs(v) == float("inf"):
            raise ValueError("Koordinat sonlu bir sayı olmalıdır.")
        return float(v)


class PhaseSuitability(BaseModel):
    """Kalkış veya iniş fazına özel Go / No-Go / Koşullu özeti."""

    status: GoNoGoStatus = Field(..., description="Bu faz için nihai uygunluk.")
    messages: list[str] = Field(
        default_factory=list,
        description="Faza özgü gerekçe ve uyarılar.",
    )


class WeatherRawSnapshot(BaseModel):
    """Harici API’den gelen özet (debug/şeffaflık için)."""

    source: str = "weatherapi.com"
    location_name: Optional[str] = None
    temp_c: Optional[float] = None
    wind_kph: Optional[float] = Field(
        None,
        description="Sürekli rüzgar hızı (km/h), WeatherAPI `wind_kph`.",
    )
    wind_gust_kph: Optional[float] = Field(
        None,
        description="Ani rüzgar (gust) hızı km/h; kısa süreli sıçrama. İş kuralı max(sürekli, ani) knot ile değerlendirir.",
    )
    wind_knots_effective: Optional[float] = Field(
        None,
        description="Kurallarda kullanılan etkin rüzgar (knot); sürekli ve ani rüzgârdan büyük olanın knot karşılığı.",
    )
    condition_code: Optional[int] = None
    condition_text: Optional[str] = None


class WeatherAssessment(BaseModel):
    """
    Ham hava ölçümleri ve eşik karşılaştırmaları.

    Yüzey rüzgarı: tabloda kalkış < 30 kt, iniş < 15–20 kt (eşikler ayarlanabilir).
    Yıldırım: tabloya göre yalnızca **kalkış** fazını durdurur (sayım durur); noktasal hava verisi kullanılır
    (15 km yarıçap için ayrı radar entegrasyonu ileride eklenebilir).
    """

    exceeds_takeoff_wind_limit: bool = Field(
        ...,
        description="Etkin rüzgar kalkış üst sınırını (varsayılan 30 kt) aşıyorsa True.",
    )
    exceeds_landing_wind_limit: bool = Field(
        ...,
        description="Etkin rüzgar iniş üst sınırını (varsayılan ~18 kt, 15–20 aralığı) aşıyorsa True.",
    )
    temp_pressure_warning: bool = Field(
        ...,
        description="Sıcaklık 0–35 °C dışındaysa yakıt/basınç riski (kalkış ve iniş için uyarı).",
    )
    lightning_detected: bool = Field(
        ...,
        description="Yıldırım/fırtına göstergesi (koşul kodu veya mock).",
    )
    lightning_halt_scoring: bool = Field(
        ...,
        description="Yıldırım varsa kalkış sayımı durur; skor/operasyonel kalkış No-Go ile uyumlu.",
    )
    messages: list[str] = Field(default_factory=list, description="İnsan okunur notlar.")
    raw: Optional[WeatherRawSnapshot] = None


class ElevationAssessment(BaseModel):
    """Open Elevation tabanlı rakım ve yaklaşık yerel eğim değerlendirmesi."""

    evaluated: bool = Field(
        False,
        description="True ise Open Elevation’dan anlamlı örnek alındı ve eğim hesaplandı.",
    )
    elevation_m: Optional[float] = Field(
        None,
        description="Merkez nokta rakımı (metre, deniz seviyesinden).",
    )
    slope_percent: Optional[float] = Field(
        None,
        description="K–D–G–B örnekleri arasından tahmini maksimum eğim yüzdesi (grade %).",
    )
    terrain_unsuitable: Optional[bool] = Field(
        None,
        description="True ise eğim eşiği aşıldı (karaya iniş + kalkış alanı için tablo: ~1–2 %).",
    )
    sample_radius_m: Optional[float] = Field(
        None,
        description="Komşu örnek noktalarının merkeze mesafesi (metre).",
    )
    slope_per_direction_percent: Optional[list[float]] = Field(
        None,
        description="Sırasıyla Kuzey, Doğu, Güney, Batı yönündeki eğim % tahminleri.",
    )
    messages: list[str] = Field(default_factory=list)


class LogisticsAssessment(BaseModel):
    """Overpass/OSM tabanlı liman–kıyı, demiryolu ve otoyol özeti."""

    evaluated: bool = Field(
        False,
        description="True ise Overpass sorgusu başarılı veya mock kullanıldı.",
    )
    deep_water_port_within_50km: Optional[bool] = Field(
        None,
        description="True: OSM’de liman/kıyı vektörü var; False: katman başarılı ama yok; None: katman alınamadı.",
    )
    heavy_rail_within_50km: Optional[bool] = Field(
        None,
        description="True: railway=rail var; False: yok; None: Overpass katmanı alınamadı.",
    )
    motorway_within_20km: Optional[bool] = Field(
        None,
        description="True: motorway/trunk var; False: yok; None: katman alınamadı.",
    )
    nearest_maritime_like_m: Optional[float] = Field(
        None,
        description="En yakın liman/pier/ferry benzeri öğeye jeodezik mesafe (m).",
    )
    nearest_rail_m: Optional[float] = Field(None, description="En yakın rail hattına mesafe (m).")
    nearest_motorway_m: Optional[float] = Field(None, description="En yakın otoyol/trunk mesafe (m).")
    osm_feature_counts: Optional[dict[str, int]] = Field(
        None,
        description="Kategori başına eşleşen öğe sayısı (maritime/rail/motorway).",
    )
    port_lock_warning: Optional[bool] = Field(
        None,
        description="Liman/kıyı vektörü yoksa True — tablo: ana gövde taşıma / inşaat kilidi riski.",
    )
    rail_cost_multiplier_note: Optional[str] = Field(
        None,
        description="Demiryolu yoksa maliyet çarpanı notu (tablo: ~x2).",
    )
    messages: list[str] = Field(default_factory=list)


class PayloadCapacityHint(BaseModel):
    """Ekvator yakınlığı — tablo: kalkış için 0°–28° enlem en verimli (payload / yakıt ekonomisi)."""

    evaluated: bool = Field(False, description="True ise enlem bandına göre skor üretildi.")
    latitude_abs: Optional[float] = None
    score_hint: Optional[float] = Field(
        None,
        description="0–28° ideal bandında 0–100 arası; 28° üzeri 0’a yaklaşır (sadece kalkış verimliliği ipucu).",
    )
    messages: list[str] = Field(default_factory=list)


class SimulationReport(BaseModel):
    """Simülasyon yanıtı."""

    latitude: float
    longitude: float
    landing_surface: LandingSurface
    overall_status: GoNoGoStatus = Field(
        ...,
        description="Kalkış ve iniş fazlarının birleşik en kötü sonucu (No-Go > Koşullu > Go).",
    )
    overall_messages: list[str] = Field(default_factory=list)
    takeoff: PhaseSuitability = Field(..., description="Kalkış uygunluğu (tablo: Kalkış sütunu).")
    landing: PhaseSuitability = Field(..., description="İniş uygunluğu (Karaya / Suya senaryosu).")
    weather: WeatherAssessment
    elevation: ElevationAssessment
    logistics: LogisticsAssessment
    payload_hint: PayloadCapacityHint
    meta: dict[str, Any] = Field(
        default_factory=dict,
        description="Kaynaklar, eşikler, faz notları.",
    )
