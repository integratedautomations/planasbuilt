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
nano .env   # paste TUNNEL_TOKEN after step 3, and set PUBLIC_URL=https://plans.example.com (your tunnel hostname, no trailing slash)
```

`PUBLIC_URL` is the address people use in the browser. Invite and password-reset links (returned to the admin and emailed) are built from it, and cross-origin browser access to the API is limited to it. If it is empty the app falls back to the request's `Host` header (never the `Origin` header) and logs a warning at startup, so set it for any internet-facing install. After changing `.env`, recreate the app: `docker compose up -d`.

Optional: set `SETUP_TOKEN` to a secret of your choosing for the first-run setup (below). Leave it empty and the app generates one.

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
Open `https://plans.example.com/` and create the first admin on the setup screen (this works only once). The setup screen asks for a **setup code**, so a stranger who finds the URL first cannot claim the install:
- If `SETUP_TOKEN` is set in `.env`, enter that value.
- Otherwise the app generated one at startup; read it from the log: `docker compose logs app | grep 'First-run setup code'`.

The code is only checked while there are no users; existing installs are unaffected.

## 5. Backups
The `backup` service runs nightly at `BACKUP_HOUR` (UTC) and writes `backups/db-<ts>.dump` (pg_dump custom format) and `backups/files-<ts>.tar.gz`, pruning files older than `BACKUP_RETENTION_DAYS` (14). Run one now:
```bash
docker compose exec backup /bin/bash /backup.sh once
ls -lh backups
```
Backups contain every password hash and all plans, so the script creates `./backups` as mode 700 and each file as mode 600 (owner: root, because the backup container runs as root). Use `sudo` to read or copy them, and run `deploy/restore.sh` with `sudo`. A lost server must not lose the backups, so also set up off-site copies (below).

### Readable files and per-company backups
Files are stored in readable folders under `/data/files` (on Unraid: `/mnt/user/PlanAsBuilt/files`, browse it over SMB):
```
<Company>/_company/logo.png
<Company>/Projects/<Project>/Plans/<Plan>/Rev 01 - 2026-10-21 - <original name>.pdf
<Company>/Projects/<Project>/Photos/<Plan>/<TAG> - <device type>/2026-10-21 1432 - <caption>.jpg   (Untagged/ without a tag)
<Company>/Projects/<Project>/_project/report-logo.png
_users/<email>/avatar.png          _trash/<date-time>/...   (deleted files, purged after the retention period)
```
The database still finds files by id, so renaming a company, project, plan or device tag, or moving a device or a project, is safe: the files follow in the background. Deleted files wait in `_trash/` for **Days to keep deleted files** (Settings > Storage, default 30, 0 = delete at once). Files saved by older versions keep their numbered names until an admin runs **Settings > Storage > Organize files** (Preview, then Organize; it runs in the background and can be left). A project member can also download **Download project folder** on the project page: a zip in the same layout plus a device list (`devices.csv`, `devices.json`).

Each backup target has a scope. **System** targets (platform admin only; every target saved before scopes existed) get the full copy described above. **Company** targets get only that company's own folder (`files/`, synced; replaced or deleted files are kept in `files-deleted/<timestamp>` for the target's retention days) and a database export of its rows (`db/company-export-<timestamp>.json`), so one company's data never lands in another company's backup. For company targets the backup container downloads the export from the app, which needs a shared secret: put the same random value in `.env` for both containers (compose passes it to `app` and `backup`), then recreate them.
```bash
echo "BACKUP_INTERNAL_TOKEN=$(openssl rand -hex 32)" >> .env   # or paste it over the empty BACKUP_INTERNAL_TOKEN= line
docker compose up -d --build app backup
```
The token is accepted only on `GET /api/admin/companies/:id/export`. Company folders on an S3 bucket are not on local disk, so the folder part of a company target skips them (the database export is still copied).

### Off-site copies (rclone)
After each local backup, `backup.sh` copies the new `db-*.dump` and `files-*.tar.gz` to every enabled system target with rclone and deletes remote copies older than that target's retention (default 30 days). Targets: SFTP, S3-compatible, OneDrive, Google Drive, Zoho WorkDrive, each optionally wrapped in rclone `crypt` so the files are encrypted before they leave the server.

1. Generate a key that encrypts the saved passwords/tokens in the database, and add it to `.env` (keep a copy somewhere safe):
   ```bash
   echo "BACKUP_ENCRYPTION_KEY=$(openssl rand -hex 32)" >> .env   # or paste it over the empty BACKUP_ENCRYPTION_KEY= line
   ```
2. Update the stack so the app and backup containers have rclone (the `backup` service now uses `Dockerfile.backup`: postgres + rclone + jq):
   ```bash
   docker compose up -d --build                                  # VPS
   docker compose -f docker-compose.yml -f docker-compose.unraid.yml pull
   docker compose -f docker-compose.yml -f docker-compose.unraid.yml up -d   # Unraid (prebuilt GHCR images)
   ```
3. Sign in as an admin: avatar menu > **Backups** > **Add target**, fill it in, Save, then **Test connection**. **Run backup now** starts a backup within a few seconds. Each target shows its last result; a red banner appears for admins whenever an enabled target's last run failed.

OneDrive, Google Drive and Zoho need a one-time sign-in done on any computer that has [rclone](https://rclone.org/downloads/) installed:
```bash
rclone authorize "onedrive"     # or "drive" (Google Drive) / "zoho"
```
A browser opens; after you sign in, rclone prints a line of JSON (`{"access_token":...}`). Paste it into the Token field. The server never runs an OAuth flow itself. For Google Drive, rclone's shared client is rate-limited; for heavy use create your own OAuth client and run `rclone authorize "drive" "<client_id>" "<client_secret>"`, then enter the same ID and secret under Advanced. Zoho: also pick your data centre (`com`, `eu`, `in`, ...).

How it works: the app stores targets in the database (secrets AES-256-GCM encrypted with `BACKUP_ENCRYPTION_KEY`) and writes `rclone.conf` (mode 600) and `targets.json` to the `rclone` volume shared with the backup service; `backup.sh` writes `status.json` there. The backup service checks every few seconds for a "run now" request, so it also runs a backup on demand. If `BACKUP_ENCRYPTION_KEY` is lost or changed, saved targets must be re-entered. If you enable `crypt`, the passphrase is the only way to read the remote copies: store it separately (rclone can restore with `rclone copy tNNNNNNNNc: ./restore` using the same config). Restoring from off-site: download the `db-*.dump` and `files-*.tar.gz` pair (decrypted if you used crypt) into `./backups` and follow section 6.

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
- The app trusts `X-Forwarded-*` and `CF-Connecting-IP` only from private/loopback peers (the cloudflared container on the docker network), and keys every rate limit (logins, setup, invites, resets) on the real client IP. Anything else that can reach the app's port directly, such as the Unraid LAN port, is treated as a trusted LAN client.
- Only app admins can create projects by default. An admin can tick **Can create projects** for a user under Users. Only app admins can change the shared Revu mappings.
- Invite creation is limited to 30 per hour per user; repeated failed logins for one account lock it for 1, 2, 4... up to 15 minutes.
- Auth uses bearer JWTs (no cookies). The server refuses to start in production with a missing/weak `JWT_SECRET`.
- Debugging locally on the VPS: uncomment the `ports: 127.0.0.1:3001:3001` lines under `app`.
- Health: `GET /api/health` returns `{"status":"ok","db":"ok"}`.
