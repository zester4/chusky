"""Bounded adaptive endpointing for Flux voice sessions.

Flux already provides semantic turn events. This module does not replace
those events or add another VAD. It only tunes the next turn's Configure
values after enough evidence has accumulated in the current call.

The policy is deliberately conservative:

* it needs several completed turns before changing anything;
* it changes only one bounded step at a time;
* a resumed turn makes the policy more patient;
* a sequence of short, clean turns lets the policy become more responsive;
* it never stores transcript text or provider payloads.
"""
from __future__ import annotations

from dataclasses import dataclass
from math import isfinite
from statistics import mean
from typing import Optional


@dataclass(frozen=True)
class FluxTurnConfig:
    """The subset of Flux Configure values controlled by this policy."""

    eager_eot_threshold: float
    eot_threshold: float
    eot_timeout_ms: int

    def as_payload(self) -> dict[str, float | int]:
        return {
            "eager_eot_threshold": self.eager_eot_threshold,
            "eot_threshold": self.eot_threshold,
            "eot_timeout_ms": self.eot_timeout_ms,
        }


@dataclass(frozen=True)
class _Observation:
    duration_ms: int
    resumed: bool


class AdaptiveTurnPolicy:
    """Tune endpointing from bounded, in-call turn observations.

    The caller should invoke ``start`` on StartOfTurn, ``resumed`` on
    TurnResumed, and ``complete`` on EndOfTurn. ``complete`` returns a new
    Flux configuration only when a meaningful, bounded change is justified.
    """

    def __init__(
        self,
        *,
        eager_eot_threshold: float,
        eot_threshold: float,
        eot_timeout_ms: int,
        enabled: bool = False,
        min_turns: int = 3,
        sample_limit: int = 12,
    ) -> None:
        self.enabled = bool(enabled)
        self.min_turns = max(2, min(int(min_turns), 12))
        self.sample_limit = max(self.min_turns, min(int(sample_limit), 32))
        self._base = self._bounded_config(eager_eot_threshold, eot_threshold, eot_timeout_ms)
        self._current = self._base
        self._started_at: dict[int, float] = {}
        self._resumed: set[int] = set()
        self._observations: list[_Observation] = []
        self._last_emitted: FluxTurnConfig | None = None

    @property
    def current(self) -> FluxTurnConfig:
        return self._current

    @staticmethod
    def _bounded_config(eager: float, eot: float, timeout_ms: int) -> FluxTurnConfig:
        def probability(value: float, fallback: float) -> float:
            try:
                parsed = float(value)
            except (TypeError, ValueError, OverflowError):
                parsed = fallback
            if not isfinite(parsed):
                parsed = fallback
            return round(max(0.3, min(parsed, 0.9)), 3)

        try:
            timeout = int(timeout_ms)
        except (TypeError, ValueError, OverflowError):
            timeout = 800
        return FluxTurnConfig(
            eager_eot_threshold=probability(eager, 0.45),
            eot_threshold=probability(eot, 0.65),
            eot_timeout_ms=max(500, min(timeout, 60_000)),
        )

    def start(self, turn_index: int, now: float) -> None:
        if not isinstance(turn_index, int) or turn_index < 0 or not isfinite(float(now)):
            return
        self._started_at[turn_index] = float(now)
        if len(self._started_at) > 16:
            self._started_at.pop(next(iter(self._started_at)))

    def resumed(self, turn_index: int) -> None:
        if isinstance(turn_index, int) and turn_index >= 0:
            self._resumed.add(turn_index)

    def complete(self, turn_index: int, now: float) -> Optional[FluxTurnConfig]:
        if not self.enabled or not isinstance(turn_index, int) or turn_index < 0 or not isfinite(float(now)):
            return None
        started = self._started_at.pop(turn_index, None)
        resumed = turn_index in self._resumed
        self._resumed.discard(turn_index)
        if started is None:
            return None
        duration_ms = max(0, min(round((float(now) - started) * 1000), 120_000))
        self._observations.append(_Observation(duration_ms=duration_ms, resumed=resumed))
        self._observations = self._observations[-self.sample_limit :]
        if len(self._observations) < self.min_turns:
            return None

        recent = self._observations[-self.min_turns :]
        resumed_count = sum(1 for item in recent if item.resumed)
        average_duration = mean(item.duration_ms for item in recent)
        if resumed_count >= 2:
            target = self._bounded_config(
                self._current.eager_eot_threshold + 0.03,
                self._current.eot_threshold + 0.03,
                self._current.eot_timeout_ms + 150,
            )
        elif resumed_count == 0 and average_duration <= 2_200:
            target = self._bounded_config(
                self._current.eager_eot_threshold - 0.03,
                self._current.eot_threshold - 0.03,
                self._current.eot_timeout_ms - 100,
            )
        else:
            return None

        if target == self._current or target == self._last_emitted:
            return None
        self._current = target
        self._last_emitted = target
        return target
