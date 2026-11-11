/* Ghost Lab demo: a simulated time trial (you, PB ghost, rival ghost) that runs
   entirely in the browser and speaks the same messages as the bridge, so the
   app works on GitHub Pages without a game or a PC. */
"use strict";
window.GhostDemo = class GhostDemo {
  constructor(emit){
    this.emit = emit;
    this.N = 3000;
    this.lapSeq = 0;
    this.packets = 0;
    this.timer = null;
    this.build();
  }

  build(){
    const N = this.N, pts = [];
    for (let i = 0; i < N; i++){
      const u = 2 * Math.PI * i / N;
      const r = 850 + 260 * Math.sin(3 * u) + 110 * Math.cos(5 * u + 1.0) + 60 * Math.sin(7 * u + 0.4);
      pts.push([r * Math.cos(u), 12 * Math.sin(2 * u) + 4 * Math.sin(5 * u), 0.62 * r * Math.sin(u)]);
    }
    const seg = pts.map((p, i) => { const q = pts[(i + 1) % N]; return Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]); });
    const cum = [0];
    for (let i = 0; i < N - 1; i++) cum.push(cum[i] + seg[i]);
    this.L = cum[N - 1] + seg[N - 1];
    const curv = pts.map((b, i) => {
      const a = pts[(i - 3 + N) % N], c = pts[(i + 3) % N];
      const cross = (b[0] - a[0]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[0] - a[0]);
      const la = Math.hypot(a[0] - b[0], a[2] - b[2]), lb = Math.hypot(b[0] - c[0], b[2] - c[2]), lc = Math.hypot(a[0] - c[0], a[2] - c[2]);
      return 2 * cross / Math.max(la * lb * lc, 1e-6);
    });
    const v = curv.map(k => Math.min(92, Math.max(18, Math.sqrt(38 / Math.max(Math.abs(k), 1e-5)))));
    for (let pass = 0; pass < 2; pass++){
      for (let i = 0; i < N; i++){ const j = (i - 1 + N) % N, a = 13 * (1 - v[j] / 100) + 1.5; v[i] = Math.min(v[i], Math.sqrt(v[j] ** 2 + 2 * a * seg[j])); }
      for (let i = N - 1; i >= 0; i--){ const j = (i + 1) % N; v[i] = Math.min(v[i], Math.sqrt(v[j] ** 2 + 2 * 42 * seg[i])); }
    }
    this.acc = v.map((vi, i) => (v[(i + 1) % N] ** 2 - vi ** 2) / (2 * seg[i]));
    Object.assign(this, {pts, cum, v, curv});
  }

  index(s){
    let lo = 0, hi = this.N - 1;
    while (hi - lo > 1){ const m = (lo + hi) >> 1; if (this.cum[m] <= s) lo = m; else hi = m; }
    return lo;
  }

  carState(car){
    const N = this.N, s = car.s, i = this.index(s), p0 = this.pts[i], p1 = this.pts[(i + 1) % N];
    let fx = p1[0] - p0[0], fy = p1[1] - p0[1], fz = p1[2] - p0[2];
    const len = Math.hypot(fx, fy, fz) || 1e-6, u = (s - this.cum[i]) / len;
    fx /= len; fy /= len; fz /= len;
    const off = car.lane + 1.4 * Math.sin(s / 90 + car.phase);
    const x = p0[0] + (p1[0] - p0[0]) * u - fz * off;
    const y = p0[1] + (p1[1] - p0[1]) * u;
    const z = p0[2] + (p1[2] - p0[2]) * u + fx * off;
    const v = this.v[i] * car.k * (1 + 0.012 * Math.sin(s / 170 + car.phase)), a = this.acc[i];
    let thr = 0, brk = 0;
    if (a > 1) thr = Math.min(1, 0.55 + a / 10);
    else if (a < -3) brk = Math.min(1, 0.2 - a / 40);
    else thr = 0.45 + 0.1 * Math.sin(s / 40);
    const kmh = v * 3.6, bands = [0, 90, 125, 160, 195, 230, 265, 295];
    const gear = bands.filter(b => kmh >= b).length, lo = bands[gear - 1], hi = gear < 8 ? bands[gear] : 345;
    const rpm = Math.round(6500 + 5500 * Math.min(1, (kmh - lo) / (hi - lo)));
    const steer = Math.max(-1, Math.min(1, this.curv[i] * 45));
    return {x, y, z, fx, fy, fz, v, kmh, thr, brk, gear, rpm, steer,
            drs: kmh > 280 && thr >= 1 ? 1 : 0, glat: v * v * this.curv[i] / 9.81, glon: a / 9.81};
  }

  newCars(){
    const mk = (k, lane, phase, name, idx) => ({k, lane, phase, name, idx, s: 0, cur: 0, lap: 1, last: 0, s1: 0, s2: 0, buf: [], st: null});
    this.cars = {
      player: mk(0.985, 0, 0, 'Player', 0),
      pb: mk(0.995, 0.6, 1.7, 'Personal Best', 1),
      rival: mk(1.01, -0.7, 3.1, 'Rival Ghost', 2),
    };
    this.laps = [];
  }

  step(dt, live){
    for (const role of ['player', 'pb', 'rival']){
      const c = this.cars[role], st = this.carState(c);
      c.st = st;
      const r3 = n => Math.round(n * 1000) / 1000, r2 = n => Math.round(n * 100) / 100;
      c.buf.push([Math.round(c.cur * 1000), r2(c.s), r2(st.x), r2(st.y), r2(st.z), Math.round(st.kmh),
                  r3(st.thr), r3(st.brk), r3(st.steer), st.gear, st.rpm, st.drs, r3(st.fx), r3(st.fy), r3(st.fz)]);
      c.s += st.v * dt;
      c.cur += dt;
      if (!c.s1 && c.s >= this.L / 3) c.s1 = Math.round(c.cur * 1000);
      if (!c.s2 && c.s >= 2 * this.L / 3) c.s2 = Math.round(c.cur * 1000) - c.s1;
      if (c.s < this.L) continue;

      const over = (c.s - this.L) / st.v, lapMs = Math.round((c.cur - over) * 1000);
      const prev = [...this.laps].reverse().find(l => l.role === role);
      const replay = role !== 'player' && prev && Math.abs(prev.lapTime - lapMs) <= 5;
      let lap = null;
      if (!replay){
        lap = {id: ++this.lapSeq, role, name: c.name, lapTime: lapMs, invalid: false, trackId: -1,
               trackName: 'Demo Circuit', created: Date.now() / 1000, samples: c.buf};
        this.laps.push(lap);
        if (this.laps.length > 30) this.laps.shift();
      }
      Object.assign(c, {last: lapMs, buf: [], s: c.s - this.L, cur: over, s1: 0, s2: 0, lap: c.lap + 1});
      if (role === 'player'){
        c.k = 0.978 + Math.random() * 0.02;
        for (const g of ['pb', 'rival']){
          const gc = this.cars[g];
          Object.assign(gc, {s: c.s, cur: c.cur, s1: 0, s2: 0, buf: [], lap: gc.lap + 1});
        }
      }
      if (live && lap) this.emit({type: 'lap', lap});
      if (live && role === 'player') this.emit({type: 'tt', tt: this.tt()});
    }
  }

  session(){
    return {trackId: -1, trackName: 'Demo Circuit', trackLength: Math.round(this.L), sessionType: 18,
            sessionName: 'Time Trial', timeTrial: true, sector2: Math.round(this.L / 3 * 10) / 10,
            sector3: Math.round(2 * this.L / 3 * 10) / 10, packetFormat: 2026};
  }

  tt(){
    const sectors = lap => {
      const at = d => { const r = lap.samples.find(row => row[1] >= d); return r ? r[0] : lap.lapTime; };
      const a = at(this.L / 3), b = at(2 * this.L / 3);
      return [a, b - a, lap.lapTime - b];
    };
    const set = (lap, idx) => {
      if (!lap) return {carIdx: 255, lapTime: 0, s1: 0, s2: 0, s3: 0};
      const [s1, s2, s3] = sectors(lap);
      return {carIdx: idx, teamId: 0, lapTime: lap.lapTime, s1, s2, s3, valid: 1};
    };
    const latest = role => [...this.laps].reverse().find(l => l.role === role);
    const best = this.laps.filter(l => l.role === 'player').sort((a, b) => a.lapTime - b.lapTime)[0];
    return {sessionBest: set(best, 0), personalBest: set(latest('pb'), 1), rival: set(latest('rival'), 2)};
  }

  status(){
    return {type: 'status',
      bridge: {version: 'demo', demo: true, udpPort: 20777, httpPort: null, lanIp: null},
      telemetry: {packets: this.packets, rate: 180, lastAgo: 0, ignored: 0,
                  sources: [{ip: 'simulated', format: 2026, game: 'F1 26', packets: this.packets, ago: 0}]},
      session: this.session(), cars: {player: true, pb: true, rival: true}, laps: this.laps.length};
  }

  frame(){
    const cars = {};
    for (const role of ['player', 'pb', 'rival']){
      const c = this.cars[role], st = c.st || this.carState(c);
      cars[role] = {x: st.x, y: st.y, z: st.z, fx: st.fx, fy: st.fy, fz: st.fz, speed: Math.round(st.kmh),
        throttle: st.thr, brake: st.brk, steer: st.steer, gear: st.gear, rpm: st.rpm, drs: st.drs,
        d: c.s, lapNum: c.lap, sector: c.s < this.L / 3 ? 0 : c.s < 2 * this.L / 3 ? 1 : 2, invalid: 0,
        curLap: Math.round(c.cur * 1000), lastLap: c.last, s1: c.s1, s2: c.s2,
        gLat: st.glat, gLon: st.glon, idx: c.idx, name: c.name};
    }
    return {type: 'frame', cars};
  }

  start(){
    // Pre-record one lap of each car so the track and traces appear straight away.
    this.newCars();
    for (let n = 0; n < 60 * 90 && !this.laps.some(l => l.role === 'player'); n++) this.step(1 / 60, false);
    this.emit({type: 'hello', fields: ['t', 'd', 'x', 'y', 'z', 'speed', 'throttle', 'brake', 'steer', 'gear', 'rpm', 'drs', 'fx', 'fy', 'fz'],
               session: this.session(), tt: this.tt(), laps: [...this.laps], status: this.status()});
    let last = performance.now(), acc = 0, fAcc = 0, sAcc = 1;
    this.timer = setInterval(() => {
      const now = performance.now(), el = Math.min(1, (now - last) / 1000);
      last = now;
      acc += el;
      for (let n = 0; acc >= 1 / 60 && n < 90; n++){ this.step(1 / 60, true); acc -= 1 / 60; this.packets += 3; }
      acc = Math.min(acc, 1 / 60);
      fAcc += el; if (fAcc >= 1 / 30){ fAcc = 0; this.emit(this.frame()); }
      sAcc += el; if (sAcc >= 1){ sAcc = 0; this.emit(this.status()); }
    }, 1000 / 60);
  }

  stop(){
    clearInterval(this.timer);
    this.timer = null;
  }
};
