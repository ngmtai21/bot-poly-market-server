// Control-panel commands, validated on both sides: the admin API rejects
// bad input early, and the bot re-validates before acting — the bot holds
// the key, so it's the real trust boundary even if the web layer is
// compromised.

export interface ConfigPatch {
  minProfitMargin?: number;
  executeMarginThreshold?: number;
  maxOrderSizeUsdc?: number;
  enableTrading?: boolean;
}

export type Command =
  | { type: "set_config"; payload: ConfigPatch }
  | { type: "pause"; payload: Record<string, never> }
  | { type: "resume"; payload: Record<string, never> }
  | { type: "redeem"; payload: { conditionId: string; negRisk: boolean } };

// Hard ceiling on per-trade size settable from the UI — a typo like 50000
// instead of 50 shouldn't be one click away from risking real capital.
export const MAX_ORDER_SIZE_CEILING_USDC = 1000;

const isFraction = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v < 1;

export function validateCommand(type: unknown, payload: unknown): Command {
  const p = (payload ?? {}) as Record<string, unknown>;
  if (typeof p !== "object" || Array.isArray(p)) throw new Error("payload must be an object");

  switch (type) {
    case "pause":
    case "resume":
      return { type, payload: {} };

    case "redeem": {
      if (typeof p.conditionId !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(p.conditionId)) {
        throw new Error("redeem.conditionId must be a 0x-prefixed 32-byte hex string");
      }
      if (typeof p.negRisk !== "boolean") throw new Error("redeem.negRisk must be a boolean");
      return { type, payload: { conditionId: p.conditionId, negRisk: p.negRisk } };
    }

    case "set_config": {
      const patch: ConfigPatch = {};
      if ("minProfitMargin" in p) {
        if (!isFraction(p.minProfitMargin)) throw new Error("minProfitMargin must be a number in [0, 1)");
        patch.minProfitMargin = p.minProfitMargin as number;
      }
      if ("executeMarginThreshold" in p) {
        if (!isFraction(p.executeMarginThreshold)) throw new Error("executeMarginThreshold must be a number in [0, 1)");
        patch.executeMarginThreshold = p.executeMarginThreshold as number;
      }
      if ("maxOrderSizeUsdc" in p) {
        const v = p.maxOrderSizeUsdc;
        if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v > MAX_ORDER_SIZE_CEILING_USDC) {
          throw new Error(`maxOrderSizeUsdc must be a number in (0, ${MAX_ORDER_SIZE_CEILING_USDC}]`);
        }
        patch.maxOrderSizeUsdc = v;
      }
      if ("enableTrading" in p) {
        if (typeof p.enableTrading !== "boolean") throw new Error("enableTrading must be a boolean");
        patch.enableTrading = p.enableTrading;
      }
      if (Object.keys(patch).length === 0) throw new Error("set_config needs at least one field");
      return { type, payload: patch };
    }

    default:
      throw new Error(`unknown command type: ${String(type)}`);
  }
}
