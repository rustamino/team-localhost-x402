"""
In-memory registry of connected printer servers.

Printers connect via WebSocket at /ws/printer and register with a token.
The registry keeps the live WS connection per printer and exposes a
request/response interface (JSON-RPC over WebSocket) so the rest of the
backend can talk to a printer without knowing its IP address.

Message protocol (printer ↔ backend):

  Printer → Backend on connect:
    {"type": "register", "token": "<token>", "info": {<printer metadata>}}

  Backend → Printer on success:
    {"type": "registered", "proxy_base_url": "https://x402.nb3.me/printer/<id>"}

  Backend → Printer (request):
    {"type": "request", "request_id": "<uuid>",
     "method": "GET|POST", "path": "/pay/…", "headers": {…}, "body": {…}}

  Printer → Backend (response):
    {"type": "response", "request_id": "<uuid>",
     "status": 200|402, "headers": {…}, "body": {…}}
"""

import asyncio
import logging
import uuid
from dataclasses import dataclass, field
from typing import Any

from starlette.websockets import WebSocket

log = logging.getLogger(__name__)


@dataclass
class PrinterConnection:
    printer_id: str
    info: dict[str, Any]
    ws: WebSocket
    _pending: dict[str, asyncio.Future] = field(default_factory=dict, repr=False)

    async def request(
        self,
        method: str,
        path: str,
        body: dict | None = None,
        headers: dict[str, str] | None = None,
        timeout: float = 8.0,
    ) -> dict[str, Any]:
        req_id = str(uuid.uuid4())
        msg: dict[str, Any] = {
            "type": "request",
            "request_id": req_id,
            "method": method,
            "path": path,
        }
        if body is not None:
            msg["body"] = body
        if headers:
            msg["headers"] = headers

        loop = asyncio.get_running_loop()
        future: asyncio.Future[dict] = loop.create_future()
        self._pending[req_id] = future
        try:
            await self.ws.send_json(msg)
            return await asyncio.wait_for(future, timeout=timeout)
        finally:
            self._pending.pop(req_id, None)

    def resolve(self, request_id: str, result: dict[str, Any]) -> bool:
        fut = self._pending.get(request_id)
        if fut and not fut.done():
            fut.set_result(result)
            return True
        return False


class PrinterRegistry:
    def __init__(self) -> None:
        self._printers: dict[str, PrinterConnection] = {}

    def register(self, conn: PrinterConnection) -> None:
        self._printers[conn.printer_id] = conn
        log.info("printer registered: %s", conn.printer_id)

    def unregister(self, printer_id: str) -> None:
        self._printers.pop(printer_id, None)
        log.info("printer unregistered: %s", printer_id)

    def get(self, printer_id: str) -> PrinterConnection | None:
        return self._printers.get(printer_id)

    def all(self) -> list[PrinterConnection]:
        return list(self._printers.values())


registry = PrinterRegistry()
