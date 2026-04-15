import React, { useMemo } from 'react';
import { MapContainer, TileLayer, CircleMarker, Tooltip, Rectangle } from 'react-leaflet';

const toNumber = (value) => {
  if (value === null || value === undefined) return null;
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) ? num : null;
};

const getBoundsFromGeofences = (geofences) => {
  if (!geofences.length) return null;
  const lats = geofences.flatMap((g) => [toNumber(g.min_lat), toNumber(g.max_lat)]).filter((v) => v !== null);
  const lons = geofences.flatMap((g) => [toNumber(g.min_lon), toNumber(g.max_lon)]).filter((v) => v !== null);
  if (!lats.length || !lons.length) return null;
  return [
    [Math.min(...lats), Math.min(...lons)],
    [Math.max(...lats), Math.max(...lons)]
  ];
};

const getBoundsFromDevices = (devices) => {
  const lats = devices.map((d) => toNumber(d.lat)).filter((v) => v !== null);
  const lons = devices.map((d) => toNumber(d.lon)).filter((v) => v !== null);
  if (!lats.length || !lons.length) return null;
  return [
    [Math.min(...lats), Math.min(...lons)],
    [Math.max(...lats), Math.max(...lons)]
  ];
};

const MapPanel = ({ devices, geofences }) => {
  const bounds = useMemo(() => {
    return getBoundsFromGeofences(geofences) || getBoundsFromDevices(devices);
  }, [devices, geofences]);

  const center = bounds
    ? [(bounds[0][0] + bounds[1][0]) / 2, (bounds[0][1] + bounds[1][1]) / 2]
    : [30.6817, 114.1833];

  return (
    <div className="card map-card">
      <div className="card-header">
        <div>
          <div className="card-title">设备定位</div>
          <div className="card-subtitle">OSM 地图 + 围栏标注</div>
        </div>
        <span className="chip">GPS 正常</span>
      </div>
      <div className="map-body real-map">
        <MapContainer
          center={center}
          zoom={18}
          className="leaflet-map"
          scrollWheelZoom
          bounds={bounds || undefined}
          boundsOptions={{ padding: [30, 30] }}
        >
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />

          {geofences.map((zone) => (
            <Rectangle
              key={zone.zone_id}
              bounds={[[zone.min_lat, zone.min_lon], [zone.max_lat, zone.max_lon]]}
              pathOptions={{ color: '#2f7dff', weight: 2, fillOpacity: 0.1 }}
            >
              <Tooltip sticky>
                {zone.name} ({zone.zone_id})
              </Tooltip>
            </Rectangle>
          ))}

          {devices
            .filter((device) => toNumber(device.lat) !== null && toNumber(device.lon) !== null)
            .map((device) => (
              <CircleMarker
                key={device.device_id}
                center={[device.lat, device.lon]}
                radius={6}
                pathOptions={{ color: '#65c8ff', weight: 2, fillOpacity: 0.9 }}
              >
                <Tooltip>
                  {device.device_id} · {device.zone_id || '未分配'}
                </Tooltip>
              </CircleMarker>
            ))}
        </MapContainer>
        <div className="map-list">
          {devices.map((device) => (
            <div key={device.device_id} className="map-item">
              <div>
                <div className="map-item-title">{device.device_id}</div>
                <div className="map-item-sub">{device.zone_id || '未分配区域'}</div>
              </div>
              <div className="map-item-coords">
                {toNumber(device.lat) !== null && toNumber(device.lon) !== null
                  ? `${toNumber(device.lat).toFixed(5)}, ${toNumber(device.lon).toFixed(5)}`
                  : '未定位'}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default MapPanel;
