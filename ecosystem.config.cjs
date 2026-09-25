// pm2 deploy config for the two processes (see README "Running").
// Requires .env.bot and .env.admin to already exist in this directory
// (cp env.bot.dist .env.bot / cp env.admin.dist .env.admin, then fill
// them in — see README "Two env files"); each process loads its own file
// explicitly and does not fall back to a shared `.env`.
// Usage:
//   pm2 start ecosystem.config.cjs   # first deploy
//   pm2 reload ecosystem.config.cjs  # apply code/env changes after `git pull`
//   pm2 save                         # persist across VPS reboots
module.exports = {
  apps: [
    {
      name: "polymarket-bot",
      script: "npm",
      args: "run scan",
      cwd: __dirname,
      autorestart: true,
      max_restarts: 20,
      restart_delay: 3000,
    },
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
