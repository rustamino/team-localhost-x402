export type PrinterOffer = {
  printer_id: string;
  name: string;

  location: {
    lat: number;
    lon: number;
    city: string;
  };

  capabilities?: {
    materials?: string[];
    max_volume_cm3?: number;
  };

  can_start_at: string;

  payment_url: string;

  payment_required: {
    scheme: "algorand" | string;
    address: string;
    amount: number; // micro-USDC
    asset: number;
    nonce: string;
  };
};

export type OfferSelectionResult =
  | {
      selected_index: number;
      confidence: "high" | "medium";
      reason: string;
    }
  | {
      selected_index: null;
      confidence: "low";
      reason: string;
    };

type SelectBestOfferInput = {
  instruction: string;
  offers: PrinterOffer[];
  openaiApiKey?: string;
  model?: string;
};

function microUsdcToUsdc(amount: number): number {
  return amount / 1_000_000;
}

function buildOfferSummary(offers: PrinterOffer[]) {
  return offers.map((offer, index) => ({
    index,
    printer_id: offer.printer_id,
    name: offer.name,
    city: offer.location.city,
    location: offer.location,
    can_start_at: offer.can_start_at,
    price_usdc: microUsdcToUsdc(offer.payment_required.amount),
    payment_amount_micro_usdc: offer.payment_required.amount,
    payment_asset: offer.payment_required.asset,
    payment_url: offer.payment_url,
    capabilities: offer.capabilities ?? {},
  }));
}

function extractOutputText(responseJson: any): string {
  const outputText =
    responseJson?.output?.[0]?.content?.find?.((c: any) => c.type === "output_text")?.text ??
    responseJson?.output_text;

  if (typeof outputText !== "string") {
    throw new Error("OpenAI response does not contain output text");
  }

  return outputText;
}

export async function selectBestOffer(input: SelectBestOfferInput): Promise<OfferSelectionResult> {
  const apiKey = input.openaiApiKey ?? process.env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not set");
  }

  if (input.offers.length === 0) {
    return {
      selected_index: null,
      confidence: "low",
      reason: "No printer offers were provided.",
    };
  }

  const offersForModel = buildOfferSummary(input.offers);

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: input.model ?? process.env.OPENAI_MODEL ?? "gpt-4.1-mini",
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text:
                "You are an offer-selection agent for a 3D printing marketplace. " +
                "Choose exactly one printer offer if the user's instruction is clear enough. " +
                "Use only the provided offer data. Do not invent missing facts. " +
                "If the instruction cannot be satisfied or the data is insufficient, return selected_index=null. " +
                "Prefer cheaper offers only when the user asks for cheapness or when other criteria are equal. " +
                "Prefer earlier can_start_at when the user asks for speed. " +
                "Prefer matching location when the user mentions a place. " +
                "Never select an offer with a price above a stated budget if the instruction includes one.",
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: JSON.stringify(
                {
                  user_instruction: input.instruction,
                  offers: offersForModel,
                  expected_output:
                    "Return selected_index as one of the provided offer indexes, or null if not confident.",
                },
                null,
                2,
              ),
            },
          ],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "offer_selection_result",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              selected_index: {
                anyOf: [
                  {
                    type: "integer",
                    minimum: 0,
                    maximum: input.offers.length - 1,
                  },
                  {
                    type: "null",
                  },
                ],
              },
              confidence: {
                type: "string",
                enum: ["high", "medium", "low"],
              },
              reason: {
                type: "string",
              },
            },
            required: ["selected_index", "confidence", "reason"],
          },
        },
      },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI API error ${response.status}: ${errorText}`);
  }

  const json = await response.json();
  const outputText = extractOutputText(json);
  const parsed = JSON.parse(outputText) as OfferSelectionResult;

  if (parsed.selected_index !== null && input.offers[parsed.selected_index] === undefined) {
    return {
      selected_index: null,
      confidence: "low",
      reason: `Model returned invalid offer index: ${parsed.selected_index}`,
    };
  }

  return parsed;
}
