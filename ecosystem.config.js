/**
 * ecosystem.config.js — PM2 process config for the live server.
 *
 * Runs BOTH Node apps (api + web) detached, with auto-restart on crash and a
 * memory ceiling. Each app loads its own .env (via dotenv) from its folder, so
 * no env is duplicated here.
 *
 * Deploy (from this folder, e.g. /www/wwwroot/tallysaas):
 *   npm install -g pm2                # once
 *   pm2 start ecosystem.config.js     # start api + web
 *   pm2 save                          # remember them across reboots
 *   pm2 startup                       # run the line it prints (systemd hook)
 *
 * Handy:
 *   pm2 status | pm2 logs tallysaas-api | pm2 restart tallysaas-api
 *
 * NOTE: use EITHER pm2 OR the hosting panel's Node manager for a given app —
 * not both, or they fight over the port.
 */
module.exports = {
    apps: [
        {
            name: 'tallysaas-api',
            cwd: './api',
            script: 'index.js',
            instances: 1,
            exec_mode: 'fork',
            autorestart: true,
            max_restarts: 20,
            restart_delay: 3000,       // wait 3s before a restart (avoid tight crash loops)
            watch: false,
            max_memory_restart: '600M',
            env: { NODE_ENV: 'production' },
        },
        {
            name: 'tallysaas-web',
            cwd: './web',
            script: 'index.js',
            instances: 1,
            exec_mode: 'fork',
            autorestart: true,
            max_restarts: 20,
            restart_delay: 3000,
            watch: false,
            max_memory_restart: '400M',
            env: { NODE_ENV: 'production' },
        },
    ],
};
