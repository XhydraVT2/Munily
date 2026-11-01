# Portón

Access control and community management for gated communities and PHs.
Residents, guards and administrators each get their own view. Everything is live on any phone, iPad or computer.

## What's inside

- `public/index.html` the app (installable on iPhone and iPad with Share > Add to Home Screen)
- `api/index.js` one Vercel serverless function: accounts, roles, approvals, visitors, passes, bookings, announcements, chat and panic alerts
- Database: Neon Postgres. The tables are created automatically on the first request.
- The app refreshes every 3 seconds while it is open, so alerts and intercom calls show up on every device.

## Deploy (about 10 minutes)

1. Put this folder in a new GitHub repository.
2. In Vercel, click **Add New > Project** and import the repository. Leave the framework preset on **Other**. Do not deploy yet.
3. In the project, open **Storage**, add **Neon** (Postgres) from the Marketplace and connect it to this project. This adds `DATABASE_URL` for you.
4. Open **Settings > Environment Variables** and add `JWT_SECRET` with a long random value (for example the output of `openssl rand -hex 32`).
5. Click **Deploy**. Open the Vercel URL on your phone and iPad.

Or with the CLI: `npm i -g vercel`, then `vercel` inside this folder, add the Neon storage and `JWT_SECRET` in the dashboard, then `vercel --prod`.

## First use

1. Create an account, then choose **I manage a building**. You get a community code and a 4-digit booth PIN.
2. On another device (or the same one, using **Add role**) create an account, choose **I live here**, enter the code, your name and apartment.
3. The admin sees the request under **Approval requests** and approves it. The resident's screen opens up by itself.
4. Guards choose **I work the gate** and enter the code and PIN.

## Notes

- Permissions are enforced on the server: only admins approve residents, only residents answer their own intercom calls, only guards and admins open the gate.
- Browser notifications work while the app is open. Push notifications while the app is closed need a service worker and web push keys, which is a natural next step.
- Munily's face and license-plate recognition and gate or elevator hardware are not part of this project.

## Premium Hybrid V3 updates

- Distinct Portón One premium styling for desktop and mobile, including glass-like surfaces, refined cards, motion, dark theme, and reduced-motion support.
- Guard console now has a live operations header, queue/alert/entry KPIs, and an instant search for its visible entry log.
- Admin console now has an overview header and instant search of approved residents.
- Existing resident passes, bookings, chat, announcements, visitor approvals, and alert flows are preserved.
- Added `vercel.json` and a separate `public/premium-v3.css` stylesheet.

### Deployment checklist

1. Upload the **contents** of `Munily-main` (not the parent ZIP) to a GitHub repository.
2. Import into Vercel using Framework Preset **Other**, with root directory set to the project folder.
3. Add `DATABASE_URL` from Neon Postgres and a long random `JWT_SECRET` in Vercel environment variables.
4. Deploy; register an admin, then create separate resident and guard accounts to test permissions and real-time updates.
5. For local development, install Node.js 20+, run `npm install`, configure `.env.local`, and use `npx vercel dev` to emulate the serverless API.

**Important:** This release is not a production security audit. Validate access-control logic, authentication, database configuration, rate limits, and privacy obligations before real residential use. The gate actions represent app workflow states, not physical hardware control. iOS/Android store packages are not included.


## V4 changes (2026-11-01)
- Premium hybrid responsive interface, focus states and reduced-motion support.
- Strict resident approval and guard check-in state transitions.
- Atomic QR invitation redemption to prevent concurrent double use.
- Corrected UI terminology: **Check in** logs access; it does not physically open a gate.
- Pass validation requires an approved guard/admin account and checks community, expiry, revocation, and usage.

### Important before production
The app currently uses 3-second polling while the page is active; it does not yet provide native push notifications, a camera-based QR scanner, photographed ID verification, or gate hardware integration. Guard PIN authentication should be strengthened with individual guard invitations, rate limiting, and audit logs before handling real-world visitor IDs. Do not use as a sole physical security control until independently tested and reviewed.
