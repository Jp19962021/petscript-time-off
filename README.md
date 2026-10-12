# PetScript Time Off

## Upload to GitHub
Upload the contents of this ZIP directly into the root of your GitHub repository.

Files:
- src/index.js
- wrangler.jsonc
- package.json
- .gitignore

## Cloudflare deployment
If Cloudflare asks:

Install command:
npm install

Deploy command:
npx wrangler deploy

No separate build command is required.

## Next step
Create a Cloudflare D1 database named:

petscript-timeoff

Then bind it to your Worker with the binding name:

DB

Once DB is connected, reload the Worker URL and the dashboard will load.

The app creates its own database tables automatically.

## Important
This first package includes:
- employee roster
- off today
- this week
- this month
- manual time-off entry
- persistent D1 storage

The AI PDF/photo upload reader can be added after the D1 connection is confirmed working.
