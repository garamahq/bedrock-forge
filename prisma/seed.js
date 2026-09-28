"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const client_1 = require("@prisma/client");
const adapter_pg_1 = require("@prisma/adapter-pg");
const pg_1 = __importDefault(require("pg"));
const bcrypt = __importStar(require("bcryptjs"));
const pool = new pg_1.default.Pool({ connectionString: process.env.DATABASE_URL ?? "" });
const adapter = new adapter_pg_1.PrismaPg(pool);
const prisma = new client_1.PrismaClient({ adapter });
// ── Roles ────────────────────────────────────────────────────────────────────
async function seedRoles() {
    const roles = ["admin", "manager", "maintainer", "client"];
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
    const email = "admin@bedrockforge.local";
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing)
        return 0;
    const initialPassword = process.env.ADMIN_BOOTSTRAP_PASSWORD;
    if (!initialPassword || initialPassword.length < 32) {
        throw new Error("ADMIN_BOOTSTRAP_PASSWORD must be set to a value of at least 32 characters when creating the initial admin user");
    }
    const password_hash = await bcrypt.hash(initialPassword, 12);
    const adminRole = await prisma.role.findUnique({ where: { name: "admin" } });
    if (!adminRole)
        throw new Error("Admin role not found — run seedRoles first");
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
        if (r)
            count++;
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
            description: "High-performance hosting for agencies managing multiple clients",
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
            description: "Priority support with 8-hour response time and managed updates",
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
    return 0;
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
    console.log("\nExisting users are left unchanged by the seed.");
}
main()
    .catch((e) => {
    console.error(e);
    process.exit(1);
})
    .finally(() => prisma.$disconnect());
