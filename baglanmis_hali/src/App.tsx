import React, { useState, useEffect, useRef, useMemo } from 'react';
import { 
  Rocket, 
  Wind, 
  Mountain, 
  Truck, 
  Zap, 
  AlertTriangle, 
  CheckCircle2, 
  XCircle, 
  Waves, 
  MapPin, 
  Info,
  Loader2,
  ChevronRight,
  Target,
  Globe as GlobeIcon,
  RefreshCcw,
  ArrowLeft,
  Search,
  ChevronDown
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import Globe from 'react-globe.gl';
import { cn } from './lib/utils';
import {
  bboxToPolygonGeometry,
  pointInGeometry,
  type GeoJsonPolygonLike,
} from './lib/polygon';
import {
  pickBestNominatimResult,
  buildCitySelectionGeometry,
  LOCAL_FALLBACK_HALF_DEG,
} from './lib/nominatimPick';
import { fetchCountryBboxAndPolygon, altitudeForCountryBbox, bboxCenter } from './lib/nominatimCountry';
import { 
  GoNoGoStatus, 
  LandingSurface, 
  SimulationRequest, 
  SimulationReport 
} from './types';

// --- Data ---
// --- Components ---

const SearchableSelect = ({ 
  options, 
  onSelect, 
  placeholder, 
  label,
  loading = false
}: { 
  options: string[], 
  onSelect: (val: string) => void, 
  placeholder: string,
  label: string,
  loading?: boolean
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState("");
  const dropdownRef = useRef<HTMLDivElement>(null);

  const filteredOptions = options.filter(opt => 
    opt.toLowerCase().includes(search.toLowerCase())
  );

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  return (
    <div className="space-y-2 relative" ref={dropdownRef}>
      <label className="mission-label">{label}</label>
      <div 
        onClick={() => !loading && setIsOpen(!isOpen)}
        className={cn(
          "mission-input w-full flex items-center justify-between cursor-pointer hover:border-nasa-red/45 transition-colors",
          loading && "opacity-50 cursor-wait"
        )}
      >
        <span className={cn("text-sm truncate pr-4", !search && "text-mission-muted")}>
          {loading ? (
            "Loading database..."
          ) : isOpen ? (
            <input 
              autoFocus
              className="bg-transparent border-none outline-none w-full text-mission-accent placeholder:text-mission-muted/50"
              placeholder="Type to search..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            search || placeholder
          )}
        </span>
        <ChevronDown size={16} className={cn("transition-transform shrink-0", isOpen && "rotate-180")} />
      </div>

      <AnimatePresence>
        {isOpen && (
          <motion.div 
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="absolute z-[100] w-full mt-2 mission-card overflow-hidden bg-[#0a1222]/95 backdrop-blur-2xl max-h-64 overflow-y-auto custom-scrollbar border-nasa-red/35 shadow-2xl shadow-nasa-red/10"
            style={{ top: '100%' }}
          >
            {filteredOptions.length > 0 ? (
              filteredOptions.map((opt) => (
                <div
                  key={opt}
                  onClick={() => {
                    onSelect(opt);
                    setSearch(opt);
                    setIsOpen(false);
                  }}
                  className="px-4 py-3 text-sm hover:bg-nasa-red/15 hover:text-mission-accent cursor-pointer transition-colors border-b border-white/5 last:border-none uppercase tracking-widest font-bold"
                >
                  {opt}
                </div>
              ))
            ) : (
              <div className="px-4 py-3 text-xs text-mission-muted italic uppercase">No results found in database</div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

const StatusBadge = ({ status, className }: { status: GoNoGoStatus, className?: string }) => {
  const config = {
    [GoNoGoStatus.GO]: { color: 'bg-go/20 text-go border-go/30', icon: CheckCircle2, label: 'GO' },
    [GoNoGoStatus.NO_GO]: { color: 'bg-no-go/20 text-no-go border-no-go/30', icon: XCircle, label: 'NO-GO' },
    [GoNoGoStatus.CONDITIONAL]: { color: 'bg-conditional/20 text-conditional border-conditional/30', icon: AlertTriangle, label: 'CONDITIONAL' },
  };
  
  const { color, icon: Icon, label } = config[status];
  
  return (
    <div className={cn("flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[10px] font-bold tracking-wider uppercase", color, className)}>
      <Icon size={12} />
      {label}
    </div>
  );
};

const AssessmentCard = ({ title, icon: Icon, status, children, messages }: { 
  title: string, 
  icon: any, 
  status?: GoNoGoStatus, 
  children: React.ReactNode,
  messages?: string[]
}) => (
  <motion.div 
    initial={{ opacity: 0, y: 20 }}
    animate={{ opacity: 1, y: 0 }}
    className="mission-card p-5 flex flex-col gap-4"
  >
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-3">
        <div className="p-2 rounded bg-white/5 text-mission-accent">
          <Icon size={20} />
        </div>
        <h3 className="font-bold text-sm tracking-tight uppercase">{title}</h3>
      </div>
      {status && <StatusBadge status={status} />}
    </div>
    
    <div className="flex-1">
      {children}
    </div>

    {messages && messages.length > 0 && (
      <div className="mt-2 space-y-1">
        {messages.map((msg, i) => (
          <div key={i} className="flex items-start gap-2 text-[11px] text-mission-text/60 leading-tight">
            <ChevronRight size={10} className="mt-0.5 shrink-0 text-mission-accent" />
            {msg}
          </div>
        ))}
      </div>
    )}
  </motion.div>
);

export default function App() {
  const globeRef = useRef<any>();
  /** Hızlı ülke değişiminde gecikmeli Nominatim yanıtının eski ülkeyi çizmesini engeller. */
  const countrySelectFetchGenRef = useRef(0);
  const simulateGenerationRef = useRef(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ 
    width: typeof window !== 'undefined' ? window.innerWidth : 0, 
    height: typeof window !== 'undefined' ? window.innerHeight : 0 
  });
  const [loading, setLoading] = useState(false);
  const [report, setReport] = useState<SimulationReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<'globe' | 'results'>('globe');
  const [selectionStep, setSelectionStep] = useState<'country' | 'city' | 'point'>('country');
  const [selectedCountry, setSelectedCountry] = useState<any | null>(null);
  const [selectedCity, setSelectedCity] = useState<any | null>(null);
  const [targetPoint, setTargetPoint] = useState<any[]>([]);
  const [hoverPoint, setHoverPoint] = useState<any[]>([]);
  const [countries, setCountries] = useState<any[]>([]);
  const [cities, setCities] = useState<string[]>([]);
  const [isLoadingCountries, setIsLoadingCountries] = useState(true);
  const [isLoadingCities, setIsLoadingCities] = useState(false);

  // Handle globe resizing and remounting
  useEffect(() => {
    const target = containerRef.current;
    if (!target) return;
    
    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.contentRect.width > 0 && entry.contentRect.height > 0) {
          setDimensions({
            width: entry.contentRect.width,
            height: entry.contentRect.height,
          });
        }
      }
    });

    resizeObserver.observe(target);
    return () => resizeObserver.disconnect();
  }, [view]); // Re-run when view changes to catch the remounted ref

  const [formData, setFormData] = useState<SimulationRequest>({
    latitude: 28.5721, // Cape Canaveral
    longitude: -80.6480,
    landing_surface: LandingSurface.LAND,
    wave_height_m: undefined
  });

  const arcsData = useMemo(() => [
    { startLat: 28.57, startLng: -80.64, endLat: 34.74, endLng: -120.57, color: 'rgba(248,250,252,0.45)' },
    { startLat: 5.23, startLng: -52.76, endLat: 45.96, endLng: 63.30, color: 'rgba(224,40,40,0.35)' }
  ], []);

  /** Şehir geometrisi yoksa (Nominatim poligonu gelmediyse) şehir merkezi kırmızı işaret. */
  const cityAnchorPoints = useMemo(() => {
    if (selectionStep !== 'point' || !selectedCity) return [];
    if (selectedCity.selectionGeometry) return [];
    const lat = selectedCity.lat;
    const lng = selectedCity.lng;
    if (typeof lat !== 'number' || typeof lng !== 'number' || Number.isNaN(lat) || Number.isNaN(lng)) return [];
    return [{
      lat,
      lng,
      size: 0.14,
      color: '#FC3D21',
      role: 'cityAnchor' as const,
    }];
  }, [selectionStep, selectedCity]);

  const selectionPolygonsData = useMemo(() => {
    if (selectionStep !== 'point' || !selectedCity?.selectionGeometry) return [];
    return [{ geometry: selectedCity.selectionGeometry as GeoJsonPolygonLike }];
  }, [selectionStep, selectedCity]);

  const isInsideSelectionArea = (lat: number, lng: number): boolean => {
    if (!selectedCity) return false;
    const g = selectedCity.selectionGeometry as GeoJsonPolygonLike | undefined;
    if (g) return pointInGeometry(lat, lng, g);
    if (selectedCity.boundingBox) {
      const { minLat, maxLat, minLng, maxLng } = selectedCity.boundingBox;
      return lat >= minLat && lat <= maxLat && lng >= minLng && lng <= maxLng;
    }
    return true;
  };

  // --- Data Fetching ---

  useEffect(() => {
    const fetchCountries = async () => {
      try {
        const response = await fetch('https://countriesnow.space/api/v0.1/countries/positions');
        const data = await response.json();
        if (!data.error) {
          const sorted = data.data.sort((a: any, b: any) => a.name.localeCompare(b.name));
          setCountries(sorted);
        }
      } catch (err) {
        console.error("Failed to fetch countries:", err);
      } finally {
        setIsLoadingCountries(false);
      }
    };
    fetchCountries();
  }, []);

  const fetchCities = async (countryName: string) => {
    setIsLoadingCities(true);
    setCities([]);
    try {
      const response = await fetch('https://countriesnow.space/api/v0.1/countries/cities', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ country: countryName })
      });
      const data = await response.json();
      if (!data.error) {
        setCities(data.data.sort());
      }
    } catch (err) {
      console.error("Failed to fetch cities:", err);
    } finally {
      setIsLoadingCities(false);
    }
  };

  const geocodeCity = async (cityName: string, countryName: string) => {
    try {
      const query = encodeURIComponent(`${cityName}, ${countryName}`);
      const url =
        `https://nominatim.openstreetmap.org/search?q=${query}&format=json&limit=20` +
        `&polygon_geojson=1&addressdetails=1&email=burakkaradas71@gmail.com`;
      const response = await fetch(url);
      const data = await response.json();
      if (!data?.length) return null;

      const targetArea = pickBestNominatimResult(data);
      if (!targetArea) return null;

      const la = parseFloat(String(targetArea.lat));
      const lo = parseFloat(String(targetArea.lon));
      if (!Number.isFinite(la) || !Number.isFinite(lo)) return null;

      const { boundingBox, selectionGeometry } = buildCitySelectionGeometry(targetArea, la, lo);

      return {
        lat: la,
        lng: lo,
        boundingBox,
        selectionGeometry,
      };
    } catch (err) {
      console.error("Geocoding failed:", err);
    }
    return null;
  };

  const handleSimulate = async (overrideCoords?: { lat: number, lng: number }) => {
    setLoading(true);
    setError(null);

    const lat = Number(overrideCoords?.lat ?? formData.latitude);
    const lng = Number(overrideCoords?.lng ?? formData.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      setLoading(false);
      setError('Invalid coordinates. Pick a city and tap the marker or the globe again.');
      return;
    }

    const gen = ++simulateGenerationRef.current;
    const { landing_surface, wave_height_m } = formData;

    try {
      if (globeRef.current) {
        globeRef.current.pointOfView({ lat, lng, alt: 0.15 }, 1500);
      }

      await new Promise(r => setTimeout(r, 1500));
      if (gen !== simulateGenerationRef.current) return;

      const requestData = { latitude: lat, longitude: lng, landing_surface, wave_height_m };

      const response = await fetch('/api/v1/simulate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestData)
      });

      if (gen !== simulateGenerationRef.current) return;

      if (!response.ok) throw new Error('Simulation failed. Check backend connectivity.');
      const result = await response.json();

      if (gen !== simulateGenerationRef.current) return;

      setReport(result);
      setView('results');
    } catch (err: any) {
      if (gen === simulateGenerationRef.current) {
        setError(err.message);
        if (globeRef.current) {
          globeRef.current.pointOfView({ alt: 2.5 }, 1000);
        }
      }
    } finally {
      if (gen === simulateGenerationRef.current) {
        setLoading(false);
      }
    }
  };

  const resetSimulation = () => {
    setView('globe');
    setSelectionStep('country');
    setSelectedCountry(null);
    setSelectedCity(null);
    setTargetPoint([]);
    setReport(null);
    if (globeRef.current) {
      globeRef.current.pointOfView({ alt: 2.5 }, 1500);
    }
  };

  const recalibrateTarget = () => {
    setView('globe');
    setSelectionStep('point');
    setTargetPoint([]);
    setReport(null);
    if (globeRef.current && selectedCity) {
      globeRef.current.pointOfView({ lat: selectedCity.lat, lng: selectedCity.lng, alt: 0.15 }, 1500);
    }
  };

  const handleCountrySelect = async (countryName: string) => {
    const country = countries.find(c => c.name === countryName);
    if (!country) return;

    const fetchGen = ++countrySelectFetchGenRef.current;

    setSelectedCity(null);
    setSelectedCountry(country);
    setSelectionStep('city');
    fetchCities(countryName);

    const apiLng = country.iso2 === 'TR' ? 35 : country.long;
    const apiLat = Number(country.lat);
    if (globeRef.current) {
      globeRef.current.pointOfView({ lat: apiLat, lng: apiLng, alt: 0.4 }, 1000);
    }

    const mapped = await fetchCountryBboxAndPolygon(countryName);
    if (fetchGen !== countrySelectFetchGenRef.current) return;

    if (mapped && globeRef.current) {
      const c = bboxCenter(mapped.bbox);
      const alt = altitudeForCountryBbox(mapped.bbox);
      globeRef.current.pointOfView({ lat: c.lat, lng: c.lng, alt }, 2200);
    } else if (globeRef.current) {
      globeRef.current.pointOfView({ lat: apiLat, lng: Number(apiLng), alt: 0.36 }, 1800);
    }
  };

  const handleCitySelect = async (cityName: string) => {
    if (!selectedCountry) return;
    
    setIsLoadingCities(true);
    const coords = await geocodeCity(cityName, selectedCountry.name);
    setIsLoadingCities(false);
    
    type CitySel = {
      name: string;
      lat: number;
      lng: number;
      boundingBox: { minLat: number; maxLat: number; minLng: number; maxLng: number } | null;
      selectionGeometry: GeoJsonPolygonLike | null;
    };

    let payload: CitySel;
    if (coords) {
      payload = { name: cityName, ...coords };
    } else {
      const clat = Number(selectedCountry.lat);
      const clng = Number(selectedCountry.long);
      const h = LOCAL_FALLBACK_HALF_DEG;
      payload = {
        name: cityName,
        lat: clat,
        lng: clng,
        boundingBox: null,
        selectionGeometry: bboxToPolygonGeometry(clat - h, clat + h, clng - h, clng + h),
      };
    }

    setSelectedCity(payload);
    setSelectionStep('point');
    setTargetPoint([]);
    setHoverPoint([]);
    setFormData(prev => ({ ...prev, latitude: payload.lat, longitude: payload.lng }));

    if (globeRef.current) {
      globeRef.current.pointOfView({ lat: payload.lat, lng: payload.lng, alt: 0.15 }, 2500);
    }
  };

  const confirmCoordinates = (lat: number, lng: number) => {
    if (selectionStep !== 'point' || loading) return;

    if (selectedCity && !isInsideSelectionArea(lat, lng)) {
      setError(`Click inside the red zone for ${selectedCity.name}.`);
      setTimeout(() => setError(null), 3500);
      return;
    }

    setFormData(prev => ({ ...prev, latitude: lat, longitude: lng }));
    setTargetPoint([{ lat, lng, size: 0.05, color: '#f8fafc' }]);
    setHoverPoint([]);
    handleSimulate({ lat, lng });
  };

  const handleGlobeClick = ({ lat, lng }: { lat: number, lng: number }) => {
    confirmCoordinates(lat, lng);
  };

  const handlePointClick = (point: object) => {
    const p = point as { role?: string };
    if (p.role !== 'cityAnchor' || !selectedCity || selectionStep !== 'point' || loading) return;
    confirmCoordinates(selectedCity.lat, selectedCity.lng);
  };

  const handlePolygonClick = (_polygon: object, event: MouseEvent, coords: { lat: number; lng: number }) => {
    event.stopPropagation?.();
    if (selectionStep !== 'point' || loading) return;
    confirmCoordinates(coords.lat, coords.lng);
  };

  const handleGlobeHover = (point: { lat: number, lng: number } | null) => {
    if (selectionStep === 'point' && !loading && point) {
      const isValid = selectedCity ? isInsideSelectionArea(point.lat, point.lng) : true;

      if (isValid) {
        setHoverPoint([{ ...point, size: 0.02, color: 'rgba(248, 250, 252, 0.55)' }]);
      } else {
        setHoverPoint([{ ...point, size: 0.01, color: 'rgba(255, 68, 68, 0.35)' }]);
      }
    } else {
      setHoverPoint([]);
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-mission-bg overflow-hidden">
      {/* Header */}
      <header className="border-b border-white/10 bg-[#070f1c]/85 backdrop-blur-md z-50">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3 cursor-pointer" onClick={resetSimulation}>
            <div className="w-10 h-10 rounded-lg bg-nasa-red flex items-center justify-center text-white shadow-[0_0_22px_rgba(224,40,40,0.45)]">
              <Rocket size={24} />
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-tighter uppercase">Spaceport Simulator</h1>
              <p className="text-[10px] font-mono text-mission-muted tracking-widest uppercase">Mission Control Interface v0.3.0</p>
            </div>
          </div>
          
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2 bg-white/5 rounded-full px-3 py-1 border border-white/10">
              <div className="w-2 h-2 rounded-full animate-pulse bg-mission-accent" />
              <span className="text-[10px] font-mono uppercase tracking-wider">
                Live API Mode
              </span>
            </div>
          </div>
        </div>
      </header>

      <div className="flex-1 relative">
        <AnimatePresence mode="wait">
          {view === 'globe' ? (
            <motion.div 
              key="globe-view"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0, scale: 1.1, filter: 'blur(10px)' }}
              className="absolute inset-0 flex flex-col md:flex-row items-center justify-end md:justify-start p-6 md:p-12 pointer-events-none"
            >
              {/* Globe Background */}
              <div ref={containerRef} className="absolute inset-0 z-0 pointer-events-auto">
                <Globe
                  ref={globeRef}
                  width={dimensions.width}
                  height={dimensions.height}
                  globeImageUrl="//unpkg.com/three-globe/example/img/earth-night.jpg"
                  bumpImageUrl="//unpkg.com/three-globe/example/img/earth-topology.png"
                  backgroundImageUrl="//unpkg.com/three-globe/example/img/night-sky.png"
                  arcsData={arcsData}
                  arcColor={'color'}
                  arcDashLength={0.4}
                  arcDashGap={4}
                  arcDashAnimateTime={1500}
                  atmosphereColor="#c8d4e8"
                  atmosphereAltitude={0.15}
                  onGlobeClick={handleGlobeClick}
                  onGlobeHover={handleGlobeHover}
                  onPointClick={handlePointClick}
                  onPolygonClick={handlePolygonClick}
                  polygonsData={selectionPolygonsData}
                  polygonGeoJsonGeometry="geometry"
                  polygonCapColor={() => 'rgba(255, 24, 40, 0.16)'}
                  polygonSideColor={() => 'rgba(255, 24, 40, 0.35)'}
                  polygonStrokeColor={() => '#ff1528'}
                  polygonAltitude={0.012}
                  pointsData={[...cityAnchorPoints, ...targetPoint, ...hoverPoint]}
                  pointColor="color"
                  pointAltitude={0.01}
                  pointRadius="size"
                />
              </div>

              {/* Overlay Controls */}
              <div className="relative z-10 w-full max-w-sm md:max-w-md pointer-events-auto mb-4 md:mb-0">
                <motion.div 
                  initial={{ x: -100, opacity: 0 }}
                  animate={{ x: 0, opacity: 1 }}
                  transition={{ delay: 0.5, type: 'spring', damping: 20 }}
                  className="mission-card p-6 md:p-8 backdrop-blur-xl bg-[#070f1c]/75 shadow-[0_0_50px_rgba(0,0,0,0.45)] border-l-4 border-l-nasa-red"
                >
                  <div className="flex items-center gap-3 mb-6 md:mb-8">
                    <div className="p-2 rounded bg-nasa-red/15 text-nasa-red">
                      <GlobeIcon size={24} />
                    </div>
                    <div>
                      <h2 className="text-xl font-bold uppercase tracking-tight">
                        {selectionStep === 'country' && "Select Country"}
                        {selectionStep === 'city' && "Select City"}
                        {selectionStep === 'point' && "Confirm Location"}
                      </h2>
                      <p className="text-[10px] text-mission-muted uppercase tracking-widest">
                        {selectionStep === 'country' && "Step 1: Regional Targeting"}
                        {selectionStep === 'city' && "Step 2: Local Deployment"}
                        {selectionStep === 'point' && "Step 3: Precise Coordinates"}
                      </p>
                    </div>
                  </div>

                  <div className="space-y-6">
                    {selectionStep === 'country' && (
                      <div className="space-y-4">
                        <SearchableSelect 
                          label="Target Country"
                          placeholder="Select a country..."
                          options={countries.map(l => l.name)}
                          onSelect={handleCountrySelect}
                          loading={isLoadingCountries}
                        />
                        <p className="text-[10px] text-mission-muted uppercase tracking-widest italic">
                          * Global database access active: {countries.length} nations available
                        </p>
                      </div>
                    )}

                    {selectionStep === 'city' && selectedCountry && (
                      <div className="space-y-4">
                        <button 
                          onClick={() => {
                            setSelectionStep('country');
                            setSelectedCountry(null);
                            setSelectedCity(null);
                          }}
                          className="text-[10px] font-mono uppercase tracking-widest text-mission-muted hover:text-nasa-red flex items-center gap-1 mb-2"
                        >
                          <ArrowLeft size={12} /> Back to Countries
                        </button>
                        
                        <SearchableSelect 
                          label={`Launch Complex in ${selectedCountry.name}`}
                          placeholder="Select a city..."
                          options={cities}
                          onSelect={handleCitySelect}
                          loading={isLoadingCities}
                        />

                        <div className="p-4 bg-white/5 border border-white/10 rounded-lg">
                          <div className="mission-label mb-1">Regional HQ</div>
                          <div className="text-sm font-bold text-nasa-red uppercase tracking-widest">
                            {selectedCountry.name} Command Center
                          </div>
                        </div>
                      </div>
                    )}

                    {selectionStep === 'point' && selectedCity && (
                      <div className="space-y-6">
                        <button 
                          onClick={() => {
                            setSelectionStep('city');
                            setSelectedCity(null);
                            setTargetPoint([]);
                            if (globeRef.current && selectedCountry) {
                              globeRef.current.pointOfView({ lat: selectedCountry.lat, lng: selectedCountry.long, alt: 0.8 }, 1500);
                            }
                          }}
                          className="text-[10px] font-mono uppercase tracking-widest text-mission-muted hover:text-nasa-red flex items-center gap-1"
                        >
                          <ArrowLeft size={12} /> Back to City Selection
                        </button>
                        
                        <div className="bg-white/5 border border-nasa-red/35 rounded-lg p-6 space-y-4 text-center">
                          <div className="flex flex-col items-center gap-4">
                            <div className="w-16 h-16 rounded-full border-2 border-nasa-red border-dashed animate-[spin_10s_linear_infinite] flex items-center justify-center">
                              <Target size={32} className="text-nasa-red" />
                            </div>
                            <div>
                              <span className="text-sm font-bold uppercase tracking-[0.3em] text-mission-accent">Targeting Active</span>
                              <p className="text-[10px] text-mission-muted mt-2 uppercase tracking-widest leading-relaxed">
                                Click inside the <span className="text-nasa-red font-bold">red boundary</span> on the globe for <span className="text-nasa-red font-bold">{selectedCity.name}</span> — area size follows OpenStreetMap city / province limits
                              </p>
                            </div>
                          </div>
                        </div>

                        <div className="space-y-2">
                          <label className="mission-label">Landing Surface Preference</label>
                          <div className="grid grid-cols-2 gap-2">
                            <button
                              type="button"
                              onClick={() => setFormData({...formData, landing_surface: LandingSurface.LAND})}
                              className={cn(
                                "px-3 py-2 md:px-4 md:py-3 rounded text-[10px] md:text-[11px] font-bold uppercase tracking-widest transition-all border",
                                formData.landing_surface === LandingSurface.LAND 
                                  ? "bg-nasa-red text-white border-nasa-red" 
                                  : "bg-white/5 text-mission-text/60 border-white/10 hover:border-white/20"
                              )}
                            >
                              Land
                            </button>
                            <button
                              type="button"
                              onClick={() => setFormData({...formData, landing_surface: LandingSurface.WATER})}
                              className={cn(
                                "px-3 py-2 md:px-4 md:py-3 rounded text-[10px] md:text-[11px] font-bold uppercase tracking-widest transition-all border",
                                formData.landing_surface === LandingSurface.WATER 
                                  ? "bg-nasa-red text-white border-nasa-red" 
                                  : "bg-white/5 text-mission-text/60 border-white/10 hover:border-white/20"
                              )}
                            >
                              Water
                            </button>
                          </div>
                        </div>

                        {loading && (
                          <div className="flex items-center justify-center gap-3 text-nasa-red font-mono text-[10px] uppercase tracking-widest animate-pulse">
                            <Loader2 className="animate-spin" size={14} />
                            Acquiring Telemetry...
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  {error && (
                    <motion.div 
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="mt-6 bg-no-go/10 border border-no-go/30 p-4 rounded-lg flex gap-3 text-no-go text-xs"
                    >
                      <AlertTriangle size={16} className="shrink-0" />
                      <p>{error}</p>
                    </motion.div>
                  )}
                </motion.div>
              </div>
            </motion.div>
          ) : (
            <motion.div 
              key="results-view"
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 overflow-y-auto p-6"
            >
              <div className="max-w-7xl mx-auto space-y-6">
                {/* Back Button */}
                <button 
                  onClick={resetSimulation}
                  className="flex items-center gap-2 text-[10px] font-mono uppercase tracking-widest text-mission-muted hover:text-nasa-red transition-colors mb-2"
                >
                  <ArrowLeft size={14} />
                  Back to Orbital View
                </button>

                {/* Overall Status Header */}
                <div className={cn(
                  "mission-card p-8 flex flex-col md:flex-row items-center justify-between gap-6 relative overflow-hidden",
                  report?.overall_status === GoNoGoStatus.GO ? "border-go/30" : 
                  report?.overall_status === GoNoGoStatus.NO_GO ? "border-no-go/30" : "border-conditional/30"
                )}>
                  <div className="absolute top-0 right-0 w-64 h-64 bg-current opacity-5 blur-[100px] -mr-32 -mt-32 pointer-events-none" />
                  
                  <div className="flex flex-col items-center md:items-start gap-2">
                    <div className="mission-label">Mission Suitability</div>
                    <div className={cn(
                      "text-6xl font-bold tracking-tighter uppercase",
                      report?.overall_status === GoNoGoStatus.GO ? "text-go" : 
                      report?.overall_status === GoNoGoStatus.NO_GO ? "text-no-go" : "text-conditional"
                    )}>
                      {report?.overall_status}
                    </div>
                    <div className="flex gap-2 mt-2">
                      {report?.overall_messages.map((m, i) => (
                        <span key={i} className="text-xs text-mission-text/80">{m}</span>
                      ))}
                    </div>
                    {report && (
                      <p className="text-[11px] font-mono text-mission-muted mt-3 tracking-wide">
                        Target: {report.latitude.toFixed(4)}°, {report.longitude.toFixed(4)}°
                        {selectedCity?.name != null && (
                          <span className="text-mission-text/70"> · {selectedCity.name}</span>
                        )}
                      </p>
                    )}
                  </div>

                  <div className="grid grid-cols-2 gap-4 w-full md:w-auto">
                    <div className="mission-card bg-white/5 p-4 flex flex-col items-center">
                      <div className="mission-label mb-1">Takeoff</div>
                      {report && <StatusBadge status={report.takeoff.status} />}
                    </div>
                    <div className="mission-card bg-white/5 p-4 flex flex-col items-center">
                      <div className="mission-label mb-1">Landing</div>
                      {report && <StatusBadge status={report.landing.status} />}
                    </div>
                  </div>
                </div>

                {/* Detailed Grid */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  {/* Weather */}
                  <AssessmentCard 
                    title="Meteorology" 
                    icon={Wind} 
                    status={report?.weather.lightning_detected || report?.weather.exceeds_takeoff_wind_limit ? GoNoGoStatus.NO_GO : GoNoGoStatus.GO}
                    messages={report?.weather.messages}
                  >
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <div className="mission-label">Wind Speed</div>
                        <div className="mission-value">
                          {report?.weather.raw?.wind_knots_effective != null
                            ? Number(report.weather.raw.wind_knots_effective).toFixed(1)
                            : '—'}{' '}
                          <span className="text-[10px]">kt</span>
                        </div>
                      </div>
                      <div>
                        <div className="mission-label">Temperature</div>
                        <div className="mission-value">{report?.weather.raw?.temp_c || '—'} <span className="text-[10px]">°C</span></div>
                      </div>
                      <div>
                        <div className="mission-label">Lightning</div>
                        <div className={cn("mission-value", report?.weather.lightning_detected ? "text-no-go" : "text-go")}>
                          {report?.weather.lightning_detected ? "Detected" : "Clear"}
                        </div>
                      </div>
                      <div>
                        <div className="mission-label">Condition</div>
                        <div className="mission-value text-sm">{report?.weather.raw?.condition_text || 'Unknown'}</div>
                      </div>
                    </div>
                  </AssessmentCard>

                  {/* Elevation */}
                  <AssessmentCard 
                    title="Terrain Analysis" 
                    icon={Mountain} 
                    status={
                      report?.elevation.evaluated === false
                        ? GoNoGoStatus.CONDITIONAL
                        : report?.elevation.terrain_unsuitable
                          ? GoNoGoStatus.NO_GO
                          : GoNoGoStatus.GO
                    }
                    messages={report?.elevation.messages}
                  >
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <div className="mission-label">Elevation</div>
                        <div className="mission-value">{report?.elevation.elevation_m || '—'} <span className="text-[10px]">m</span></div>
                      </div>
                      <div>
                        <div className="mission-label">Max Slope</div>
                        <div className={cn("mission-value", report?.elevation.terrain_unsuitable ? "text-no-go" : "text-mission-accent")}>
                          {report?.elevation.slope_percent || '—'} <span className="text-[10px]">%</span>
                        </div>
                      </div>
                      <div className="col-span-2">
                        <div className="mission-label mb-2">Slope Distribution</div>
                        <div className="flex gap-1 h-2 bg-white/5 rounded-full overflow-hidden">
                          {(report?.elevation.slope_per_direction_percent || [0, 0, 0, 0]).map((s, i) => (
                            <div 
                              key={i} 
                              className="h-full bg-nasa-red/35" 
                              style={{ width: `${Math.max(5, s * 10)}%` }} 
                            />
                          ))}
                        </div>
                      </div>
                    </div>
                  </AssessmentCard>

                  {/* Logistics */}
                  <AssessmentCard 
                    title="Logistics & Infra" 
                    icon={Truck} 
                    status={
                      report?.logistics.evaluated === false
                        ? GoNoGoStatus.CONDITIONAL
                        : report?.logistics.port_lock_warning
                          ? GoNoGoStatus.CONDITIONAL
                          : GoNoGoStatus.GO
                    }
                    messages={report?.logistics.messages}
                  >
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <Waves size={14} className={report?.logistics.deep_water_port_within_50km ? "text-go" : "text-no-go"} />
                          <span className="text-[11px] uppercase tracking-wider">Deep Water Port</span>
                        </div>
                        <span className="text-[10px] font-mono">{report?.logistics.nearest_maritime_like_m ? `${(report.logistics.nearest_maritime_like_m/1000).toFixed(1)}km` : 'N/A'}</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <div className="w-3.5 h-[1px] bg-current" />
                          <span className="text-[11px] uppercase tracking-wider">Heavy Rail</span>
                        </div>
                        <span className="text-[10px] font-mono">{report?.logistics.nearest_rail_m ? `${(report.logistics.nearest_rail_m/1000).toFixed(1)}km` : 'N/A'}</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <MapPin size={14} className="text-nasa-red" />
                          <span className="text-[11px] uppercase tracking-wider">Motorway</span>
                        </div>
                        <span className="text-[10px] font-mono">{report?.logistics.nearest_motorway_m ? `${(report.logistics.nearest_motorway_m/1000).toFixed(1)}km` : 'N/A'}</span>
                      </div>
                    </div>
                  </AssessmentCard>

                  {/* Payload */}
                  <AssessmentCard 
                    title="Efficiency Hint" 
                    icon={Zap}
                    messages={report?.payload_hint.messages}
                  >
                    <div className="flex flex-col items-center justify-center h-full gap-2">
                      <div className="relative w-24 h-24 flex items-center justify-center">
                        <svg className="w-full h-full -rotate-90">
                          <circle 
                            cx="48" cy="48" r="44" 
                            className="stroke-white/5 fill-none" 
                            strokeWidth="8" 
                          />
                          <motion.circle 
                            cx="48" cy="48" r="44" 
                            className="stroke-nasa-red fill-none" 
                            strokeWidth="8" 
                            strokeDasharray="276.46"
                            initial={{ strokeDashoffset: 276.46 }}
                            animate={{ strokeDashoffset: 276.46 - (276.46 * (report?.payload_hint.score_hint || 0)) / 100 }}
                            transition={{ duration: 1.5, ease: "easeOut" }}
                            strokeLinecap="round"
                          />
                        </svg>
                        <div className="absolute inset-0 flex flex-col items-center justify-center">
                          <span className="text-2xl font-mono font-bold">{Math.round(report?.payload_hint.score_hint || 0)}</span>
                          <span className="text-[8px] uppercase tracking-widest text-mission-muted">Score</span>
                        </div>
                      </div>
                      <p className="text-[10px] text-center text-mission-text/50 uppercase tracking-wider">
                        Latitude: {report?.payload_hint.latitude_abs?.toFixed(2)}°
                      </p>
                    </div>
                  </AssessmentCard>
                </div>
                
                {/* Action Buttons */}
                <div className="flex flex-col sm:flex-row gap-4 pt-4">
                  <button 
                    onClick={recalibrateTarget}
                    className="flex-1 bg-white/5 border border-nasa-red/35 text-mission-accent font-bold uppercase tracking-widest py-4 rounded hover:bg-nasa-red/10 transition-all flex items-center justify-center gap-2 text-xs"
                  >
                    <Target size={16} />
                    Recalibrate Target
                  </button>
                  <button 
                    onClick={resetSimulation}
                    className="flex-1 bg-nasa-red text-white font-bold uppercase tracking-widest py-4 rounded shadow-[0_0_20px_rgba(224,40,40,0.35)] hover:shadow-[0_0_28px_rgba(224,40,40,0.5)] transition-all flex items-center justify-center gap-2 text-xs"
                  >
                    <GlobeIcon size={16} />
                    New Mission
                  </button>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      
      {/* Footer / Status Bar */}
      <footer className="border-t border-white/10 bg-[#070f1c]/90 p-3 flex items-center justify-between text-[9px] font-mono uppercase tracking-[0.2em] text-mission-muted z-50">
        <div className="flex gap-6">
          <div className="flex items-center gap-2">
            <div className="w-1.5 h-1.5 rounded-full bg-mission-accent" />
            System Online
          </div>
          <div className="flex items-center gap-2">
            <div className="w-1.5 h-1.5 rounded-full bg-nasa-red" />
            Telemetry Sync: Active
          </div>
        </div>
        <div>
          © 2026 Spaceport Simulation Engine • All Rights Reserved
        </div>
      </footer>
    </div>
  );
}


