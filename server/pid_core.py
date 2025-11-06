# server/pid_core.py
from dataclasses import dataclass
from typing import List, Dict, Optional

@dataclass
class LoopDef:
    enabled: bool
    kind: str           # "analog" | "digital"
    src: str            # "ai" | "tc"
    ai_ch: int
    out_ch: int         # AO idx for analog, DO idx for digital
    target: float
    kp: float
    ki: float
    kd: float
    out_min: Optional[float] = None
    out_max: Optional[float] = None
    err_min: Optional[float] = None
    err_max: Optional[float] = None
    i_min: Optional[float] = None
    i_max: Optional[float] = None
    name: str = ""

class _PID:
    def __init__(self, d: LoopDef):
        self.d = d
        self.i = 0.0
        self.prev = None

    def step(self, pv: float, dt: float) -> float:
        e = self.d.target - pv
        if self.d.err_min is not None: e = max(self.d.err_min, e)
        if self.d.err_max is not None: e = min(self.d.err_max, e)
        p = self.d.kp * e
        self.i += self.d.ki * e * dt
        if self.d.i_min is not None: self.i = max(self.d.i_min, self.i)
        if self.d.i_max is not None: self.i = min(self.d.i_max, self.i)
        d = 0.0
        if self.prev is not None:
            d = self.d.kd * (e - self.prev) / max(1e-6, dt)
        self.prev = e
        u = p + self.i + d
        return u, e

class PIDManager:
    def __init__(self):
        self.loops: List[_PID] = []
        self.meta: List[LoopDef] = []

    def load(self, pid_file):
        self.loops.clear(); self.meta.clear()
        for rec in pid_file.loops:
            d = LoopDef(**rec.dict())
            self.loops.append(_PID(d))
            self.meta.append(d)

    def step(self, ai_vals: List[float], tc_vals: List[float], bridge) -> List[Dict]:
        import time
        dt = 1.0  # approximate; the outer loop is rate-controlled
        tel = []
        for p, d in zip(self.loops, self.meta):
            if not d.enabled: continue
            pv = 0.0
            if d.src == "ai":
                pv = ai_vals[d.ai_ch]
            elif d.src == "tc" and tc_vals:
                pv = tc_vals[min(d.ai_ch, len(tc_vals)-1)]
            u, err = p.step(pv, dt)
            if d.kind == "digital":
                bridge.set_do(d.out_ch, u >= 0.0, active_high=True)
                ov = 1.0 if u >= 0 else 0.0
            else:
                lo = -10.0 if d.out_min is None else d.out_min
                hi =  10.0 if d.out_max is None else d.out_max
                ov = max(lo, min(hi, u))
                bridge.set_ao(d.out_ch, ov)
            tel.append({"name": d.name, "pv": pv, "u": u, "out": ov, "err": err})
        return tel