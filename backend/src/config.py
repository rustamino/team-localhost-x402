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


def _normalize_printer_url(raw: str) -> str:
    url = raw.strip().rstrip("/")
    if not url:
        return ""
    if "://" not in url:
        url = f"http://{url}"
    return url


def _parse_printers(raw: str) -> tuple[str, ...]:
    """Parse the PRINTERS env var: a comma-separated list of printer base URLs.

    Accepts bare ``host:port`` (assumes http) or full ``http://host:port`` URLs.
    Example: ``PRINTERS=http://localhost:5555,192.168.1.42:5556``
    """
    parts = (_normalize_printer_url(p) for p in raw.split(","))
    return tuple(p for p in parts if p)


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
    rate_cache_ttl: float            # seconds
    printers: tuple[str, ...]        # base URLs of registered printer servers
    printer_timeout: float           # seconds, per printer HTTP request
    openai_api_key: str | None       # used later for agentic offer selection
    openai_model: str

    @classmethod
    def from_env(cls) -> "AppConfig":
        return cls(
            port=int(_env("PORT", "8000")),
            price=PriceConfig.from_env(),
            x402_url=_env("X402_SERVER_URL", "http://localhost:3402"),
            slicer_url=_env("SLICER_URL", "http://localhost:8001"),
            rate_cache_ttl=float(_env("RATE_CACHE_TTL", "300")),
            printers=_parse_printers(_env("PRINTERS", "")),
            printer_timeout=float(_env("PRINTER_TIMEOUT", "8")),
            openai_api_key=os.environ.get("OPENAI_API_KEY"),
            openai_model=_env("OPENAI_MODEL", "gpt-4.1-mini"),
        )
