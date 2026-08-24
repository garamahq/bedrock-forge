import type { SecurityFinding } from "@bedrock-forge/shared";
import { makeFinding } from "./scoring";

type Executor = {
  execute(
    cmd: string,
    opts?: { timeout?: number },
  ): Promise<{ stdout: string; stderr: string; code: number }>;
};

// ─── SSH_AUDIT ────────────────────────────────────────────────────────────────

export async function runSshAudit(exec: Executor): Promise<SecurityFinding[]> {
  const findings: SecurityFinding[] = [];

  // 1. Collect authorized_keys for root and all home users
  const { stdout: authKeysRoot } = await exec.execute(
    `cat /root/.ssh/authorized_keys 2>/dev/null || true`,
  );
  const { stdout: homeUsers } = await exec.execute(
    `ls /home 2>/dev/null || true`,
  );

  const users = homeUsers
    .split("\n")
    .map((u) => u.trim())
    .filter(Boolean);
  const allKeyFiles: { path: string; content: string }[] = [];

  if (authKeysRoot.trim()) {
    allKeyFiles.push({
      path: "/root/.ssh/authorized_keys",
      content: authKeysRoot,
    });
  }
  for (const user of users) {
    const { stdout } = await exec.execute(
      `cat /home/${user}/.ssh/authorized_keys 2>/dev/null || true`,
    );
    if (stdout.trim()) {
      allKeyFiles.push({
        path: `/home/${user}/.ssh/authorized_keys`,
        content: stdout,
      });
    }
  }

  for (const { path, content } of allKeyFiles) {
    const keys = content
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));

    if (keys.length > 0) {
      findings.push(
        makeFinding(
          "info",
          "AUTHORIZED_KEYS",
          `${keys.length} authorized key(s) in ${path}`,
          `${path} contains ${keys.length} public key(s). Verify they are all known and expected.`,
          {
            remediation:
              "Periodically audit authorized_keys to remove stale access.",
            resource: path,
            metadata: { key_count: keys.length },
          },
        ),
      );
    }
  }

  // 2. Parse auth log for failed and successful logins
  const authLogFile = await resolveAuthLog(exec);

  if (authLogFile) {
    const { stdout: failedRaw } = await exec.execute(
      `grep -i "Failed password\\|Invalid user" ${authLogFile} 2>/dev/null | tail -2000 || true`,
      { timeout: 30000 },
    );

    const failedByIp: Record<string, number> = {};
    for (const line of failedRaw.split("\n").filter(Boolean)) {
      const ipMatch = line.match(/from (\d+\.\d+\.\d+\.\d+)/);
      if (ipMatch) {
        const ip = ipMatch[1];
        failedByIp[ip] = (failedByIp[ip] ?? 0) + 1;
      }
    }

    const bruteForceIps = Object.entries(failedByIp).filter(
      ([, count]) => count >= 10,
    );
    const highVolumeIps = Object.entries(failedByIp).filter(
      ([, count]) => count >= 50,
    );

    if (highVolumeIps.length > 0) {
      findings.push(
        makeFinding(
          "critical",
          "FAILED_LOGINS",
          `Brute-force SSH attack detected from ${highVolumeIps.length} IP(s)`,
          `IP(s) with 50+ failed login attempts: ${highVolumeIps.map(([ip, n]) => `${ip} (${n})`).join(", ")}`,
          {
            remediation:
              "Block these IPs with ufw/iptables immediately. Enable fail2ban. " +
              "Consider disabling password authentication entirely (PasswordAuthentication no in sshd_config).",
            resource: highVolumeIps.map(([ip]) => ip).join(", "),
            metadata: { ips: Object.fromEntries(highVolumeIps) },
          },
        ),
      );
    } else if (bruteForceIps.length > 0) {
      findings.push(
        makeFinding(
          "high",
          "FAILED_LOGINS",
          `Repeated SSH login failures from ${bruteForceIps.length} IP(s)`,
          `IP(s) with 10+ failed attempts: ${bruteForceIps.map(([ip, n]) => `${ip} (${n})`).join(", ")}`,
          {
            remediation:
              "Review these IPs and block malicious ones. Enable fail2ban if not active.",
            resource: bruteForceIps.map(([ip]) => ip).join(", "),
            metadata: { ips: Object.fromEntries(bruteForceIps) },
          },
        ),
      );
    } else if (Object.keys(failedByIp).length > 0) {
      findings.push(
        makeFinding(
          "low",
          "FAILED_LOGINS",
          `SSH login failures from ${Object.keys(failedByIp).length} IP(s)`,
          `Low-level failed login activity observed.`,
          {
            remediation:
              "Monitor trends. Enable fail2ban for automated blocking.",
            metadata: { ips: failedByIp },
          },
        ),
      );
    }

    // Successful logins
    const { stdout: successRaw } = await exec.execute(
      `grep -i "Accepted publickey\\|Accepted password" ${authLogFile} 2>/dev/null | tail -500 || true`,
      { timeout: 15000 },
    );

    const successByIp: Record<string, { count: number; users: Set<string> }> =
      {};
    for (const line of successRaw.split("\n").filter(Boolean)) {
      const ipMatch = line.match(/from (\d+\.\d+\.\d+\.\d+)/);
      const userMatch = line.match(/for (\S+) from/);
      if (ipMatch) {
        const ip = ipMatch[1];
        const user = userMatch?.[1] ?? "unknown";
        if (!successByIp[ip]) successByIp[ip] = { count: 0, users: new Set() };
        successByIp[ip].count++;
        successByIp[ip].users.add(user);
      }
    }

    if (Object.keys(successByIp).length > 0) {
      findings.push(
        makeFinding(
          "info",
          "SUCCESSFUL_LOGINS",
          `SSH logins from ${Object.keys(successByIp).length} distinct IP(s)`,
          `Recent successful SSH logins detected. Review login sources.`,
          {
            remediation:
              "Verify all source IPs are expected. Remove any legacy accounts.",
            metadata: {
              ips: Object.fromEntries(
                Object.entries(successByIp).map(([ip, v]) => [
                  ip,
                  { count: v.count, users: [...v.users] },
                ]),
              ),
            },
          },
        ),
      );
    }
  }

  // 3. SSH host key file permissions — should be 600
  const { stdout: hostKeyPerms } = await exec.execute(
    `find /etc/ssh -name "ssh_host_*_key" -not -name "*.pub" -exec stat -c '%n %a' {} \\; 2>/dev/null || true`,
  );
  for (const line of hostKeyPerms.split("\n").filter(Boolean)) {
    const parts = line.trim().split(" ");
    if (parts.length >= 2) {
      const keyPath = parts.slice(0, -1).join(" ");
      const perm = parts[parts.length - 1];
      if (perm !== "600") {
        findings.push(
          makeFinding(
            "high",
            "SSH_CONFIG",
            `SSH host key has insecure permissions: ${keyPath} (${perm})`,
            "Host private keys should be readable only by root (600).",
            {
              remediation: `chmod 600 ${keyPath}`,
              resource: keyPath,
              metadata: { permissions: perm },
            },
          ),
        );
      }
    }
  }

  // 4. .ssh directory permissions for root and home users — should be 700
  const dirsToCheck: string[] = ["/root/.ssh"];
  const { stdout: homeDirs } = await exec.execute(
    `ls /home 2>/dev/null || true`,
  );
  for (const u of homeDirs
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)) {
    dirsToCheck.push(`/home/${u}/.ssh`);
  }
  for (const dir of dirsToCheck) {
    const { stdout: dirPerm } = await exec.execute(
      `stat -c '%a' ${dir} 2>/dev/null || true`,
    );
    const perm = dirPerm.trim();
    if (perm && perm !== "700") {
      findings.push(
        makeFinding(
          "medium",
          "SSH_CONFIG",
          `${dir} has insecure permissions: ${perm}`,
          ".ssh directories should be 700 to prevent other users reading authorized_keys.",
          {
            remediation: `chmod 700 ${dir}`,
            resource: dir,
            metadata: { permissions: perm },
          },
        ),
      );
    }
  }

  // 5. sshd_config analysis
  try {
    const { stdout: sshdRaw } = await exec.execute(
      `cat /etc/ssh/sshd_config 2>/dev/null || true`,
    );
    const configLines = sshdRaw
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));

    const getValue = (key: string): string | null => {
      const line = configLines.find((l) =>
        l.toLowerCase().startsWith(key.toLowerCase()),
      );
      return line ? (line.split(/\s+/)[1] ?? null) : null;
    };

    const permitRootLogin = getValue("PermitRootLogin");
    if (permitRootLogin === "yes") {
      findings.push(
        makeFinding(
          "critical",
          "SSH_CONFIG",
          "Root password login enabled",
          "sshd_config allows direct root login with a password. This is a prime target for brute-force and credential-stuffing attacks.",
          {
            remediation:
              'Manually set "PermitRootLogin prohibit-password" in /etc/ssh/sshd_config to block password-based root login while keeping SSH key access. Then reload: systemctl reload sshd',
            resource: "/etc/ssh/sshd_config",
          },
        ),
      );
    } else if (permitRootLogin === null) {
      findings.push(
        makeFinding(
          "high",
          "SSH_CONFIG",
          "PermitRootLogin not explicitly configured",
          "PermitRootLogin is absent from sshd_config. The default value may allow root login depending on the distro and sshd version.",
          {
            remediation:
              'Manually add "PermitRootLogin prohibit-password" to /etc/ssh/sshd_config to explicitly disable password-based root login while preserving SSH key access. Then reload: systemctl reload sshd',
            resource: "/etc/ssh/sshd_config",
          },
        ),
      );
    } else if (
      permitRootLogin === "prohibit-password" ||
      permitRootLogin === "without-password"
    ) {
      findings.push(
        makeFinding(
          "info",
          "SSH_CONFIG",
          "Root SSH key access permitted",
          "PermitRootLogin is set to prohibit-password — password-based root login is blocked, but root can still authenticate via SSH key. This is acceptable when key-based access is required for management.",
          {
            remediation:
              'Periodically audit /root/.ssh/authorized_keys to ensure only known and current keys are present. Set "PermitRootLogin no" only if a non-root sudo user is configured for all management access.',
            resource: "/etc/ssh/sshd_config",
          },
        ),
      );
    }

    const passwordAuth = getValue("PasswordAuthentication");
    // Read AuthenticationMethods early — if set to publickey it fully overrides
    // PasswordAuthentication regardless of its value, so skip that finding.
    const authMethodsVal = getValue("AuthenticationMethods");
    if (
      authMethodsVal !== "publickey" &&
      (passwordAuth === "yes" || passwordAuth === null)
    ) {
      findings.push(
        makeFinding(
          "high",
          "SSH_CONFIG",
          "Password authentication is enabled",
          "SSH allows password-based logins, enabling brute-force attacks.",
          {
            remediation:
              'Set "PasswordAuthentication no" to require key-based auth only. ' +
              "Ensure all admin SSH keys are in authorized_keys first.",
            resource: "/etc/ssh/sshd_config",
          },
        ),
      );
    }

    const maxAuthTries = parseInt(getValue("MaxAuthTries") ?? "6", 10);
    if (maxAuthTries > 3) {
      findings.push(
        makeFinding(
          "medium",
          "SSH_CONFIG",
          `MaxAuthTries is set to ${maxAuthTries}`,
          "High MaxAuthTries gives attackers more attempts per connection before being disconnected.",
          {
            remediation: 'Set "MaxAuthTries 3" in /etc/ssh/sshd_config.',
            resource: "/etc/ssh/sshd_config",
          },
        ),
      );
    }

    const x11 = getValue("X11Forwarding");
    if (x11 === "yes") {
      findings.push(
        makeFinding(
          "low",
          "SSH_CONFIG",
          "X11Forwarding is enabled",
          "X11 forwarding is unnecessary on headless servers and widens the attack surface.",
          {
            remediation: 'Set "X11Forwarding no" in /etc/ssh/sshd_config.',
            resource: "/etc/ssh/sshd_config",
          },
        ),
      );
    }

    // AllowUsers / AllowGroups not set means any valid user can log in via SSH
    const allowUsers = getValue("AllowUsers");
    const allowGroups = getValue("AllowGroups");
    if (!allowUsers && !allowGroups) {
      findings.push(
        makeFinding(
          "medium",
          "SSH_CONFIG",
          "AllowUsers / AllowGroups not configured in sshd_config",
          "Without AllowUsers or AllowGroups, any valid system user can attempt SSH login.",
          {
            remediation:
              'Add "AllowUsers root deploy" (or a specific group via AllowGroups) to /etc/ssh/sshd_config and reload sshd.',
            resource: "/etc/ssh/sshd_config",
          },
        ),
      );
    }

    // AuthenticationMethods should be publickey only (reuse value read above)
    const authMethods = authMethodsVal;
    if (authMethods && authMethods !== "publickey") {
      findings.push(
        makeFinding(
          "high",
          "SSH_CONFIG",
          `AuthenticationMethods is set to "${authMethods}" instead of publickey`,
          "Allowing non-publickey authentication methods enables password-based brute-force.",
          {
            remediation:
              'Set "AuthenticationMethods publickey" in /etc/ssh/sshd_config.',
            resource: "/etc/ssh/sshd_config",
          },
        ),
      );
    }
  } catch {
    // sshd_config unreadable — not a local permission issue we can fix
  }

  // 6. Open ports
  try {
    const { stdout: netstatOut } = await exec.execute(
      `ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null || true`,
      { timeout: 10000 },
    );

    // Standard web/hosting ports + CyberPanel + mail + DNS + FTP
    const knownPorts = new Set([
      20, 21, 22, 25, 53, 80, 110, 143, 443, 465, 587, 993, 995, 3306, 33060, 5432, 6379, 7080, 8080, 8088, 8090, 8443,
      8888, 11211,
    ]);
    const openPorts: number[] = [];

    for (const line of netstatOut.split("\n").filter(Boolean)) {
      const match = line.match(/:(\d+)\s/);
      if (match) {
        const port = parseInt(match[1], 10);
        // Exclude ephemeral / passive FTP port range (40000-50000)
        if (!isNaN(port) && !knownPorts.has(port) && (port < 40000 || port > 50000) && port < 65535) {
          if (!openPorts.includes(port)) openPorts.push(port);
        }
      }
    }

    if (openPorts.length > 5) {
      findings.push(
        makeFinding(
          "medium",
          "OPEN_PORTS",
          `${openPorts.length} unexpected open port(s)`,
          `Ports open beyond standard: ${openPorts.slice(0, 20).join(", ")}${openPorts.length > 20 ? ", ..." : ""}`,
          {
            remediation:
              "Review all open ports and close any that are not required. " +
              "Use ufw to restrict port access.",
            metadata: { ports: openPorts },
          },
        ),
      );
    } else if (openPorts.length > 0) {
      findings.push(
        makeFinding(
          "info",
          "OPEN_PORTS",
          `${openPorts.length} additional open port(s)`,
          `Non-standard ports open: ${openPorts.join(", ")}`,
          {
            remediation: "Confirm each port is intentional.",
            metadata: { ports: openPorts },
          },
        ),
      );
    }
  } catch {
    // ss/netstat unavailable
  }

  return findings;
}

// ─── SERVER_HARDENING ─────────────────────────────────────────────────────────

export async function runServerHardening(
  exec: Executor,
): Promise<SecurityFinding[]> {
  const findings: SecurityFinding[] = [];

  // 1. Firewall status
  const { stdout: ufwStatus } = await exec.execute(
    `ufw status 2>/dev/null || true`,
  );
  const { stdout: csfCheck } = await exec.execute(
    `csf -v 2>/dev/null | head -1 || echo missing`,
    { timeout: 10000 },
  );

  if (!csfCheck.includes("missing")) {
    // CSF is present
    const { stdout: csfTesting } = await exec.execute(
      `grep -E "^TESTING\\s*=" /etc/csf/csf.conf 2>/dev/null | grep -c "1" || echo 0`,
    );
    if (parseInt(csfTesting.trim(), 10) > 0) {
      findings.push(
        makeFinding(
          "high",
          "FIREWALL",
          "CSF is in TESTING mode — firewall rules are not being enforced",
          "CSF TESTING=1 means DROP rules are not applied. The firewall is effectively disabled.",
          {
            remediation:
              'Edit /etc/csf/csf.conf: set TESTING = "0", then run: csf -r',
          },
        ),
      );
    }
  } else if (
    ufwStatus.toLowerCase().includes("inactive") ||
    !ufwStatus.trim()
  ) {
    const { stdout: iptables } = await exec.execute(
      `iptables -L INPUT -n 2>/dev/null | wc -l || true`,
    );
    const ruleCount = parseInt(iptables.trim(), 10);
    if (!iptables.trim() || ruleCount <= 3) {
      findings.push(
        makeFinding(
          "high",
          "FIREWALL",
          "No active firewall detected",
          "Neither ufw nor iptables appears to be actively filtering inbound traffic.",
          {
            remediation:
              'Enable ufw: "ufw default deny incoming && ufw allow 22 && ufw allow 80 && ufw allow 443 && ufw enable"',
          },
        ),
      );
    }
  } else {
    // CSF not installed and UFW is not active — suggest CSF
    findings.push(
      makeFinding(
        "info",
        "FIREWALL",
        "CSF (ConfigServer Firewall) is not installed",
        "CSF is the recommended firewall for CyberPanel servers. It provides advanced IP blocking and rate limiting.",
        {
          remediation:
            "Install CSF: wget https://download.configserver.com/csf.tgz && tar -xzf csf.tgz && cd csf && sh install.sh",
        },
      ),
    );
  }

  // 2. Pending OS updates
  const { stdout: aptUpgradable } = await exec.execute(
    `apt list --upgradable 2>/dev/null | grep -c "\\[upgradable" || echo 0`,
    { timeout: 30000 },
  );
  const updateCount = parseInt(aptUpgradable.trim(), 10);
  if (updateCount > 50) {
    findings.push(
      makeFinding(
        "high",
        "OS_UPDATES",
        `${updateCount} pending OS packages to update`,
        "A large number of unpatched packages increases the attack surface.",
        {
          remediation:
            'Run "apt update && apt upgrade -y" to apply all security updates.',
          metadata: { pending_updates: updateCount },
        },
      ),
    );
  } else if (updateCount > 10) {
    findings.push(
      makeFinding(
        "medium",
        "OS_UPDATES",
        `${updateCount} pending OS packages to update`,
        "Security updates are available but not yet applied.",
        {
          remediation: 'Run "apt update && apt upgrade -y".',
          metadata: { pending_updates: updateCount },
        },
      ),
    );
  } else if (updateCount > 0) {
    findings.push(
      makeFinding(
        "low",
        "OS_UPDATES",
        `${updateCount} pending OS update(s)`,
        "Minor updates are available.",
        { metadata: { pending_updates: updateCount } },
      ),
    );
  }

  // 3. Fail2ban status — essential for blocking SSH brute-force
  const { stdout: fail2banStatus } = await exec.execute(
    `systemctl is-active fail2ban 2>/dev/null || echo inactive`,
    { timeout: 10000 },
  );
  if (!fail2banStatus.trim().startsWith("active")) {
    const { stdout: fail2banExists } = await exec.execute(
      `which fail2ban-client 2>/dev/null && echo found || echo missing`,
    );
    findings.push(
      makeFinding(
        "high",
        "SECURITY_TOOLS",
        fail2banExists.includes("missing")
          ? "fail2ban is not installed"
          : "fail2ban is installed but not running",
        "fail2ban automatically bans IPs with repeated failed SSH logins. It is the primary defence against brute-force attacks.",
        {
          remediation: fail2banExists.includes("missing")
            ? "apt install fail2ban -y && systemctl enable fail2ban && systemctl start fail2ban"
            : "systemctl enable fail2ban && systemctl start fail2ban",
        },
      ),
    );
  }

  // 4. ClamAV antivirus daemon
  const { stdout: clamavStatus } = await exec.execute(
    `systemctl is-active clamav-daemon 2>/dev/null || echo inactive`,
    { timeout: 10000 },
  );
  if (!clamavStatus.trim().startsWith("active")) {
    const { stdout: clamavExists } = await exec.execute(
      `which clamscan 2>/dev/null && echo found || echo missing`,
    );
    findings.push(
      makeFinding(
        "medium",
        "SECURITY_TOOLS",
        clamavExists.includes("missing")
          ? "ClamAV is not installed"
          : "ClamAV daemon is not running",
        "ClamAV provides real-time file scanning to detect webshells and malware.",
        {
          remediation: clamavExists.includes("missing")
            ? "apt install clamav clamav-daemon -y && freshclam && systemctl enable clamav-daemon && systemctl start clamav-daemon"
            : "systemctl enable clamav-daemon && systemctl start clamav-daemon && freshclam",
        },
      ),
    );
  }

  // 5. World-writable files — anyone can modify these
  const { stdout: worldWritable } = await exec.execute(
    `find /home -type f -perm -002 -not -path "*/proc/*" -not -path "*/.git/*" 2>/dev/null | head -20 || true`,
    { timeout: 60000 },
  );
  const wwFiles = worldWritable
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (wwFiles.length > 0) {
    findings.push(
      makeFinding(
        "high",
        "WORLD_WRITABLE",
        `${wwFiles.length} world-writable file(s) found`,
        "World-writable files can be modified by any process running on the server — a common malware propagation vector.",
        {
          remediation: `chmod o-w <file> for each entry. Run: find /home -type f -perm -002 -exec chmod o-w {} \\;`,
          metadata: { files: wwFiles },
        },
      ),
    );
  }

  // 6. Suspicious cron entries — common persistence mechanism
  const { stdout: cronContent } = await exec.execute(
    `(cat /etc/crontab 2>/dev/null; ls /etc/cron.d/ 2>/dev/null | xargs -I{} cat /etc/cron.d/{} 2>/dev/null; crontab -l 2>/dev/null; for u in $(ls /home 2>/dev/null); do crontab -u "$u" -l 2>/dev/null; done) | grep -E "curl |wget |base64|/tmp/[a-zA-Z]|python[23]? -c|bash -[ic]" || true`,
    { timeout: 30000 },
  );
  const suspiciousCrons = cronContent
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (suspiciousCrons.length > 0) {
    findings.push(
      makeFinding(
        "critical",
        "CRON_JOBS",
        `${suspiciousCrons.length} suspicious cron job(s) detected`,
        "Cron entries that download, execute from temp, or use base64/eval are a common attacker persistence mechanism.",
        {
          remediation:
            "Inspect each flagged cron entry. If unknown, remove it: crontab -e or edit /etc/cron.d/<file>",
          metadata: { entries: suspiciousCrons },
        },
      ),
    );
  }

  return findings;
}

// ─── MALWARE_SCAN ─────────────────────────────────────────────────────────────

export async function runMalwareScan(
  exec: Executor,
): Promise<SecurityFinding[]> {
  const findings: SecurityFinding[] = [];

  // 1. ClamAV on-demand scan
  const { stdout: clamavCheck } = await exec.execute(
    `which clamscan 2>/dev/null && echo found || echo missing`,
  );
  if (clamavCheck.includes("found")) {
    const { stdout: clamScan } = await exec.execute(
      `timeout 180 clamscan --infected --no-summary --include="*.php" --recursive --max-dir-recursion=10 --max-filesize=5M --max-files=500 /home/*/public_html 2>/dev/null | head -100 || true`,
      { timeout: 200000 },
    );
    const infected = clamScan.split("\n").filter((l) => l.includes("FOUND"));
    if (infected.length > 0) {
      findings.push(
        makeFinding(
          "critical",
          "MALWARE",
          `ClamAV: ${infected.length} infected file(s) found`,
          `ClamAV detected malware in: ${infected.slice(0, 5).join("; ")}${infected.length > 5 ? " …" : ""}`,
          {
            remediation:
              "Quarantine or delete the infected files immediately. " +
              "Investigate how the malware was introduced (outdated plugin, weak credentials, etc.).",
            metadata: { infected_files: infected.slice(0, 20) },
          },
        ),
      );
    }
  }

  // 2. Try maldet (Linux Malware Detect)
  const { stdout: maldetCheck } = await exec.execute(
    `which maldet 2>/dev/null && echo found || echo missing`,
  );
  if (maldetCheck.includes("found")) {
    const { stdout: maldetScan } = await exec.execute(
      `timeout 180 maldet --scan-all /home/*/public_html 2>/dev/null | tail -30 || true`,
      { timeout: 200000 },
    );
    const hitLines = maldetScan
      .split("\n")
      .filter((l) => l.toLowerCase().includes("hit") || l.includes("INFECTED"));
    if (hitLines.length > 0) {
      findings.push(
        makeFinding(
          "critical",
          "MALWARE",
          `Maldet: ${hitLines.length} hit(s)`,
          hitLines.slice(0, 5).join("; "),
          {
            remediation:
              'Run "maldet --clean <reportid>" then audit the affected sites.',
            metadata: { hits: hitLines.slice(0, 20) },
          },
        ),
      );
    }
  }

  // 3. Pattern-based scan (always runs — no tool dependency)
  const suspiciousPatterns = [
    { name: "base64_decode eval", pattern: "eval\\s*\\(\\s*base64_decode\\s*\\(" },
    { name: "gzinflate eval chain", pattern: "eval\\s*\\(\\s*gzinflate\\s*\\(" },
    { name: "assert execution", pattern: "assert\\s*\\(\\s*base64_decode\\s*\\(" },
    { name: "POST webshell dispatch", pattern: "\\$_POST\\[['\"][a-zA-Z0-9_-]+['\"]\\]\\(\\$_POST" },
    {
      name: "c99/r57/WSO webshell signature",
      pattern: "FilesMan|c99shell|r57shell|WSOset",
    },
    { name: "system execution from query", pattern: "system\\(\\$_GET\\[" },
  ];

  for (const { name, pattern } of suspiciousPatterns) {
    const { stdout: matches } = await exec.execute(
      `grep -rl --exclude-dir=vendor --exclude-dir=wp-includes --exclude-dir=wp-admin -E "${pattern}" /home/*/public_html --include="*.php" 2>/dev/null | head -20 || true`,
      { timeout: 60000 },
    );
    const files = matches
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (files.length > 0) {
      findings.push(
        makeFinding(
          "critical",
          "MALWARE",
          `Suspicious PHP pattern detected: ${name}`,
          `Found ${files.length} file(s) matching the "${name}" pattern.`,
          {
            remediation:
              "Inspect these files manually. If confirmed malicious, delete them, " +
              "identify the entry point (outdated plugin/theme, weak FTP password), and rotate all credentials.",
            metadata: { matched_files: files },
          },
        ),
      );
    }
  }

  // 4. PHP files in uploads (critical — webshell indicator)
  const { stdout: phpInUploads } = await exec.execute(
    `find /home/*/public_html -path "*/uploads/*.php" -type f 2>/dev/null | head -20 || true`,
    { timeout: 30000 },
  );
  const phpUploadFiles = phpInUploads
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (phpUploadFiles.length > 0) {
    findings.push(
      makeFinding(
        "critical",
        "SUSPICIOUS_FILES",
        `PHP file(s) found in WordPress uploads directory`,
        `${phpUploadFiles.length} .php file(s) found in /uploads/ directories — this is a strong indicator of a webshell backdoor.`,
        {
          remediation:
            "Delete these files immediately. Add a rule to deny PHP execution in wp-content/uploads " +
            'via .htaccess: "deny from all" inside uploads/ and "RemoveHandler .php" / "php_flag engine off".',
          metadata: { files: phpUploadFiles },
        },
      ),
    );
  }

  // 5. Recently modified PHP files (last 7 days) — informational audit metric (not actionable malware)
  const { stdout: recentFiles } = await exec.execute(
    `find /home/*/public_html -name "*.php" -newer /home -mtime -7 -type f 2>/dev/null | head -50 || true`,
    { timeout: 30000 },
  );
  const recentPhp = recentFiles
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (recentPhp.length > 10) {
    findings.push(
      makeFinding(
        "medium",
        "SYSTEM_HEALTH",
        `${recentPhp.length} PHP files modified in the last 7 days`,
        "A large number of recently modified PHP files may indicate recent updates, deployments, or potential unauthorized changes.",
        {
          remediation:
            "Review recently modified files against version control or recent deployment logs.",
          metadata: { recent_files: recentPhp.slice(0, 30), count: recentPhp.length, is_malware: false },
        },
      ),
    );
  } else if (recentPhp.length > 0) {
    findings.push(
      makeFinding(
        "info",
        "SYSTEM_HEALTH",
        `${recentPhp.length} PHP file(s) modified in the last 7 days`,
        "Review recently modified files to confirm changes are expected.",
        { metadata: { recent_files: recentPhp, count: recentPhp.length, is_malware: false } },
      ),
    );
  }

  // 6a. .htaccess code-execution injection (eval / base64_decode) — definitively malicious
  const { stdout: htaccessCodeScan } = await exec.execute(
    `grep -rl --include=".htaccess" -E "eval|base64_decode" /home 2>/dev/null | head -20 || true`,
    { timeout: 60000 },
  );
  const htaccessCodeFiles = htaccessCodeScan
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (htaccessCodeFiles.length > 0) {
    findings.push(
      makeFinding(
        "critical",
        "HTACCESS",
        `Malicious .htaccess file(s) detected: ${htaccessCodeFiles.length} file(s)`,
        ".htaccess files containing eval or base64_decode are a strong indicator of PHP code injection.",
        {
          remediation:
            "Inspect each .htaccess file manually. Remove injected eval/base64 lines and harden the site.",
          metadata: { files: htaccessCodeFiles },
        },
      ),
    );
  }

  // 6b. .htaccess external redirect injection — RewriteRule pointing to a hardcoded
  // external domain. Self-referential %{HTTP_HOST} / %{SERVER_NAME} rewrites (standard
  // WordPress HTTPS rules) are intentionally excluded to avoid false positives.
  const { stdout: htaccessRedirectScan } = await exec.execute(
    `grep -rl --include=".htaccess" -E "RewriteRule[[:space:]]+\\S+[[:space:]]+https?://[^%]" /home 2>/dev/null | head -20 || true`,
    { timeout: 60000 },
  );
  const htaccessRedirectFiles = htaccessRedirectScan
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (htaccessRedirectFiles.length > 0) {
    findings.push(
      makeFinding(
        "high",
        "HTACCESS",
        `Suspicious .htaccess redirect to hardcoded external domain: ${htaccessRedirectFiles.length} file(s)`,
        ".htaccess RewriteRules redirecting to a fixed external URL may indicate traffic-hijacking malware. Standard %{HTTP_HOST} self-referential redirects are excluded.",
        {
          remediation:
            "Review the flagged .htaccess files. If the destination domain is not one you own, remove the rule.",
          metadata: { files: htaccessRedirectFiles },
        },
      ),
    );
  }

  // 7. Reverse shell patterns in PHP files
  const reverseShellPatterns = [
    { name: "bash reverse shell (/dev/tcp)", pattern: "/dev/tcp/" },
    {
      name: "nc bind shell (nc -e)",
      pattern: "nc -e /bin/bash\\|nc -e /bin/sh\\|nc -e bash",
    },
    {
      name: "Python pty.spawn shell",
      pattern: "import pty.*spawn\\|pty\\.spawn",
    },
    { name: "socat exec shell", pattern: "socat.*exec:.*bash\\|socat.*EXEC:" },
  ];
  for (const { name, pattern } of reverseShellPatterns) {
    const { stdout: rsMatches } = await exec.execute(
      `grep -rl "${pattern}" /home/*/public_html --include="*.php" 2>/dev/null | head -10 || true`,
      { timeout: 30000 },
    );
    const rsFiles = rsMatches
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (rsFiles.length > 0) {
      findings.push(
        makeFinding(
          "critical",
          "REVERSE_SHELL",
          `Reverse shell pattern detected: ${name}`,
          `Found ${rsFiles.length} PHP file(s) matching "${name}" — strong indicator of an active backdoor.`,
          {
            remediation:
              "Delete or quarantine these files immediately. Block outbound connections if possible. " +
              "Rotate all credentials on this server.",
            metadata: { files: rsFiles },
          },
        ),
      );
    }
  }

  // 8. PHP files in /tmp or /var/tmp — malware staging area
  const { stdout: phpInTmp } = await exec.execute(
    `find /tmp /var/tmp -name "*.php" -type f 2>/dev/null | head -20 || true`,
    { timeout: 15000 },
  );
  const tmpPhpFiles = phpInTmp
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (tmpPhpFiles.length > 0) {
    findings.push(
      makeFinding(
        "critical",
        "SUSPICIOUS_FILES",
        `${tmpPhpFiles.length} PHP file(s) found in /tmp or /var/tmp`,
        "PHP scripts in temp directories are commonly used as dropper stages for webshells.",
        {
          remediation:
            "Delete these files immediately. Investigate how they were placed there.",
          metadata: { files: tmpPhpFiles },
        },
      ),
    );
  }

  // 9. iframe injection — malware injects hidden iframes to redirect visitors
  const { stdout: iframeMatches } = await exec.execute(
    `grep -rl --include="*.php" -E "<iframe[^>]+src=[\"']https?://" /home/*/public_html 2>/dev/null | head -10 || true`,
    { timeout: 30000 },
  );
  const iframeFiles = iframeMatches
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (iframeFiles.length > 0) {
    findings.push(
      makeFinding(
        "high",
        "MALWARE",
        `iframe injection pattern found in ${iframeFiles.length} file(s)`,
        "PHP files containing hidden iframes with external URLs are a common drive-by download injection.",
        {
          remediation:
            "Inspect each file. Remove injected iframe tags and identify the source of the injection.",
          metadata: { files: iframeFiles },
        },
      ),
    );
  }

  return findings;
}

// ─── SYSTEM_AUDIT ─────────────────────────────────────────────────────────────

export async function runSystemAudit(exec: Executor): Promise<SecurityFinding[]> {
  const findings: SecurityFinding[] = [];

  // 1. OS details & pending updates
  const { stdout: osRelease } = await exec.execute(
    `cat /etc/os-release 2>/dev/null || true`,
    { timeout: 10000 },
  );
  const prettyNameMatch = osRelease.match(/PRETTY_NAME="([^"]+)"/);
  const prettyName = prettyNameMatch ? prettyNameMatch[1] : "Unknown Linux";

  // 2. Kernel & Reboot required
  const { stdout: kernel } = await exec.execute(`uname -r 2>/dev/null || true`, {
    timeout: 5000,
  });
  const { stdout: rebootReq } = await exec.execute(
    `test -f /var/run/reboot-required && echo "reboot_required" || echo "ok"`,
    { timeout: 5000 },
  );
  if (rebootReq.trim() === "reboot_required") {
    findings.push(
      makeFinding(
        "low",
        "SYSTEM_HEALTH",
        "System reboot required for pending kernel/package updates",
        "The server has updated core packages or kernel that require a system reboot to take effect.",
        {
          remediation: "Schedule a maintenance window and reboot the server.",
          metadata: { os: prettyName, kernel: kernel.trim() },
        },
      ),
    );
  }

  // 3. Disk Space & Inode Usage
  const { stdout: dfOut } = await exec.execute(
    `df -Pk / 2>/dev/null | tail -1 || true`,
    { timeout: 10000 },
  );
  const dfParts = dfOut.trim().split(/\s+/);
  if (dfParts.length >= 5) {
    const usePercent = parseInt(dfParts[4].replace("%", ""), 10);
    if (!isNaN(usePercent)) {
      if (usePercent >= 90) {
        findings.push(
          makeFinding(
            "critical",
            "SYSTEM_HEALTH",
            `Root filesystem disk usage critically high (${usePercent}%)`,
            `The root filesystem has reached ${usePercent}% capacity. Services or database transactions may fail due to lack of disk space.`,
            {
              remediation: "Clean up system logs (/var/log), temporary files, old backups, or resize disk volume.",
              resource: "/",
              metadata: { usedPercent: usePercent, mount: dfParts[5] || "/" },
            },
          ),
        );
      } else if (usePercent >= 80) {
        findings.push(
          makeFinding(
            "medium",
            "SYSTEM_HEALTH",
            `Root filesystem disk usage elevated (${usePercent}%)`,
            `The root filesystem has reached ${usePercent}% capacity.`,
            {
              remediation: "Monitor disk growth and clean up unused files or logs.",
              resource: "/",
              metadata: { usedPercent: usePercent },
            },
          ),
        );
      }
    }
  }

  // 4. Inode Usage
  const { stdout: dfiOut } = await exec.execute(
    `df -Pi / 2>/dev/null | tail -1 || true`,
    { timeout: 10000 },
  );
  const dfiParts = dfiOut.trim().split(/\s+/);
  if (dfiParts.length >= 5) {
    const inodePercent = parseInt(dfiParts[4].replace("%", ""), 10);
    if (!isNaN(inodePercent) && inodePercent >= 85) {
      findings.push(
        makeFinding(
          "high",
          "SYSTEM_HEALTH",
          `Root filesystem inode usage elevated (${inodePercent}%)`,
          `The root filesystem has used ${inodePercent}% of available inodes, typically caused by millions of small cache, session, or mail files.`,
          {
            remediation: "Find and remove large directories containing excessive small files (e.g. PHP session files in /var/lib/php/sessions).",
            resource: "/",
            metadata: { inodePercent },
          },
        ),
      );
    }
  }

  // 5. Memory & Swap
  const { stdout: freeOut } = await exec.execute(`free -m 2>/dev/null || true`, {
    timeout: 5000,
  });
  const memLine = freeOut.split("\n").find((l) => l.startsWith("Mem:"));
  if (memLine) {
    const memParts = memLine.trim().split(/\s+/);
    if (memParts.length >= 7) {
      const totalMem = parseInt(memParts[1], 10);
      const availMem = parseInt(memParts[6], 10);
      if (totalMem > 0 && availMem >= 0) {
        const freePct = Math.round((availMem / totalMem) * 100);
        if (freePct < 5) {
          findings.push(
            makeFinding(
              "high",
              "SYSTEM_HEALTH",
              `Available system memory critically low (${freePct}% available)`,
              `Only ${availMem} MB of ${totalMem} MB memory is currently available. The system is at risk of invoking OOM-killer on critical services.`,
              {
                remediation: "Investigate memory consumers using top/htop or configure swap space.",
                metadata: { totalMem, availMem, freePct },
              },
            ),
          );
        }
      }
    }
  }

  // 6. Time Synchronization (NTP)
  const { stdout: timedateOut } = await exec.execute(
    `timedatectl status 2>/dev/null || chronyc tracking 2>/dev/null || true`,
    { timeout: 5000 },
  );
  if (
    timedateOut &&
    (timedateOut.includes("NTP service: inactive") ||
      timedateOut.includes("System clock synchronized: no"))
  ) {
    findings.push(
      makeFinding(
        "low",
        "SYSTEM_HEALTH",
        "NTP time synchronization is inactive or not synchronized",
        "The system clock is not synchronized with an NTP server. Inaccurate system time causes TLS certificate verification errors and corrupted log timestamps.",
        {
          remediation: "Enable systemd-timesyncd or chrony (e.g. timedatectl set-ntp true).",
        },
      ),
    );
  }

  return findings;
}

// ─── PROCESS_AUDIT ────────────────────────────────────────────────────────────

export async function runProcessAudit(exec: Executor): Promise<SecurityFinding[]> {
  const findings: SecurityFinding[] = [];

  // 1. Deleted-running executables (/proc/*/exe -> deleted) — primary indicator of stealth malware
  const { stdout: deletedExes } = await exec.execute(
    `ls -l /proc/*/exe 2>/dev/null | grep -i '(deleted)' || true`,
    { timeout: 15000 },
  );
  const deletedLines = deletedExes
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  if (deletedLines.length > 0) {
    const suspiciousPids: { pid: string; path: string; cmdline: string }[] = [];
    for (const line of deletedLines) {
      const match = line.match(/\/proc\/(\d+)\/exe\s*->\s*(.+)/);
      if (match) {
        const pid = match[1];
        const exePath = match[2];
        const { stdout: cmdline } = await exec.execute(
          `cat /proc/${pid}/cmdline 2>/dev/null | tr '\\0' ' ' || true`,
          { timeout: 5000 },
        );
        suspiciousPids.push({ pid, path: exePath, cmdline: cmdline.trim() });
      }
    }

    if (suspiciousPids.length > 0) {
      findings.push(
        makeFinding(
          "critical",
          "DELETED_EXECUTABLE",
          `${suspiciousPids.length} process(es) running from deleted binaries (/proc/*/exe)`,
          `Processes are running whose executable files have been unlinked from the filesystem. This is a signature technique used by malware and cryptominers to evade filesystem scans.`,
          {
            remediation: "Inspect the PID and command line. Terminate suspicious processes and isolate the server if unauthorized.",
            metadata: { processes: suspiciousPids },
          },
        ),
      );
    }
  }

  // 2. Processes executing out of /tmp, /var/tmp, /dev/shm (excluding legitimate temporary management scripts)
  const { stdout: tmpProcs } = await exec.execute(
    `ls -l /proc/*/cwd /proc/*/exe 2>/dev/null | grep -E '(/tmp|/var/tmp|/dev/shm)' | grep -v -E '(composer_mgr_|bf-|wp-cli-|composer\\.phar)' || true`,
    { timeout: 15000 },
  );
  if (tmpProcs.trim()) {
    const rawLines = tmpProcs.split("\n").map((l) => l.trim()).filter(Boolean);
    const suspiciousLines = rawLines.filter(
      (l) => !l.includes("composer_mgr_") && !l.includes("bf-") && !l.includes("wp-cli"),
    );
    if (suspiciousLines.length > 0) {
      findings.push(
        makeFinding(
          "critical",
          "PROCESS_ANOMALY",
          `Processes executing or based in temporary directories (/tmp, /var/tmp, /dev/shm)`,
          `Found processes whose current working directory or binary path points into world-writable temporary directories.`,
          {
            remediation: "Inspect the process PIDs and binaries immediately. Terminate malicious processes.",
            metadata: { raw: suspiciousLines.slice(0, 10) },
          },
        ),
      );
    }
  }

  // 3. Web server spawning interactive shells (PHP -> sh/bash)
  const { stdout: webShells } = await exec.execute(
    `ps -eo pid,ppid,user,args 2>/dev/null | grep -E '(php-fpm|lsphp|httpd|apache2|nginx).*([0-9]+).*(sh|bash|python|perl|nc|curl|wget)' | grep -v grep || true`,
    { timeout: 10000 },
  );
  if (webShells.trim()) {
    const lines = webShells.split("\n").filter(Boolean);
    findings.push(
      makeFinding(
        "critical",
        "PROCESS_ANOMALY",
        "Web server process spawned an interactive shell or downloader tool",
        "A web server or PHP worker process appears to have spawned a child shell or downloader process (sh/bash/curl/nc). This indicates remote command execution (RCE).",
        {
          remediation: "Investigate web access logs for corresponding POST requests, identify the compromised PHP file, and quarantine it.",
          metadata: { matches: lines.slice(0, 10) },
        },
      ),
    );
  }

  // 4. Excessive CPU utilization by unknown process
  const { stdout: highCpu } = await exec.execute(
    `ps -eo pid,user,%cpu,%mem,command --sort=-%cpu 2>/dev/null | head -5 || true`,
    { timeout: 10000 },
  );
  const cpuLines = highCpu.split("\n").filter(Boolean);
  if (cpuLines.length > 1) {
    const topProc = cpuLines[1].trim().split(/\s+/);
    if (topProc.length >= 4) {
      const cpuVal = parseFloat(topProc[2]);
      if (!isNaN(cpuVal) && cpuVal >= 90) {
        findings.push(
          makeFinding(
            "medium",
            "PROCESS_ANOMALY",
            `Process PID ${topProc[0]} (${topProc[1]}) consuming ${cpuVal}% CPU`,
            `High CPU load detected from process: ${topProc.slice(4).join(" ")}`,
            {
              remediation: "Verify if this high CPU activity is expected (e.g. backup compression) or unapproved (cryptomining/runaway loop).",
              metadata: { pid: topProc[0], user: topProc[1], cpu: cpuVal, cmd: topProc.slice(4).join(" ") },
            },
          ),
        );
      }
    }
  }

  return findings;
}

// ─── NETWORK_AUDIT ────────────────────────────────────────────────────────────

export async function runNetworkAudit(exec: Executor): Promise<SecurityFinding[]> {
  const findings: SecurityFinding[] = [];

  // 1. Listening ports
  const { stdout: ssOut } = await exec.execute(
    `ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null || true`,
    { timeout: 15000 },
  );

  const lines = ssOut.split("\n").filter(Boolean);
  const exposedDbPorts: { port: number; name: string; addr: string }[] = [];

  const sensitivePorts: Record<number, string> = {
    3306: "MySQL / MariaDB",
    33060: "MySQL X-Protocol",
    5432: "PostgreSQL",
    6379: "Redis",
    11211: "Memcached",
    27017: "MongoDB",
    9200: "Elasticsearch",
  };

  for (const line of lines) {
    for (const [portStr, name] of Object.entries(sensitivePorts)) {
      const port = Number(portStr);
      // Matches :3306 bound to 0.0.0.0:* or *:* or [::]:*
      if (
        (line.includes(`:${port} `) || line.includes(`:${port}\t`)) &&
        (line.includes("0.0.0.0:") || line.includes("*:") || line.includes("[::]:"))
      ) {
        exposedDbPorts.push({ port, name, addr: "0.0.0.0 / [::]" });
      }
    }
  }

  if (exposedDbPorts.length > 0) {
    // Cross-check UFW deny rules for each exposed port.
    // When UFW is active and blocking a port, the external exposure risk is
    // significantly lower — the process binds internally but external traffic
    // is dropped at the firewall. Report as LOW instead of CRITICAL/HIGH to
    // avoid alarm fatigue and reflect the actual threat level accurately.
    const { stdout: ufwRaw } = await exec.execute(
      `ufw status 2>/dev/null || true`,
      { timeout: 8000 },
    );
    const ufwActive = ufwRaw.includes("Status: active");
    const ufwBlockedPorts = new Set<number>();
    if (ufwActive) {
      for (const port of Object.keys(sensitivePorts).map(Number)) {
        // UFW status shows rules like "3306  DENY IN  Anywhere" or "3306/tcp  DENY  Anywhere"
        if (new RegExp(`\\b${port}\\b.*DENY`, "i").test(ufwRaw)) {
          ufwBlockedPorts.add(port);
        }
      }
    }

    for (const db of exposedDbPorts) {
      const isUfwBlocked = ufwBlockedPorts.has(db.port);
      const baseSeverity = db.port === 6379 || db.port === 11211 ? "critical" : "high";
      const severity = isUfwBlocked ? "low" : baseSeverity;

      const title = isUfwBlocked
        ? `${db.name} (port ${db.port}) bound to 0.0.0.0 but blocked by UFW firewall`
        : `${db.name} (port ${db.port}) listening on public network interface (0.0.0.0)`;

      const description = isUfwBlocked
        ? `${db.name} is bound to all interfaces internally (0.0.0.0) but UFW has an active DENY rule blocking external access on port ${db.port}. The service is not reachable from the internet. For full hardening, update the service configuration to bind only to 127.0.0.1.`
        : `The database/cache service is bound to all network interfaces. Unless strictly protected by a firewall, it may be exposed to unauthorized network access or brute-force attacks.`;

      const remediation = isUfwBlocked
        ? `UFW is protecting this port. For complete hardening, also update the ${db.name} bind-address to 127.0.0.1 in its configuration file to restrict the bind at the process level.`
        : `Configure ${db.name} bind-address to 127.0.0.1 in its configuration file, or restrict access via UFW firewall.`;

      findings.push(
        makeFinding(
          severity,
          "LISTENING_PORTS",
          title,
          description,
          {
            remediation,
            resource: `Port ${db.port}`,
            metadata: { service: db.name, port: db.port, bind: db.addr, ufw_blocked: isUfwBlocked },
          },
        ),
      );
    }
  }

  // 2. Insecure protocols (Telnet / Rlogin)
  for (const line of lines) {
    if (line.includes(":23 ") && (line.includes("0.0.0.0") || line.includes("*"))) {
      findings.push(
        makeFinding(
          "critical",
          "LISTENING_PORTS",
          "Telnet daemon (port 23) listening on public network interface",
          "Telnet transmits credentials and traffic in plaintext. It should never be used.",
          {
            remediation: "Disable and remove telnetd immediately; use SSH exclusively.",
            resource: "Port 23",
          },
        ),
      );
    }
  }

  return findings;
}

// ─── FIREWALL_AUDIT ───────────────────────────────────────────────────────────

export async function runFirewallAudit(exec: Executor): Promise<SecurityFinding[]> {
  const findings: SecurityFinding[] = [];

  // Check UFW
  const { stdout: ufwStatus } = await exec.execute(`ufw status 2>/dev/null || true`, {
    timeout: 10000,
  });
  // Check iptables
  const { stdout: iptablesRules } = await exec.execute(
    `iptables -L -n 2>/dev/null | grep -E '^(Chain|ACCEPT|DROP|REJECT)' || true`,
    { timeout: 10000 },
  );

  const isUfwActive = ufwStatus.includes("Status: active");
  const hasIptablesRules = iptablesRules.includes("Chain INPUT") && (iptablesRules.includes("DROP") || iptablesRules.includes("REJECT"));

  if (!isUfwActive && !hasIptablesRules) {
    findings.push(
      makeFinding(
        "high",
        "FIREWALL",
        "No host-based firewall (UFW/iptables) is active",
        "The server does not have an active host firewall. All listening ports are directly accessible from the network.",
        {
          remediation: "Enable UFW with default deny incoming: 'ufw default deny incoming && ufw allow ssh && ufw allow http && ufw allow https && ufw enable'.",
        },
      ),
    );
  } else if (isUfwActive) {
    // Check if OpenLiteSpeed/CyberPanel port 8090 is open
    if (ufwStatus.includes("8090") && ufwStatus.includes("ALLOW")) {
      findings.push(
        makeFinding(
          "low",
          "FIREWALL",
          "CyberPanel admin port 8090 is accessible in UFW",
          "Port 8090 is allowed in UFW rules. Consider restricting access to trusted management IPs only.",
          {
            remediation: "Restrict port 8090 access in UFW to your VPN or office IP allowlist.",
            resource: "Port 8090",
          },
        ),
      );
    }
  }

  return findings;
}

// ─── FAIL2BAN_AUDIT ───────────────────────────────────────────────────────────

export async function runFail2BanAudit(exec: Executor): Promise<SecurityFinding[]> {
  const findings: SecurityFinding[] = [];

  const { stdout: f2bActive } = await exec.execute(
    `systemctl is-active fail2ban 2>/dev/null || true`,
    { timeout: 5000 },
  );

  if (f2bActive.trim() !== "active") {
    findings.push(
      makeFinding(
        "high",
        "FAIL2BAN",
        "Fail2Ban is not installed or service is inactive",
        "Fail2Ban is not running to protect against SSH and web brute-force attacks.",
        {
          remediation: "Install and enable Fail2Ban: 'apt install -y fail2ban && systemctl enable --now fail2ban'.",
        },
      ),
    );
  } else {
    const { stdout: f2bStatus } = await exec.execute(
      `fail2ban-client status 2>/dev/null || true`,
      { timeout: 10000 },
    );
    const jailMatch = f2bStatus.match(/Jail list:\s*(.+)/);
    const jails = jailMatch
      ? jailMatch[1]
          .split(",")
          .map((j) => j.trim())
          .filter(Boolean)
      : [];

    if (jails.length === 0) {
      findings.push(
        makeFinding(
          "medium",
          "FAIL2BAN",
          "Fail2Ban is running but has no active jails configured",
          "The Fail2Ban daemon is running without any active monitoring jails.",
          {
            remediation: "Enable at least the sshd jail in /etc/fail2ban/jail.local.",
          },
        ),
      );
    } else {
      // Collect total currently banned IPs across jails
      let totalBanned = 0;
      for (const jail of jails) {
        const { stdout: jailOut } = await exec.execute(
          `fail2ban-client status ${jail} 2>/dev/null || true`,
          { timeout: 5000 },
        );
        const countMatch = jailOut.match(/Currently banned:\s*(\d+)/);
        if (countMatch) {
          totalBanned += parseInt(countMatch[1], 10);
        }
      }

      findings.push(
        makeFinding(
          "info",
          "FAIL2BAN",
          `Fail2Ban active with ${jails.length} jail(s) (${totalBanned} currently banned IPs)`,
          `Active jails: ${jails.join(", ")}. Currently enforcing ${totalBanned} active IP ban(s).`,
          {
            metadata: { jails, totalBanned },
          },
        ),
      );
    }
  }

  return findings;
}

// ─── SERVICE_AUDIT ────────────────────────────────────────────────────────────

export async function runServiceAudit(exec: Executor): Promise<SecurityFinding[]> {
  const findings: SecurityFinding[] = [];

  // 1. Failed systemd services
  const { stdout: failedServices } = await exec.execute(
    `systemctl --failed --no-legend --no-pager 2>/dev/null | awk '{print $1, $2, $3, $4}' || true`,
    { timeout: 10000 },
  );
  const failedList = failedServices
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (failedList.length > 0) {
    findings.push(
      makeFinding(
        "low",
        "SERVICES",
        `${failedList.length} systemd service(s) currently in failed state`,
        `The following services have failed: ${failedList.slice(0, 5).join(", ")}`,
        {
          remediation: "Inspect service failure causes via 'journalctl -u <service_name> -e'.",
          metadata: { failedServices: failedList },
        },
      ),
    );
  }

  // 2. Custom systemd unit files in /etc/systemd/system pointing to unusual locations
  const { stdout: suspiciousUnits } = await exec.execute(
    `grep -rE 'ExecStart=.*(/tmp|/var/tmp|/dev/shm|/home/)' /etc/systemd/system/ 2>/dev/null || true`,
    { timeout: 15000 },
  );
  if (suspiciousUnits.trim()) {
    const lines = suspiciousUnits.split("\n").filter(Boolean);
    findings.push(
      makeFinding(
        "high",
        "SERVICES",
        "Systemd unit file executes binaries from user home or temporary directories",
        "Found systemd service definitions that execute binaries directly from /home or /tmp.",
        {
          remediation: "Verify service validity; move legitimate service binaries to /usr/local/bin or standard directories.",
          metadata: { entries: lines.slice(0, 5) },
        },
      ),
    );
  }

  return findings;
}

// ─── FILESYSTEM_AUDIT ─────────────────────────────────────────────────────────

export async function runFilesystemAudit(exec: Executor): Promise<SecurityFinding[]> {
  const findings: SecurityFinding[] = [];

  // 1. Exposed database dumps & archives in web-accessible roots only
  // For Bedrock, web-accessible is /home/*/public_html/web; for standard WP, /home/*/public_html
  const { stdout: exposedDumps } = await exec.execute(
    `find /home/*/public_html/web /home/*/public_html/app /var/www/*/web /var/www/*/public -maxdepth 3 -type f \\( -name "*.sql" -o -name "*.sql.gz" -o -name "*.sql.tar" -o -name "*.sql.zip" \\) 2>/dev/null; ` +
    `for d in /home/*/public_html; do [ -d "$d" ] && [ ! -d "$d/web" ] && find "$d" -maxdepth 2 -type f \\( -name "*.sql" -o -name "*.sql.gz" -o -name "*.sql.tar" -o -name "*.sql.zip" \\) 2>/dev/null; done | head -15 || true`,
    { timeout: 20000 },
  );
  const dumpFiles = exposedDumps
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  if (dumpFiles.length > 0) {
    findings.push(
      makeFinding(
        "critical",
        "EXPOSED_BACKUPS",
        `${dumpFiles.length} database SQL dump file(s) exposed in web root`,
        `Directly accessible SQL database backups found in web-accessible directories. Anyone on the internet can download these databases.`,
        {
          remediation: "Delete or move SQL dumps outside of public_html/web immediately.",
          resource: dumpFiles.join(", "),
          remediation_available: true,
          remediation_type: "command",
          metadata: { files: dumpFiles },
        },
      ),
    );
  }

  // 2. World-writable files in /etc
  const { stdout: worldWritableEtc } = await exec.execute(
    `find /etc -maxdepth 3 -type f -perm -0002 2>/dev/null | head -10 || true`,
    { timeout: 15000 },
  );
  const etcFiles = worldWritableEtc
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (etcFiles.length > 0) {
    findings.push(
      makeFinding(
        "critical",
        "WORLD_WRITABLE",
        `${etcFiles.length} world-writable file(s) found in /etc`,
        "Configuration files in /etc are world-writable, allowing any local user to modify system configuration.",
        {
          remediation: "Fix permissions using 'chmod o-w <file>' immediately.",
          resource: etcFiles.join(", "),
          metadata: { files: etcFiles },
        },
      ),
    );
  }

  return findings;
}

// ─── CRON_AUDIT ───────────────────────────────────────────────────────────────

export async function runCronAudit(exec: Executor): Promise<SecurityFinding[]> {
  const findings: SecurityFinding[] = [];

  const { stdout: cronContent } = await exec.execute(
    `cat /etc/crontab /etc/cron.d/* /var/spool/cron/crontabs/* 2>/dev/null || true`,
    { timeout: 15000 },
  );

  const lines = cronContent.split("\n").filter((l) => l.trim() && !l.trim().startsWith("#"));
  const suspiciousLines: string[] = [];

  for (const line of lines) {
    if (
      line.includes("curl ") && (line.includes("| sh") || line.includes("| bash") || line.includes("|sh") || line.includes("|bash")) ||
      line.includes("wget ") && (line.includes("| sh") || line.includes("| bash") || line.includes("|sh") || line.includes("|bash")) ||
      line.includes("/tmp/") ||
      line.includes("/dev/shm/") ||
      line.includes("base64 -d")
    ) {
      suspiciousLines.push(line.trim());
    }
  }

  if (suspiciousLines.length > 0) {
    findings.push(
      makeFinding(
        "critical",
        "CRON_JOBS",
        `${suspiciousLines.length} suspicious cron job command(s) detected`,
        "Found scheduled cron tasks that download and execute scripts directly or execute from temporary directories.",
        {
          remediation: "Inspect /etc/crontab and /var/spool/cron/crontabs/*; remove malicious cron entries.",
          metadata: { suspiciousEntries: suspiciousLines },
        },
      ),
    );
  }

  return findings;
}

// ─── USER_AUDIT ───────────────────────────────────────────────────────────────

export async function runUserAudit(exec: Executor): Promise<SecurityFinding[]> {
  const findings: SecurityFinding[] = [];

  // 1. UID 0 accounts check (only root should have UID 0)
  const { stdout: uidZero } = await exec.execute(
    `awk -F: '($3 == 0) {print $1}' /etc/passwd 2>/dev/null || true`,
    { timeout: 5000 },
  );
  const uidZeroUsers = uidZero
    .split("\n")
    .map((u) => u.trim())
    .filter(Boolean);

  const nonRootUidZero = uidZeroUsers.filter((u) => u !== "root");
  if (nonRootUidZero.length > 0) {
    findings.push(
      makeFinding(
        "critical",
        "USERS",
        `Non-root user(s) with UID 0 detected: ${nonRootUidZero.join(", ")}`,
        "Backdoor accounts with UID 0 have complete root privileges.",
        {
          remediation: "Disable or remove unauthorized UID 0 accounts immediately.",
          resource: nonRootUidZero.join(", "),
          metadata: { accounts: nonRootUidZero },
        },
      ),
    );
  }

  // 2. Sudoers with NOPASSWD: ALL
  const { stdout: nopasswdSudo } = await exec.execute(
    `grep -rE 'NOPASSWD:\\s*ALL' /etc/sudoers /etc/sudoers.d/ 2>/dev/null || true`,
    { timeout: 5000 },
  );
  if (nopasswdSudo.trim()) {
    const lines = nopasswdSudo.split("\n").filter((l) => l.trim() && !l.trim().startsWith("#"));
    if (lines.length > 0) {
      findings.push(
        makeFinding(
          "medium",
          "USERS",
          "Passwordless sudo (NOPASSWD: ALL) configured for one or more users",
          "Users with NOPASSWD: ALL can escalate to root privileges without entering a password.",
          {
            remediation: "Require passwords for sudo commands where appropriate.",
            metadata: { entries: lines },
          },
        ),
      );
    }
  }

  return findings;
}

// ─── CYBERPANEL_AUDIT ─────────────────────────────────────────────────────────

export async function runCyberPanelAudit(exec: Executor): Promise<SecurityFinding[]> {
  const findings: SecurityFinding[] = [];

  const { stdout: cpVersionRaw } = await exec.execute(
    `cat /usr/local/CyberCP/version.txt 2>/dev/null || true`,
    { timeout: 5000 },
  );

  if (cpVersionRaw.trim()) {
    const version = cpVersionRaw.trim();
    const { stdout: lscpdActive } = await exec.execute(
      `systemctl is-active lscpd 2>/dev/null || true`,
      { timeout: 5000 },
    );

    findings.push(
      makeFinding(
        "info",
        "CYBERPANEL",
        `CyberPanel v${version} detected (lscpd service: ${lscpdActive.trim() || "unknown"})`,
        `CyberPanel management service is installed and operational.`,
        {
          metadata: { version, serviceStatus: lscpdActive.trim() },
        },
      ),
    );
  }

  return findings;
}

// ─── PHP_AUDIT ────────────────────────────────────────────────────────────────

export async function runPhpAudit(exec: Executor): Promise<SecurityFinding[]> {
  const findings: SecurityFinding[] = [];

  // Find installed PHP binaries and deduplicate canonical paths (resolving symlinks)
  const { stdout: phpBins } = await exec.execute(
    `for b in $(which php 2>/dev/null; ls -d /usr/bin/php* /usr/local/lsws/lsphp* 2>/dev/null); do [ -x "$b" ] && [ ! -d "$b" ] && (readlink -f "$b" 2>/dev/null || realpath "$b" 2>/dev/null || echo "$b"); done | sort -u || true`,
    { timeout: 10000 },
  );
  const bins = Array.from(
    new Set(
      phpBins
        .split("\n")
        .map((b) => b.trim())
        .filter((b) => b && !b.endsWith(".old") && !b.endsWith(".bak")),
    ),
  );

  const exposePhpFoundIn: string[] = [];

  for (const bin of bins.slice(0, 5)) {
    const { stdout: iniInfo } = await exec.execute(
      `${bin} -i 2>/dev/null | grep -E '^(allow_url_fopen|allow_url_include|disable_functions|expose_php)' || true`,
      { timeout: 10000 },
    );

    if (iniInfo.includes("allow_url_include => On")) {
      findings.push(
        makeFinding(
          "critical",
          "PHP_CONFIG",
          `allow_url_include is enabled in ${bin}`,
          "allow_url_include allows remote file inclusion (RFI) attacks in vulnerable PHP scripts.",
          {
            remediation: "Set 'allow_url_include = Off' in php.ini.",
            resource: bin,
          },
        ),
      );
    }

    if (iniInfo.includes("expose_php => On")) {
      exposePhpFoundIn.push(bin);
    }
  }

  if (exposePhpFoundIn.length > 0) {
    findings.push(
      makeFinding(
        "low",
        "PHP_CONFIG",
        `expose_php is enabled in PHP runtime (${exposePhpFoundIn.join(", ")})`,
        "expose_php reveals exact PHP version headers in HTTP responses.",
        {
          remediation: "Set 'expose_php = Off' in php.ini.",
          resource: exposePhpFoundIn[0],
          metadata: { binaries: exposePhpFoundIn },
        },
      ),
    );
  }

  return findings;
}

// ─── SECURITY_TOOLS_AUDIT ─────────────────────────────────────────────────────

export async function runSecurityToolsAudit(exec: Executor): Promise<SecurityFinding[]> {
  const findings: SecurityFinding[] = [];

  const { stdout: toolsStatus } = await exec.execute(
    `echo "fail2ban:$(systemctl is-active fail2ban 2>/dev/null || echo missing)"; ` +
      `echo "clamav:$(systemctl is-active clamav-daemon 2>/dev/null || echo missing)"; ` +
      `echo "ufw:$(ufw status 2>/dev/null | head -1 || echo missing)"; ` +
      `echo "apparmor:$(systemctl is-active apparmor 2>/dev/null || echo missing)"`,
    { timeout: 10000 },
  );

  const toolMap: Record<string, string> = {};
  for (const line of toolsStatus.split("\n").filter(Boolean)) {
    const [k, v] = line.split(":");
    if (k && v) toolMap[k.trim()] = v.trim();
  }

  findings.push(
    makeFinding(
      "info",
      "SECURITY_TOOLS",
      "Security tools inventory and status summary",
      `Discovered security tool statuses: Fail2Ban (${toolMap.fail2ban || "unknown"}), UFW (${toolMap.ufw || "unknown"}), ClamAV (${toolMap.clamav || "unknown"}), AppArmor (${toolMap.apparmor || "unknown"}).`,
      {
        metadata: toolMap,
      },
    ),
  );

  return findings;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function resolveAuthLog(exec: Executor): Promise<string | null> {
  // Try Ubuntu/Debian paths first, then CentOS/RHEL
  for (const path of [
    "/var/log/auth.log",
    "/var/log/secure",
    "/var/log/auth.log.1",
  ]) {
    const { stdout } = await exec.execute(
      `test -f ${path} && echo exists || echo missing`,
    );
    if (stdout.trim() === "exists") return path;
  }
  return null;
}
