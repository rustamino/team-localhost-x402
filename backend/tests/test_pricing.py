from decimal import Decimal
import pytest
from src.config import PriceConfig
from src.exchange import RateSnapshot, ExchangeRateService
from src.pricing import compute_quote, PriceQuote


RATE_0916 = RateSnapshot(eur_per_usd=Decimal("0.9160"), fetched_at=0.0)
DEFAULT_CFG = PriceConfig()  # 0.035 EUR/g, 0.005 EUR/min


class TestRateSnapshot:
    def test_eur_to_usdc(self):
        # 2.35 EUR / 0.9160 eur_per_usd = 2.565502... USDC
        usdc = RATE_0916.eur_to_usdc(Decimal("2.35"))
        assert float(usdc) == pytest.approx(2.565502, rel=1e-4)

    def test_usdc_to_eur(self):
        eur = RATE_0916.usdc_to_eur(Decimal("2.564847"))
        assert float(eur) == pytest.approx(2.3494, rel=1e-3)

    def test_round_trip_precision(self):
        eur = Decimal("10.00")
        usdc = RATE_0916.eur_to_usdc(eur)
        eur_back = RATE_0916.usdc_to_eur(usdc)
        assert abs(eur_back - eur) < Decimal("0.000001")


class TestComputeQuote:
    def test_basic(self):
        q = compute_quote(50.0, 120.0, RATE_0916, DEFAULT_CFG)
        # EUR: 50*0.035 + 120*0.005 = 1.75 + 0.60 = 2.35
        assert q.eur_amount == Decimal("2.35")
        # USDC: 2.35 / 0.9160 = 2.565502...
        assert q.usdc_amount == Decimal("2.565502")
        assert q.eur_per_usd == Decimal("0.9160")

    def test_rounding_eur(self):
        # 1g * 0.035 + 1min * 0.005 = 0.040 → rounds to 0.04
        q = compute_quote(1.0, 1.0, RATE_0916, DEFAULT_CFG)
        assert q.eur_amount == Decimal("0.04")

    def test_minimum_price(self):
        # 0.01g, 0min → 0.035 * 0.01 = 0.00035 → rounds to 0.00
        # floor is effectively 0.01 EUR when non-zero (handled at API layer)
        q = compute_quote(0.01, 0.0, RATE_0916, DEFAULT_CFG)
        assert q.eur_amount == Decimal("0.00")

    def test_override_per_gram(self):
        q = compute_quote(100.0, 0.0, RATE_0916, DEFAULT_CFG,
                          override={"price_per_gram": "0.020"})
        assert q.eur_amount == Decimal("2.00")
        assert q.price_config["price_per_gram"] == "0.020"
        # per_minute not overridden, stays at default
        assert q.price_config["price_per_minute"] == "0.005"

    def test_override_both(self):
        q = compute_quote(10.0, 60.0, RATE_0916, DEFAULT_CFG,
                          override={"price_per_gram": "0.010", "price_per_minute": "0.002"})
        # 10*0.010 + 60*0.002 = 0.10 + 0.12 = 0.22
        assert q.eur_amount == Decimal("0.22")

    def test_rate_affects_usdc(self):
        rate_parity = RateSnapshot(eur_per_usd=Decimal("1.0000"), fetched_at=0.0)
        q = compute_quote(50.0, 120.0, rate_parity, DEFAULT_CFG)
        assert q.eur_amount == Decimal("2.35")
        assert q.usdc_amount == Decimal("2.350000")  # 1:1

    def test_to_dict(self):
        q = compute_quote(50.0, 120.0, RATE_0916, DEFAULT_CFG)
        d = q.to_dict()
        assert d["eur_amount"] == "2.35"
        assert d["usdc_amount"] == "2.565502"
        assert "price_config" in d

    def test_usdc_6_decimal_places(self):
        q = compute_quote(1.0, 0.0, RATE_0916, DEFAULT_CFG)
        # 0.04 EUR / 0.916 = 0.043668... → 6 places
        assert len(str(q.usdc_amount).split(".")[-1]) == 6


class TestExchangeRateService:
    def test_caches_result(self):
        calls = []
        def fake_fetch(clock):
            calls.append(1)
            return RateSnapshot(eur_per_usd=Decimal("0.92"), fetched_at=clock())

        tick = [0.0]
        def clock():
            return tick[0]

        svc = ExchangeRateService(ttl=60.0, clock=clock)
        # monkey-patch _fetch_rate via module
        import src.exchange as ex
        original = ex._fetch_rate
        ex._fetch_rate = fake_fetch
        try:
            r1 = svc.get()
            r2 = svc.get()
            assert len(calls) == 1          # second call used cache
            assert r1 is r2

            tick[0] = 61.0                  # expire cache
            r3 = svc.get()
            assert len(calls) == 2          # fetched again
            assert r3.eur_per_usd == Decimal("0.92")
        finally:
            ex._fetch_rate = original

    def test_fallback_on_error(self):
        tick = [0.0]
        def clock():
            return tick[0]

        svc = ExchangeRateService(ttl=1.0, clock=clock)
        svc._cache = RateSnapshot(eur_per_usd=Decimal("0.91"), fetched_at=0.0)

        import src.exchange as ex
        original = ex._fetch_rate
        ex._fetch_rate = lambda c: (_ for _ in ()).throw(OSError("network down"))
        try:
            tick[0] = 5.0   # cache expired
            r = svc.get()   # fetch fails → returns stale cache
            assert r.eur_per_usd == Decimal("0.91")
        finally:
            ex._fetch_rate = original

    def test_raises_when_no_cache_and_error(self):
        svc = ExchangeRateService(ttl=60.0)
        import src.exchange as ex
        original = ex._fetch_rate
        ex._fetch_rate = lambda c: (_ for _ in ()).throw(OSError("down"))
        try:
            with pytest.raises(RuntimeError, match="unavailable"):
                svc.get()
        finally:
            ex._fetch_rate = original
