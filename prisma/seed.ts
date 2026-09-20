import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import * as bcrypt from "bcryptjs";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "" });
const adapter = new PrismaPg(pool as any);
const prisma = new PrismaClient({ adapter });

// ── Roles ────────────────────────────────────────────────────────────────────

async function seedRoles() {
  const roles = ["admin", "manager", "maintainer", "client"] as const;
  let count = 0;
  for (const name of roles) {
    const existing = await prisma.role.findUnique({ where: { name } });
    if (!existing) {
      await prisma.role.create({ data: { name } });
      count++;
    }
  }
  return count;
}

// ── Admin User ───────────────────────────────────────────────────────────────

async function seedAdminUser() {
  // ⚠ Development seed only — change password immediately after first login.
  const email = "admin@bedrockforge.local";
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return 0;

  const password_hash = await bcrypt.hash("admin123", 12);
  const adminRole = await prisma.role.findUnique({ where: { name: "admin" } });
  if (!adminRole) throw new Error("Admin role not found — run seedRoles first");

  await prisma.user.create({
    data: {
      email,
      name: "Administrator",
      password_hash,
      user_roles: {
        create: { role_id: adminRole.id },
      },
    },
  });
  return 1;
}

// ── Tags ─────────────────────────────────────────────────────────────────────

async function seedTags() {
  const tags = [
    { name: "WordPress", color: "#3b82f6" },
    { name: "WooCommerce", color: "#a855f7" },
    { name: "Maintenance", color: "#f59e0b" },
    { name: "Bedrock", color: "#10b981" },
    { name: "Client", color: "#6366f1" },
  ];
  let count = 0;
  for (const tag of tags) {
    const r = await prisma.tag.upsert({
      where: { name: tag.name },
      update: {},
      create: tag,
    });
    if (r) count++;
  }
  return count;
}

// ── Hosting Packages ─────────────────────────────────────────────────────────

async function seedHostingPackages() {
  const packages = [
    {
      name: "Basic",
      description: "Entry-level hosting for small WordPress sites",
      price_monthly: 15.0,
      storage_gb: 10,
      bandwidth_gb: 100,
      max_sites: 1,
    },
    {
      name: "Pro",
      description: "Professional hosting for growing businesses",
      price_monthly: 35.0,
      storage_gb: 50,
      bandwidth_gb: 500,
      max_sites: 5,
    },
    {
      name: "Agency",
      description:
        "High-performance hosting for agencies managing multiple clients",
      price_monthly: 99.0,
      storage_gb: 200,
      bandwidth_gb: 2000,
      max_sites: 25,
    },
  ];
  let count = 0;
  for (const pkg of packages) {
    const existing = await prisma.hostingPackage.findFirst({
      where: { name: pkg.name },
    });
    if (!existing) {
      await prisma.hostingPackage.create({ data: pkg });
      count++;
    }
  }
  return count;
}

// ── Support Packages ─────────────────────────────────────────────────────────

async function seedSupportPackages() {
  const packages = [
    {
      name: "Standard",
      description: "Standard support with 48-hour response time",
      price_monthly: 25.0,
      response_hours: 48,
      includes_updates: false,
    },
    {
      name: "Priority",
      description:
        "Priority support with 8-hour response time and managed updates",
      price_monthly: 75.0,
      response_hours: 8,
      includes_updates: true,
    },
  ];
  let count = 0;
  for (const pkg of packages) {
    const existing = await prisma.supportPackage.findFirst({
      where: { name: pkg.name },
    });
    if (!existing) {
      await prisma.supportPackage.create({ data: pkg });
      count++;
    }
  }
  return count;
}

// ── Servers ──────────────────────────────────────────────────────────────────
// No servers are seeded by default. Add your own via Settings → Servers in the
// UI, or extend this list for automated provisioning environments.

async function seedServers() {
  // Servers are intentionally not seeded — they contain environment-specific
  // SSH credentials and IP addresses that must be supplied by the operator.
  return 0 as number;
}

// ── Custom Plugins ───────────────────────────────────────────────────────────

async function seedCustomPlugins() {
  const plugin = await prisma.customPlugin.upsert({
    where: { slug: "wp-secure-guard" },
    update: {
      name: "WP Secure Guard",
      repo_url: "https://github.com/garamahq/wp-secure-guard.git",
      repo_path: ".",
      type: "plugin",
    },
    create: {
      name: "WP Secure Guard",
      slug: "wp-secure-guard",
      repo_url: "https://github.com/garamahq/wp-secure-guard.git",
      repo_path: ".",
      type: "plugin",
    },
  });
  return plugin ? 1 : 0;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("Seeding database…\n");

  const roles = await seedRoles();
  console.log(`  Roles created:             ${roles}`);

  const adminUsers = await seedAdminUser();
  console.log(`  Admin users created:       ${adminUsers}`);

  const tags = await seedTags();
  console.log(`  Tags upserted:             ${tags}`);

  const hostingPkgs = await seedHostingPackages();
  console.log(`  Hosting packages created:  ${hostingPkgs}`);

  const supportPkgs = await seedSupportPackages();
  console.log(`  Support packages created:  ${supportPkgs}`);

  const servers = await seedServers();
  console.log(`  Servers created:           ${servers}`);

  const customPlugins = await seedCustomPlugins();
  console.log(`  Custom plugins upserted:   ${customPlugins}`);

  console.log("\nDone.");
  console.log(
    "\nAdmin credentials are printed by install.sh. Change the password immediately after first login.",
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
