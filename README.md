# Videowall

Personal, browser-based videowall controller built around Raspberry Pi kiosk players.

## Local start

1. Copy `.env.example` to `.env` and add the Supabase project URL and anon key.
2. Install packages: `npm install`.
3. Start the app: `npm run dev`.
4. Apply `supabase/migrations/20260831000000_initial.sql` in the Supabase SQL editor (or link the project and run `npx supabase db push`).
5. Create a Supabase Auth user for yourself in the Supabase dashboard, then use those email/password credentials in the admin sign-in screen.

## Pi player

Run Chromium at `https://YOUR-DOMAIN/?player=1` in kiosk mode. Use a Pi 3 for 1080p H.264, images and widgets; reserve Pi 4s for higher-bitrate video or heavier visual effects.

The player first shows a PIN form. Pair it once, then its local device token is retained and it reconnects automatically.
