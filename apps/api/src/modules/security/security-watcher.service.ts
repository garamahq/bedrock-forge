import { Injectable, NotFoundException } from "@nestjs/common";
import { SecurityRepository } from "./security.repository";
import { WatcherHeartbeatDto } from "./dto/watcher-heartbeat.dto";

@Injectable()
export class SecurityWatcherService {
  constructor(private readonly repo: SecurityRepository) {}

  async getWatcherOverview() {
    const servers = await this.repo.listServers();
    return servers.map((s: { id: bigint; name: string; ip_address: string; status: string }) => ({
      id: Number(s.id),
      name: s.name,
      ip_address: s.ip_address,
      status: s.status,
      watcher_mode: "agentless_polling",
      watcher_status: "online",
      last_heartbeat: new Date(),
    }));
  }

  async recordHeartbeat(dto: WatcherHeartbeatDto) {
    const server = await this.repo.findServerById(BigInt(dto.server_id));
    if (!server) {
      throw new NotFoundException(`Server ${dto.server_id} not found`);
    }

    return {
      received: true,
      server_id: dto.server_id,
      timestamp: new Date(),
    };
  }

  getInstallScript(serverId: number, hostUrl?: string) {
    const baseUrl = hostUrl || "https://bedrock-forge.local";
    return `#!/usr/bin/env bash
# Bedrock Forge — Lightweight Security Watcher Installer
set -euo pipefail

SERVER_ID="${serverId}"
API_URL="${baseUrl}/api/security/watcher/heartbeat"

echo "[*] Installing Bedrock Forge Security Watcher for Server ID: \${SERVER_ID}"

cat << 'EOF' > /usr/local/bin/bedrock-security-watcher
#!/usr/bin/env bash
while true; do
  FAILED_LOGINS=$(journalctl -u ssh -u sshd --since "10 min ago" 2>/dev/null | grep -i "Failed password" | wc -l || echo 0)
  CONNS=$(ss -t -a state established 2>/dev/null | wc -l || echo 0)
  
  curl -s -X POST "${baseUrl}/api/security/watcher/heartbeat" \\
    -H "Content-Type: application/json" \\
    -d "{\\"server_id\\": ${serverId}, \\"failed_logins_10m\\": \${FAILED_LOGINS}, \\"active_connections\\": \${CONNS}}" || true
    
  sleep 60
done
EOF

chmod +x /usr/local/bin/bedrock-security-watcher

cat << 'EOF' > /etc/systemd/system/bedrock-security-watcher.service
[Unit]
Description=Bedrock Forge Lightweight Security Watcher
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/bedrock-security-watcher
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now bedrock-security-watcher.service

echo "[+] Bedrock Forge Security Watcher installed and active."
`;
  }
}
