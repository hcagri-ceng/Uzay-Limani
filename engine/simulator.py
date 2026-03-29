"""
Fırlatma uygunluk motoru: tablo kurallarına göre kalkış ve iniş ayrı değerlendirilir.

**Kalkış (tablo — Kalkış):**
- Yüzey rüzgarı: etkin rüzgar > kalkış eşiği (varsayılan 30 kt) → No-Go.
- Yıldırım/oraj: tespit → kalkış No-Go, sayım durur (noktasal hava; 15 km yarıçap ileride).
- Sıcaklık: 0–35 °C dışı → koşullu (yakıt/basınç riski).
- Eğim (karaya alan): max eğim % > eşik → arazi uygun değil, kalkış No-Go.
- Ekvator yakınlığı: 0–28° için payload ipucu (puan); No-Go tetiklemez.

**İniş — karaya (tablo — Karaya iniş):**
- Yüzey rüzgarı: > iniş eşiği (varsayılan 18 kt, 15–20 bandı) → No-Go.
- Yıldırım: tabloya göre yalnızca kalkış; iniş kararını **bloke etmez**.
- Sıcaklık: aynı uyarı → koşullu.
- Eğim: karaya inişte eğim eşiği aşımı → No-Go.

**İniş — suya (tablo — Suya iniş):**
- Rüzgar: iniş eşiği.
- Dalga: ``wave_height_m`` verilmiş ve > eşik (varsayılan 2.5 m) → No-Go.
- Dalga verisi yok → koşullu (manuel doğrulama).
- Eğim kuralı uygulanmaz (deniz yüzeyi).

Genel durum: kalkış ve inişten **daha kötü** olan (No-Go > Koşullu > Go).
"""

from __future__ import annotations

from typing import Any, Optional

from models import (
    ElevationAssessment,
    GoNoGoStatus,
    LandingSurface,
    LogisticsAssessment,
    PayloadCapacityHint,
    PhaseSuitability,
    SimulationReport,
    WeatherAssessment,
    WeatherRawSnapshot,
)


TEMP_MIN_C: float = 0.0
TEMP_MAX_C: float = 35.0
DEFAULT_MAX_TERRAIN_SLOPE_PERCENT: float = 2.0


def _severity_rank(s: GoNoGoStatus) -> int:
    """Düşük = daha kötü (öncelikli)."""
    return {GoNoGoStatus.NO_GO: 0, GoNoGoStatus.CONDITIONAL: 1, GoNoGoStatus.GO: 2}[s]


def merge_phase_status(a: GoNoGoStatus, b: GoNoGoStatus) -> GoNoGoStatus:
    """İki faz sonucunu birleştirir (en kötü kazanır)."""
    return a if _severity_rank(a) <= _severity_rank(b) else b


def _lift_to_conditional(status: GoNoGoStatus) -> GoNoGoStatus:
    """No-Go’yu korur; Go → Koşullu; zaten koşullu ise aynı kalır."""
    if status == GoNoGoStatus.NO_GO:
        return status
    if status == GoNoGoStatus.GO:
        return GoNoGoStatus.CONDITIONAL
    return GoNoGoStatus.CONDITIONAL


def _apply_logistics_rules(logistics_ctx: dict[str, Any]) -> LogisticsAssessment:
    """
    Overpass özet sözlüğünü ``LogisticsAssessment`` modeline ve tablo mesajlarına çevirir.
    """
    if not logistics_ctx.get("evaluated"):
        err = logistics_ctx.get("error")
        return LogisticsAssessment(
            evaluated=False,
            messages=[
                "Lojistik (OpenStreetMap / Overpass) verisi alınamadı: "
                f"{err or 'bilinmeyen neden'}."
            ],
        )

    mmin = logistics_ctx.get("maritime_min_m")
    rmin = logistics_ctx.get("rail_min_m")
    omin = logistics_ctx.get("motorway_min_m")
    counts = logistics_ctx.get("counts") or {}
    ml_ok = bool(logistics_ctx.get("maritime_layer_ok"))
    rl_ok = bool(logistics_ctx.get("rail_layer_ok"))
    rd_ok = bool(logistics_ctx.get("motorway_layer_ok"))

    # True / False / None(None) = katman hatası (429 vb.) → kural uygulanmaz, uyarı verilir.
    port_ok: Optional[bool] = True if mmin is not None else (False if ml_ok else None)
    rail_ok: Optional[bool] = True if rmin is not None else (False if rl_ok else None)
    mot_ok: Optional[bool] = True if omin is not None else (False if rd_ok else None)

    messages: list[str] = []
    if not ml_ok:
        messages.append("Lojistik: liman/kıyı OSM katmanı alınamadı (Overpass hız sınırı veya ağ hatası).")
    if not rl_ok:
        messages.append("Lojistik: demiryolu OSM katmanı alınamadı — demiryolu kuralı atlandı.")
    if not rd_ok:
        messages.append("Lojistik: otoyol OSM katmanı alınamadı — otoyol kuralı atlandı.")

    if port_ok is True:
        messages.append(
            f"Kıyı/liman vektörü: en yakın OSM öğesi ~{float(mmin):.0f} m "
            f"({logistics_ctx.get('port_rail_radius_m', 50000)} m tarama)."
        )
    elif port_ok is False:
        messages.append(
            "50 km içinde harbour/pier/ferry_terminal vb. bulunamadı — tablo: deniz lojistiği / "
            "ana gövde taşıma için yüksek risk; inşaat veya operasyon kilit uyarısı."
        )

    rail_note: Optional[str] = None
    if rail_ok is True:
        messages.append(f"Demiryolu (rail): en yakın hat ~{float(rmin):.0f} m.")
    elif rail_ok is False:
        rail_note = (
            "50 km içinde railway=rail bulunamadı — tablo: demiryolu yokken lojistik maliyet ~2x kabulü."
        )
        messages.append(rail_note)

    if mot_ok is True:
        messages.append(f"Otoyol/trunk: en yakın ~{float(omin):.0f} m ({logistics_ctx.get('motorway_radius_m', 20000)} m tarama).")
    elif mot_ok is False:
        messages.append(
            "20 km içinde motorway/trunk bulunamadı — tablo: acil ekip/personel erişim süresi riski."
        )

    return LogisticsAssessment(
        evaluated=True,
        deep_water_port_within_50km=port_ok,
        heavy_rail_within_50km=rail_ok,
        motorway_within_20km=mot_ok,
        nearest_maritime_like_m=float(mmin) if mmin is not None else None,
        nearest_rail_m=float(rmin) if rmin is not None else None,
        nearest_motorway_m=float(omin) if omin is not None else None,
        osm_feature_counts=dict(counts) if isinstance(counts, dict) else None,
        port_lock_warning=(port_ok is False),
        rail_cost_multiplier_note=rail_note if rail_ok is False else None,
        messages=messages,
    )


def _apply_weather_rules(
    parsed: dict[str, Any],
    *,
    takeoff_wind_max_kt: float,
    landing_wind_max_kt: float,
    lightning_mock_override: Optional[bool] = None,
) -> WeatherAssessment:
    """Etkin rüzgarı kalkış ve iniş eşikleriyle ayrı karşılaştırır."""
    temp = parsed.get("temp_c")
    wind_knots = float(parsed.get("wind_knots_effective") or 0.0)
    lightning_api = bool(parsed.get("lightning_from_api"))

    if lightning_mock_override is not None:
        lightning_detected = bool(lightning_mock_override)
    else:
        lightning_detected = lightning_api

    exceeds_takeoff_wind = wind_knots > takeoff_wind_max_kt
    exceeds_landing_wind = wind_knots > landing_wind_max_kt

    temp_pressure_warning = False
    if temp is not None:
        t = float(temp)
        temp_pressure_warning = t < TEMP_MIN_C or t > TEMP_MAX_C

    messages: list[str] = []
    if exceeds_takeoff_wind:
        messages.append(
            f"Kalkış — yüzey rüzgarı: etkin ~{wind_knots:.2f} kt > kalkış limiti {takeoff_wind_max_kt} kt → No-Go."
        )
    if exceeds_landing_wind:
        messages.append(
            f"İniş — yüzey rüzgarı: etkin ~{wind_knots:.2f} kt > iniş limiti {landing_wind_max_kt} kt → No-Go."
        )
    if temp_pressure_warning and temp is not None:
        messages.append(
            f"Sıcaklık {temp} °C, önerilen bant dışı ({TEMP_MIN_C}–{TEMP_MAX_C} °C): "
            "yakıt/basınç riski (kalkış ve iniş için koşullu değerlendirme)."
        )
    if lightning_detected:
        messages.append(
            "Yıldırım/fırtına tespiti: tabloya göre **kalkış** sayımı durur / kalkış No-Go; "
            "iniş kararı bu gerekçeyle tek başına bloke edilmez."
        )

    raw = WeatherRawSnapshot(
        location_name=parsed.get("location_name"),
        temp_c=parsed.get("temp_c"),
        wind_kph=parsed.get("wind_kph"),
        wind_gust_kph=parsed.get("wind_gust_kph"),
        wind_knots_effective=parsed.get("wind_knots_effective"),
        condition_code=parsed.get("condition_code"),
        condition_text=parsed.get("condition_text"),
    )

    return WeatherAssessment(
        exceeds_takeoff_wind_limit=exceeds_takeoff_wind,
        exceeds_landing_wind_limit=exceeds_landing_wind,
        temp_pressure_warning=temp_pressure_warning,
        lightning_detected=lightning_detected,
        lightning_halt_scoring=lightning_detected,
        messages=messages,
        raw=raw,
    )


def _apply_elevation_rules(
    elevation_ctx: dict[str, Any],
    *,
    max_slope_percent: float,
) -> ElevationAssessment:
    """Open Elevation çıktısını iş kurallarına çevirir."""
    messages: list[str] = []

    if not elevation_ctx.get("evaluated"):
        err = elevation_ctx.get("error") or "Bilinmeyen neden"
        messages.append(f"Rakım/eğim verisi alınamadı: {err}")
        return ElevationAssessment(
            evaluated=False,
            elevation_m=elevation_ctx.get("elevation_m"),
            slope_percent=elevation_ctx.get("slope_percent_max"),
            terrain_unsuitable=None,
            sample_radius_m=elevation_ctx.get("sample_radius_m"),
            slope_per_direction_percent=elevation_ctx.get("slope_per_direction_percent"),
            messages=messages,
        )

    slope = elevation_ctx.get("slope_percent_max")
    elev = elevation_ctx.get("elevation_m")
    radius = elevation_ctx.get("sample_radius_m")
    per = elevation_ctx.get("slope_per_direction_percent")

    if slope is None:
        messages.append("Eğim hesaplanamadı.")
        return ElevationAssessment(
            evaluated=True,
            elevation_m=elev,
            slope_percent=None,
            terrain_unsuitable=None,
            sample_radius_m=radius,
            slope_per_direction_percent=per,
            messages=messages,
        )

    s = float(slope)
    terrain_unsuitable = s > max_slope_percent

    messages.append(
        f"Merkez rakımı ~{elev} m; {radius} m yarıçaplı örnekte tahmini max eğim ~{s:.2f} % "
        f"(eşik {max_slope_percent} %; tablo: karaya kalkış/iniş için ~1–2 %)."
    )
    if per:
        messages.append(
            "Yön başına eğim % (K,D,G,B): "
            + ", ".join(f"{p:.2f}" for p in per)
            + "."
        )
    if terrain_unsuitable:
        messages.append(
            f"Arazi uygun değil: eğim %{s:.2f} eşik %{max_slope_percent} değerini aşıyor."
        )

    return ElevationAssessment(
        evaluated=True,
        elevation_m=float(elev) if elev is not None else None,
        slope_percent=round(s, 4),
        terrain_unsuitable=terrain_unsuitable,
        sample_radius_m=float(radius) if radius is not None else None,
        slope_per_direction_percent=list(per) if isinstance(per, list) else None,
        messages=messages,
    )


def _payload_hint_for_takeoff(
    latitude: float,
    ideal_band_max_deg: float,
) -> PayloadCapacityHint:
    """
    Tablo: 0°–28° enlem kalkış verimliliği için ideal; payload / yakıt ekonomisi puanı.

    Skor: |enlem| 0° iken 100, 28° iken 0; 28° üzeri 0.
    """
    abs_lat = abs(latitude)
    messages: list[str] = []
    if abs_lat <= ideal_band_max_deg:
        score = 100.0 * (1.0 - abs_lat / ideal_band_max_deg)
        messages.append(
            f"Kalkış coğrafyası: |enlem| {abs_lat:.2f}° — ideal 0–{ideal_band_max_deg:.0f}° bandında; "
            f"payload/yakıt ekonomisi ipucu skoru ~{score:.1f}/100."
        )
    else:
        score = 0.0
        messages.append(
            f"Kalkış coğrafyası: |enlem| {abs_lat:.2f}° — tabloda ideal üst sınır {ideal_band_max_deg:.0f}°; "
            "ekvator dönüşünden fayda puanı düşük kabul edilir."
        )

    return PayloadCapacityHint(
        evaluated=True,
        latitude_abs=abs_lat,
        score_hint=round(score, 2),
        messages=messages,
    )


def build_simulation_report(
    latitude: float,
    longitude: float,
    weather_parsed: dict[str, Any],
    elevation_ctx: dict[str, Any],
    logistics_ctx: dict[str, Any],
    *,
    landing_surface: LandingSurface = LandingSurface.LAND,
    wave_height_m: Optional[float] = None,
    lightning_mock_override: Optional[bool] = None,
    max_terrain_slope_percent: float = DEFAULT_MAX_TERRAIN_SLOPE_PERCENT,
    wind_takeoff_max_knots: float = 30.0,
    wind_landing_max_knots: float = 18.0,
    max_wave_height_m: float = 2.5,
    ideal_equator_latitude_max_deg: float = 28.0,
) -> SimulationReport:
    """
    Hava + topoğrafya + Overpass lojistik + (isteğe bağlı) dalga ile kalkış/iniş raporu üretir.
    """
    weather = _apply_weather_rules(
        weather_parsed,
        takeoff_wind_max_kt=wind_takeoff_max_knots,
        landing_wind_max_kt=wind_landing_max_knots,
        lightning_mock_override=lightning_mock_override,
    )
    elevation = _apply_elevation_rules(
        elevation_ctx,
        max_slope_percent=max_terrain_slope_percent,
    )

    terrain_bad = bool(elevation.terrain_unsuitable is True)
    temp_warn = weather.temp_pressure_warning

    # --- Kalkış ---
    takeoff_msgs: list[str] = []
    takeoff_no_go = (
        weather.exceeds_takeoff_wind_limit
        or weather.lightning_detected
        or terrain_bad
    )
    if takeoff_no_go:
        takeoff_status = GoNoGoStatus.NO_GO
        if weather.exceeds_takeoff_wind_limit:
            takeoff_msgs.append("Kalkış No-Go: yüzey rüzgarı limiti aşıldı.")
        if weather.lightning_detected:
            takeoff_msgs.append("Kalkış No-Go: yıldırım/oraj (sayım durur).")
        if terrain_bad:
            takeoff_msgs.append("Kalkış No-Go: eğim / arazi uygun değil.")
    elif temp_warn:
        takeoff_status = GoNoGoStatus.CONDITIONAL
        takeoff_msgs.append("Kalkış koşullu: sıcaklık bandı dışı uyarısı.")
    else:
        takeoff_status = GoNoGoStatus.GO
        takeoff_msgs.append("Kalkış: yüzey rüzgarı, yıldırım ve eğim açısından tablo eşikleri içinde.")

    if not elevation.evaluated and elevation_ctx.get("error"):
        takeoff_msgs.append(
            "Uyarı: Rakım/eğim alınamadı; kalkış topoğrafya No-Go kuralı uygulanamadı."
        )

    # --- İniş ---
    landing_msgs: list[str] = []
    landing_no_go = weather.exceeds_landing_wind_limit

    if landing_surface == LandingSurface.LAND:
        landing_no_go = landing_no_go or terrain_bad
        if weather.exceeds_landing_wind_limit:
            landing_msgs.append("İniş No-Go: yüzey rüzgarı iniş limitini aşıyor (sapma riski).")
        if terrain_bad:
            landing_msgs.append("İniş No-Go: karaya iniş için eğim uygun değil.")
        if not landing_no_go and temp_warn:
            landing_status = GoNoGoStatus.CONDITIONAL
            landing_msgs.append("İniş koşullu: sıcaklık bandı dışı (yakıt/basınç riski).")
        elif landing_no_go:
            landing_status = GoNoGoStatus.NO_GO
        else:
            landing_status = GoNoGoStatus.GO
            landing_msgs.append("İniş (karaya): rüzgar ve eğim tablo eşikleri içinde.")
        landing_msgs.append("Not: Yıldırım tabloya göre yalnızca kalkış fazını bağlar.")
    else:
        # Suya iniş — dalga (tablo: < 2–3 m); kara eğimi bu fazda uygulanmaz.
        if wave_height_m is not None:
            wh = float(wave_height_m)
            if wh > max_wave_height_m:
                landing_no_go = True
                landing_msgs.append(
                    f"İniş No-Go: dalga yüksekliği {wh:.2f} m > limit {max_wave_height_m} m (kurtarma/güvenlik)."
                )
            else:
                landing_msgs.append(
                    f"Suya iniş: dalga {wh:.2f} m ≤ {max_wave_height_m} m — tablo aralığına uygun."
                )
        else:
            landing_msgs.append(
                "Suya iniş: dalga yüksekliği gönderilmedi; ölçüm/API ile doğrulanana kadar koşullu kabul edilir."
            )
        if weather.exceeds_landing_wind_limit:
            landing_no_go = True
            landing_msgs.append("İniş No-Go: yüzey rüzgarı iniş limitini aşıyor.")

        if landing_no_go:
            landing_status = GoNoGoStatus.NO_GO
        elif wave_height_m is None or temp_warn:
            landing_status = GoNoGoStatus.CONDITIONAL
            if temp_warn:
                landing_msgs.append("İniş koşullu: sıcaklık bandı dışı uyarısı.")
        else:
            landing_status = GoNoGoStatus.GO
            landing_msgs.append("İniş (suya): rüzgar ve dalga eşikleri içinde.")
        landing_msgs.append("Suya inişte kara eğimi kuralı uygulanmadı.")

    logistics = _apply_logistics_rules(logistics_ctx)
    if logistics.evaluated:
        if logistics.port_lock_warning:
            takeoff_status = _lift_to_conditional(takeoff_status)
            takeoff_msgs.append(
                "Lojistik (OSM): 50 km içinde liman/kıyı vektörü yok → kalkış **koşullu** "
                "(tablo: ana gövde deniz taşımacılığı / inşaat kilidi riski)."
            )
        if logistics.heavy_rail_within_50km is False:
            takeoff_status = _lift_to_conditional(takeoff_status)
            takeoff_msgs.append(
                "Lojistik (OSM): ağır yük demiryolu (rail) yok → kalkış **koşullu** "
                "(tablo: lojistik maliyet ~2x varsayımı)."
            )
        if logistics.motorway_within_20km is False:
            landing_status = _lift_to_conditional(landing_status)
            landing_msgs.append(
                "Lojistik (OSM): 20 km içinde otoyol/trunk yok → iniş **koşullu** "
                "(tablo: acil müdahale erişimi)."
            )

    takeoff_phase = PhaseSuitability(status=takeoff_status, messages=takeoff_msgs)
    landing_phase = PhaseSuitability(status=landing_status, messages=landing_msgs)

    overall = merge_phase_status(takeoff_status, landing_status)

    overall_messages: list[str] = [
        f"Genel özet: kalkış={takeoff_status.value}, iniş={landing_status.value} → birleşik={overall.value}."
    ]
    if overall == GoNoGoStatus.NO_GO:
        overall_messages.append(
            "En az bir faz No-Go; operasyon iptal veya faz ayrı planlanmalı."
        )
    elif overall == GoNoGoStatus.CONDITIONAL:
        overall_messages.append(
            "Tüm fazlar en azından koşullu veya Go; manuel onay önerilir."
        )
    else:
        overall_messages.append("Her iki faz da Go (mevcut veri ve tablo eşikleriyle).")

    payload_hint = _payload_hint_for_takeoff(latitude, ideal_equator_latitude_max_deg)

    return SimulationReport(
        latitude=latitude,
        longitude=longitude,
        landing_surface=landing_surface,
        overall_status=overall,
        overall_messages=overall_messages,
        takeoff=takeoff_phase,
        landing=landing_phase,
        weather=weather,
        elevation=elevation,
        logistics=logistics,
        payload_hint=payload_hint,
        meta={
            "phase": "weather+elevation+logistics+phases",
            "max_terrain_slope_percent": max_terrain_slope_percent,
            "wind_takeoff_max_knots": wind_takeoff_max_knots,
            "wind_landing_max_knots": wind_landing_max_knots,
            "max_wave_height_m": max_wave_height_m,
            "ideal_equator_latitude_max_deg": ideal_equator_latitude_max_deg,
            "logistics_port_rail_radius_m": logistics_ctx.get("port_rail_radius_m"),
            "logistics_motorway_radius_m": logistics_ctx.get("motorway_radius_m"),
            "lightning_note": (
                "Yıldırım şu an tek nokta hava verisine dayanır; tablodaki 15 km yarıçap için "
                "ileride alan verisi eklenebilir."
            ),
            "logistics_note": (
                "Deniz altı kablolar vb. ayrı etiketler ileride eklenebilir; şu an harbour/pier/rail/motorway."
            ),
        },
    )
