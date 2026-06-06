"""
Print job price calculation.

All monetary values are Decimal to avoid float rounding errors.
EUR amounts are rounded to 2 decimal places (display precision).
USDC amounts are rounded to 6 decimal places (on-chain precision).
"""

from dataclasses import dataclass
from decimal import Decimal, ROUND_HALF_UP
from typing import Any

from .config import PriceConfig
from .exchange import RateSnapshot

EUR_PLACES  = Decimal("0.01")
USDC_PLACES = Decimal("0.000001")


@dataclass(frozen=True)
class PriceQuote:
    eur_amount:   Decimal   # e.g. Decimal("2.35")
    usdc_amount:  Decimal   # e.g. Decimal("2.564847")
    eur_per_usd:  Decimal   # rate snapshot used for conversion
    grams:        Decimal
    minutes:      Decimal
    price_config: dict      # snapshot of {price_per_gram, price_per_minute} in EUR

    def to_dict(self) -> dict[str, Any]:
        return {
            "eur_amount":   str(self.eur_amount),
            "usdc_amount":  str(self.usdc_amount),
            "eur_per_usd":  str(self.eur_per_usd),
            "grams":        str(self.grams),
            "minutes":      str(self.minutes),
            "price_config": self.price_config,
        }


def _apply_override(base: PriceConfig, override: dict | None) -> PriceConfig:
    if not override:
        return base
    return PriceConfig(
        price_per_gram=Decimal(str(override.get("price_per_gram", base.price_per_gram))),
        price_per_minute=Decimal(str(override.get("price_per_minute", base.price_per_minute))),
    )


def compute_quote(
    grams: float,
    minutes: float,
    rate: RateSnapshot,
    config: PriceConfig,
    override: dict | None = None,
) -> PriceQuote:
    cfg = _apply_override(config, override)

    g = Decimal(str(grams))
    m = Decimal(str(minutes))

    eur_raw = g * cfg.price_per_gram + m * cfg.price_per_minute
    eur = eur_raw.quantize(EUR_PLACES, rounding=ROUND_HALF_UP)

    usdc_raw = rate.eur_to_usdc(eur)
    usdc = usdc_raw.quantize(USDC_PLACES, rounding=ROUND_HALF_UP)

    return PriceQuote(
        eur_amount=eur,
        usdc_amount=usdc,
        eur_per_usd=rate.eur_per_usd,
        grams=g,
        minutes=m,
        price_config={
            "price_per_gram":   str(cfg.price_per_gram),
            "price_per_minute": str(cfg.price_per_minute),
        },
    )
