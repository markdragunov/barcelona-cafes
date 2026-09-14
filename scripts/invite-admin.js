#!/usr/bin/env node
/**
 * Invite (or create) an admin user via Supabase Auth Admin API.
 *
 * Usage:
 *   node scripts/invite-admin.js you@example.com
 *
 * Requires env:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * Also add the same email to ADMIN_EMAILS in .env (comma-separated).
 */
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const email = String(process.argv[2] || "")
  .trim()
  .toLowerCase();
if (!email || !email.includes("@")) {
  console.error("Usage: node scripts/invite-admin.js you@example.com");
  process.exit(1);
}

const url = String(process.env.SUPABASE_URL || "")
  .trim()
  .replace(/\/$/, "");
const serviceKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

if (!url || !serviceKey) {
  console.error(
    "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required (server-only; never commit)."
  );
  process.exit(1);
}

const redirectTo =
  String(process.env.ADMIN_INVITE_REDIRECT || "").trim() ||
  "https://admin.mark-d.dev/admin";

const supabase = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const { data, error } = await supabase.auth.admin.inviteUserByEmail(email, {
  redirectTo,
});

if (error) {
  // Fallback: create user then generate magic link (no invite email)
  console.warn(`inviteUserByEmail failed: ${error.message}`);
  console.warn("Trying createUser + generateLink(magiclink)…");
  const created = await supabase.auth.admin.createUser({
    email,
    email_confirm: true,
  });
  if (created.error && !/already/i.test(created.error.message)) {
    console.error(created.error.message);
    process.exit(1);
  }
  const link = await supabase.auth.admin.generateLink({
    type: "magiclink",
    email,
    options: { redirectTo },
  });
  if (link.error) {
    console.error(link.error.message);
    process.exit(1);
  }
  console.log(`User ready: ${email}`);
  console.log(`Magic link (single use): ${link.data.properties?.action_link || "(see Supabase dashboard)"}`);
} else {
  console.log(`Invite sent to ${email}`);
  console.log(`User id: ${data.user?.id || "?"}`);
}

console.log("");
console.log("Next steps:");
console.log(`  1. Ensure ADMIN_EMAILS includes ${email}`);
console.log("  2. In Supabase Auth → URL config, allow redirect:");
console.log(`       ${redirectTo}`);
console.log("       https://mark-d.dev/admin");
console.log("       http://localhost:3847/admin");
console.log("  3. Open the admin site and complete the magic link (or use the invite email).");
