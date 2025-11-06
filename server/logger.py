# server/logger.py
# server/logger.py
import csv
from pathlib import Path

class SessionLogger:
    def __init__(self, folder: Path):
        self.path = folder/"session.csv"
        self.f = open(self.path, "w", newline="")
        self.w = csv.writer(self.f)
        self.w.writerow(["t", *[f"ai{i}" for i in range(8)], "ao0","ao1", *[f"do{i}" for i in range(8)], "tc0","tc1","tc2","tc3","tc4","tc5","tc6","tc7"])

    def write(self, frame: dict):
        ai = frame.get("ai", [None]*8)
        ao = frame.get("ao", [None]*2)
        do = frame.get("do", [None]*8)
        tc = frame.get("tc", []) + [None]*8
        row = [frame.get("t"), *ai[:8], *ao[:2], *do[:8], *tc[:8]]
        self.w.writerow(row)

    def close(self):
        self.f.close()