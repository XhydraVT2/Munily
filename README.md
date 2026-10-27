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
