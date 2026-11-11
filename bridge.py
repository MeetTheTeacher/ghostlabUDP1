#!/usr/bin/env python3
"""
Ghost Lab bridge - F1 26 / F1 25 UDP telemetry for your phone and browser.

The game sends telemetry as UDP packets, which browsers can't receive. This
small server runs on a PC on the same network as your PC/console and phone:

  * receives the game's packets on UDP 20777
  * picks out you, your personal-best ghost and the rival ghost
  * saves every complete lap as a CSV in ./laps
  * serves the Ghost Lab web app and streams live data to it (one port, 8000)

Standard library only - nothing to pip install. Python 3.9+.

    python bridge.py              # listen for the game
    python bridge.py --demo       # no game handy? stream a simulated time trial

Then open the address it prints - on your phone, use the "On your phone" one.
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import csv
import hashlib
import json
import math
import mimetypes
import os
import random
import socket
import struct
import sys
import time
import urllib.parse
import webbrowser

VERSION = "2.0"
HERE = os.path.dirname(os.path.abspath(__file__))

# --------------------------------------------------------------------------
# Packet layouts (F1 23 / 24 / 25 / 26 share the 29-byte header)
# --------------------------------------------------------------------------
NUM_CARS = 22
HEADER = struct.Struct("<HBBBBBQfIIBB")   # packetFormat ... secondaryPlayerCarIndex
MOTION = struct.Struct("<6f6h6f")         # CarMotionData, 60 bytes
TELEM_HEAD = struct.Struct("<H3fBbHB")    # first 19 bytes of CarTelemetryData
TT_SET = struct.Struct("<BBIIIIBBBBBB")   # TimeTrialDataSet, 24 bytes

PKT_MOTION, PKT_SESSION, PKT_LAP = 0, 1, 2
PKT_PARTICIPANTS, PKT_TELEMETRY, PKT_TIMETRIAL = 4, 6, 14

FIELDS = ["t", "d", "x", "y", "z", "speed", "throttle", "brake", "steer",
          "gear", "rpm", "drs", "fx", "fy", "fz"]
LIVE_KEYS = ["x", "y", "z", "fx", "fy", "fz", "speed", "throttle", "brake",
             "steer", "gear", "rpm", "drs", "d", "lapNum", "sector", "invalid",
             "curLap", "lastLap", "s1", "s2", "gLat", "gLon"]
ROLES = ("player", "pb", "rival")
ROLE_LABEL = {"player": "You", "pb": "Personal best", "rival": "Rival"}

TRACKS = {
    0: "Melbourne", 1: "Paul Ricard", 2: "Shanghai", 3: "Sakhir", 4: "Catalunya",
    5: "Monaco", 6: "Montreal", 7: "Silverstone", 8: "Hockenheim", 9: "Hungaroring",
    10: "Spa", 11: "Monza", 12: "Singapore", 13: "Suzuka", 14: "Abu Dhabi",
    15: "Texas", 16: "Brazil", 17: "Austria", 18: "Sochi", 19: "Mexico", 20: "Baku",
    21: "Sakhir Short", 22: "Silverstone Short", 23: "Texas Short", 24: "Suzuka Short",
    25: "Hanoi", 26: "Zandvoort", 27: "Imola", 28: "Portimao", 29: "Jeddah",
    30: "Miami", 31: "Las Vegas", 32: "Losail", 39: "Silverstone (Reverse)",
    40: "Austria (Reverse)", 41: "Zandvoort (Reverse)", 127: "Demo Circuit",
}
SESSIONS_24 = {0: "Unknown", 1: "Practice 1", 2: "Practice 2", 3: "Practice 3", 4: "Short Practice",
               5: "Qualifying 1", 6: "Qualifying 2", 7: "Qualifying 3", 8: "Short Qualifying",
               9: "One-Shot Qualifying", 10: "Sprint Shootout 1", 11: "Sprint Shootout 2",
               12: "Sprint Shootout 3", 13: "Short Sprint Shootout", 14: "One-Shot Sprint Shootout",
               15: "Race", 16: "Race 2", 17: "Race 3", 18: "Time Trial"}
SESSIONS_23 = {0: "Unknown", 1: "Practice 1", 2: "Practice 2", 3: "Practice 3", 4: "Short Practice",
               5: "Qualifying 1", 6: "Qualifying 2", 7: "Qualifying 3", 8: "Short Qualifying",
               9: "One-Shot Qualifying", 10: "Race", 11: "Race 2", 12: "Race 3", 13: "Time Trial"}
GAMES = {2023: "F1 23", 2024: "F1 24", 2025: "F1 25", 2026: "F1 26"}


def track_name(tid):
    if tid is None or tid < 0:
        return ""
    return TRACKS.get(tid, f"Track {tid}")


def game_name(fmt):
    return GAMES.get(fmt, f"F1 ({fmt})")


def fmt_lap(ms):
    m, s = divmod(ms / 1000, 60)
    return f"{int(m)}:{s:06.3f}"


# --------------------------------------------------------------------------
# Telemetry state
# --------------------------------------------------------------------------
class State:
    def __init__(self, laps_dir: str, info: dict, max_laps: int = 60):
        self.laps_dir = laps_dir
        self.info = info
        self.max_laps = max_laps
        os.makedirs(laps_dir, exist_ok=True)
        self.session_uid = None
        self.packet_format = None
        self.player_idx = 0
        self.pb_idx = 255
        self.rival_idx = 255
        self.cars = [dict() for _ in range(NUM_CARS)]
        self.session: dict = {}
        self.tt = None
        self.names = [""] * NUM_CARS
        self.laps: list = []
        self.lap_seq = 0
        self.outbox: list = []
        self.frame_dirty = False
        # detection / health
        self.packets = 0
        self.sources: dict = {}
        self.last_packet = None
        self.ignored = 0
        self.ignored_format = None
        self.rate = 0
        self._rate_count = 0
        self._rate_t = time.time()
        self._reset_roles()

    def _reset_roles(self):
        self.buf = {r: [] for r in ROLES}
        self.prev = {r: None for r in ROLES}
        self.role_idx = {r: None for r in ROLES}
        self.lap_invalid = {r: False for r in ROLES}
        self.lap_start = {r: None for r in ROLES}
        self.prev_sector = None

    def reset_session(self, uid):
        self.session_uid = uid
        self.cars = [dict() for _ in range(NUM_CARS)]
        self.session = {}
        self.tt = None
        self.laps = []
        self.pb_idx = self.rival_idx = 255
        self._reset_roles()
        self.outbox.append({"type": "reset"})

    def role_index(self, role):
        idx = {"player": self.player_idx, "pb": self.pb_idx, "rival": self.rival_idx}[role]
        return idx if idx < NUM_CARS else None

    # ---- entry point ------------------------------------------------------
    def handle(self, data: bytes, ip: str = "?"):
        if len(data) < HEADER.size:
            return
        (fmt, _yr, _maj, _min, _pv, pid, uid, stime, _fr, _ofr, pidx, _sidx) = HEADER.unpack_from(data, 0)
        now = time.time()
        src = self.sources.setdefault(ip, {"packets": 0})
        src.update(format=fmt, last=now, packets=src["packets"] + 1)
        self.last_packet = now
        self._rate_count += 1
        if fmt < 2023 or fmt > 2100:
            self.ignored += 1
            self.ignored_format = fmt
            return
        self.packets += 1
        self.packet_format = fmt
        if uid and uid != self.session_uid:
            self.reset_session(uid)
        if pidx < NUM_CARS:
            self.player_idx = pidx
        b = HEADER.size
        try:
            if pid == PKT_MOTION:
                self._motion(data, b)
            elif pid == PKT_LAP:
                self._lap(data, b, fmt)
            elif pid == PKT_TELEMETRY:
                self._telemetry(data, b, stime)
            elif pid == PKT_SESSION:
                self._session(data, b, fmt)
            elif pid == PKT_PARTICIPANTS:
                self._participants(data, b)
            elif pid == PKT_TIMETRIAL:
                self._timetrial(data, b)
        except struct.error:
            pass  # truncated or unexpected layout - skip this packet

    # ---- packet parsers ---------------------------------------------------
    def _motion(self, data, b):
        if len(data) < b + MOTION.size * NUM_CARS:
            return
        for i in range(NUM_CARS):
            v = MOTION.unpack_from(data, b + i * MOTION.size)
            c = self.cars[i]
            c["x"], c["y"], c["z"] = v[0], v[1], v[2]
            c["fx"], c["fy"], c["fz"] = v[6] / 32767, v[7] / 32767, v[8] / 32767
            c["gLat"], c["gLon"] = v[12], v[13]

    def _lap(self, data, b, fmt):
        stride = (len(data) - b - 2) // NUM_CARS
        if stride < 36:
            return
        dist_off, pos_off = (20, 32) if fmt >= 2024 else (18, 30)   # F1 23 lacks two minute bytes
        for i in range(NUM_CARS):
            o = b + i * stride
            last, cur = struct.unpack_from("<II", data, o)
            s1ms, s1m, s2ms, s2m = struct.unpack_from("<HBHB", data, o + 8)
            dist, = struct.unpack_from("<f", data, o + dist_off)
            _pos, lapnum, _pit, _npit, sector, invalid = struct.unpack_from("<6B", data, o + pos_off)
            self.cars[i].update(lastLap=last, curLap=cur, s1=s1m * 60000 + s1ms,
                                s2=s2m * 60000 + s2ms, d=dist, lapNum=lapnum,
                                sector=sector, invalid=invalid)
        self.pb_idx, self.rival_idx = data[-2], data[-1]

    def _telemetry(self, data, b, stime):
        stride = (len(data) - b - 3) // NUM_CARS
        if stride < TELEM_HEAD.size:
            return
        for i in range(NUM_CARS):
            sp, thr, steer, brk, _cl, gear, rpm, drs = TELEM_HEAD.unpack_from(data, b + i * stride)
            self.cars[i].update(speed=sp, throttle=thr, steer=steer, brake=brk,
                                gear=gear, rpm=rpm, drs=drs)
        self._sample(stime)

    def _session(self, data, b, fmt):
        _w, _tt, _at, _tl, tlen, stype, tid = struct.unpack_from("<BbbBHBb", data, b)
        s2, s3 = struct.unpack_from("<ff", data, len(data) - 8)
        ok = 0 < s2 < s3 < tlen
        names = SESSIONS_24 if fmt >= 2024 else SESSIONS_23
        new = {"trackId": tid, "trackName": track_name(tid), "trackLength": tlen,
               "sessionType": stype, "sessionName": names.get(stype, f"Session {stype}"),
               "timeTrial": stype == (18 if fmt >= 2024 else 13),
               "sector2": round(s2, 1) if ok else self.session.get("sector2"),
               "sector3": round(s3, 1) if ok else self.session.get("sector3"),
               "packetFormat": fmt}
        if new != self.session:
            self.session = new
            self.outbox.append({"type": "session", "session": new})

    def _participants(self, data, b):
        stride = (len(data) - b - 1) // NUM_CARS
        if stride < 39:
            return
        for i in range(NUM_CARS):
            o = b + 1 + i * stride
            self.names[i] = data[o + 7:o + 39].split(b"\0")[0].decode("utf-8", "replace")

    def _timetrial(self, data, b):
        keys = ("carIdx", "teamId", "lapTime", "s1", "s2", "s3", "tractionControl",
                "gearbox", "abs", "equalPerformance", "customSetup", "valid")
        sets = [dict(zip(keys, TT_SET.unpack_from(data, b + k * TT_SET.size))) for k in range(3)]
        tt = {"sessionBest": sets[0], "personalBest": sets[1], "rival": sets[2]}
        if tt != self.tt:
            self.tt = tt
            self.outbox.append({"type": "tt", "tt": tt})

    # ---- lap recording ----------------------------------------------------
    def _sample(self, stime):
        L = self.session.get("trackLength") or 0
        for role in ROLES:
            idx = self.role_index(role)
            if idx != self.role_idx[role]:          # ghost swapped or vanished
                self.role_idx[role] = idx
                self.buf[role] = []
                self.prev[role] = None
                self.lap_invalid[role] = False
                self.lap_start[role] = None
            if idx is None:
                continue
            c = self.cars[idx]
            if "x" not in c or "d" not in c or "speed" not in c:
                continue
            d, lapnum = c["d"], c["lapNum"]
            prev = self.prev[role]
            if prev is not None:
                back = prev[1] - d
                if lapnum != prev[0] or back > max(L * 0.5, 500):
                    self._finish_lap(role, idx)
                elif back > 20:                        # flashback / restart: lap is broken
                    self.buf[role] = []
                    self.lap_start[role] = None
            self.prev[role] = (lapnum, d)
            if role == "player":
                self._learn_sectors(c)
            if d < 0:
                continue                                # still before the line
            if self.lap_start[role] is None:
                self.lap_start[role] = stime
            t = c.get("curLap") or round((stime - self.lap_start[role]) * 1000)
            self.buf[role].append([
                int(t), round(d, 2), round(c["x"], 2), round(c["y"], 2), round(c["z"], 2),
                c["speed"], round(c["throttle"], 3), round(c["brake"], 3), round(c["steer"], 3),
                c["gear"], c["rpm"], c["drs"],
                round(c["fx"], 3), round(c["fy"], 3), round(c["fz"], 3)])
            if c.get("invalid"):
                self.lap_invalid[role] = True
        self.frame_dirty = True

    def _learn_sectors(self, c):
        """Fallback for formats whose session packet has no sector distances."""
        sec = c.get("sector")
        if self.prev_sector is not None and sec != self.prev_sector and c["d"] > 0:
            key = {1: "sector2", 2: "sector3"}.get(sec)
            if key and not self.session.get(key):
                self.session = dict(self.session, **{key: round(c["d"], 1)})
                self.outbox.append({"type": "session", "session": self.session})
        self.prev_sector = sec

    def _finish_lap(self, role, idx):
        buf, invalid = self.buf[role], self.lap_invalid[role]
        self.buf[role], self.lap_invalid[role], self.lap_start[role] = [], False, None
        if len(buf) < 120:
            return
        L = self.session.get("trackLength") or buf[-1][1]
        if buf[0][1] > 150 or buf[-1][1] < L - 150:
            return                                      # did not cover the whole lap
        last = buf[-1]
        est = last[0] + (L - last[1]) / max(last[5] / 3.6, 1) * 1000
        exact = None
        if role == "player":
            exact = self.cars[idx].get("lastLap")
        elif self.tt:
            exact = self.tt["personalBest" if role == "pb" else "rival"]["lapTime"]
        lap_time = int(exact) if exact and abs(exact - est) < 400 else int(est)
        if role != "player":                            # ghosts replay the same lap every time
            prev = next((l for l in reversed(self.laps) if l["role"] == role), None)
            if prev and abs(prev["lapTime"] - lap_time) <= 5:
                return
        self.lap_seq += 1
        lap = {"id": self.lap_seq, "role": role,
               "name": self.names[idx] or ROLE_LABEL[role],
               "lapTime": lap_time, "invalid": invalid,
               "trackId": self.session.get("trackId"),
               "trackName": self.session.get("trackName", ""),
               "created": time.time(), "samples": buf}
        self.laps.append(lap)
        del self.laps[:-self.max_laps]
        self.outbox.append({"type": "lap", "lap": lap})
        self._save(lap)
        print(f"  lap recorded: {ROLE_LABEL[role]:<13} {fmt_lap(lap_time)}{'  (invalid)' if invalid else ''}")

    def _save(self, lap):
        slug = (lap["trackName"] or "track").lower().replace(" ", "-").replace("(", "").replace(")", "")
        stamp = fmt_lap(lap["lapTime"]).replace(":", "-").replace(".", "-")
        path = os.path.join(self.laps_dir, f"{slug}_{lap['role']}_{stamp}_{int(lap['created'])}.csv")
        meta = {k: lap[k] for k in ("role", "name", "lapTime", "invalid", "trackId", "trackName")}
        try:
            with open(path, "w", newline="", encoding="utf-8") as f:
                f.write("# " + ",".join(f"{k}={str(v).replace(',', ' ')}" for k, v in meta.items()) + "\n")
                w = csv.writer(f)
                w.writerow(FIELDS)
                w.writerows(lap["samples"])
        except OSError as e:
            print(f"  could not save lap: {e}")

    # ---- outgoing messages ------------------------------------------------
    def tick_rate(self, now):
        span = now - self._rate_t
        if span >= 0.5:
            self.rate = round(self._rate_count / span)
            self._rate_count, self._rate_t = 0, now

    def status(self):
        now = time.time()
        sources = sorted(self.sources.items(), key=lambda kv: -kv[1]["last"])[:4]
        cars = {}
        for role in ROLES:
            idx = self.role_index(role)
            cars[role] = idx is not None and "x" in self.cars[idx] and "d" in self.cars[idx]
        return {
            "type": "status",
            "bridge": self.info,
            "telemetry": {
                "packets": self.packets, "rate": self.rate,
                "lastAgo": round(now - self.last_packet, 1) if self.last_packet else None,
                "sources": [{"ip": ip, "format": s["format"], "game": game_name(s["format"]),
                             "packets": s["packets"], "ago": round(now - s["last"], 1)} for ip, s in sources],
                "ignored": self.ignored, "ignoredFormat": self.ignored_format,
            },
            "session": self.session, "cars": cars, "laps": len(self.laps),
        }

    def hello(self):
        """Initial snapshot: per car, the latest lap and the fastest lap (keeps phones light)."""
        pick = []
        for role in ROLES:
            mine = [l for l in self.laps if l["role"] == role]
            if mine:
                pick.append(mine[-1])
                best = min(mine, key=lambda l: (l["invalid"], l["lapTime"]))
                if best is not mine[-1]:
                    pick.append(best)
        pick.sort(key=lambda l: l["id"])
        return {"type": "hello", "fields": FIELDS, "session": self.session, "tt": self.tt,
                "laps": pick, "status": self.status()}

    def drain(self):
        out, self.outbox = self.outbox, []
        if self.frame_dirty:
            self.frame_dirty = False
            cars = {}
            for role in ROLES:
                idx = self.role_index(role)
                if idx is None or "x" not in self.cars[idx]:
                    continue
                c = self.cars[idx]
                live = {k: c.get(k) for k in LIVE_KEYS}
                live["idx"] = idx
                live["name"] = self.names[idx]
                cars[role] = live
            out.append({"type": "frame", "cars": cars})
        return out


# --------------------------------------------------------------------------
# Demo mode: a simulated time trial that emits real F1-format packets
# --------------------------------------------------------------------------
class Demo:
    N = 3000

    def __init__(self):
        self.uid = random.getrandbits(62) or 1
        self.frame = 0
        self.stime = 0.0
        self._build_track()
        self.cars = {
            0: {"s": 0.0, "k": 0.985, "lane": 0.0, "phase": 0.0},      # you
            1: {"s": 0.0, "k": 0.995, "lane": 0.6, "phase": 1.7},      # PB ghost
            2: {"s": 0.0, "k": 1.010, "lane": -0.7, "phase": 3.1},     # rival ghost
        }
        for c in self.cars.values():
            c.update(lap=1, cur=0.0, last=0, s1=0, s2=0, best=0)

    def _build_track(self):
        N = self.N
        pts = []
        for i in range(N):
            u = 2 * math.pi * i / N
            r = 850 + 260 * math.sin(3 * u) + 110 * math.cos(5 * u + 1.0) + 60 * math.sin(7 * u + 0.4)
            pts.append((r * math.cos(u), 12 * math.sin(2 * u) + 4 * math.sin(5 * u), 0.62 * r * math.sin(u)))
        seg = [math.dist(pts[i], pts[(i + 1) % N]) for i in range(N)]
        cum = [0.0]
        for i in range(N - 1):
            cum.append(cum[-1] + seg[i])
        self.L = cum[-1] + seg[-1]
        curv = []
        for i in range(N):
            a, b, c = pts[i - 3], pts[i], pts[(i + 3) % N]
            ax, az, bx, bz, cx, cz = a[0], a[2], b[0], b[2], c[0], c[2]
            cross = (bx - ax) * (cz - az) - (bz - az) * (cx - ax)
            la, lb, lc = math.dist((ax, az), (bx, bz)), math.dist((bx, bz), (cx, cz)), math.dist((ax, az), (cx, cz))
            curv.append(2 * cross / max(la * lb * lc, 1e-6))
        v = [min(92.0, max(18.0, math.sqrt(38 / max(abs(k), 1e-5)))) for k in curv]
        for _ in range(2):
            for i in range(N):
                j = i - 1
                a = 13 * (1 - v[j] / 100) + 1.5
                v[i] = min(v[i], math.sqrt(v[j] ** 2 + 2 * a * seg[j]))
            for i in reversed(range(N)):
                j = (i + 1) % N
                v[i] = min(v[i], math.sqrt(v[j] ** 2 + 2 * 42 * seg[i]))
        acc = [(v[(i + 1) % N] ** 2 - v[i] ** 2) / (2 * seg[i]) for i in range(N)]
        t = [0.0]
        for i in range(N - 1):
            t.append(t[-1] + seg[i] / ((v[i] + v[i + 1]) / 2))
        self.base_time = t[-1] + seg[-1] / v[-1]
        self.t_at = lambda s: self._interp(t, s)
        self.pts, self.cum, self.v, self.acc, self.curv = pts, cum, v, acc, curv

    def _index(self, s):
        lo, hi = 0, self.N - 1
        while hi - lo > 1:
            m = (lo + hi) // 2
            if self.cum[m] <= s:
                lo = m
            else:
                hi = m
        return lo

    def _interp(self, arr, s):
        i = self._index(s)
        j = min(i + 1, self.N - 1)
        span = (self.cum[j] - self.cum[i]) or 1
        u = min(1.0, max(0.0, (s - self.cum[i]) / span))
        return arr[i] + (arr[j] - arr[i]) * u

    def _state(self, car):
        s = car["s"]
        i = self._index(s)
        p0, p1 = self.pts[i], self.pts[(i + 1) % self.N]
        u = (s - self.cum[i]) / max(math.dist(p0, p1), 1e-6)
        fx, fy, fz = p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]
        n = math.sqrt(fx * fx + fy * fy + fz * fz) or 1
        fx, fy, fz = fx / n, fy / n, fz / n
        off = car["lane"] + 1.4 * math.sin(s / 90 + car["phase"])
        x = p0[0] + (p1[0] - p0[0]) * u - fz * off
        y = p0[1] + (p1[1] - p0[1]) * u
        z = p0[2] + (p1[2] - p0[2]) * u + fx * off
        mod = car["k"] * (1 + 0.012 * math.sin(s / 170 + car["phase"]))
        v = self.v[i] * mod
        a = self.acc[i]
        if a > 1.0:
            thr, brk = min(1.0, 0.55 + a / 10), 0.0
        elif a < -3.0:
            thr, brk = 0.0, min(1.0, 0.2 - a / 40)
        else:
            thr, brk = 0.45 + 0.1 * math.sin(s / 40), 0.0
        kmh = v * 3.6
        bands = [0, 90, 125, 160, 195, 230, 265, 295]
        gear = sum(1 for b in bands if kmh >= b)
        lo = bands[gear - 1]
        hi = bands[gear] if gear < 8 else 345
        rpm = int(6500 + 5500 * min(1.0, (kmh - lo) / (hi - lo)))
        steer = max(-1.0, min(1.0, self.curv[i] * 45))
        return dict(x=x, y=y, z=z, fx=fx, fy=fy, fz=fz, v=v, kmh=kmh, thr=thr, brk=brk,
                    gear=gear, rpm=rpm, steer=steer, drs=1 if kmh > 280 and thr >= 1 else 0,
                    glat=v * v * self.curv[i] / 9.81, glon=a / 9.81)

    def step(self, dt):
        self.stime += dt
        self.frame += 1
        for idx, car in self.cars.items():
            st = self._state(car)
            car["s"] += st["v"] * dt
            car["cur"] += dt
            for key, frac in (("s1", 1 / 3), ("s2", 2 / 3)):
                if not car[key] and car["s"] >= self.L * frac:
                    car[key] = int(car["cur"] * 1000) - (car["s1"] if key == "s2" else 0)
            if car["s"] >= self.L:
                car["s"] -= self.L
                car["last"] = int(car["cur"] * 1000)
                car["cur"], car["s1"], car["s2"] = 0.0, 0, 0
                car["lap"] += 1
                if idx == 0:
                    if not car["best"] or car["last"] < car["best"]:
                        car["best"] = car["last"]
                    car["k"] = 0.978 + random.random() * 0.02
                    for g in (1, 2):                    # ghosts restart with you
                        gc = self.cars[g]
                        gc.update(s=0.0, cur=0.0, s1=0, s2=0, lap=gc["lap"] + 1)

    def _hdr(self, pid):
        return HEADER.pack(2026, 26, 1, 0, 1, pid, self.uid, self.stime, self.frame, self.frame, 0, 255)

    def packets(self):
        states = {i: self._state(c) for i, c in self.cars.items()}
        motion = bytearray(MOTION.size * NUM_CARS)
        lap = bytearray(57 * NUM_CARS + 2)
        tel = bytearray(60 * NUM_CARS + 3)
        for i, st in states.items():
            car = self.cars[i]
            MOTION.pack_into(motion, i * MOTION.size, st["x"], st["y"], st["z"],
                             st["fx"] * st["v"], st["fy"] * st["v"], st["fz"] * st["v"],
                             int(st["fx"] * 32767), int(st["fy"] * 32767), int(st["fz"] * 32767),
                             int(-st["fz"] * 32767), 0, int(st["fx"] * 32767),
                             st["glat"], st["glon"], 0.0, math.atan2(st["fx"], st["fz"]), 0.0, 0.0)
            o = i * 57
            s1, s2 = car["s1"], car["s2"]
            struct.pack_into("<II", lap, o, car["last"], int(car["cur"] * 1000))
            struct.pack_into("<HBHB", lap, o + 8, s1 % 60000, s1 // 60000, s2 % 60000, s2 // 60000)
            struct.pack_into("<fff", lap, o + 20, car["s"], car["s"] + (car["lap"] - 1) * self.L, 0.0)
            sector = 0 if car["s"] < self.L / 3 else (1 if car["s"] < 2 * self.L / 3 else 2)
            struct.pack_into("<6B", lap, o + 32, i + 1, car["lap"] % 256, 0, 0, sector, 0)
            TELEM_HEAD.pack_into(tel, i * 60, int(st["kmh"]), st["thr"], st["steer"], st["brk"],
                                 0, st["gear"], st["rpm"], st["drs"])
        lap[-2], lap[-1] = 1, 2
        out = [self._hdr(PKT_MOTION) + bytes(motion), self._hdr(PKT_LAP) + bytes(lap),
               self._hdr(PKT_TELEMETRY) + bytes(tel)]
        if self.frame % 30 == 1:
            sess = bytearray(720)
            struct.pack_into("<BbbBHBb", sess, 0, 0, 32, 24, 1, int(self.L), 18, 127)
            struct.pack_into("<ff", sess, len(sess) - 8, self.L / 3, 2 * self.L / 3)
            out.append(self._hdr(PKT_SESSION) + bytes(sess))
        if self.frame % 120 == 1:
            part = bytearray(1 + 57 * NUM_CARS)
            part[0] = 3
            for i, name in enumerate(("Player", "Personal Best", "Rival Ghost")):
                part[1 + i * 57 + 7:1 + i * 57 + 7 + len(name)] = name.encode()
            out.append(self._hdr(PKT_PARTICIPANTS) + bytes(part))
        if self.frame % 60 == 1:
            def tt(idx, lap_ms):
                s1 = int(self.t_at(self.L / 3) / self.base_time * lap_ms)
                s2 = int(self.t_at(2 * self.L / 3) / self.base_time * lap_ms) - s1
                return TT_SET.pack(idx, 0, lap_ms, s1, s2, lap_ms - s1 - s2, 0, 0, 0, 1, 0, 1)
            best = self.cars[0]["best"] or int(self.base_time / 0.99 * 1000)
            body = (tt(0, best) + tt(1, int(self.base_time / self.cars[1]["k"] * 1000))
                    + tt(2, int(self.base_time / self.cars[2]["k"] * 1000)))
            out.append(self._hdr(PKT_TIMETRIAL) + body)
        return out


async def run_demo(state: State, speed: float = 1.0):
    demo = Demo()
    dt = 1 / 60
    print(f"  demo circuit: {demo.L / 1000:.2f} km, ~{demo.base_time:.1f}s per lap")
    nxt = time.perf_counter()
    while True:
        demo.step(dt)
        for pkt in demo.packets():
            state.handle(pkt, "simulated")
        nxt += dt / speed
        await asyncio.sleep(max(0.0, nxt - time.perf_counter()))


# --------------------------------------------------------------------------
# Web server: static files + WebSocket on one port (standard library only)
# --------------------------------------------------------------------------
WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
TYPES = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
         ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
         ".webmanifest": "application/manifest+json", ".json": "application/json",
         ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8", ".csv": "text/csv; charset=utf-8"}


def ws_frame(payload: bytes, opcode: int = 1) -> bytes:
    n = len(payload)
    if n < 126:
        head = struct.pack("!BB", 0x80 | opcode, n)
    elif n < 65536:
        head = struct.pack("!BBH", 0x80 | opcode, 126, n)
    else:
        head = struct.pack("!BBQ", 0x80 | opcode, 127, n)
    return head + payload


async def ws_read(reader):
    b1, b2 = await reader.readexactly(2)
    op, n = b1 & 0x0F, b2 & 0x7F
    if n == 126:
        n, = struct.unpack("!H", await reader.readexactly(2))
    elif n == 127:
        n, = struct.unpack("!Q", await reader.readexactly(8))
    if n > 1 << 20:
        raise ConnectionError("frame too large")
    mask = await reader.readexactly(4) if b2 & 0x80 else b"\0\0\0\0"
    data = bytearray(await reader.readexactly(n))
    for i in range(n):
        data[i] ^= mask[i & 3]
    return op, bytes(data)


class Hub:
    def __init__(self, state: State, web_dir: str):
        self.state = state
        self.web_dir = os.path.realpath(web_dir)
        self.clients = set()

    async def handle(self, reader, writer):
        try:
            try:
                head = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 15)
            except (asyncio.IncompleteReadError, asyncio.LimitOverrunError, asyncio.TimeoutError, ConnectionError):
                return
            lines = head.decode("latin-1").split("\r\n")
            parts = lines[0].split(" ")
            if len(parts) < 2:
                return
            method, target = parts[0].upper(), parts[1]
            headers = {}
            for line in lines[1:]:
                if ":" in line:
                    k, v = line.split(":", 1)
                    headers[k.strip().lower()] = v.strip()
            path = urllib.parse.urlsplit(target).path
            if path == "/ws" and "websocket" in headers.get("upgrade", "").lower():
                await self.websocket(reader, writer, headers)
            else:
                await self.static(writer, method, path)
        except (ConnectionError, OSError):
            pass
        finally:
            try:
                writer.close()
            except Exception:
                pass

    async def reply(self, writer, code, body: bytes, ctype, head_only=False):
        reason = {200: "OK", 400: "Bad Request", 404: "Not Found", 405: "Method Not Allowed"}.get(code, "OK")
        hdr = (f"HTTP/1.1 {code} {reason}\r\nContent-Type: {ctype}\r\nContent-Length: {len(body)}\r\n"
               "Cache-Control: no-cache\r\nConnection: close\r\n\r\n")
        writer.write(hdr.encode() + (b"" if head_only else body))
        await writer.drain()

    async def static(self, writer, method, path):
        if method not in ("GET", "HEAD"):
            return await self.reply(writer, 405, b"Method not allowed", "text/plain")
        rel = urllib.parse.unquote(path).lstrip("/")
        full = os.path.realpath(os.path.join(self.web_dir, rel))
        if os.path.isdir(full):
            full = os.path.join(full, "index.html")
        if not full.startswith(self.web_dir + os.sep) or not os.path.isfile(full):
            return await self.reply(writer, 404, b"Not found", "text/plain")
        ext = os.path.splitext(full)[1].lower()
        ctype = TYPES.get(ext) or mimetypes.guess_type(full)[0] or "application/octet-stream"
        with open(full, "rb") as f:
            body = f.read()
        await self.reply(writer, 200, body, ctype, head_only=method == "HEAD")

    async def websocket(self, reader, writer, headers):
        key = headers.get("sec-websocket-key")
        if not key:
            return await self.reply(writer, 400, b"Bad request", "text/plain")
        accept = base64.b64encode(hashlib.sha1((key + WS_GUID).encode()).digest()).decode()
        writer.write(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                      f"Sec-WebSocket-Accept: {accept}\r\n\r\n").encode())
        sock = writer.get_extra_info("socket")
        if sock is not None:
            try:
                sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            except OSError:
                pass
        peer = (writer.get_extra_info("peername") or ["?"])[0]
        print(f"  app connected: {peer}")
        self.clients.add(writer)
        try:
            writer.write(ws_frame(json.dumps(self.state.hello(), separators=(",", ":")).encode()))
            await writer.drain()
            while True:
                op, data = await ws_read(reader)
                if op == 8:                      # close
                    writer.write(ws_frame(data[:2], 8))
                    break
                if op == 9:                      # ping
                    writer.write(ws_frame(data, 10))
        except (asyncio.IncompleteReadError, ConnectionError, OSError):
            pass
        finally:
            self.clients.discard(writer)
            print(f"  app disconnected: {peer}")

    def broadcast(self, msgs):
        if not self.clients or not msgs:
            return
        for m in msgs:
            frame = ws_frame(json.dumps(m, separators=(",", ":")).encode())
            droppable = m.get("type") == "frame"
            for w in list(self.clients):
                if w.is_closing():
                    self.clients.discard(w)
                    continue
                if droppable and w.transport.get_write_buffer_size() > 256_000:
                    continue                      # slow phone: skip a live frame, never a lap
                try:
                    w.write(frame)
                except Exception:
                    self.clients.discard(w)


class UDPReceiver(asyncio.DatagramProtocol):
    def __init__(self, state: State, forward):
        self.state = state
        self.forward = forward
        self.transport = None

    def connection_made(self, transport):
        self.transport = transport

    def datagram_received(self, data, addr):
        self.state.handle(data, addr[0])
        for target in self.forward:
            self.transport.sendto(data, target)


def local_ip():
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))
            return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"


async def main_async(args):
    web_dir = os.path.join(HERE, "web")
    if not os.path.isfile(os.path.join(web_dir, "index.html")):
        sys.exit(f"Can't find the web app at {web_dir} - keep bridge.py next to the 'web' folder.")
    lan = local_ip()
    info = {"version": VERSION, "udpPort": args.port, "httpPort": args.http_port,
            "lanIp": lan, "demo": bool(args.demo)}
    state = State(args.laps, info)
    hub = Hub(state, web_dir)
    await asyncio.start_server(hub.handle, args.bind, args.http_port)

    loop = asyncio.get_running_loop()
    if args.demo:
        asyncio.ensure_future(run_demo(state, args.demo_speed))
    else:
        forward = []
        for f in args.forward or []:
            host, port = f.rsplit(":", 1)
            forward.append((host, int(port)))
        await loop.create_datagram_endpoint(lambda: UDPReceiver(state, forward),
                                            local_addr=(args.host, args.port))

    print(f"\nGhost Lab bridge {VERSION}")
    print(f"  on this PC:     http://localhost:{args.http_port}")
    print(f"  on your phone:  http://{lan}:{args.http_port}   (same Wi-Fi)")
    if args.demo:
        print("  telemetry:      simulated time trial (--demo)")
    else:
        print(f"  telemetry:      listening on UDP {args.port}")
        print(f"                  game on this PC -> UDP IP 127.0.0.1 | console -> UDP IP {lan}")
    print(f"  laps saved to:  {os.path.abspath(args.laps)}\n")
    if not args.no_browser:
        try:
            webbrowser.open(f"http://localhost:{args.http_port}")
        except Exception:
            pass

    last_status = 0.0
    last_hint = time.time()
    while True:
        await asyncio.sleep(1 / 30)
        hub.broadcast(state.drain())
        now = time.time()
        if now - last_status >= 1:
            last_status = now
            state.tick_rate(now)
            hub.broadcast([state.status()])
        if not args.demo and state.packets == 0 and now - last_hint > 20:
            last_hint = now
            if state.ignored:
                print(f"  ...packets arriving in format {state.ignored_format} - set UDP Format to 2026 (or 2025)")
            else:
                print("  ...no telemetry yet - check the game's UDP settings and your firewall")


def main():
    p = argparse.ArgumentParser(description="Ghost Lab bridge for F1 26 / F1 25 UDP telemetry")
    p.add_argument("--port", type=int, default=20777, help="game UDP port (default 20777)")
    p.add_argument("--host", default="0.0.0.0", help="address to receive UDP on (default all)")
    p.add_argument("--http-port", type=int, default=8000, help="port for the web app (default 8000)")
    p.add_argument("--bind", default="0.0.0.0", help="address the web app listens on (default all)")
    p.add_argument("--laps", default=os.path.join(HERE, "laps"), help="folder for saved lap CSVs")
    p.add_argument("--forward", action="append", metavar="HOST:PORT",
                   help="also forward raw packets to another app, e.g. SimHub (repeatable)")
    p.add_argument("--no-browser", action="store_true", help="don't open the app on this PC")
    p.add_argument("--demo", action="store_true", help="stream a simulated time trial")
    p.add_argument("--demo-speed", type=float, default=1.0, help="demo playback speed")
    args = p.parse_args()
    try:
        asyncio.run(main_async(args))
    except KeyboardInterrupt:
        print("\nbye")
    except OSError as e:
        sys.exit(f"Could not open a port: {e}\nIs another telemetry app (or another bridge) already "
                 "using it? Close it, or use --port / --http-port / --forward.")


if __name__ == "__main__":
    main()
