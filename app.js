'use strict';

const STORAGE_KEY = 'waypoint.markers.v1';
const NL_CENTER = [52.1, 5.3];
const NL_ZOOM = 7.3;

let map, addMode = false;
let markers = [];                 // {id, lat, lng, name, leafletMarker}
let currentLocation = null;       // {lat, lng}
let locationMarker = null, locationCircle = null, watchId = null;
let routeLayerGroup = null;
let followIndex = null;           // index into buildSequence(), or null if not following
let toastTimer = null;

const el = id => document.getElementById(id);
const addModeBtn = el('addModeBtn'), locateBtn = el('locateBtn'), calcBtn = el('calcBtn'),
      showRouteBtn = el('showRouteBtn'), clearBtn = el('clearBtn'), closeResultBtn = el('closeResult'),
      markerListEl = el('markerList'), markerCountEl = el('markerCount'),
      resultSection = el('resultSection'), resultSummary = el('resultSummary'),
      resultList = el('resultList'), routeNote = el('routeNote'),
      startFromLocationChk = el('startFromLocation'), roundTripChk = el('roundTrip'),
      panelEl = el('panel'), dragHandle = el('dragHandle'), toastEl = el('toast'),
      exportBtn = el('exportBtn'), importBtn = el('importBtn'), importFile = el('importFile'),
      followBtn = el('followBtn'), followStatus = el('followStatus'), stopFollowBtn = el('stopFollowBtn');

/* ---------------- geometry ---------------- */

function haversine(a, b) {
  const R = 6371000, toRad = d => d * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function bearing(a, b) {
  const toRad = d => d * Math.PI / 180, toDeg = r => r * 180 / Math.PI;
  const y = Math.sin(toRad(b.lng - a.lng)) * Math.cos(toRad(b.lat));
  const x = Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) -
            Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lng - a.lng));
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

function buildMatrix(points) {
  const n = points.length, m = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) {
      const d = haversine(points[i], points[j]);
      m[i][j] = m[j][i] = d;
    }
  return m;
}

/* ---------------- TSP heuristic ---------------- */

function nearestNeighbor(dist, start, n) {
  const visited = new Array(n).fill(false);
  const order = [start];
  visited[start] = true;
  let current = start;
  for (let k = 1; k < n; k++) {
    let best = -1, bestD = Infinity;
    for (let v = 0; v < n; v++) {
      if (!visited[v] && dist[current][v] < bestD) { bestD = dist[current][v]; best = v; }
    }
    order.push(best); visited[best] = true; current = best;
  }
  return order;
}

function tourLength(order, dist, closed) {
  let total = 0;
  for (let i = 0; i < order.length - 1; i++) total += dist[order[i]][order[i + 1]];
  if (closed) total += dist[order[order.length - 1]][order[0]];
  return total;
}

function twoOpt(order, dist, closed) {
  order = order.slice();
  const n = order.length;
  if (n < 4) return order;
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 0; i < n - 2; i++) {
      const A = order[i], B = order[i + 1];
      const jMax = closed ? n - 1 : n - 2;
      for (let j = i + 2; j <= jMax; j++) {
        if (closed && i === 0 && j === n - 1) continue;
        const C = order[j];
        const D = closed ? order[(j + 1) % n] : order[j + 1];
        const before = dist[A][B] + dist[C][D];
        const after = dist[A][C] + dist[B][D];
        if (after < before - 1e-9) {
          let lo = i + 1, hi = j;
          while (lo < hi) { [order[lo], order[hi]] = [order[hi], order[lo]]; lo++; hi--; }
          improved = true;
        }
      }
    }
  }
  return order;
}

function solveTSP(points, { fixedStart = null, closed = false }) {
  const n = points.length;
  if (n <= 1) return n === 1 ? [0] : [];
  const dist = buildMatrix(points);
  if (fixedStart !== null) {
    return twoOpt(nearestNeighbor(dist, fixedStart, n), dist, closed);
  }
  const tries = Math.min(n, 12);
  let bestOrder = null, bestLen = Infinity;
  for (let t = 0; t < tries; t++) {
    const s = Math.floor(t * n / tries);
    const order = twoOpt(nearestNeighbor(dist, s, n), dist, closed);
    const len = tourLength(order, dist, closed);
    if (len < bestLen) { bestLen = len; bestOrder = order; }
  }
  return bestOrder;
}

/* ---------------- OSRM routing ---------------- */

async function fetchOsrmRoute(points) {
  const coords = points.map(p => `${p.lng},${p.lat}`).join(';');
  const url = `https://router.project-osrm.org/route/v1/foot/${coords}?overview=full&geometries=geojson`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('http ' + res.status);
  const data = await res.json();
  if (data.code !== 'Ok' || !data.routes || !data.routes.length) throw new Error(data.code || 'no route');
  return data.routes[0];
}

/* ---------------- direction arrows ---------------- */

function arrowIcon(deg) {
  return L.divIcon({
    className: '',
    html: `<div class="arrow-wrap" style="transform:rotate(${deg}deg)"><div class="route-arrow"></div></div>`,
    iconSize: [14, 14],
    iconAnchor: [7, 7]
  });
}

function placeArrowsAlong(latlngs, spacing) {
  const arrows = [];
  let cum = 0, nextMark = spacing / 2;
  for (let i = 0; i < latlngs.length - 1; i++) {
    const a = latlngs[i], b = latlngs[i + 1];
    const segLen = haversine(a, b);
    while (segLen > 0 && cum + segLen >= nextMark) {
      const t = (nextMark - cum) / segLen;
      arrows.push({ lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t, bearing: bearing(a, b) });
      nextMark += spacing;
    }
    cum += segLen;
  }
  return arrows;
}

function arrowSpacing(latlngs) {
  let total = 0;
  for (let i = 0; i < latlngs.length - 1; i++) total += haversine(latlngs[i], latlngs[i + 1]);
  return Math.min(500, Math.max(80, total / 8));
}

function renderPolylineWithArrows(latlngs, opts = {}) {
  clearRouteLayer();
  if (latlngs.length < 2) return null;
  const line = L.polyline(latlngs, {
    color: '#E2622B', weight: opts.dashed ? 4 : 5, opacity: 0.85,
    dashArray: opts.dashed ? '2 10' : null
  });
  const arrows = placeArrowsAlong(latlngs, arrowSpacing(latlngs))
    .map(a => L.marker([a.lat, a.lng], { icon: arrowIcon(a.bearing), interactive: false, keyboard: false }));
  routeLayerGroup = L.layerGroup([line, ...arrows]).addTo(map);
  return routeLayerGroup;
}

function clearRouteLayer() {
  if (routeLayerGroup) { map.removeLayer(routeLayerGroup); routeLayerGroup = null; }
}

/* ---------------- map setup ---------------- */

function initMap() {
  map = L.map('map', { zoomControl: false, attributionControl: true }).setView(NL_CENTER, NL_ZOOM);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }).addTo(map);
  map.on('click', e => { if (addMode) addMarkerAt(e.latlng.lat, e.latlng.lng); });
  loadMarkers();
}

function numIcon(n, highlighted) {
  return L.divIcon({
    className: '',
    html: `<div class="num-icon${highlighted ? ' visited' : ''}"><span>${n}</span></div>`,
    iconSize: [26, 26],
    iconAnchor: [13, 24]
  });
}

function renumberIcons(highlighted) {
  markers.forEach((m, i) => m.leafletMarker.setIcon(numIcon(i + 1, !!highlighted)));
}

/* ---------------- markers ---------------- */

function addMarkerAt(lat, lng, name) {
  const id = 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const data = { id, lat, lng, name: name || `Marker ${markers.length + 1}` };
  const lm = L.marker([lat, lng], { draggable: true, icon: numIcon(markers.length + 1, false) }).addTo(map);
  lm.on('dragend', () => {
    const p = lm.getLatLng();
    data.lat = p.lat; data.lng = p.lng;
    saveMarkers(); clearResult();
  });
  data.leafletMarker = lm;
  markers.push(data);
  renderMarkerList();
  saveMarkers();
  clearResult();
  expandPanelOnMobile();
}

function removeMarker(id) {
  const idx = markers.findIndex(m => m.id === id);
  if (idx === -1) return;
  map.removeLayer(markers[idx].leafletMarker);
  markers.splice(idx, 1);
  renderMarkerList();
  saveMarkers();
  clearResult();
}

function moveMarker(id, dir) {
  const idx = markers.findIndex(m => m.id === id);
  const swap = idx + dir;
  if (idx === -1 || swap < 0 || swap >= markers.length) return;
  [markers[idx], markers[swap]] = [markers[swap], markers[idx]];
  renderMarkerList();
  saveMarkers();
  clearResult();
}

function renderMarkerList() {
  markerCountEl.textContent = String(markers.length);
  markerListEl.innerHTML = '';
  markers.forEach((m, i) => {
    const li = document.createElement('li');
    li.dataset.id = m.id;
    li.innerHTML = `
      <span class="badge">${i + 1}</span>
      <input class="marker-name" value="${escapeAttr(m.name)}" maxlength="60">
      <span class="reorder">
        <button class="reorder-btn" data-dir="-1" aria-label="Move up" ${i === 0 ? 'disabled' : ''}>&#9650;</button>
        <button class="reorder-btn" data-dir="1" aria-label="Move down" ${i === markers.length - 1 ? 'disabled' : ''}>&#9660;</button>
      </span>
      <button class="remove-btn" aria-label="Remove marker">✕</button>`;
    const input = li.querySelector('.marker-name');
    input.addEventListener('input', () => { m.name = input.value || `Marker ${i + 1}`; saveMarkers(); updateFollowUI(buildSequence()); });
    li.querySelector('.remove-btn').addEventListener('click', ev => { ev.stopPropagation(); removeMarker(m.id); });
    li.querySelectorAll('.reorder-btn').forEach(btn => {
      btn.addEventListener('click', ev => { ev.stopPropagation(); moveMarker(m.id, Number(btn.dataset.dir)); });
    });
    li.addEventListener('click', ev => {
      if (ev.target === input) return;
      map.flyTo([m.lat, m.lng], Math.max(map.getZoom(), 16));
      setFollowCurrent(m.id);
    });
    markerListEl.appendChild(li);
  });
  updateFollowUI(buildSequence());
}

function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function saveMarkers() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(
      markers.map(m => ({ id: m.id, lat: m.lat, lng: m.lng, name: m.name }))
    ));
  } catch (e) { /* Storage unavailable. Silently skip persistence. */ }
}

function loadMarkers() {
  let saved = [];
  try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); } catch (e) { saved = []; }
  if (!Array.isArray(saved) || !saved.length) return;
  saved.forEach(s => addMarkerAt(s.lat, s.lng, s.name));
  fitToMarkers();
}

function fitToMarkers() {
  if (!markers.length) return;
  const group = L.featureGroup(markers.map(m => m.leafletMarker));
  map.fitBounds(group.getBounds().pad(0.3));
}

/* ---------------- add mode ---------------- */

addModeBtn.addEventListener('click', () => {
  addMode = !addMode;
  addModeBtn.classList.toggle('active', addMode);
  el('map').classList.toggle('add-mode', addMode);
  addModeBtn.lastChild.textContent = addMode ? ' Tap the map to place it' : ' Tap map to drop a marker';
});

/* ---------------- geolocation ---------------- */

function updateLocationMarker(coords) {
  const latlng = [coords.latitude, coords.longitude];
  if (!locationMarker) {
    locationMarker = L.marker(latlng, {
      icon: L.divIcon({ className: '', html: '<div class="loc-dot"></div>', iconSize: [16, 16], iconAnchor: [8, 8] }),
      zIndexOffset: 1000
    }).addTo(map);
    locationCircle = L.circle(latlng, { radius: coords.accuracy || 30, color: '#4A90D9', weight: 1, fillOpacity: 0.08 }).addTo(map);
  } else {
    locationMarker.setLatLng(latlng);
    locationCircle.setLatLng(latlng);
    locationCircle.setRadius(coords.accuracy || 30);
  }
}

function requestLocation(onFirstFix) {
  if (!navigator.geolocation) { toast('Location isn\u2019t available in this browser.'); return; }
  navigator.geolocation.getCurrentPosition(
    pos => {
      currentLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      updateLocationMarker(pos.coords);
      map.flyTo([currentLocation.lat, currentLocation.lng], Math.max(map.getZoom(), 15));
      locateBtn.classList.add('active');
      if (!watchId) {
        watchId = navigator.geolocation.watchPosition(
          p => { currentLocation = { lat: p.coords.latitude, lng: p.coords.longitude }; updateLocationMarker(p.coords); },
          () => {},
          { enableHighAccuracy: true, maximumAge: 4000 }
        );
      }
      if (onFirstFix) onFirstFix();
    },
    err => {
      const msgs = { 1: 'Location access was denied.', 2: 'Your location is currently unavailable.', 3: 'Locating you timed out. Try again.' };
      toast(msgs[err.code] || 'Couldn\u2019t get your location.');
      startFromLocationChk.checked = false;
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

locateBtn.addEventListener('click', () => requestLocation());
startFromLocationChk.addEventListener('change', () => {
  if (startFromLocationChk.checked && !currentLocation) requestLocation();
  updateFollowUI(buildSequence());
});
roundTripChk.addEventListener('change', () => updateFollowUI(buildSequence()));

/* ---------------- sequence / route ---------------- */

function buildSequence() {
  const seq = [];
  if (startFromLocationChk.checked && currentLocation) {
    seq.push({ kind: 'start', lat: currentLocation.lat, lng: currentLocation.lng, name: 'Your location' });
  }
  markers.forEach(m => seq.push({ kind: 'marker', lat: m.lat, lng: m.lng, name: m.name, ref: m }));
  return seq;
}

function computeHaversineLegs(seq, closed) {
  const legs = [];
  for (let i = 0; i < seq.length - 1; i++) legs.push(haversine(seq[i], seq[i + 1]));
  if (closed && seq.length > 1) legs.push(haversine(seq[seq.length - 1], seq[0]));
  return legs;
}

function fmtDist(m) { return m >= 1000 ? (m / 1000).toFixed(1) + ' km' : Math.round(m) + ' m'; }
function fmtTime(min) {
  const h = Math.floor(min / 60), m = Math.round(min % 60);
  return h > 0 ? `${h}h ${m}m` : `${m} min`;
}

function renderResult(seq, closed, legs, totalM, totalSec, isReal) {
  resultSummary.innerHTML = `
    <div class="stat"><b>${fmtDist(totalM)}</b><span>total distance</span></div>
    <div class="stat"><b>${fmtTime(totalSec / 60)}</b><span>est. walking time</span></div>`;

  resultList.innerHTML = '';
  let stopNum = 1;
  seq.forEach((p, i) => {
    const li = document.createElement('li');
    const name = p.kind === 'start' ? 'Your location' : p.ref.name;
    const cls = p.kind === 'start' ? 'badge start' : 'badge';
    const label = p.kind === 'start' ? '\u25CE' : String(stopNum++);
    const legTxt = i < legs.length ? fmtDist(legs[i]) + ' \u2192' : '';
    li.innerHTML = `<span class="${cls}">${label}</span><span>${escapeAttr(name)}</span><span class="leg">${legTxt}</span>`;
    resultList.appendChild(li);
  });

  routeNote.textContent = isReal
    ? 'Walking path via OpenStreetMap routing (OSRM demo server).'
    : 'Live routing was unavailable, so straight-line distances are shown instead.';
}

async function runRoute(optimize) {
  const useLoc = startFromLocationChk.checked;
  if (useLoc && !currentLocation) {
    toast('Finding your location\u2026');
    requestLocation(() => runRoute(optimize));
    return;
  }
  if (markers.length === 0) { toast('Add at least one marker first.'); return; }

  const closed = roundTripChk.checked;
  let seq;

  if (optimize) {
    const markerPts = markers.map(m => ({ lat: m.lat, lng: m.lng, kind: 'marker', name: m.name, ref: m }));
    const points = useLoc ? [{ lat: currentLocation.lat, lng: currentLocation.lng, kind: 'start', name: 'Your location' }, ...markerPts] : markerPts;
    const order = points.length <= 1 ? points.map((_, i) => i) : solveTSP(points, { fixedStart: useLoc ? 0 : null, closed });
    seq = order.map(i => points[i]);
    markers = seq.filter(p => p.kind === 'marker').map(p => p.ref);
    renderMarkerList();
  } else {
    seq = buildSequence();
  }

  followIndex = null;
  clearRouteLayer();
  updateFollowUI(seq);
  resultSection.hidden = false;
  expandPanelOnMobile();

  const haversineLegs = computeHaversineLegs(seq, closed);
  const haversineTotal = haversineLegs.reduce((a, b) => a + b, 0);
  renderResult(seq, closed, haversineLegs, haversineTotal, haversineTotal / 1.3, false);
  routeNote.textContent = 'Calculating the walking path\u2026';
  renumberIcons(true);

  const routePoints = closed && seq.length > 1 ? [...seq, seq[0]] : seq;
  if (routePoints.length < 2) { routeNote.textContent = ''; return; }

  try {
    const route = await fetchOsrmRoute(routePoints);
    const latlngs = route.geometry.coordinates.map(c => L.latLng(c[1], c[0]));
    renderPolylineWithArrows(latlngs);
    map.fitBounds(L.latLngBounds(latlngs).pad(0.15));
    const realLegs = route.legs ? route.legs.map(l => l.distance) : haversineLegs;
    renderResult(seq, closed, realLegs, route.distance, route.duration, true);
  } catch (e) {
    const latlngs = routePoints.map(p => L.latLng(p.lat, p.lng));
    renderPolylineWithArrows(latlngs, { dashed: true });
    map.fitBounds(L.latLngBounds(latlngs).pad(0.15));
    renderResult(seq, closed, haversineLegs, haversineTotal, haversineTotal / 1.3, false);
  }
}

calcBtn.addEventListener('click', () => runRoute(true));
showRouteBtn.addEventListener('click', () => runRoute(false));

function clearResult() {
  resultSection.hidden = true;
  clearRouteLayer();
  followIndex = null;
  renumberIcons(false);
  updateFollowUI(buildSequence());
}

closeResultBtn.addEventListener('click', () => { resultSection.hidden = true; });

/* ---------------- follow mode ---------------- */

function setFollowCurrent(markerId) {
  const seq = buildSequence();
  const idx = seq.findIndex(p => p.kind === 'marker' && p.ref.id === markerId);
  if (idx === -1) return;
  followIndex = idx;
  clearRouteLayer();
  updateFollowUI(seq);
}

function updateFollowUI(seq) {
  markerListEl.querySelectorAll('li').forEach(li => li.classList.remove('active'));
  if (followIndex !== null && seq[followIndex] && seq[followIndex].kind === 'marker') {
    const li = markerListEl.querySelector(`[data-id="${seq[followIndex].ref.id}"]`);
    if (li) li.classList.add('active');
  }
  stopFollowBtn.hidden = followIndex === null;
  const label = followBtn.querySelector('.btn-label');

  if (seq.length < 2) {
    followBtn.disabled = true;
    followStatus.textContent = 'Add two or more stops (or turn on your location) to follow a route.';
    label.textContent = 'Path to next marker';
    return;
  }

  const idx = followIndex === null ? 0 : followIndex;
  const atEnd = idx >= seq.length - 1;

  if (followIndex === null) {
    followStatus.textContent = `Starting point: ${seq[0].name}.`;
    label.textContent = `Path to ${seq[1].name}`;
    followBtn.disabled = false;
  } else if (atEnd) {
    if (roundTripChk.checked) {
      followStatus.textContent = `At ${seq[idx].name} \u2014 last stop.`;
      label.textContent = `Path back to ${seq[0].name}`;
      followBtn.disabled = false;
    } else {
      followStatus.textContent = `You\u2019ve reached ${seq[idx].name} \u2014 the last stop.`;
      label.textContent = 'Route complete';
      followBtn.disabled = true;
    }
  } else {
    followStatus.textContent = `At ${seq[idx].name}.`;
    label.textContent = `Path to ${seq[idx + 1].name}`;
    followBtn.disabled = false;
  }
}

async function showLeg(a, b) {
  try {
    const route = await fetchOsrmRoute([a, b]);
    const latlngs = route.geometry.coordinates.map(c => L.latLng(c[1], c[0]));
    renderPolylineWithArrows(latlngs);
    map.fitBounds(L.latLngBounds(latlngs).pad(0.3));
    toast(`${fmtDist(route.distance)} to ${b.name} \u2022 about ${fmtTime(route.duration / 60)}`);
  } catch (e) {
    const latlngs = [L.latLng(a.lat, a.lng), L.latLng(b.lat, b.lng)];
    renderPolylineWithArrows(latlngs, { dashed: true });
    map.fitBounds(L.latLngBounds(latlngs).pad(0.3));
    toast(`${fmtDist(haversine(a, b))} to ${b.name} (straight line \u2014 live routing unavailable)`);
  }
}

followBtn.addEventListener('click', async () => {
  const seq = buildSequence();
  if (seq.length < 2) return;
  if (followIndex === null) followIndex = 0;
  const atEnd = followIndex >= seq.length - 1;
  if (atEnd && !roundTripChk.checked) return;
  const fromIdx = followIndex;
  const toIdx = atEnd ? 0 : followIndex + 1;

  followBtn.disabled = true;
  const label = followBtn.querySelector('.btn-label');
  label.textContent = 'Finding path\u2026';

  await showLeg(seq[fromIdx], seq[toIdx]);
  followIndex = toIdx;
  updateFollowUI(buildSequence());
});

stopFollowBtn.addEventListener('click', () => {
  followIndex = null;
  clearRouteLayer();
  updateFollowUI(buildSequence());
});

/* ---------------- clear all ---------------- */

clearBtn.addEventListener('click', () => {
  if (!markers.length) return;
  if (!confirm('Remove all markers?')) return;
  markers.forEach(m => map.removeLayer(m.leafletMarker));
  markers = [];
  renderMarkerList();
  saveMarkers();
  clearResult();
});

/* ---------------- config export / import ---------------- */

function exportConfig() {
  const config = {
    type: 'waypoint-config',
    version: 1,
    exportedAt: new Date().toISOString(),
    options: { roundTrip: roundTripChk.checked, startFromLocation: startFromLocationChk.checked },
    markers: markers.map(m => ({ lat: m.lat, lng: m.lng, name: m.name }))
  };
  const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `waypoint-config-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function importConfig(file) {
  const reader = new FileReader();
  reader.onload = () => {
    let data;
    try { data = JSON.parse(reader.result); }
    catch (e) { toast('That file isn\u2019t valid JSON.'); return; }

    const list = Array.isArray(data) ? data : Array.isArray(data.markers) ? data.markers : null;
    if (!list) { toast('No markers found in that file.'); return; }
    const valid = list.filter(m => typeof m.lat === 'number' && typeof m.lng === 'number');
    if (!valid.length) { toast('No valid markers found in that file.'); return; }

    if (markers.length && !confirm(`Replace your current ${markers.length} marker(s) with ${valid.length} from this file?`)) return;

    markers.forEach(m => map.removeLayer(m.leafletMarker));
    markers = [];
    clearResult();
    valid.forEach(m => addMarkerAt(m.lat, m.lng, m.name));
    fitToMarkers();

    if (data.options) {
      roundTripChk.checked = !!data.options.roundTrip;
      startFromLocationChk.checked = !!data.options.startFromLocation && !!currentLocation;
    }
    toast(`Loaded ${valid.length} marker(s).`);
  };
  reader.onerror = () => toast('Couldn\u2019t read that file.');
  reader.readAsText(file);
}

exportBtn.addEventListener('click', () => {
  if (!markers.length) { toast('Add at least one marker first.'); return; }
  exportConfig();
});
importBtn.addEventListener('click', () => importFile.click());
importFile.addEventListener('change', () => {
  if (importFile.files[0]) importConfig(importFile.files[0]);
  importFile.value = '';
});

/* ---------------- mobile sheet ---------------- */

function expandPanelOnMobile() {
  if (window.innerWidth <= 780) panelEl.classList.add('expanded');
}
dragHandle.addEventListener('click', () => panelEl.classList.toggle('expanded'));
let sheetStartY = null;
dragHandle.addEventListener('touchstart', e => { sheetStartY = e.touches[0].clientY; }, { passive: true });
dragHandle.addEventListener('touchend', e => {
  if (sheetStartY === null) return;
  const dy = e.changedTouches[0].clientY - sheetStartY;
  if (dy < -20) panelEl.classList.add('expanded');
  if (dy > 20) panelEl.classList.remove('expanded');
  sheetStartY = null;
});

/* ---------------- toast ---------------- */

function toast(msg, ms = 3200) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, ms);
}

/* ---------------- init ---------------- */

initMap();
