# server/mcc_bridge.py
import asyncio
from typing import List, Optional

BRIDGE_VERSION = "0.5.0"

# ---------- Try mcculw (E-1608 AI/AO/DO and optional TCs) ----------
HAVE_MCCULW = False
try:
    from mcculw import ul
    from mcculw.enums import ULRange, DigitalPortType, AnalogInputMode, TempScale as MCCTempScale
    HAVE_MCCULW = True
except Exception as e:
    ul = None  # type: ignore
    HAVE_MCCULW = False
    print(f"[MCCBridge] mcculw import failed: {e}")

# ---------- Try ULDAQ (E-TC preferred path) ----------
HAVE_ULDAQ = False
HAVE_ULDAQ_CFG = False
try:
    import uldaq
    from uldaq import (
        get_daq_device_inventory,
        DaqDevice,
        InterfaceType,
        TempScale,
        TInFlags,
        ThermocoupleType,
    )
    HAVE_ULDAQ = True
    try:
        from uldaq import ConfigItem  # some builds expose this
        HAVE_ULDAQ_CFG = True
    except Exception:
        HAVE_ULDAQ_CFG = False
except Exception as e:
    HAVE_ULDAQ = False
    print(f"[MCCBridge] uldaq import failed: {e}")

# Optional MCC thermocouple enum (not on all installs)
MCCTcType = None
if HAVE_MCCULW:
    try:
        from mcculw.enums import TcType as MCCTcType  # type: ignore
    except Exception:
        MCCTcType = None

from app_models import AppConfig

# ---------- TC type maps ----------
_TC_MAP_ULDAQ = {
    "J": ThermocoupleType.J if HAVE_ULDAQ else None,
    "K": ThermocoupleType.K if HAVE_ULDAQ else None,
    "T": ThermocoupleType.T if HAVE_ULDAQ else None,
    "E": ThermocoupleType.E if HAVE_ULDAQ else None,
    "N": ThermocoupleType.N if HAVE_ULDAQ else None,
    "B": ThermocoupleType.B if HAVE_ULDAQ else None,
    "R": ThermocoupleType.R if HAVE_ULDAQ else None,
    "S": ThermocoupleType.S if HAVE_ULDAQ else None,
}

_TC_MAP_MCC = {
    "J": getattr(MCCTcType, "J", None) if MCCTcType else None,
    "K": getattr(MCCTcType, "K", None) if MCCTcType else None,
    "T": getattr(MCCTcType, "T", None) if MCCTcType else None,
    "E": getattr(MCCTcType, "E", None) if MCCTcType else None,
    "N": getattr(MCCTcType, "N", None) if MCCTcType else None,
    "B": getattr(MCCTcType, "B", None) if MCCTcType else None,
    "R": getattr(MCCTcType, "R", None) if MCCTcType else None,
    "S": getattr(MCCTcType, "S", None) if MCCTcType else None,
}


class AIFrame:
    def __init__(self, vals: List[float]):
        self.vals = vals


class MCCBridge:
    def __init__(self):
        self.cfg: Optional[AppConfig] = None

        # AO/DO soft mirrors for UI snapshots
        self._do_bits = [0] * 8
        self._ao_vals = [0.0, 0.0]
        self._do_active_high = [True] * 8
        self._buzz_tasks = {}

        # E-TC handles
        self._etc_uldaq_dev: Optional[DaqDevice] = None
        self._etc_uldaq_tdev = None
        self._etc_uldaq_ok = False

        self._etc_mcc_board: Optional[int] = None
        self._mcc_can_set_tctype = False
        self._warned_mcc_tctype = False

        # Avoid re-writing TC type every sample
        self._tc_type_set_cache = {}  # ch -> "K"/"J"/...

    # ---------------- Lifecycle ----------------
    def open(self, cfg: AppConfig):
        self.cfg = cfg

        # Configure E-1608 DIO direction and AI mode on mcculw path if available
        if HAVE_MCCULW:
            try:
                # DIO: AUXPORT -> OUT (8 bits)
                ul.d_config_port(cfg.board1608.boardNum, DigitalPortType.AUXPORT, 1)  # 1 == OUT
                print("[MCCBridge] DIO configured AUXPORT -> OUT")
            except Exception as e:
                print(f"[MCCBridge] DIO config warn: {e}")
            try:
                mode = AnalogInputMode.SINGLE_ENDED if str(cfg.board1608.aiMode).upper().startswith("SE") else AnalogInputMode.DIFFERENTIAL
                ul.a_input_mode(cfg.board1608.boardNum, mode)
                print(f"[MCCBridge] AI mode -> {mode.name}")
            except Exception as e:
                print(f"[MCCBridge] AI mode set warn: {e}")

        # Try ULDAQ for E-TC
        self._etc_uldaq_ok = False
        self._etc_uldaq_dev = None
        self._etc_uldaq_tdev = None
        if HAVE_ULDAQ:
            try:
                inv = get_daq_device_inventory(InterfaceType.ETHERNET)
                if not inv:
                    inv = get_daq_device_inventory(InterfaceType.ANY)
                if inv and 0 <= cfg.boardetc.boardNum < len(inv):
                    dev = DaqDevice(inv[cfg.boardetc.boardNum])
                    dev.connect()
                    tdev = dev.get_temp_device()
                    if tdev is not None:
                        self._etc_uldaq_dev = dev
                        self._etc_uldaq_tdev = tdev
                        self._etc_uldaq_ok = True
                        print("[MCCBridge] E-TC via ULDAQ ready")
            except Exception as e:
                print(f"[MCCBridge] ULDAQ E-TC open failed: {e}")

        # Fallback to mcculw for E-TC (cbTIn) if available
        self._etc_mcc_board = None
        self._mcc_can_set_tctype = False
        self._warned_mcc_tctype = False
        if not self._etc_uldaq_ok and HAVE_MCCULW:
            try:
                self._etc_mcc_board = cfg.boardetc.boardNum
                # Probe and also check if set_config(TCTYPE) exists on this install
                try:
                    from mcculw.enums import InfoType, BoardInfo  # type: ignore
                    self._mcc_can_set_tctype = hasattr(BoardInfo, "TCTYPE")
                except Exception:
                    self._mcc_can_set_tctype = False
                # Smoke test read (ignore value)
                _ = ul.t_in(self._etc_mcc_board, 0, MCCTempScale.CELSIUS)
                print("[MCCBridge] E-TC via mcculw ready")
            except Exception as e:
                self._etc_mcc_board = None
                print(f"[MCCBridge] mcculw E-TC open failed: {e}")

    def close(self):
        # Ensure DOs off if you want a safe state (optional):
        # for i in range(8): self.set_do(i, False, active_high=True)
        if self._etc_uldaq_ok and self._etc_uldaq_dev:
            try:
                self._etc_uldaq_dev.disconnect()
            except Exception:
                pass
        self._etc_uldaq_ok = False
        self._etc_uldaq_dev = None
        self._etc_uldaq_tdev = None
        self._etc_mcc_board = None

    # ---------------- Analog Inputs (E-1608) ----------------
    def read_ai_all(self) -> List[float]:
        """Return 8 AI channels in volts (eng units). Simulator only if no driver."""
        if not HAVE_MCCULW:
            # Simulator (only if absolutely no driver)
            import math, time
            t = time.time()
            return [0.5 * math.sin(2 * math.pi * (0.2 + i * 0.07) * t) for i in range(8)]
        vals: List[float] = []
        bd = self.cfg.board1608.boardNum
        rng = ULRange.BIP10VOLTS
        for ch in range(8):
            try:
                raw = ul.a_in(bd, ch, rng)                 # raw counts
                v = ul.to_eng_units(bd, rng, raw)          # volts
            except Exception as e:
                print(f"[MCCBridge] AI ch{ch} read failed: {e}")
                v = float('nan')
            vals.append(v)
        return vals

    # ---------------- Thermocouples (E-TC) ----------------
    def _set_tc_type_if_needed(self, ch: int, typ: str):
        """Best effort per-channel TC type set."""
        t = (typ or "K").upper()
        if self._tc_type_set_cache.get(ch) == t:
            return

        # ULDAQ path (if config API present)
        if self._etc_uldaq_ok and HAVE_ULDAQ and HAVE_ULDAQ_CFG and self._etc_uldaq_dev is not None:
            try:
                tc_enum = _TC_MAP_ULDAQ.get(t)
                if tc_enum is not None:
                    # ConfigItem name varies across builds
                    try:
                        self._etc_uldaq_dev.get_config().set_cfg(ConfigItem.TEMP_SENSOR_TYPE, ch, tc_enum)  # type: ignore
                    except Exception:
                        self._etc_uldaq_dev.get_config().set_cfg(ConfigItem.TEMPERATURE_SENSOR_TYPE, ch, tc_enum)  # type: ignore
                    self._tc_type_set_cache[ch] = t
                    return
            except Exception as e:
                print(f"[MCCBridge] ULDAQ set TC type ch{ch} failed: {e}")

        # mcculw set_config fallback (only if TCTYPE supported on this install)
        if HAVE_MCCULW and self._etc_mcc_board is not None and self._mcc_can_set_tctype:
            try:
                tc_enum = _TC_MAP_MCC.get(t)
                if tc_enum is not None:
                    from mcculw.enums import InfoType, BoardInfo  # type: ignore
                    ul.set_config(InfoType.BOARDINFO, self._etc_mcc_board, ch, BoardInfo.TCTYPE, tc_enum)
                    self._tc_type_set_cache[ch] = t
                    return
            except Exception:
                if not self._warned_mcc_tctype:
                    print("[MCCBridge] MCCULW: cannot set TC type; using InstaCal setting.")
                    self._warned_mcc_tctype = True

    def read_tc_all(self) -> List[float]:
        """Return enabled TC channels (ordered by config.thermocouples). Missing driver -> []."""
        if self.cfg is None:
            return []
        # Build lists from config
        enabled = []
        types = []
        for rec in self.cfg.thermocouples:
            if rec.include:
                enabled.append(int(rec.ch))
                types.append(rec.type or "K")

        if not enabled:
            return []

        # ULDAQ path
        if self._etc_uldaq_ok and self._etc_uldaq_tdev is not None:
            out: List[float] = []
            for i, ch in enumerate(enabled):
                # Set type once if we can
                self._set_tc_type_if_needed(ch, types[i] if i < len(types) else "K")
                try:
                    val = self._etc_uldaq_tdev.t_in(int(ch), TempScale.CELSIUS, TInFlags.DEFAULT)
                    out.append(float(val))
                except Exception as e:
                    print(f"[MCCBridge] ULDAQ t_in ch{ch} failed: {e}")
                    out.append(float('nan'))
            return out

        # mcculw fallback (cbTIn)
        if HAVE_MCCULW and self._etc_mcc_board is not None:
            out: List[float] = []
            for i, ch in enumerate(enabled):
                self._set_tc_type_if_needed(ch, types[i] if i < len(types) else "K")
                try:
                    val = ul.t_in(self._etc_mcc_board, int(ch), MCCTempScale.CELSIUS)
                    out.append(float(val))
                except Exception as e:
                    print(f"[MCCBridge] MCC t_in ch{ch} failed: {e}")
                    out.append(float('nan'))
            return out

        # No driver
        return []

    # ---------------- Digital Outputs (E-1608) ----------------
    def set_do(self, index: int, state: bool, active_high=True):
        assert 0 <= index < 8
        logical = bool(state)
        phys = 1 if (logical == bool(active_high)) else 0
        self._do_bits[index] = 1 if logical else 0
        if HAVE_MCCULW:
            try:
                ul.d_bit_out(self.cfg.board1608.boardNum, DigitalPortType.AUXPORT, index, phys)
            except Exception as e:
                print(f"[MCCBridge] DO ch{index} write failed: {e}")

    # --- DO buzz: one cancellable task per channel; STOP always forces OFF ---
    async def start_buzz(self, index: int, hz: float, active_high: bool = True):
        self._do_active_high[index] = bool(active_high)
        await self.stop_buzz(index)  # cancel any prior
        period = 1.0 / max(0.1, float(hz))

        async def _worker():
            on = False
            try:
                while True:
                    on = not on
                    self.set_do(index, on, active_high=self._do_active_high[index])
                    await asyncio.sleep(period / 2.0)
            except asyncio.CancelledError:
                # guarantee OFF on cancel
                self.set_do(index, False, active_high=self._do_active_high[index])
                raise

        self._buzz_tasks[index] = asyncio.create_task(_worker())

    async def stop_buzz(self, index: int):
        t = self._buzz_tasks.pop(index, None)
        if t:
            t.cancel()
            try:
                await t
            except asyncio.CancelledError:
                pass
            except Exception:
                pass
        # double-ensure OFF in case there was no task
        self.set_do(index, False, active_high=self._do_active_high[index])

    def get_do_snapshot(self):
        return list(self._do_bits)

    # Offline sanity check for E-1608 AO code mapping (±10 V -> 0..65535).
    def to_code(v):
        v = max(-10.0, min(10.0, float(v)))
        return int(round((v + 10.0) * (65535.0 / 20.0)))

    for val in [-12, -10, -5, 0, 5, 10, 12]:
        code = to_code(val)
        print(f"{val:>6.2f} V -> code {code:5d}")

    # Expected:
    #  -10.00 V -> ~0
    #    0.00 V -> ~32768
    #  +10.

    # ---------------- Analog Outputs (E-1608) ----------------
    def _dac_counts(self, volts: float) -> int:
        """Convert volts to 16-bit DAC code for ±10 V range (BIP10V).
        Clamps to [-10.0, +10.0], returns integer in [0, 65535].
        """
        try:
            v = float(volts)
        except Exception:
            v = 0.0
        # Clamp to device range
        if v < -10.0: v = -10.0
        if v > +10.0: v = +10.0

        # Preferred: library conversion (handles calibration)
        if HAVE_MCCULW and (ul is not None):
            try:
                return int(ul.from_eng_units(self.cfg.board1608.boardNum, ULRange.BIP10VOLTS, v))
            except Exception as e:
                print(f"[MCCBridge] from_eng_units failed, using math: {e}")

        # Fallback math: map [-10, +10] -> [0, 65535]
        # LSB ≈ 20 V / 65535 ≈ 0.000305 V
        code = int(round((v + 10.0) * (65535.0 / 20.0)))
        if code < 0: code = 0
        if code > 65535: code = 65535
        return code

    def set_ao(self, index: int, volts: float):
        assert 0 <= index < 2
        # Store the requested voltage for UI echo
        try:
            self._ao_vals[index] = float(volts)
        except Exception:
            self._ao_vals[index] = 0.0

        code = self._dac_counts(volts)  # ALWAYS int [0..65535]

        if HAVE_MCCULW and (ul is not None):
            try:
                # IMPORTANT: Use BIP10VOLTS for E‑1608 (AO is ±10 V)
                ul.a_out(self.cfg.board1608.boardNum, index, ULRange.BIP10VOLTS, int(code))
            except Exception as e:
                print(f"[MCCBridge] AO ch{index} write failed: {e}")
        # If no hardware, snapshot already updated; nothing else to do.

    def get_ao_snapshot(self):
        return list(self._ao_vals)
