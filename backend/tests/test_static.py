import pytest
from fastapi.testclient import TestClient
from src.main import app, FRONTEND_DIR


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


@pytest.mark.skipif(not FRONTEND_DIR.is_dir(), reason="frontend/ not present")
class TestStaticServing:
    def test_root_returns_200(self, client):
        r = client.get("/")
        assert r.status_code == 200

    def test_root_is_html(self, client):
        r = client.get("/")
        assert "text/html" in r.headers["content-type"]

    def test_root_is_index(self, client):
        index_content = (FRONTEND_DIR / "index.html").read_text()
        r = client.get("/")
        assert r.text == index_content

    def test_admin_returns_200(self, client):
        r = client.get("/admin")
        assert r.status_code == 200

    def test_admin_is_html(self, client):
        r = client.get("/admin")
        assert "text/html" in r.headers["content-type"]

    def test_css_served(self, client):
        r = client.get("/style.css")
        assert r.status_code == 200
        assert "text/css" in r.headers["content-type"]
