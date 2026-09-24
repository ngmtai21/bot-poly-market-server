import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  { ignores: ["dist", "node_modules", "web"] },
  {
    // The admin process is web-facing and must never hold the wallet key or
    // sign anything — it may only use the shared db/commands modules.
    files: ["src/admin/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "**/config*",
                "**/signer*",
                "**/redeem*",
                "**/executor*",
                "**/preflight*",
                "**/control*",
                "**/scan*",
                "dotenv/config",
                "viem*",
                "@polymarket/*",
              ],
              message: "admin/ must not import key-handling or trading modules — go through db.ts/commands.ts.",
            },
          ],
        },
      ],
    },
  },
);
