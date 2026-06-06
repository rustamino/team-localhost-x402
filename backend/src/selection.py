"""
Agentic offer selection — picks the "Agent's Pick" from collected offers.

For now this is a placeholder that always selects the first offer (index 0).
The next step wires this to the OpenAI Responses API, passing the user's
natural-language instruction plus the offer list and letting the model return
the winning index (or null when it cannot decide confidently).

See x402_transactions/open-ai-analyzer/agenticOfferSelection.ts for the
reference TypeScript implementation this will mirror.
"""

from dataclasses import dataclass

from .printers import PrinterOffer


@dataclass(frozen=True)
class Selection:
    selected_index: int | None
    confidence: str            # "high" | "medium" | "low"
    reasoning: str


def select_offer(
    offers: list[PrinterOffer],
    instruction: str | None = None,
) -> Selection:
    """Pick the Agent's Pick offer.

    Placeholder behaviour: always returns the first offer. Replaced by an
    OpenAI call in the next step (``instruction`` is accepted now so the call
    site is already correct).
    """
    if not offers:
        return Selection(
            selected_index=None,
            confidence="low",
            reasoning="No printer offers were available.",
        )

    # TODO: replace with OpenAI Responses API call using `instruction`.
    return Selection(
        selected_index=0,
        confidence="medium",
        reasoning="Agent's Pick placeholder: selected the first available offer.",
    )
