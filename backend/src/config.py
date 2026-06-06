import os
from dataclasses import dataclass
from decimal import Decimal


def _env(name: str, default: str) -> str:
    return os.environ.get(name, default)


def _required(name: str) -> str:
    v = os.environ.get(name)
    if not v:
        raise RuntimeError(f"Missing required env var: {name}")
    return v


@dataclass(frozen=True)
class PriceConfig:
    price_per_gram: Decimal = Decimal("0.035")    # EUR
    price_per_minute: Decimal = Decimal("0.005")  # EUR

    @classmethod
    def from_env(cls) -> "PriceConfig":
        return cls(
            price_per_gram=Decimal(_env("PRICE_PER_GRAM", "0.035")),
            price_per_minute=Decimal(_env("PRICE_PER_MINUTE", "0.005")),
        )


@dataclass(frozen=True)
class AppConfig:
    port: int
    price: PriceConfig
    x402_url: str
    slicer_url: str
    rate_cache_ttl: float   # seconds

    @classmethod
    def from_env(cls) -> "AppConfig":
        return cls(
            port=int(_env("PORT", "8000")),
            price=PriceConfig.from_env(),
            x402_url=_env("X402_SERVER_URL", "http://localhost:3402"),
            slicer_url=_env("SLICER_URL", "http://localhost:8001"),
            rate_cache_ttl=float(_env("RATE_CACHE_TTL", "300")),
        )
