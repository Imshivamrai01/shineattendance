# Shine Attendance

Dynamic workforce attendance platform: Next.js (App Router) + MongoDB. MongoDB is the source of truth; Google Sheets is a one-way reporting copy.

## Setup

```bash
npm install
cp .env.example .env.local      # then edit MONGODB_URI and the admin values
npm run seed:admin              # creates the initial admin (idempotent)
npm run dev
```

Sign in at `/login` with `ADMIN_EMAIL` / `ADMIN_INITIAL_PASSWORD`. You are forced to change the password on first login.
`.env.local` is git-ignored. Never commit real credentials.

> Don't run `npm run build` while `npm run dev` is running: both use the `.next` folder and the pages get stuck on a blank/unstyled "Loading" screen. If that happens, stop the server, delete `.next`, and start `npm run dev` again.

## Roles

ADMIN > MANAGER > HR > EMPLOYEE. Nothing is seeded except the admin; add everyone else in the app (or `/users/import`).

| Action | Admin | Manager | HR | Employee |
|---|---|---|---|---|
| Create Manager/HR/Employee | yes | no | Employee only | no |
| Edit people | all fields | assignment fields of own team | via request | via request (own) |
| Attendance correction | direct | direct (own team) | via request | via request |
| Void attendance / archive user | yes | no | no | no |
| Approve requests | any stage (ADMIN_OVERRIDE) | manager stage | HR stage | no |

Login is User ID + password only (no OTP). The User ID can be the employee ID, email or mobile. Admin (or HR for employees) sets the initial password when creating an account, or leaves it blank for a generated one; users change it at first login.

Request flow: Employee -> HR -> Manager -> applied. HR -> Manager -> applied. Manager -> Admin -> applied. A missing or inactive stage is skipped; with no approver left it waits for Admin. Admin can override any stage.

## Data safety

- "Delete" archives a user; attendance is voided, never destroyed. Login is blocked for INACTIVE/ARCHIVED users.
- Every create/edit/approve/void/settings change writes an append-only `AuditLog` (the model rejects update/delete).
- Tracked profile fields keep a version history (`ProfileVersion`): what, who, when, why.
- Admin actions that change or remove data require a reason.
- Passwords: bcrypt (cost 12), sessions are random tokens stored hashed in MongoDB with an httpOnly cookie, 5 failed logins lock an account for 15 minutes.

## Google Sheets (optional)

One row per person per day (columns: date, employee, location, first check-in, last check-out, hours, all sessions, re-entry reasons, notes). It updates automatically on every check-in, check-out, auto check-out, correction and void. Setup:

It uses a Google Apps Script web app that lives in your own sheet, so no Google Cloud project or service account is needed.

1. Open the Google Sheet, then **Extensions, Apps Script**, delete the sample code.
2. In the app go to **Settings, Google Sheets, Show script**, copy it into Apps Script, and save.
3. **Deploy, New deployment, Web app**. Execute as **Me**, access **Anyone**. Approve the permissions and copy the Web app URL.
4. Paste the URL in Settings, save, then **Test connection**. The tab is created if missing. **Send all past attendance** backfills history.

The script holds a random secret; requests without it are rejected. **New secret** in Settings rotates it (paste and re-deploy the script afterwards). After editing the script later, use *Deploy, Manage deployments, Edit, New version* so the same URL keeps working.

Not exercised by the automated test (needs a real deployed script).

## Tests

`npm run build && npm run test:smoke` runs 28 API checks against a throwaway in-memory MongoDB (downloads a mongod binary on first run).
