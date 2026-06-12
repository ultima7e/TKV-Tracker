# Deploying the Tamakoshi-V Tracker

## One-time setup (done by the project owner — credentials never leave your hands)

1. **Nutstore app password:** Nutstore web → Account → Security →
   "Third-party application management" → generate an app password.
   Note your account email, the app password, and the file's path
   relative to the WebDAV root (e.g. `ProjectData/tracker.xlsx`).
2. **Vercel account:** sign up free at vercel.com (no card needed).
3. Install CLI and deploy from the project root:
   ```bash
   npm i -g vercel
   vercel        # link/create the project, accept defaults
   ```
4. In the Vercel dashboard → Project → Settings → Environment Variables, add:
   - `NUTSTORE_USER` = your Nutstore email
   - `NUTSTORE_PASSWORD` = the app password (mark as Sensitive)
   - `NUTSTORE_FILE_PATH` = e.g. `ProjectData/tracker.xlsx`
5. Redeploy: `vercel --prod`. Open the URL; footer should say
   "Data source: Nutstore".

## Verifying the Nutstore connection (the day-one spike)

Visit `https://<your-app>.vercel.app/api/data` directly:
- JSON with `"source":"nutstore"` → connection works.
- `{"error":"Nutstore responded 401 ..."}` → wrong app password/user.
- `{"error":"Nutstore responded 404 ..."}` → wrong `NUTSTORE_FILE_PATH`.

## Local development

`npm run dev` — uses `data/sample.xlsx`, no credentials needed.
