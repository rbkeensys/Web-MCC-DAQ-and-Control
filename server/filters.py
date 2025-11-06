# server/filters.py
import math

class OnePoleLPFBank:
    def __init__(self):
        self.alpha = []
        self.state = []

    def configure(self, rate_hz: float, cutoff_list):
        dt = 1.0/max(1.0, rate_hz)
        self.alpha = []
        self.state = [None]*len(cutoff_list)
        for fc in cutoff_list:
            if fc and fc > 0:
                a = math.exp(-2.0*math.pi*fc*dt)
            else:
                a = 0.0  # disabled -> pass through
            self.alpha.append(a)

    def apply(self, idx: int, x: float) -> float:
        a = self.alpha[idx] if idx < len(self.alpha) else 0.0
        s = self.state[idx]
        if a == 0.0 or s is None:
            self.state[idx] = x
            return x
        y = a*s + (1.0-a)*x
        self.state[idx] = y
        return y