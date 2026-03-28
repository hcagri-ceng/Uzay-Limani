"""
Uzay Limanı — FastAPI giriş noktası.

Çalıştırma (proje kökünde):
    uvicorn main:app --reload --host 0.0.0.0 --port 8000

Swagger: http://127.0.0.1:8000/docs
Test arayüzü: http://127.0.0.1:8000/ui/
"""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncGenerator

import httpx
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from config import Settings, get_settings
from engine.simulator import build_simulation_report
from models import SimulationReport, SimulationRequest
from services.elevation_service import fetch_elevation_context
from services.logistics_service import fetch_logistics_context
from services.weather_service import (
    WeatherServiceError,
    fetch_current_weather,
    parse_weather_for_simulator,
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Paylaşılan HTTP istemcisi (connection reuse)
_http_client: httpx.AsyncClient | None = None


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    """Uygulama ömrü: httpx.AsyncClient oluştur ve kapat."""
    global _http_client
    _http_client = httpx.AsyncClient(
        headers={"User-Agent": "SpaceportSim/1.0 (FastAPI)"},
        follow_redirects=True,
    )
    yield
    if _http_client is not None:
        await _http_client.aclose()
        _http_client = None


app = FastAPI(
    title="Uzay Limanı — Lojistik ve Çevresel Etki Simülasyonu",
    description=(
        "Koordinat bazlı meteoroloji, Open Elevation, Overpass (OSM) lojistik; kalkış/iniş kuralları."
    ),
    version="0.3.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def get_http_client() -> httpx.AsyncClient:
    """Route bağımlılığı: yaşam döngüsü istemcisi."""
    if _http_client is None:
        raise RuntimeError("HTTP istemcisi başlatılmadı.")
    return _http_client


@app.post(
    "/api/v1/simulate",
    response_model=SimulationReport,
    summary="Fırlatma uygunluk simülasyonu",
    responses={
        502: {"description": "Harici hava servisi hatası veya yapılandırma eksik."},
        422: {"description": "Geçersiz istek gövdesi."},
    },
)
async def simulate(
    body: SimulationRequest,
    request: Request,
    client: httpx.AsyncClient = Depends(get_http_client),
    settings: Settings = Depends(get_settings),
) -> SimulationReport:
    """
    WeatherAPI, Open Elevation ve Overpass (OpenStreetMap) **paralel** çağrılır. Kalkış/iniş tablo
    kuralları + 50 km liman–demiryolu / 20 km otoyol OSM taraması; eksiklerde faz **koşullu** yükseltilir.

    İsteğe bağlı ``lightning_mock`` sorgu parametresi: test için yıldırım mock’u.
    """
    lightning_mock: bool | None = None
    q = request.query_params.get("lightning_mock")
    if q is not None:
        lightning_mock = q.strip().lower() in ("1", "true", "yes", "on")

    try:
        raw_w, elev_ctx, log_ctx = await asyncio.gather(
            fetch_current_weather(client, settings, body.latitude, body.longitude),
            fetch_elevation_context(client, settings, body.latitude, body.longitude),
            fetch_logistics_context(client, settings, body.latitude, body.longitude),
        )
        parsed = parse_weather_for_simulator(raw_w)
        report = build_simulation_report(
            body.latitude,
            body.longitude,
            parsed,
            elev_ctx,
            log_ctx,
            landing_surface=body.landing_surface,
            wave_height_m=body.wave_height_m,
            lightning_mock_override=lightning_mock,
            max_terrain_slope_percent=settings.max_terrain_slope_percent,
            wind_takeoff_max_knots=settings.wind_takeoff_max_knots,
            wind_landing_max_knots=settings.wind_landing_max_knots,
            max_wave_height_m=settings.max_wave_height_m,
            ideal_equator_latitude_max_deg=settings.ideal_equator_latitude_max_deg,
        )
        if settings.use_mock_weather:
            report.meta["weather_source"] = "mock"
        else:
            report.meta["weather_source"] = "weatherapi.com"
        if elev_ctx.get("mock"):
            report.meta["elevation_source"] = "mock"
        else:
            prov = elev_ctx.get("provider") or "—"
            report.meta["elevation_source"] = prov
            report.meta["elevation_provider"] = prov
        if not elev_ctx.get("evaluated"):
            err = elev_ctx.get("error") or ""
            if "<html" in err.lower():
                err = "Rakım servisi yanıt vermedi (504/502). OpenTopoData ve Open Elevation denendi."
            report.meta["elevation_error"] = err
        report.meta["requested_wave_height_m"] = body.wave_height_m
        report.meta["logistics_source"] = "mock" if log_ctx.get("mock") else "overpass-osm"
        if not log_ctx.get("evaluated"):
            report.meta["logistics_error"] = log_ctx.get("error")
        return report
    except WeatherServiceError as exc:
        logger.warning("Weather hata: %s", exc)
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.get("/health")
async def health() -> dict[str, str]:
    """Basit sağlık kontrolü (yük dengeleyici / konteyner prob)."""
    return {"status": "ok"}


# Statik test arayüzü: static/ klasörü
_STATIC_DIR = Path(__file__).resolve().parent / "static"
if _STATIC_DIR.is_dir():
    app.mount("/ui/static", StaticFiles(directory=str(_STATIC_DIR)), name="ui_static")


@app.get("/ui/", include_in_schema=False)
async def serve_test_ui() -> FileResponse:
    """Basit HTML test sayfası."""
    index = _STATIC_DIR / "index.html"
    if not index.is_file():
        return JSONResponse(
            status_code=404,
            content={"detail": "static/index.html bulunamadı."},
        )
    return FileResponse(index)


@app.get("/", include_in_schema=False)
async def root_redirect() -> dict[str, str]:
    """Kök yol: UI ve dokümantasyon bağlantıları."""
    return {
        "message": "Uzay Limanı API",
        "docs": "/docs",
        "test_ui": "/ui/",
        "simulate": "POST /api/v1/simulate",
    }
