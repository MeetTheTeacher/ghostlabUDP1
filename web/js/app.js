/* Ghost Lab: live F1 26 / F1 25 time trial telemetry with rival ghosts. */
"use strict";
(() => {
const $ = id => document.getElementById(id);
const V3 = THREE.Vector3, UP = new V3(0, 1, 0);
const ROLES = ['player', 'pb', 'rival'];
const ROLE_COLOR = {player: '#38bdf8', pb: '#4ade80', rival: '#f472b6', import: '#fbbf24'};
const ROLE_LABEL = {player: 'You', pb: 'PB ghost', rival: 'Rival ghost', import: 'Imported'};
const ROLE_SHORT = {player: 'You', pb: 'PB', rival: 'Rival', import: 'Imported'};
const mqDesk = matchMedia('(min-width: 1024px)');
const TOUCH = matchMedia('(pointer: coarse)').matches;
const store = {
  get(k, d){ try { const v = localStorage.getItem('ghostlab.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v){ try { localStorage.setItem('ghostlab.' + k, JSON.stringify(v)); } catch {} },
};
let FIELDS = [], F = {};
function setFields(f){ FIELDS = f; F = {}; f.forEach((k, i) => F[k] = i); }
setFields(['t', 'd', 'x', 'y', 'z', 'speed', 'throttle', 'brake', 'steer', 'gear', 'rpm', 'drs', 'fx', 'fy', 'fz']);

const S = {
  view: 'detect', tab: store.get('tab', 'map'), demo: false, status: null, autoGo: true, goTimer: null,
  connectedAt: 0, session: {}, tt: null, laps: [], shown: new Set(), refId: null, cmpId: null,
  auto: store.get('auto', true), live: {}, showLive: true, track: null, hoverD: null, xr: null, xrUser: false,
  liveLap: {id: 'live', role: 'player', name: 'Live lap', samples: [], D: [], color: '#ffffff'},
  mirror: store.get('mirror', false), labels: true, lines: true, cam: store.get('cam', 'orbit'), follow: 'player',
  importSeq: 0, tvIdx: -1, chartsDirty: true, lastFrame: 0,
  chOn: Object.assign({speed: true, throttle: true, brake: true, steer: true, gear: true, rpm: false, delta: true}, store.get('channels', {})),
};
const isDesk = () => mqDesk.matches;
const paneVisible = p => isDesk() || S.tab === p;

// ---------- formatting ----------
function fmtLap(ms){ if (ms == null || !isFinite(ms) || ms <= 0) return '–'; const m = Math.floor(ms / 60000), s = (ms % 60000) / 1000; return `${m}:${s.toFixed(3).padStart(6, '0')}`; }
function fmtSec(ms){ if (ms == null || !isFinite(ms) || ms <= 0) return '–'; return ms >= 60000 ? fmtLap(ms) : (ms / 1000).toFixed(3); }
function fmtDelta(s){ if (s == null || !isFinite(s)) return '–'; return (s > 0 ? '+' : s < 0 ? '−' : '±') + Math.abs(s).toFixed(3); }
function clamp(v, a, b){ return Math.max(a, Math.min(b, v)); }
function esc(s){ return String(s ?? '').replace(/[&<>"]/g, ch => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[ch])); }

// ---------- lap maths ----------
function seek(D, d){
  let lo = 0, hi = D.length - 1;
  if (d <= D[0]) return 0;
  if (d >= D[hi]) return Math.max(0, hi - 1);
  while (hi - lo > 1){ const m = (lo + hi) >> 1; if (D[m] <= d) lo = m; else hi = m; }
  return lo;
}
function valAt(lap, key, d){
  const D = lap.D; if (!D || D.length < 2) return NaN;
  const i = seek(D, d), a = lap.samples[i], b = lap.samples[i + 1], k = F[key];
  if (key === 'gear' || key === 'drs') return (d - D[i] < D[i + 1] - d) ? a[k] : b[k];
  const u = clamp((d - D[i]) / ((D[i + 1] - D[i]) || 1), 0, 1);
  return a[k] + (b[k] - a[k]) * u;
}
function shade(hex, n){
  if (!n) return hex;
  const c = new THREE.Color(hex), h = {}; c.getHSL(h);
  c.setHSL((h.h + (n % 4) * 0.045) % 1, h.s * 0.85, clamp(h.l + ((n % 3) - 1) * 0.12, 0.35, 0.8));
  return '#' + c.getHexString();
}
function prepLap(lap){
  const keep = []; let last = -Infinity;
  for (const r of lap.samples){ const d = r[F.d]; if (isFinite(d) && d > last + 0.05){ keep.push(r); last = d; } }
  lap.samples = keep; lap.D = keep.map(r => r[F.d]);
  lap.color = shade(ROLE_COLOR[lap.role] || ROLE_COLOR.import, S.laps.filter(l => l.role === lap.role).length);
  return lap;
}
const lapById = id => id == null ? null : (id === 'live' ? S.liveLap : S.laps.find(l => l.id === id) || null);
function trackLen(){
  if (S.session.trackLength) return S.session.trackLength;
  if (S.track) return S.track.L;
  let m = 0; for (const l of S.laps) m = Math.max(m, l.D[l.D.length - 1] || 0); return m || 5000;
}
function sectorBounds(){ const a = S.session.sector2, b = S.session.sector3; return (a && b && a < b) ? [a, b] : null; }
function lapSectors(lap){
  const sb = sectorBounds(); if (!sb || !lap.D.length || lap.D[lap.D.length - 1] < sb[1]) return null;
  const s1 = valAt(lap, 't', sb[0]), s2 = valAt(lap, 't', sb[1]) - s1;
  return [s1, s2, lap.lapTime ? lap.lapTime - s1 - s2 : null];
}
function deltaAt(lap, ref, d){ return (valAt(lap, 't', d) - valAt(ref, 't', d)) / 1000; }

// =====================================================================
// 3D scene
// =====================================================================
const view = $('view');
const renderer = new THREE.WebGLRenderer({antialias: true, powerPreference: 'high-performance'});
renderer.setPixelRatio(Math.min(devicePixelRatio, TOUCH ? 1.75 : 2));
view.prepend(renderer.domElement);
const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x0a0c10, 2500, 9000);
const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 20000);
camera.position.set(600, 700, 900);
const controls = new THREE.OrbitControls(camera, renderer.domElement);
controls.enableDamping = true; controls.dampingFactor = 0.12; controls.maxPolarAngle = Math.PI * 0.495;
scene.add(new THREE.HemisphereLight(0xcfd8ff, 0x1a1d24, 0.9));
const sun = new THREE.DirectionalLight(0xffffff, 0.8); sun.position.set(400, 900, 300); scene.add(sun);
const trackRoot = new THREE.Group(), lineRoot = new THREE.Group(), crumbRoot = new THREE.Group();
scene.add(trackRoot, lineRoot, crumbRoot);
const V = (x, y, z) => new V3(S.mirror ? -x : x, y, z);

function makeLabel(text, color){
  const cv = document.createElement('canvas'); cv.width = 256; cv.height = 64;
  const g = cv.getContext('2d');
  g.fillStyle = 'rgba(10,12,16,.82)'; g.beginPath();
  if (g.roundRect) g.roundRect(4, 10, 248, 44, 10); else g.rect(4, 10, 248, 44);
  g.fill();
  g.fillStyle = color; g.fillRect(14, 22, 6, 20);
  g.fillStyle = '#e7eaf0'; g.font = '600 26px Inter, sans-serif'; g.textBaseline = 'middle'; g.fillText(text, 30, 33);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({map: new THREE.CanvasTexture(cv), depthTest: false, transparent: true}));
  sp.scale.set(8, 2, 1); sp.renderOrder = 10; return sp;
}
function makeCar(role){
  const color = ROLE_COLOR[role], ghost = role !== 'player';
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({color, metalness: .3, roughness: .45, emissive: color, emissiveIntensity: ghost ? .45 : .15, transparent: ghost, opacity: ghost ? .5 : 1, depthWrite: !ghost});
  const dark = new THREE.MeshStandardMaterial({color: 0x14161b, roughness: .8, transparent: ghost, opacity: ghost ? .45 : 1, depthWrite: !ghost});
  const box = (w, h, l, x, y, z, m) => { const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, l), m); b.position.set(x, y, z); g.add(b); };
  box(.9, .55, 4.4, 0, .5, 0, mat);
  box(1.75, .42, 1.9, 0, .42, -.4, mat);
  box(.38, .26, 1.3, 0, .38, 2.75, mat);
  box(1.95, .06, .5, 0, .14, 3.3, dark);
  box(1.15, .06, .42, 0, 1.0, -2.35, dark);
  box(.06, .6, .5, .56, .75, -2.35, mat); box(.06, .6, .5, -.56, .75, -2.35, mat);
  box(.5, .35, .7, 0, .95, -.3, mat);
  for (const [x, z, r, w] of [[.9, 1.75, .36, .36], [-.9, 1.75, .36, .36], [.9, -1.65, .38, .46], [-.9, -1.65, .38, .46]]){
    const wh = new THREE.Mesh(new THREE.CylinderGeometry(r, r, w, 18), dark);
    wh.rotation.z = Math.PI / 2; wh.position.set(x, r, z); g.add(wh);
  }
  const label = makeLabel(ROLE_LABEL[role], color); label.position.set(0, 3.2, 0);
  label.material.sizeAttenuation = false; label.scale.set(.2, .05, 1); g.add(label);   // constant size on screen

  g.userData = {role, label, target: new V3(), fwd: new V3(0, 0, 1), f: new V3(0, 0, 1), init: false};
  g.visible = false; scene.add(g);
  return g;
}
const cars = {}; ROLES.forEach(r => cars[r] = makeCar(r));
const marker = new THREE.Mesh(new THREE.TorusGeometry(5, .45, 8, 40), new THREE.MeshBasicMaterial({color: 0xfacc15, depthTest: false, transparent: true}));
marker.rotation.x = Math.PI / 2; marker.renderOrder = 11; marker.visible = false; scene.add(marker);

function disposeGroup(g){
  g.traverse(o => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => { if (m.map) m.map.dispose(); m.dispose(); });
  });
  g.clear();
}

// ---------- track ----------
function clearTrack(){ disposeGroup(trackRoot); S.track = null; }
function buildTrack(lap){
  clearTrack();
  const D = lap.D, L = D[D.length - 1], P = [], dd = [];
  for (let d = Math.max(0, D[0]); d <= L; d += 3){ P.push(V(valAt(lap, 'x', d), valAt(lap, 'y', d), valAt(lap, 'z', d))); dd.push(d); }
  const n = P.length; if (n < 30) return;
  const closed = P[0].distanceTo(P[n - 1]) < 40, W = 13;
  const pos = new Float32Array(n * 6), col = new Float32Array(n * 6), T = [], N = [], eL = [], eR = [];
  const box = new THREE.Box3();
  for (let i = 0; i < n; i++){
    const a = P[closed ? (i - 2 + n) % n : Math.max(0, i - 2)], b = P[closed ? (i + 2) % n : Math.min(n - 1, i + 2)];
    const t = new V3().subVectors(b, a); t.y = 0; t.normalize();
    const nn = new V3(-t.z, 0, t.x); T.push(t); N.push(nn);
    const l = P[i].clone().addScaledVector(nn, W / 2), r = P[i].clone().addScaledVector(nn, -W / 2);
    pos.set([l.x, l.y, l.z, r.x, r.y, r.z], i * 6);
    eL.push(l.clone().setY(l.y + .06)); eR.push(r.clone().setY(r.y + .06));
    box.expandByPoint(P[i]);
  }
  const idx = [], segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++){ const j = (i + 1) % n, a = i * 2, b = a + 1, c = j * 2, d = c + 1; idx.push(a, c, b, b, c, d); }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setIndex(idx);
  trackRoot.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({vertexColors: true, side: THREE.DoubleSide})));
  const edgeMat = new THREE.LineBasicMaterial({color: 0xdfe5ee, transparent: true, opacity: .55});
  for (const e of [eL, eR]) trackRoot.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(closed ? [...e, e[0]] : e), edgeMat));

  const size = box.getSize(new V3()), center = box.getCenter(new V3()), span = Math.max(size.x, size.z, 200);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(span * 2.2, span * 2.2), new THREE.MeshLambertMaterial({color: 0x0d1015}));
  ground.rotation.x = -Math.PI / 2; ground.position.set(center.x, box.min.y - .8, center.z); trackRoot.add(ground);
  const grid = new THREE.GridHelper(span * 2.2, 44, 0x1d2330, 0x151a23); grid.position.set(center.x, box.min.y - .75, center.z); trackRoot.add(grid);

  const tvCams = [];
  for (let i = 0, k = 0; i < n; i += 70, k++){
    const side = k % 2 ? 1 : -1;
    tvCams.push(P[i].clone().addScaledVector(N[i], side * (W / 2 + 22)).add(new V3(0, 7 + (k % 3) * 3, 0)));
  }
  S.track = {lap, P, d: dd, T, N, L, n, closed, W, geo, center, span, tvCams};
  addGate(0, '#ffffff', 'S/F');
  const sb = sectorBounds();
  if (sb){ addGate(sb[0], '#38bdf8', 'S2'); addGate(sb[1], '#facc15', 'S3'); }
  colorTrack();
  if (S.cam === 'overview') setCam('overview');
}
function trackIndex(d){ return clamp(seek(S.track.d, d), 0, S.track.n - 1); }
function trackPosAt(d){
  const t = S.track, i = trackIndex(d), j = Math.min(i + 1, t.n - 1);
  const u = clamp((d - t.d[i]) / ((t.d[j] - t.d[i]) || 1), 0, 1);
  return t.P[i].clone().lerp(t.P[j], u);
}
function addGate(d, color, text){
  const t = S.track, i = trackIndex(d), g = new THREE.Group();
  g.position.copy(t.P[i]); g.lookAt(t.P[i].clone().add(t.T[i]));
  const m = new THREE.MeshBasicMaterial({color});
  const pole = new THREE.CylinderGeometry(.25, .25, 7, 8);
  for (const s of [1, -1]){ const p = new THREE.Mesh(pole, m); p.position.set(s * (t.W / 2 + 1.2), 3.5, 0); g.add(p); }
  const bar = new THREE.Mesh(new THREE.BoxGeometry(t.W + 2.8, .5, .3), m); bar.position.y = 7; g.add(bar);
  const strip = new THREE.Mesh(new THREE.BoxGeometry(t.W, .05, .9), new THREE.MeshBasicMaterial({color, transparent: true, opacity: .8}));
  strip.position.y = .05; g.add(strip);
  const lb = makeLabel(text, color); lb.position.y = 10; lb.scale.set(10, 2.5, 1); g.add(lb);
  trackRoot.add(g);
}
const C_SECT = [new THREE.Color('#8a3347'), new THREE.Color('#25607f'), new THREE.Color('#86701f')];
const C_BASE = new THREE.Color('#3a4150');
function ramp(v){
  const stops = [[0, '#ef4444'], [.45, '#f59e0b'], [.7, '#facc15'], [1, '#22c55e']];
  for (let i = 1; i < stops.length; i++) if (v <= stops[i][0]){
    const a = stops[i - 1], b = stops[i];
    return new THREE.Color(a[1]).lerp(new THREE.Color(b[1]), (v - a[0]) / (b[0] - a[0]));
  }
  return new THREE.Color(stops[stops.length - 1][1]);
}
function colorTrack(){
  const t = S.track; if (!t) return;
  const mode = $('colorMode').value, col = t.geo.attributes.color, ref = lapById(S.refId), cmp = lapById(S.cmpId), sb = sectorBounds();
  let lo = Infinity, hi = -Infinity;
  if (mode === 'speed' && ref) for (const r of ref.samples){ lo = Math.min(lo, r[F.speed]); hi = Math.max(hi, r[F.speed]); }
  for (let i = 0; i < t.n; i++){
    const d = t.d[i]; let c = C_BASE;
    if (mode === 'sector' && sb) c = C_SECT[d < sb[0] ? 0 : d < sb[1] ? 1 : 2];
    else if (mode === 'speed' && ref) c = ramp((valAt(ref, 'speed', d) - lo) / ((hi - lo) || 1)).multiplyScalar(.8);
    else if (mode === 'delta' && ref && cmp && cmp !== ref){
      const rate = (deltaAt(cmp, ref, d + 12) - deltaAt(cmp, ref, d - 12)) / 24;
      const v = clamp(rate / 0.0025, -1, 1);
      c = v < 0 ? C_BASE.clone().lerp(new THREE.Color('#22c55e'), -v) : C_BASE.clone().lerp(new THREE.Color('#ef4444'), v);
    }
    col.setXYZ(i * 2, c.r, c.g, c.b); col.setXYZ(i * 2 + 1, c.r, c.g, c.b);
  }
  col.needsUpdate = true;
}
function rebuildLines(){
  disposeGroup(lineRoot);
  if (!S.lines) return;
  for (const id of S.shown){
    const lap = lapById(id); if (!lap) continue;
    const pts = [];
    for (let i = 0; i < lap.samples.length; i += 2){ const r = lap.samples[i]; pts.push(V(r[F.x], r[F.y] + .3, r[F.z])); }
    lineRoot.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({color: lap.color})));
  }
}
function ensureTrack(){
  if (S.track) return;
  const cand = S.laps.filter(l => l.D.length > 200).sort((a, b) => b.D.length - a.D.length)[0];
  if (cand) buildTrack(cand);
}
function updateCrumbs(){
  if (S.track){ if (crumbRoot.children.length) disposeGroup(crumbRoot); return; }
  const s = S.liveLap.samples; if (s.length < 2) return;
  disposeGroup(crumbRoot);
  const pts = s.filter((_, i) => i % 3 === 0).map(r => V(r[F.x], r[F.y] + .2, r[F.z]));
  crumbRoot.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({color: 0x38bdf8, transparent: true, opacity: .7})));
}

// ---------- cameras ----------
const CAMS = ['orbit', 'chase', 'onboard', 'heli', 'tv', 'top', 'overview', 'free'];
function followCar(){ const c = cars[S.follow]; return c && c.visible ? c : (cars.player.visible ? cars.player : null); }
function setCam(mode){
  S.cam = mode; store.set('cam', mode);
  document.querySelectorAll('#camChips .chip').forEach(b => b.classList.toggle('on', b.dataset.cam === mode));
  controls.enabled = ['orbit', 'overview', 'free'].includes(mode);
  camera.up.set(0, 1, 0); camera.fov = mode === 'onboard' ? 72 : 55; camera.updateProjectionMatrix();
  const car = followCar();
  if (mode === 'overview' && S.track){
    const t = S.track, aspect = Math.max(.5, camera.aspect);
    controls.target.copy(t.center);
    camera.position.copy(t.center).add(new V3(0, t.span * .85 / Math.min(1, aspect), t.span * .55));
  } else if (mode === 'orbit' && car){
    controls.target.copy(car.position);
    camera.position.copy(car.position).add(new V3(22, 14, 22));
  }
  S.tvIdx = -1; S.orbitInit = !!car;
  updateLabels();
}
function updateLabels(){
  const car = followCar();
  for (const r of ROLES) cars[r].userData.label.visible = S.labels && !(['onboard', 'chase'].includes(S.cam) && cars[r] === car);
}
function setFollow(role){
  S.follow = role;
  document.querySelectorAll('#followChips button').forEach(b => b.classList.toggle('on', b.dataset.follow === role));
  setCam(S.cam);
}
const tmpA = new V3(), tmpB = new V3();
function updateCamera(){
  const car = followCar();
  if (!car || ['free', 'overview'].includes(S.cam)){ controls.update(); return; }
  const p = car.position, f = car.userData.f;
  switch (S.cam){
    case 'orbit':
      if (!S.orbitInit){ S.orbitInit = true; controls.target.copy(p); camera.position.copy(p).add(new V3(22, 14, 22)); }
      tmpA.copy(p).sub(controls.target); camera.position.add(tmpA); controls.target.add(tmpA); controls.update(); break;
    case 'chase':
      camera.position.copy(p).addScaledVector(f, -11).addScaledVector(UP, 3.4);
      camera.lookAt(tmpA.copy(p).addScaledVector(f, 8).addScaledVector(UP, 1)); break;
    case 'onboard':
      camera.position.copy(p).addScaledVector(f, .35).addScaledVector(UP, 1.08);
      camera.lookAt(tmpA.copy(p).addScaledVector(f, 40).addScaledVector(UP, .7)); break;
    case 'heli':
      camera.position.copy(p).addScaledVector(f, -55).addScaledVector(UP, 42);
      camera.lookAt(tmpA.copy(p).addScaledVector(f, 15)); break;
    case 'top':
      camera.up.set(0, 0, -1); camera.position.copy(p).addScaledVector(UP, camera.aspect < 1 ? 320 : 230); camera.lookAt(p); break;
    case 'tv': {
      if (!S.track){ camera.position.copy(p).add(new V3(30, 12, 30)); camera.lookAt(p); break; }
      const cams = S.track.tvCams; let best = -1, bd = Infinity;
      cams.forEach((c, i) => { const dd = c.distanceTo(p); if (dd < bd){ bd = dd; best = i; } });
      if (S.tvIdx < 0 || cams[S.tvIdx].distanceTo(p) > bd * 1.35 + 15) S.tvIdx = best;
      const cp = cams[S.tvIdx], dist = cp.distanceTo(p);
      camera.position.copy(cp); camera.lookAt(p);
      camera.fov = clamp(2 * Math.atan(10 / dist) * 180 / Math.PI / Math.min(1, camera.aspect), 3, 60); camera.updateProjectionMatrix(); break;
    }
  }
}

// =====================================================================
// Data in
// =====================================================================
function onFrame(m){
  S.lastFrame = performance.now();
  for (const role of ROLES){
    const c = m.cars[role], car = cars[role];
    if (!c){ car.visible = false; delete S.live[role]; continue; }
    S.live[role] = c; car.visible = true;
    const ud = car.userData;
    ud.target.copy(V(c.x, c.y, c.z));
    const fw = V(c.fx, c.fy, c.fz); if (fw.lengthSq() > .01) ud.fwd.copy(fw.normalize());
  }
  const p = m.cars.player, L = S.liveLap;
  if (p && p.d != null){
    const lastD = L.D.length ? L.D[L.D.length - 1] : -Infinity;
    if (p.d < lastD - 20){ L.samples = []; L.D = []; }
    if (p.d >= 0 && p.d > (L.D.length ? L.D[L.D.length - 1] : -Infinity) + .05){
      const o = {t: p.curLap, d: p.d, x: p.x, y: p.y, z: p.z, speed: p.speed, throttle: p.throttle, brake: p.brake, steer: p.steer, gear: p.gear, rpm: p.rpm, drs: p.drs, fx: p.fx, fy: p.fy, fz: p.fz};
      L.samples.push(FIELDS.map(k => o[k] ?? 0));
      L.D.push(p.d);
    }
  }
  S.chartsDirty = true;
}
function onMessage(m){
  switch (m.type){
    case 'hello':
      if (m.fields) setFields(m.fields);
      S.session = m.session || {}; S.tt = m.tt;
      S.laps = S.laps.filter(l => l.imported);
      for (const id of [...S.shown]) if (!lapById(id)) S.shown.delete(id);
      (m.laps || []).forEach(l => addLap(l, true));
      if (m.status) S.status = m.status;
      afterLapsChanged(); updateSessionUI(); updateDetect(); break;
    case 'reset':
      S.laps = S.laps.filter(l => l.imported); S.tt = null; S.session = {};
      for (const id of [...S.shown]) if (!lapById(id)) S.shown.delete(id);
      if (!lapById(S.refId)) S.refId = null;
      if (!lapById(S.cmpId)) S.cmpId = null;
      S.liveLap.samples = []; S.liveLap.D = []; S.xrUser = false; S.xr = null;
      clearTrack(); afterLapsChanged(); updateSessionUI(); break;
    case 'session': {
      const prev = S.session; S.session = m.session || {};
      if (S.track && (prev.sector2 !== S.session.sector2 || prev.sector3 !== S.session.sector3)) buildTrack(S.track.lap);
      if (!S.xrUser) S.xr = null;
      S.laps.forEach(l => l.sectors = lapSectors(l));
      updateSessionUI(); renderLaps(); S.chartsDirty = true; break;
    }
    case 'tt': S.tt = m.tt; break;
    case 'lap': addLap(m.lap, false); afterLapsChanged(); break;
    case 'frame': onFrame(m); break;
    case 'status': S.status = m; updateDetect(); break;
  }
}
function addLap(lap, quiet){
  if (S.laps.some(l => l.id === lap.id)) return;
  prepLap(lap);
  if (lap.D.length < 50) return;
  lap.sectors = lapSectors(lap);
  S.laps.push(lap);
  if (!S.auto && !quiet) return;
  S.laps.filter(l => l.role === lap.role && l !== lap && l.auto).forEach(l => { S.shown.delete(l.id); l.auto = false; });
  lap.auto = true; S.shown.add(lap.id);
  const ref = lapById(S.refId);
  if (!ref || lap.role === 'rival' || (lap.role === 'pb' && ref.role !== 'rival' && ref.auto !== false)) S.refId = lap.id;
  if (lap.role === 'player' && lap.id !== S.refId) S.cmpId = lap.id;
  if (!lapById(S.cmpId) || S.cmpId === S.refId){
    const other = [...S.laps].reverse().find(l => l.id !== S.refId && S.shown.has(l.id));
    S.cmpId = other ? other.id : null;
  }
}
function afterLapsChanged(){ ensureTrack(); rebuildLines(); colorTrack(); renderLaps(); S.chartsDirty = true; }
function updateSessionUI(){
  const s = S.session;
  $('trackName').textContent = s.trackName
    ? `${s.trackName}${s.trackLength && isDesk() ? ' · ' + (s.trackLength / 1000).toFixed(3) + ' km' : ''}${s.sessionName && isDesk() ? ' · ' + s.sessionName : ''}` : '';
}
function resetAll(){
  S.laps = []; S.shown.clear(); S.refId = S.cmpId = null; S.tt = null; S.session = {}; S.status = null; S.live = {};
  S.liveLap.samples = []; S.liveLap.D = []; S.xr = null; S.xrUser = false; S.hoverD = null;
  for (const r of ROLES){ cars[r].visible = false; cars[r].userData.init = false; }
  clearTrack(); disposeGroup(crumbRoot); afterLapsChanged(); updateSessionUI();
}

// =====================================================================
// Connection: bridge (WebSocket) or in-browser demo
// =====================================================================
const IS_HTTPS = location.protocol === 'https:';
const Conn = {
  ws: null, state: 'idle', host: '', list: [], i: 0, fails: 0, retry: null,
  candidates(){
    const qs = new URLSearchParams(location.search), list = [];
    const b = qs.get('bridge');
    if (b) list.push(b.replace(/^\w+:\/\//, '').replace(/\/.*$/, ''));
    if (location.protocol === 'http:' && location.host) list.push(location.host);
    if (location.protocol !== 'http:') list.push('localhost:8000');
    return [...new Set(list)];
  },
  start(){ this.list = this.candidates(); this.i = 0; this.fails = 0; this.tryNext(); },
  tryNext(){
    clearTimeout(this.retry);
    if (S.demo || !this.list.length) return;
    const host = this.list[this.i % this.list.length];
    this.state = 'connecting'; this.host = host; updateDetect(); updatePill();
    let ws;
    try { ws = new WebSocket(`ws://${host}/ws`); } catch { this.fail(); return; }
    this.ws = ws;
    let opened = false;
    const guard = setTimeout(() => { if (!opened) try { ws.close(); } catch {} }, 4000);
    ws.onopen = () => { opened = true; clearTimeout(guard); this.state = 'open'; this.fails = 0; S.connectedAt = performance.now(); updateDetect(); updatePill(); };
    ws.onmessage = e => { if (S.demo || this.ws !== ws) return; let m; try { m = JSON.parse(e.data); } catch { return; } onMessage(m); };
    ws.onclose = () => { clearTimeout(guard); if (this.ws !== ws) return; this.ws = null; if (opened) S.status = null; this.fail(); };
  },
  fail(){
    this.state = 'closed'; this.fails++; this.i++;
    updateDetect(); updatePill();
    if (!S.demo) this.retry = setTimeout(() => this.tryNext(), Math.min(5000, 800 + this.fails * 500));
  },
  stop(){
    clearTimeout(this.retry);
    const w = this.ws; this.ws = null;
    if (w) try { w.close(); } catch {}
    this.state = 'idle';
  },
};
let demo = null;
function startDemo(){
  Conn.stop(); resetAll();
  S.demo = true; S.autoGo = true;
  demo = new GhostDemo(m => { if (S.demo) onMessage(m); });
  demo.start();
  updateDetect(); updatePill();
}
function stopDemo(){
  if (demo) demo.stop();
  demo = null; S.demo = false;
  resetAll(); Conn.start(); updateDetect(); updatePill();
}

// =====================================================================
// Detection screen
// =====================================================================
function setStep(id, state, title, sub){
  const el = $(id); el.className = 'step ' + state;
  el.querySelector('b').textContent = title;
  el.querySelector('small').textContent = sub || '';
}
function telemetryLive(){ const t = S.status && S.status.telemetry; return !!(t && t.lastAgo != null && t.lastAgo < 3 && t.sources && t.sources.length && !(t.ignored && !t.packets)); }
function updateDetect(){
  const st = S.status, connected = S.demo || Conn.state === 'open', br = st && st.bridge, tel = st && st.telemetry;
  const live = connected && telemetryLive();
  const anyCar = !!(st && st.cars && ROLES.some(r => st.cars[r]));

  // 1. bridge
  if (S.demo) setStep('stBridge', 'ok', 'Demo mode', 'Simulated data, no bridge needed');
  else if (Conn.state === 'open') setStep('stBridge', 'ok', 'Bridge connected', `${Conn.host}${br && br.version ? ' · v' + br.version : ''}`);
  else if (Conn.fails > 1 && IS_HTTPS) setStep('stBridge', 'bad', 'No bridge reachable from here', 'Open the app from your bridge address below');
  else if (Conn.fails > 1) setStep('stBridge', 'wait', 'Looking for the bridge…', `Trying ${Conn.host}. Is bridge.py running?`);
  else setStep('stBridge', 'wait', 'Looking for the bridge…', Conn.host ? `Trying ${Conn.host}` : '');

  // 2. telemetry
  if (!connected) setStep('stUdp', 'idle', 'Game telemetry', 'Waiting for the bridge');
  else if (live){
    const s = tel.sources[0];
    setStep('stUdp', 'ok', `${s.game} telemetry detected`, `${S.demo ? 'Simulated' : 'From ' + s.ip} · format ${s.format} · ${tel.rate} packets/s`);
  } else if (tel && tel.ignored && !tel.packets) setStep('stUdp', 'warn', 'Packets in an older format', `Seeing format ${tel.ignoredFormat}. Set UDP Format to 2026 (or 2025).`);
  else if (tel && tel.lastAgo != null) setStep('stUdp', 'warn', 'Telemetry paused', `Last packet ${Math.round(tel.lastAgo)} s ago. Game paused or in the menus?`);
  else setStep('stUdp', 'wait', 'Listening for the game…', br ? `UDP port ${br.udpPort}${br.lanIp ? ' on ' + br.lanIp : ''}` : '');

  // 3. session
  const ses = st && st.session;
  if (connected && ses && ses.trackName){
    const km = ses.trackLength ? ` · ${(ses.trackLength / 1000).toFixed(2)} km` : '';
    if (ses.timeTrial === false) setStep('stSession', 'warn', ses.trackName, `${ses.sessionName || 'Session'}${km}. Ghosts only appear in Time Trial.`);
    else setStep('stSession', 'ok', ses.trackName, `${ses.sessionName || 'Session'}${km}`);
  } else setStep('stSession', 'idle', 'Session', live ? 'Waiting for session info…' : 'Start a Time Trial and drive out');

  // 4. cars
  document.querySelectorAll('.carchip').forEach(c => c.classList.toggle('on', !!(connected && st && st.cars && st.cars[c.dataset.role])));
  document.querySelectorAll('.radar .blip').forEach(b => b.classList.toggle('on', !!(connected && st && st.cars && st.cars[b.classList[1]])));
  if (connected && anyCar){
    const ghosts = st.cars.pb || st.cars.rival;
    setStep('stCars', ghosts ? 'ok' : 'warn', ghosts ? 'Cars on track' : 'You are on track', ghosts ? '' : 'No ghosts yet. Set a rival in Time Trial and turn ghosts on.');
  } else setStep('stCars', 'idle', 'Cars', 'You, your PB ghost and the rival ghost');

  // headline + radar
  const title = !connected ? 'Looking for the bridge…' : live ? (anyCar ? 'Telemetry detected' : 'Game found') : 'Listening for telemetry…';
  const sub = !connected ? (IS_HTTPS ? 'Live data needs the Ghost Lab bridge on your network, or try the demo.' : 'Checking your network for the Ghost Lab bridge.')
    : live ? (anyCar ? 'Opening the dashboard…' : 'Drive out of the garage to see the cars.')
    : 'The bridge is ready. Start a Time Trial with UDP telemetry turned on.';
  $('dTitle').textContent = title;
  $('dSub').textContent = S.view === 'detect' && !S.autoGo && live && anyCar ? 'Everything is connected.' : sub;
  $('radar').classList.toggle('found', live && anyCar);

  // actions
  const go = $('dGo');
  go.disabled = !(live || (S.laps.length > 0));
  go.textContent = live ? 'Open dashboard' : S.laps.length ? 'View saved laps' : 'Open dashboard';
  $('dDemo').textContent = S.demo ? 'Stop demo' : 'Try the demo';
  $('dRemote').hidden = !(IS_HTTPS || location.protocol === 'file:') || Conn.state === 'open' || S.demo;

  // help: open after a while with nothing arriving
  const waiting = connected && !S.demo && !live;
  $('trouble').hidden = !(waiting && performance.now() - S.connectedAt > 10000);
  if (waiting && performance.now() - S.connectedAt > 10000 && !$('dHelp').dataset.auto){ $('dHelp').open = true; $('dHelp').dataset.auto = '1'; }
  renderHelp();
  renderQR();

  // auto-continue the first time everything is found
  if (S.view === 'detect' && S.autoGo && live && anyCar && !S.goTimer){
    S.goTimer = setTimeout(() => { S.goTimer = null; if (S.view === 'detect' && S.autoGo && telemetryLive()) openDashboard(); }, 1400);
  }
}
let helpKey = '';
function renderHelp(){
  const br = S.status && S.status.bridge, ip = (br && br.lanIp) || 'your PC’s IP', port = (br && br.udpPort) || 20777;
  const key = ip + port; if (key === helpKey) return; helpKey = key;
  $('helpBody').innerHTML = `<table class="settings">
    <tr><th></th><th>Game on this PC</th><th>Console</th></tr>
    <tr><td>UDP Telemetry</td><td>On</td><td>On</td></tr>
    <tr><td>Broadcast Mode</td><td>Off</td><td>Off</td></tr>
    <tr><td>UDP IP Address</td><td>127.0.0.1</td><td>${esc(ip)}</td></tr>
    <tr><td>UDP Port</td><td>${port}</td><td>${port}</td></tr>
    <tr><td>Send Rate</td><td>60 Hz</td><td>60 Hz</td></tr>
    <tr><td>UDP Format</td><td>2026</td><td>2026</td></tr></table>
    <p class="muted small">On console you can also turn Broadcast Mode On and leave the IP alone. On F1 25 use format 2025.</p>`;
}
let qrKey = '';
function renderQR(){
  const br = S.status && S.status.bridge;
  const show = !S.demo && Conn.state === 'open' && br && br.lanIp && !/^127\./.test(br.lanIp) && !TOUCH && typeof qrcode === 'function';
  $('dQR').hidden = !show;
  if (!show) return;
  const url = `http://${br.lanIp}:${br.httpPort || location.port || 8000}/`;
  if (url === qrKey) return; qrKey = url;
  const q = qrcode(0, 'M'); q.addData(url); q.make();
  $('qrBox').innerHTML = q.createSvgTag({cellSize: 4, margin: 0, scalable: true});
  $('qrUrl').textContent = url;
}
function openDashboard(){
  if (S.view === 'dash') return;
  S.view = 'dash'; S.autoGo = false;
  const d = $('detect'); d.classList.add('leaving');
  setTimeout(() => { if (S.view === 'dash') d.hidden = true; }, 350);
  resize(); setCam(S.cam); keepAwake();
}
function showDetect(){
  S.view = 'detect'; S.autoGo = false; clearTimeout(S.goTimer); S.goTimer = null;
  const d = $('detect'); d.hidden = false; requestAnimationFrame(() => d.classList.remove('leaving'));
  updateDetect();
}
$('dGo').onclick = openDashboard;
$('dDemo').onclick = () => S.demo ? stopDemo() : startDemo();
$('pill').onclick = showDetect;
$('remoteForm').onsubmit = e => {
  e.preventDefault();
  let a = $('remoteAddr').value.trim().replace(/^\w+:\/\//, '').replace(/\/.*$/, '');
  if (!a) return;
  if (!/:\d+$/.test(a)) a += ':8000';
  store.set('bridgeAddr', a);
  location.href = `http://${a}/`;
};
$('remoteAddr').value = store.get('bridgeAddr', '');
if (/\.github\.io$/.test(location.hostname)){
  const repo = location.pathname.split('/').filter(Boolean)[0];
  if (repo){ $('repoLink').href = `https://github.com/${location.hostname.split('.')[0]}/${repo}#readme`; $('repoLink').hidden = false; }
} else $('dlBridge').hidden = true;

function updatePill(){
  const el = $('pill'), tel = S.status && S.status.telemetry;
  let cls, txt;
  if (S.demo){ cls = 'demo'; txt = 'Demo'; }
  else if (Conn.state !== 'open'){ cls = 'bad'; txt = Conn.state === 'connecting' && Conn.fails === 0 ? 'Connecting…' : 'Bridge offline'; }
  else if (telemetryLive()){ cls = 'ok'; txt = `Live${tel.rate ? ' · ' + tel.rate + '/s' : ''}`; }
  else { cls = 'warn'; txt = 'No telemetry'; }
  if (el.textContent !== txt) el.textContent = txt;
  el.className = 'pill ' + cls;
}
let wakeLock = null;
async function keepAwake(){
  try {
    if ('wakeLock' in navigator && !wakeLock && document.visibilityState === 'visible'){
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch {}
}
document.addEventListener('visibilitychange', () => { if (S.view === 'dash') keepAwake(); });

// =====================================================================
// Panels: live cards, sectors, laps
// =====================================================================
function liveDelta(role){
  const c = S.live[role], ref = lapById(S.refId);
  if (!c || !ref || c.d == null || c.d < 0 || !c.curLap) return null;
  if (ref.D[ref.D.length - 1] < c.d) return null;
  return (c.curLap - valAt(ref, 't', c.d)) / 1000;
}
function carHTML(role, big){
  const c = S.live[role]; if (!c) return '';
  const dl = liveDelta(role);
  const gap = role !== 'player' && S.live.player && c.d != null && S.live.player.d != null ? c.d - S.live.player.d : null;
  const name = c.name && c.name !== ROLE_LABEL[role] ? c.name : '';
  const steerPos = 50 + clamp(c.steer || 0, -1, 1) * 50;
  const gear = c.gear == null ? '–' : c.gear <= 0 ? (c.gear < 0 ? 'R' : 'N') : c.gear;
  return `<div class="car" style="--c:${ROLE_COLOR[role]}">
    <div class="top"><b>${ROLE_LABEL[role]}</b><span class="nm">${esc(name)}</span><span class="dl ${dl == null ? '' : dl < 0 ? 'neg' : 'pos'}">${dl == null ? '' : fmtDelta(dl)}</span></div>
    <div class="mid"><div class="spd">${c.speed ?? 0}<small>km/h</small></div><div class="gr">${gear}</div>
      <div class="bars"><div class="bar t"><i style="width:${(c.throttle || 0) * 100}%"></i></div><div class="bar b"><i style="width:${(c.brake || 0) * 100}%"></i></div><div class="steer"><i style="left:${steerPos}%"></i></div></div></div>
    <div class="foot"><span>${c.d != null && c.d >= 0 ? Math.round(c.d) + ' m' : 'out lap'}</span>${c.curLap ? `<span>${fmtLap(c.curLap)}</span>` : ''}
      ${!big && c.rpm ? `<span>${c.rpm.toLocaleString()} rpm</span>` : ''}${gap != null && Math.abs(gap) < 2000 ? `<span>${gap >= 0 ? '+' : ''}${Math.round(gap)} m</span>` : ''}${c.drs ? '<span class="drs">DRS</span>' : ''}</div></div>`;
}
function renderCards(){
  if (paneVisible('data')) $('cards').innerHTML = ROLES.map(r => carHTML(r, false)).join('') || '<div class="empty">No cars on track yet.</div>';
  if (paneVisible('map')){ const fc = followCar(); $('hud').innerHTML = fc ? carHTML(fc.userData.role, true) : ''; }
}
function renderSectors(){
  if (!paneVisible('data')) return;
  const rows = [], tt = S.tt, p = S.live.player;
  if (p) rows.push({label: 'Current', color: ROLE_COLOR.player, v: [p.sector >= 1 ? p.s1 : null, p.sector >= 2 ? p.s2 : null, null, null], live: true});
  const lastPlayer = [...S.laps].reverse().find(l => l.role === 'player' && l.sectors);
  if (lastPlayer) rows.push({label: 'Last lap', color: ROLE_COLOR.player, v: [...lastPlayer.sectors, lastPlayer.lapTime], mine: true});
  if (tt){
    const row = (k, label, color) => { const s = tt[k]; if (s && s.lapTime) rows.push({label, color, v: [s.s1, s.s2, s.s3, s.lapTime]}); };
    row('sessionBest', 'Session best', ROLE_COLOR.player);
    row('personalBest', 'PB', ROLE_COLOR.pb);
    row('rival', 'Rival', ROLE_COLOR.rival);
  }
  if (!rows.length){ $('sectors').innerHTML = '<tr><td class="empty">Sector times show once you are on track.</td></tr>'; return; }
  const best = [0, 1, 2, 3].map(i => Math.min(...rows.filter(r => !r.live).map(r => r.v[i]).filter(v => v > 0)));
  const pb = tt && tt.personalBest, pbv = pb ? [pb.s1, pb.s2, pb.s3, pb.lapTime] : null;
  let html = '<tr><th></th><th>S1</th><th>S2</th><th>S3</th><th>Lap</th></tr>';
  for (const r of rows){
    html += `<tr><td><span class="sw" style="background:${r.color}"></span>${r.label}</td>`;
    r.v.forEach((v, i) => {
      let cls = '';
      if (v > 0){
        if (v <= best[i]) cls = 'purple';
        else if (pbv && pbv[i] && v <= pbv[i]) cls = 'green';
        else if (r.live || r.mine) cls = 'yellow';
      }
      html += `<td class="${cls}">${i === 3 ? fmtLap(v) : fmtSec(v)}</td>`;
    });
    html += '</tr>';
  }
  $('sectors').innerHTML = html;
}
function renderLaps(){
  const list = $('lapList');
  if (!S.laps.length){ list.innerHTML = '<div class="empty">Completed laps appear here, including the ghosts\' laps. Saved CSVs can be imported.</div>'; return; }
  list.innerHTML = [...S.laps].reverse().map(l => {
    const sec = l.sectors ? l.sectors.map(fmtSec).join(' · ') : '';
    const on = S.shown.has(l.id);
    return `<div class="lap ${on ? 'sel' : ''}" data-id="${l.id}">
      <label><input type="checkbox" ${on ? 'checked' : ''} data-act="show" aria-label="Show lap"></label>
      <div><div class="l1"><span class="sw" style="background:${l.color}"></span><span class="role">${ROLE_SHORT[l.role] || 'Lap'}</span><span class="time">${fmtLap(l.lapTime)}</span>${l.invalid ? '<span class="inv">INVALID</span>' : ''}</div>
        <div class="l2">${esc(l.name && l.name !== ROLE_LABEL[l.role] ? l.name + ' · ' : '')}${sec}</div></div>
      <div class="btns"><button class="ref ${S.refId === l.id ? 'on' : ''}" data-act="ref">REF</button><button class="cmp ${S.cmpId === l.id ? 'on' : ''}" data-act="cmp">CMP</button><button data-act="csv" aria-label="Download CSV">CSV</button></div>
    </div>`;
  }).join('');
}
$('lapList').addEventListener('click', e => {
  const row = e.target.closest('.lap'), act = e.target.dataset.act; if (!row || !act) return;
  const id = isNaN(+row.dataset.id) ? row.dataset.id : +row.dataset.id, lap = lapById(id); if (!lap) return;
  if (act === 'show'){ if (e.target.checked) S.shown.add(id); else S.shown.delete(id); lap.auto = false; }
  if (act === 'ref'){ S.refId = id; S.shown.add(id); if (S.cmpId === id) S.cmpId = null; }
  if (act === 'cmp'){ S.cmpId = S.cmpId === id ? null : id; if (S.cmpId) S.shown.add(id); if (S.refId === id) S.refId = null; }
  if (act === 'csv'){ downloadLap(lap); return; }
  rebuildLines(); colorTrack(); renderLaps(); S.chartsDirty = true;
});
function downloadLap(lap){
  const meta = `# role=${lap.role},name=${String(lap.name || '').replace(/,/g, ' ')},lapTime=${lap.lapTime},invalid=${!!lap.invalid},trackId=${lap.trackId ?? ''},trackName=${lap.trackName || S.session.trackName || ''}`;
  const body = [meta, FIELDS.join(','), ...lap.samples.map(r => r.join(','))].join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([body], {type: 'text/csv'}));
  a.download = `${(lap.trackName || S.session.trackName || 'lap').replace(/\W+/g, '-').toLowerCase()}_${lap.role}_${fmtLap(lap.lapTime).replace(/[:.]/g, '-')}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
$('importBtn').onclick = () => $('fileIn').click();
$('fileIn').onchange = async e => {
  for (const file of e.target.files){
    const lines = (await file.text()).split(/\r?\n/).filter(Boolean);
    const meta = {};
    if (lines[0] && lines[0].startsWith('#')) lines.shift().slice(1).split(',').forEach(kv => { const [k, ...v] = kv.trim().split('='); meta[k] = v.join('='); });
    const header = (lines.shift() || '').split(',').map(s => s.trim());
    const order = FIELDS.map(f => header.indexOf(f));
    if (order[F.d] < 0 || order[F.x] < 0){ alert(`${file.name} doesn't look like a Ghost Lab lap CSV.`); continue; }
    const samples = lines.map(l => { const c = l.split(',').map(Number); return order.map(i => i >= 0 ? c[i] : 0); });
    const role = ROLE_COLOR[meta.role] ? meta.role : 'import';
    const lap = {id: 'imp' + (++S.importSeq), role, name: (meta.name || file.name.replace(/\.csv$/i, '')) + ' (imported)', imported: true,
      lapTime: +meta.lapTime || samples[samples.length - 1][0], invalid: /^true$/i.test(meta.invalid || ''), trackId: meta.trackId, trackName: meta.trackName, samples};
    prepLap(lap); lap.sectors = lapSectors(lap);
    if (lap.D.length < 50) continue;
    S.laps.push(lap); S.shown.add(lap.id);
    if (!lapById(S.refId)) S.refId = lap.id; else if (!lapById(S.cmpId)) S.cmpId = lap.id;
  }
  e.target.value = '';
  afterLapsChanged();
};

// =====================================================================
// Traces
// =====================================================================
const CH = [
  {k: 'speed', label: 'Speed', unit: 'km/h', h: 120, min: 0, auto: true},
  {k: 'throttle', label: 'Throttle', unit: '%', h: 62, min: 0, max: 100, mul: 100},
  {k: 'brake', label: 'Brake', unit: '%', h: 62, min: 0, max: 100, mul: 100},
  {k: 'steer', label: 'Steering', unit: '', h: 70, min: -1, max: 1},
  {k: 'gear', label: 'Gear', unit: '', h: 62, min: 0, max: 8},
  {k: 'rpm', label: 'RPM', unit: '', h: 70, min: 0, auto: true},
  {k: 'delta', label: 'Delta to REF', unit: 's', h: 100, sym: true},
];
const PL = 40, PR = 8;
function buildChips(){
  $('chips').innerHTML = CH.map(c => `<button class="chip ${S.chOn[c.k] ? 'on' : ''}" data-k="${c.k}">${c.label.replace(' to REF', '')}</button>`).join('');
  $('charts').innerHTML = '';
  for (const c of CH){
    if (!S.chOn[c.k]){ c.el = null; continue; }
    const wrap = document.createElement('div'); wrap.className = 'chart';
    wrap.innerHTML = `<div class="ch"><b>${c.label}</b><span class="rd"></span></div><canvas></canvas>`;
    $('charts').appendChild(wrap);
    c.el = wrap; c.canvas = wrap.querySelector('canvas'); c.rd = wrap.querySelector('.rd');
  }
  S.chartsDirty = true;
}
$('chips').addEventListener('click', e => { const k = e.target.dataset.k; if (!k) return; S.chOn[k] = !S.chOn[k]; store.set('channels', S.chOn); buildChips(); });
function chartSeries(){
  const out = [];
  for (const id of S.shown){ const l = lapById(id); if (l) out.push(l); }
  out.sort((a, b) => (a.id === S.refId) - (b.id === S.refId));
  if (S.showLive && S.liveLap.D.length > 1) out.push(S.liveLap);
  return out;
}
function xRange(){ if (!S.xr || !S.xrUser) S.xr = [0, trackLen()]; return S.xr; }
function setRange(a, b){
  const L = trackLen();
  if (b - a < 40) return;
  if (b - a >= L){ S.xr = null; S.xrUser = false; }
  else {
    if (a < 0){ b -= a; a = 0; }
    if (b > L){ a -= b - L; b = L; }
    S.xr = [a, b]; S.xrUser = true;
  }
  S.chartsDirty = true;
}
function drawCharts(){
  S.chartsDirty = false;
  const series = chartSeries(), [x0, x1] = xRange(), ref = lapById(S.refId), sb = sectorBounds();
  const live = S.live.player, cursor = S.hoverD ?? (live && live.d >= 0 ? live.d : null);
  const vis = CH.filter(c => c.el), small = !isDesk();
  $('legend').innerHTML = series.map(l => `<span><span class="sw" style="background:${l.color}"></span>${l === S.liveLap ? 'Live' : (small ? ROLE_SHORT[l.role] || 'Lap' : ROLE_LABEL[l.role] || 'Lap') + ' ' + fmtLap(l.lapTime)}${l.id === S.refId ? ' REF' : ''}</span>`).join('');
  vis.forEach((ch, ci) => {
    const cv = ch.canvas, last = ci === vis.length - 1, dpr = Math.min(devicePixelRatio, 2);
    const w = cv.clientWidth || 360, h = Math.round(ch.h * (small ? .9 : 1)) + (last ? 16 : 0);
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)){ cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); cv.style.height = h + 'px'; }
    const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
    const pt = 16, pb = last ? 18 : 4, pw = w - PL - PR, ph = h - pt - pb;
    const X = d => PL + (d - x0) / (x1 - x0) * pw;
    const get = ch.k === 'delta'
      ? (lap, i) => ref && lap !== ref ? (lap.samples[i][F.t] - valAt(ref, 't', lap.D[i])) / 1000 : NaN
      : (lap, i) => lap.samples[i][F[ch.k]] * (ch.mul || 1);
    let lo = ch.min ?? Infinity, hi = ch.max ?? -Infinity;
    if (ch.auto || ch.sym){
      let m = ch.sym ? 0.2 : 0;
      for (const lap of series){
        if (!lap.D.length) continue;
        const i0 = seek(lap.D, x0), i1 = Math.min(lap.D.length - 1, seek(lap.D, x1) + 1);
        for (let i = i0; i <= i1; i++){ const v = get(lap, i); if (isFinite(v)) m = Math.max(m, ch.sym ? Math.abs(v) : v); }
      }
      if (ch.sym){ lo = -m * 1.1; hi = m * 1.1; } else hi = Math.max(10, Math.ceil(m * 1.06 / 50) * 50);
    }
    const Y = v => pt + (1 - (v - lo) / ((hi - lo) || 1)) * ph;
    g.font = '10px JetBrains Mono, monospace'; g.fillStyle = '#5d6578'; g.strokeStyle = '#1c212b'; g.lineWidth = 1; g.textAlign = 'right'; g.textBaseline = 'middle';
    const ticks = ch.sym ? [lo / 1.1, 0, hi / 1.1] : [lo, (lo + hi) / 2, hi];
    for (const v of ticks){ const y = Math.round(Y(v)) + .5; g.beginPath(); g.moveTo(PL, y); g.lineTo(PL + pw, y); g.stroke(); g.fillText(ch.k === 'delta' ? v.toFixed(2) : Math.round(v), PL - 5, y); }
    if (ch.sym){ g.strokeStyle = '#3a4252'; const y = Math.round(Y(0)) + .5; g.beginPath(); g.moveTo(PL, y); g.lineTo(PL + pw, y); g.stroke(); }
    if (sb){
      g.setLineDash([3, 4]); g.strokeStyle = '#3a4252';
      sb.forEach((d, i) => {
        if (d < x0 || d > x1) return;
        const x = Math.round(X(d)) + .5; g.beginPath(); g.moveTo(x, pt - 4); g.lineTo(x, pt + ph); g.stroke();
        if (ci === 0){ g.fillStyle = '#8992a5'; g.textAlign = 'left'; g.fillText(i ? 'S3' : 'S2', x + 4, pt + 4); }
      });
      g.setLineDash([]);
    }
    if (ch.k === 'delta' && !ref){ g.fillStyle = '#5d6578'; g.textAlign = 'center'; g.fillText('Pick a REF lap to see the delta', PL + pw / 2, pt + ph / 2); }
    g.save(); g.beginPath(); g.rect(PL, 0, pw, h); g.clip();
    for (const lap of series){
      if (!lap.D.length) continue;
      const i0 = Math.max(0, seek(lap.D, x0) - 1), i1 = Math.min(lap.D.length - 1, seek(lap.D, x1) + 2);
      const step = Math.max(1, Math.floor((i1 - i0) / (pw * 2)));
      g.strokeStyle = lap.color; g.lineWidth = lap.id === S.refId ? 1.8 : 1.3; g.globalAlpha = .92;
      g.beginPath(); let pen = false;
      for (let i = i0; i <= i1; i += step){
        const v = get(lap, i); if (!isFinite(v)){ pen = false; continue; }
        const x = X(lap.D[i]), y = Y(clamp(v, lo, hi));
        if (pen) g.lineTo(x, y); else { g.moveTo(x, y); pen = true; }
      }
      g.stroke();
    }
    g.globalAlpha = 1; g.restore();
    let rd = '';
    if (cursor != null && cursor >= x0 && cursor <= x1){
      const x = Math.round(X(cursor)) + .5;
      g.strokeStyle = S.hoverD != null ? '#facc15' : '#e7eaf0'; g.globalAlpha = .6; g.beginPath(); g.moveTo(x, pt - 4); g.lineTo(x, pt + ph); g.stroke(); g.globalAlpha = 1;
      for (const lap of series){
        if (!lap.D.length || cursor > lap.D[lap.D.length - 1]) continue;
        const v = ch.k === 'delta' ? (ref && lap !== ref ? deltaAt(lap, ref, cursor) : NaN) : valAt(lap, ch.k, cursor) * (ch.mul || 1);
        if (!isFinite(v)) continue;
        rd += `<span style="color:${lap.color}">${ch.k === 'delta' ? fmtDelta(v) : ch.k === 'steer' ? v.toFixed(2) : Math.round(v)}</span>`;
      }
    }
    ch.rd.innerHTML = (ch.unit ? `<span>${ch.unit}</span>` : '') + rd;
    if (last){
      g.fillStyle = '#5d6578'; g.textAlign = 'center'; g.textBaseline = 'alphabetic';
      const span = x1 - x0, stepM = [50, 100, 250, 500, 1000, 2000].find(s => span / s <= (small ? 5 : 10)) || 2000;
      for (let d = Math.ceil(x0 / stepM) * stepM; d <= x1; d += stepM) g.fillText(d >= 1000 ? (d / 1000).toFixed(stepM < 1000 ? 2 : 0) + ' km' : d + ' m', X(d), h - 4);
    }
  });
}

// ---- trace interaction: mouse hover/drag/wheel, touch scrub/pinch/double-tap ----
const chartsEl = $('charts');
function chartGeom(){ const cv = chartsEl.querySelector('canvas'); if (!cv) return null; const r = cv.getBoundingClientRect(); return {left: r.left + PL, width: r.width - PL - PR}; }
function dAtX(clientX){ const g = chartGeom(); if (!g) return null; const [x0, x1] = xRange(); return x0 + (clientX - g.left) / g.width * (x1 - x0); }
const ptrs = new Map(); let pinch = null, mdrag = null, lastTap = 0;
chartsEl.addEventListener('pointerdown', e => {
  if (e.pointerType === 'mouse'){ mdrag = {x: e.clientX, xr: [...xRange()]}; return; }
  ptrs.set(e.pointerId, e.clientX);
  if (ptrs.size === 2){ const [a, b] = [...ptrs.values()]; pinch = {da: dAtX(a), db: dAtX(b)}; return; }
  S.hoverD = dAtX(e.clientX); S.chartsDirty = true;
  const now = performance.now();
  if (now - lastTap < 300){ S.xr = null; S.xrUser = false; S.hoverD = null; }
  lastTap = now;
});
chartsEl.addEventListener('pointermove', e => {
  if (e.pointerType === 'mouse'){
    S.hoverD = dAtX(e.clientX); S.chartsDirty = true;
    if (mdrag && e.buttons){
      const g = chartGeom(), span = mdrag.xr[1] - mdrag.xr[0], shift = (mdrag.x - e.clientX) / g.width * span;
      setRange(mdrag.xr[0] + shift, mdrag.xr[1] + shift);
    }
    return;
  }
  if (!ptrs.has(e.pointerId)) return;
  ptrs.set(e.pointerId, e.clientX);
  if (pinch && ptrs.size === 2){
    const [a, b] = [...ptrs.values()]; if (Math.abs(b - a) < 24) return;
    const g = chartGeom(), scale = (pinch.db - pinch.da) / (b - a), start = pinch.da - (a - g.left) * scale;
    setRange(start, start + g.width * scale);
  } else if (ptrs.size === 1){ S.hoverD = dAtX(e.clientX); S.chartsDirty = true; }
});
const endPtr = e => { ptrs.delete(e.pointerId); if (ptrs.size < 2) pinch = null; if (e.pointerType === 'mouse') mdrag = null; };
chartsEl.addEventListener('pointerup', endPtr);
chartsEl.addEventListener('pointercancel', endPtr);
chartsEl.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse'){ S.hoverD = null; mdrag = null; S.chartsDirty = true; } });
chartsEl.addEventListener('wheel', e => {
  e.preventDefault();
  const d = dAtX(e.clientX), [x0, x1] = xRange(), k = e.deltaY > 0 ? 1.25 : 0.8;
  setRange(d - (d - x0) * k, d + (x1 - d) * k);
}, {passive: false});
chartsEl.addEventListener('dblclick', () => { S.xr = null; S.xrUser = false; S.chartsDirty = true; });
function zoomBy(k){
  const [x0, x1] = xRange(), c = S.hoverD ?? (S.live.player && S.live.player.d >= 0 ? S.live.player.d : (x0 + x1) / 2);
  setRange(c - (c - x0) * k, c + (x1 - c) * k);
}
$('zoomIn').onclick = () => zoomBy(0.6);
$('zoomOut').onclick = () => zoomBy(1.6);
$('zoomReset').onclick = () => { S.xr = null; S.xrUser = false; S.hoverD = null; S.chartsDirty = true; };
(() => {
  let start = null;
  $('grip').addEventListener('pointerdown', e => { start = {y: e.clientY, h: $('pane-traces').getBoundingClientRect().height}; e.preventDefault(); });
  addEventListener('pointermove', e => { if (!start) return; const h = clamp(start.h + start.y - e.clientY, 140, innerHeight - 220); $('app').style.setProperty('--traceH', h + 'px'); });
  addEventListener('pointerup', () => { start = null; });
})();

// =====================================================================
// Controls, tabs, loop
// =====================================================================
function setTab(t){
  S.tab = t; store.set('tab', t);
  document.querySelectorAll('.pane').forEach(p => p.classList.toggle('active', p.id === 'pane-' + t));
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === t));
  S.chartsDirty = true; renderCards(); renderSectors();
}
$('tabs').addEventListener('click', e => { const b = e.target.closest('button'); if (b) setTab(b.dataset.tab); });
$('camChips').addEventListener('click', e => { const c = e.target.closest('[data-cam]'); if (c) setCam(c.dataset.cam); });
$('followChips').addEventListener('click', e => { const b = e.target.closest('[data-follow]'); if (b) setFollow(b.dataset.follow); });
$('colorMode').onchange = () => colorTrack();
function toggle(id, key, fn, persist){
  const b = $(id); b.classList.toggle('on', !!S[key]);
  b.onclick = () => { S[key] = !S[key]; b.classList.toggle('on', S[key]); if (persist) store.set(key, S[key]); fn && fn(); };
}
toggle('tLines', 'lines', rebuildLines);
toggle('tLabels', 'labels', updateLabels);
toggle('tMirror', 'mirror', () => {
  if (S.track) buildTrack(S.track.lap);
  rebuildLines(); disposeGroup(crumbRoot);
  for (const r of ROLES) cars[r].userData.init = false;
}, true);
toggle('autoBtn', 'auto', null, true);
toggle('liveBtn', 'showLive', () => { S.chartsDirty = true; });
addEventListener('keydown', e => {
  if (S.view !== 'dash' || ['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
  const n = parseInt(e.key, 10);
  if (n >= 1 && n <= CAMS.length) setCam(CAMS[n - 1]);
  if (e.key === 'Tab'){
    e.preventDefault();
    const vis = ROLES.filter(r => cars[r].visible);
    if (vis.length) setFollow(vis[(vis.indexOf(S.follow) + 1) % vis.length]);
  }
});
function updateFollowChips(){
  document.querySelectorAll('#followChips button').forEach(b => { b.disabled = !cars[b.dataset.follow].visible; });
}
function updateWaiting(){
  const w = $('waiting'); let html = null;
  const connected = S.demo || Conn.state === 'open';
  if (!connected && !S.laps.length) html = '<b>Bridge offline</b>Tap the status button for connection help.';
  else if (!S.track && connected && !Object.keys(S.live).length) html = '<b>No cars on track</b>Start a Time Trial lap with UDP telemetry on.';
  else if (!S.track) html = '<b>Mapping the track…</b>Finish one full lap (or let a ghost finish one) and the 3D track builds itself.';
  w.style.display = html ? 'flex' : 'none';
  if (html && w.firstChild.innerHTML !== html) w.firstChild.innerHTML = html;
}

function resize(){
  const r = view.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return;
  renderer.setSize(r.width, r.height); camera.aspect = r.width / r.height; camera.updateProjectionMatrix();
  S.chartsDirty = true;
}
new ResizeObserver(resize).observe(view);
new ResizeObserver(() => { S.chartsDirty = true; }).observe(chartsEl);
mqDesk.addEventListener('change', () => { setTab(S.tab); updateSessionUI(); });

let lastT = performance.now(), uiT = 0, slowT = 0, crumbT = 0, chartT = 0;
function tick(now){
  requestAnimationFrame(tick);
  const dt = Math.min(.1, (now - lastT) / 1000); lastT = now;
  const mapOn = S.view === 'dash' && paneVisible('map');
  for (const r of ROLES){
    const car = cars[r]; if (!car.visible) continue;
    const ud = car.userData;
    if (!ud.init || car.position.distanceTo(ud.target) > 60){ car.position.copy(ud.target); ud.f.copy(ud.fwd); ud.init = true; }
    else car.position.lerp(ud.target, 1 - Math.exp(-dt * 20));
    ud.f.lerp(ud.fwd, 1 - Math.exp(-dt * 14)).normalize();
    car.lookAt(tmpB.copy(car.position).add(ud.f));
  }
  if (mapOn){
    const fc = followCar();
    for (const r of ROLES){
      const c = cars[r]; if (!c.visible) continue;
      c.userData.label.visible = S.labels && !(['onboard', 'chase'].includes(S.cam) && c === fc) && c.position.distanceTo(camera.position) > 6;
    }
    if (S.hoverD != null && S.track){ marker.visible = true; marker.position.copy(trackPosAt(S.hoverD)).add(new V3(0, .4, 0)); }
    else marker.visible = false;
    updateCamera();
    renderer.render(scene, camera);
  }
  if (now - uiT > 120){
    uiT = now;
    if (S.view === 'dash'){ renderCards(); updateWaiting(); updateFollowChips(); }
    if (!S.track && now - crumbT > 500){ crumbT = now; updateCrumbs(); }
  }
  if (now - slowT > 500){ slowT = now; updatePill(); if (S.view === 'dash') renderSectors(); }
  if (S.view === 'dash' && paneVisible('traces') && S.chartsDirty && (S.hoverD != null || ptrs.size || mdrag || now - chartT > 100)){ chartT = now; drawCharts(); }
}

// ---------- start ----------
buildChips(); setTab(S.tab); setFollow('player'); setCam(S.cam); renderLaps(); updateSessionUI();
$('tMirror').classList.toggle('on', S.mirror);
if (new URLSearchParams(location.search).has('demo')) startDemo(); else Conn.start();
updateDetect(); updatePill();
setInterval(() => { if (S.view === 'detect') updateDetect(); }, 1000);
requestAnimationFrame(tick);
})();
