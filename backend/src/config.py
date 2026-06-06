import os
from dataclasses import dataclass
from decimal import Decimal

try:
    from dotenv import load_dotenv

    load_dotenv()  # load backend/.env into os.environ if present
except ImportError:  # python-dotenv not installed — rely on real env vars
    pass


def _env(name: str, default: str) -> str:
    return os.environ.get(name, default)


def _required(name: str) -> str:
    v = os.environ.get(name)
    if not v:
        raise RuntimeError(f"Missing required env var: {name}")
    return v


def _parse_tokens(raw: str) -> frozenset[str]:
    """Parse PRINTER_TOKENS: comma-separated SHA-256 hex strings."""
    return frozenset(t.strip() for t in raw.split(",") if t.strip())


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
    rate_cache_ttl: float
    printer_tokens: frozenset[str]   # allowed registration tokens
    printer_timeout: float           # seconds, per printer WS request
    public_base_url: str             # externally reachable URL of this backend
    openai_api_key: str | None
    openai_model: str
    marketplace_wallet: str          # Algorand address that receives user payments
    marketplace_fee_pct: Decimal     # commission kept by marketplace (0 = passthrough)

    @classmethod
    def from_env(cls) -> "AppConfig":
        return cls(
            port=int(_env("PORT", "8000")),
            price=PriceConfig.from_env(),
            x402_url=_env("X402_SERVER_URL", "http://localhost:3402"),
            slicer_url=_env("SLICER_URL", "http://localhost:8001"),
            rate_cache_ttl=float(_env("RATE_CACHE_TTL", "300")),
            printer_tokens=_parse_tokens(_env("PRINTER_TOKENS", "")),
            printer_timeout=float(_env("PRINTER_TIMEOUT", "8")),
            public_base_url=_env("PUBLIC_BASE_URL", "https://x402.nb3.me"),
            openai_api_key=os.environ.get("OPENAI_API_KEY"),
            openai_model=_env("OPENAI_MODEL", "gpt-4.1-mini"),
            marketplace_wallet=_env("MARKETPLACE_WALLET", ""),
            marketplace_fee_pct=Decimal(_env("MARKETPLACE_FEE_PCT", "0")),
        )
