"""
Agentic offer selection — picks the "Agent's Pick" from collected offers.

This is a 1:1 Python port of
``x402_transactions/open-ai-analyzer/agenticOfferSelection.ts``: it sends the
user's natural-language instruction plus the offer list to the OpenAI Responses
API and lets the model return the winning index (or ``None`` when it cannot
decide confidently). The request body, JSON schema and parsing logic mirror the
TypeScript ``selectBestOffer`` exactly so both code paths behave identically.
"""

import json
import os
from dataclasses import dataclass
from typing import Any

import httpx

from .printers import PrinterOffer

MICRO_USDC = 1_000_000

_SYSTEM_PROMPT = (
    "You are an offer-selection agent for a 3D printing marketplace. "
    "Choose exactly one printer offer if the user's instruction is clear enough. "
    "Use only the provided offer data. Do not invent missing facts. "
    "If the instruction cannot be satisfied or the data is insufficient, return selected_index=null. "
    "Prefer cheaper offers only when the user asks for cheapness or when other criteria are equal. "
    "Prefer earlier can_start_at when the user asks for speed. "
    "Prefer matching location when the user mentions a place. "
    "Never select an offer with a price above a stated budget if the instruction includes one."
)


@dataclass(frozen=True)
class Selection:
    selected_index: int | None
    confidence: str            # "high" | "medium" | "low"
    reasoning: str


def _micro_usdc_to_usdc(amount: int) -> float:
    return amount / MICRO_USDC


def _build_offer_summary(offers: list[PrinterOffer]) -> list[dict[str, Any]]:
    """Project offers into the compact shape the model reasons over.

    Mirrors ``buildOfferSummary`` in the TS reference.
    """
    return [
        {
            "index": index,
            "printer_id": offer.printer_id,
            "name": offer.name,
            "city": offer.location.get("city"),
            "location": offer.location,
            "can_start_at": offer.can_start_at,
            "price_usdc": _micro_usdc_to_usdc(offer.payment.amount),
            "payment_amount_micro_usdc": offer.payment.amount,
            "payment_asset": offer.payment.asset,
            "payment_url": offer.payment_url,
            "capabilities": offer.capabilities or {},
        }
        for index, offer in enumerate(offers)
    ]


def _extract_output_text(response_json: dict[str, Any]) -> str:
    """Pull the model's text output out of a Responses API payload.

    Mirrors ``extractOutputText`` in the TS reference.
    """
    output_text: Any = None

    output = response_json.get("output")
    if isinstance(output, list) and output:
        content = output[0].get("content")
        if isinstance(content, list):
            for chunk in content:
                if isinstance(chunk, dict) and chunk.get("type") == "output_text":
                    output_text = chunk.get("text")
                    break

    if output_text is None:
        output_text = response_json.get("output_text")

    if not isinstance(output_text, str):
        raise ValueError("OpenAI response does not contain output text")

    return output_text


async def select_offer(
    offers: list[PrinterOffer],
    instruction: str | None = None,
    openai_api_key: str | None = None,
    model: str | None = None,
) -> Selection:
    """Pick the Agent's Pick offer via the OpenAI Responses API.

    Python port of ``selectBestOffer``. ``instruction`` is the user's
    natural-language request; ``offers`` is the list of collected printer
    offers. Returns the chosen index plus the model's confidence and reasoning,
    or ``selected_index=None`` when no confident pick is possible.
    """
    api_key = openai_api_key or os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY is not set")

    if not offers:
        return Selection(
            selected_index=None,
            confidence="low",
            reasoning="No printer offers were provided.",
        )

    offers_for_model = _build_offer_summary(offers)
    chosen_model = model or os.environ.get("OPENAI_MODEL") or "gpt-4.1-mini"

    request_body = {
        "model": chosen_model,
        "input": [
            {
                "role": "system",
                "content": [
                    {
                        "type": "input_text",
                        "text": _SYSTEM_PROMPT,
                    }
                ],
            },
            {
                "role": "user",
                "content": [
                    {
                        "type": "input_text",
                        "text": json.dumps(
                            {
                                "user_instruction": instruction,
                                "offers": offers_for_model,
                                "expected_output": (
                                    "Return selected_index as one of the provided "
                                    "offer indexes, or null if not confident."
                                ),
                            },
                            indent=2,
                        ),
                    }
                ],
            },
        ],
        "text": {
            "format": {
                "type": "json_schema",
                "name": "offer_selection_result",
                "strict": True,
                "schema": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "selected_index": {
                            "anyOf": [
                                {
                                    "type": "integer",
                                    "minimum": 0,
                                    "maximum": len(offers) - 1,
                                },
                                {"type": "null"},
                            ]
                        },
                        "confidence": {
                            "type": "string",
                            "enum": ["high", "medium", "low"],
                        },
                        "reason": {"type": "string"},
                    },
                    "required": ["selected_index", "confidence", "reason"],
                },
            }
        },
    }

    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.post(
            "https://api.openai.com/v1/responses",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json=request_body,
        )

    if response.status_code != 200:
        raise RuntimeError(
            f"OpenAI API error {response.status_code}: {response.text}"
        )

    output_text = _extract_output_text(response.json())
    print("OpenAI response output text:", output_text)

    parsed = json.loads(output_text)

    selected_index = parsed.get("selected_index")
    if selected_index is not None and not (0 <= selected_index < len(offers)):
        return Selection(
            selected_index=None,
            confidence="low",
            reasoning=f"Model returned invalid offer index: {selected_index}",
        )

    return Selection(
        selected_index=selected_index,
        confidence=parsed.get("confidence", "low"),
        reasoning=parsed.get("reason", ""),
    )
