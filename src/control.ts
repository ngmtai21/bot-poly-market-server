import type { ClobClient } from "@polymarket/clob-client";
import type { WalletClient } from "viem";
import { config } from "./config.js";
import { type Db, type CommandRow, getKv, setKv, pendingCommands, finishCommand, markRedeemed } from "./db.js";
import { validateCommand, type Command, type ConfigPatch } from "./commands.js";
import { assertTradingReady } from "./preflight.js";
import { redeemPosition, checkPolBalance } from "./redeem.js";
import { logger } from "./logger.js";

// Bot-side half of the admin panel: the admin API only writes commands to
// SQLite; this loop (inside the process that holds the key) reads,
// re-validates, and executes them. Runs in the bot process but off the hot
// path — a tiny synchronous SQLite read per second.

const SETTINGS_KEY = "settings";
// A command queued while the bot was down shouldn't fire on restart hours
// later (e.g. an old "enable trading" click).
const COMMAND_TTL_MS = 60_000;

interface Settings extends Required<ConfigPatch> {
  paused: boolean;
}

function currentSettings(): Settings {
  return {
    minProfitMargin: config.minProfitMargin,
    executeMarginThreshold: config.executeMarginThreshold,
    maxOrderSizeUsdc: config.maxOrderSizeUsdc,
    enableTrading: config.enableTrading,
    paused: config.paused,
  };
}

function restore(s: Settings): void {
  config.minProfitMargin = s.minProfitMargin;
  config.executeMarginThreshold = s.executeMarginThreshold;
  config.maxOrderSizeUsdc = s.maxOrderSizeUsdc;
  config.enableTrading = s.enableTrading;
  config.paused = s.paused;
}

// Settings changed from the admin panel persist across restarts and take
// precedence over .env — logged loudly so an edited .env that "doesn't take
// effect" isn't a mystery.
export function applySavedSettings(db: Db): void {
  const saved = getKv<Settings>(db, SETTINGS_KEY);
  if (saved) {
    restore({ ...currentSettings(), ...saved });
    logger.info("Applied admin-panel settings (these override .env)", saved);
  }

  const addresses = getKv<Record<string, string>>(db, "contractAddresses");
  if (addresses) {
    if (addresses.ctfAdapterAddress) config.ctfAdapterAddress = addresses.ctfAdapterAddress as `0x${string}`;
    if (addresses.negRiskCtfAdapterAddress) config.negRiskCtfAdapterAddress = addresses.negRiskCtfAdapterAddress as `0x${string}`;
    if (addresses.collateralTokenAddress) config.collateralTokenAddress = addresses.collateralTokenAddress as `0x${string}`;
    logger.info("Applied admin-panel contract addresses (these override .env)", addresses);
  }
}

async function applyConfigPatch(client: ClobClient, patch: ConfigPatch): Promise<void> {
  const before = currentSettings();
  if (patch.minProfitMargin !== undefined) config.minProfitMargin = patch.minProfitMargin;
  if (patch.executeMarginThreshold !== undefined) config.executeMarginThreshold = patch.executeMarginThreshold;
  if (patch.maxOrderSizeUsdc !== undefined) config.maxOrderSizeUsdc = patch.maxOrderSizeUsdc;
  if (patch.enableTrading !== undefined) config.enableTrading = patch.enableTrading;

  // Live mode must pass the same balance/allowance check as startup, including
  // when only the order size grew. Any failure rolls the whole patch back.
  try {
    await assertTradingReady(client);
  } catch (err) {
    restore(before);
    throw err;
  }
}

async function runCommand(cmd: Command, db: Db, client: ClobClient, signer: WalletClient): Promise<unknown> {
  switch (cmd.type) {
    case "pause":
    case "resume":
      config.paused = cmd.type === "pause";
      setKv(db, SETTINGS_KEY, currentSettings());
      return currentSettings();

    case "set_config":
      await applyConfigPatch(client, cmd.payload);
      setKv(db, SETTINGS_KEY, currentSettings());
      return currentSettings();

    case "redeem": {
      if (!config.ctfAdapterAddress || !config.negRiskCtfAdapterAddress || !config.collateralTokenAddress) {
        throw new Error("Redeem contract addresses not set in .env — see README 'Claiming winnings'");
      }
      const address = signer.account!.address;
      if ((await checkPolBalance(address)) === 0n) throw new Error("Wallet has 0 POL — redeem needs gas");
      const hash = await redeemPosition(signer, cmd.payload.conditionId as `0x${string}`, cmd.payload.negRisk, {
        ctfAdapterAddress: config.ctfAdapterAddress,
        negRiskCtfAdapterAddress: config.negRiskCtfAdapterAddress,
        collateralTokenAddress: config.collateralTokenAddress,
      });
      markRedeemed(db, cmd.payload.conditionId, hash);
      return { hash };
    }
  }
}

async function processCommand(row: CommandRow, db: Db, client: ClobClient, signer: WalletClient): Promise<void> {
  try {
    if (Date.now() - Date.parse(row.createdAt) > COMMAND_TTL_MS) throw new Error("expired: queued while bot was offline");
    const cmd = validateCommand(row.type, JSON.parse(row.payload));
    const result = await runCommand(cmd, db, client, signer);
    finishCommand(db, row.id, "done", result);
    logger.info(`Admin command ${row.id} (${row.type}) done`, result);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    finishCommand(db, row.id, "failed", { error });
    logger.warn(`Admin command ${row.id} (${row.type}) failed`, error);
  }
}

export function startControlLoop(deps: {
  db: Db;
  client: ClobClient;
  signer: WalletClient;
  status: () => Record<string, unknown>;
}): void {
  const { db, client, signer } = deps;
  let busy = false;

  const writeStatus = () =>
    setKv(db, "status", { ...deps.status(), ...currentSettings(), heartbeat: new Date().toISOString() });
  writeStatus();
  setInterval(writeStatus, 5000);

  setInterval(async () => {
    if (busy) return; // a slow redeem must not overlap the next tick
    busy = true;
    try {
      const rows = pendingCommands(db);
      for (const row of rows) await processCommand(row, db, client, signer);
      if (rows.length) writeStatus(); // so the UI sees the new state right away
    } finally {
      busy = false;
    }
  }, 1000);
}
