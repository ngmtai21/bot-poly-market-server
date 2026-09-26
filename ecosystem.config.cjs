// pm2 deploy config for the admin process (see README "Running").
// Requires .env to already exist in this directory
// (cp env.dist .env, then fill it in — see README "Setup").
// The bot process has its own ecosystem.config.cjs in the sibling ../bot repo.
// Usage:
//   pm2 start ecosystem.config.cjs   # first deploy
//   pm2 reload ecosystem.config.cjs  # apply code/env changes after `git pull`
//   pm2 save                         # persist across VPS reboots
module.exports = {
  apps: [
    {
      name: "polymarket-admin",
      script: "npm",
      args: "run admin",
      cwd: __dirname,
      autorestart: true,
      max_restarts: 20,
      restart_delay: 3000,
    },
  ],
};
