# Deploying PlanAsBuilt to a VPS (Docker + Cloudflare Tunnel)

The VPS publishes no ports. Cloudflare Tunnel (outbound only) provides public HTTPS, which the PWA install and the barcode/camera scanner require.

## 1. Prepare the VPS (fresh Ubuntu 22.04/24.04)
```bash
sudo apt update && sudo apt -y upgrade
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER && newgrp docker
sudo ufw default deny incoming && sudo ufw allow OpenSSH && sudo ufw enable   # optional; nothing else needed
```

## 2. Clone and configure
```bash
git clone <your-repo-url> planmark && cd planmark
cp .env.example .env
sed -i "s/^JWT_SECRET=.*/JWT_SECRET=$(openssl rand -hex 32)/" .env
sed -i "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$(openssl rand -hex 24)/" .env
nano .env   # paste TUNNEL_TOKEN after step 3
```

## 3. Create the Cloudflare Tunnel
1. Cloudflare dashboard > Zero Trust > Networks > Tunnels > Create a tunnel > Cloudflared.
2. Name it, choose Docker, and copy the token (the long string after `--token`) into `TUNNEL_TOKEN` in `.env`.
3. Public hostname: your domain/subdomain (e.g. `plans.example.com`), Service type HTTP, URL `app:3001`.
WebSockets (`/api/ws`) work through tunnels with no extra setting. Large PDF uploads (up to 200MB) are fine, but Cloudflare's free/pro plans cap request bodies at 100MB; larger files need an Enterprise plan or another route.

## 4. Start
```bash
docker compose up -d --build
docker compose ps          # app should be "healthy"
docker compose logs -f app
```
Open `https://plans.example.com/` and create the first admin on the setup screen (this works only once).

## 5. Backups
The `backup` service runs nightly at `BACKUP_HOUR` (UTC) and writes `backups/db-<ts>.dump` (pg_dump custom format) and `backups/files-<ts>.tar.gz`, pruning files older than `BACKUP_RETENTION_DAYS` (14). Run one now:
```bash
docker compose exec backup /bin/bash /backup.sh once
ls -lh backups
```
Copy `./backups` off the box (rclone, rsync, or a provider snapshot) so a lost VPS does not lose the backups.

## 6. Restore
```bash
deploy/restore.sh backups/db-20260101-030000.dump backups/files-20260101-030000.tar.gz
```
The second argument is optional. The script asks for confirmation, stops the app, restores the DB (`pg_restore --clean`) and files, then restarts everything.

## 7. Update
```bash
git pull && docker compose up -d --build
```
Schema migrations run at app start. Take a backup first for major updates.

## 8. Optional: Cloudflare Access
Zero Trust > Access > Applications > Add a self-hosted application for your hostname, with a policy (e.g. email allow-list). This adds a login in front of the whole app. Note: it will also gate `/api` for any non-browser clients.

## Notes
- The app trusts `X-Forwarded-*` headers (Fastify `trustProxy`); only the tunnel can reach it.
- Auth uses bearer JWTs (no cookies). The server refuses to start in production with a missing/weak `JWT_SECRET`.
- Debugging locally on the VPS: uncomment the `ports: 127.0.0.1:3001:3001` lines under `app`.
- Health: `GET /api/health` returns `{"status":"ok","db":"ok"}`.
