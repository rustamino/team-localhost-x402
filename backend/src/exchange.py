"""
EUR/USD exchange rate service.

Fetches from open.er-api.com (free, no API key).
Caches the result for `ttl` seconds.
Falls back to the last known rate if the API is unreachable —
never blocks a checkout because of a transient network error.
"""

import time
import urllib.request
import urllib.error
import json
import logging
from dataclasses import dataclass
from decimal import Decimal

log = logging.getLogger(__name__)

RATE_API_URL = "https://open.er-api.com/v6/latest/USD"


@dataclass
class RateSnapshot:
    eur_per_usd: Decimal   # e.g. Decimal("0.9160")  ← how many EUR per 1 USD
    fetched_at: float      # time.monotonic()

    def age(self, now: float | None = None) -> float:
        return (now if now is not None else time.monotonic()) - self.fetched_at

    def usdc_to_eur(self, usdc: Decimal) -> Decimal:
        """Convert USDC (= USD) to EUR."""
        return usdc * self.eur_per_usd

    def eur_to_usdc(self, eur: Decimal) -> Decimal:
        """Convert EUR to USDC (= USD)."""
        return eur / self.eur_per_usd


def _fetch_rate(clock: object) -> RateSnapshot:
    with urllib.request.urlopen(RATE_API_URL, timeout=8) as resp:
        data = json.loads(resp.read())
    eur_per_usd = Decimal(str(data["rates"]["EUR"]))
    return RateSnapshot(eur_per_usd=eur_per_usd, fetched_at=clock())


class ExchangeRateService:
    def __init__(self, ttl: float = 300.0, clock=time.monotonic):
        self._ttl = ttl
        self._clock = clock
        self._cache: RateSnapshot | None = None

    def get(self) -> RateSnapshot:
        now = self._clock()
        if self._cache is not None and self._cache.age(now) < self._ttl:
            return self._cache

        try:
            snapshot = _fetch_rate(self._clock)
            self._cache = snapshot
            log.info("exchange rate updated: 1 USD = %s EUR", snapshot.eur_per_usd)
            return snapshot
        except Exception as exc:
            if self._cache is not None:
                log.warning("rate fetch failed (%s), using cached %s", exc, self._cache.eur_per_usd)
                return self._cache
            raise RuntimeError(f"Exchange rate unavailable and no cached value: {exc}") from exc

    def invalidate(self) -> None:
        self._cache = None
