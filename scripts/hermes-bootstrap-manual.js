#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { HetznerProvider } from "../src/providers/hetzner.js";

const provider = new HetznerProvider();
const name = process.argv[2] || `bb-hermes-manual-${Date.now().toString(36)}`;

const cloudInit = `#!/bin/bash
set -euo pipefail
exec > /var/log/botboot-provision.log 2>&1
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl git jq unzip wget ca-certificates gnupg python3 python3-pip python3-venv ffmpeg ripgrep
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs
id agent &>/dev/null || useradd -m -s /bin/bash agent
git clone --recurse-submodules https://github.com/NousResearch/hermes-agent.git /opt/hermes-agent
cd /opt/hermes-agent
python3 -m venv /opt/hermes-agent/venv
/opt/hermes-agent/venv/bin/pip install --upgrade pip setuptools wheel
/opt/hermes-agent/venv/bin/pip install -e ".[all]"
npm install 2>/dev/null || true
chmod -R a+rX /opt/hermes-agent
chmod a+rx /opt/hermes-agent/venv/bin/hermes
chmod a+rx /opt/hermes-agent/venv/bin/python3
ln -sf /opt/hermes-agent/venv/bin/hermes /usr/local/bin/hermes
cat > /etc/sudoers.d/agent-gateway << 'SUDOERS'
agent ALL=(ALL) NOPASSWD: /bin/systemctl restart botboot-agent, /bin/systemctl stop botboot-agent, /bin/systemctl start botboot-agent, /bin/systemctl status botboot-agent, /usr/bin/systemctl restart botboot-agent, /usr/bin/systemctl stop botboot-agent, /usr/bin/systemctl start botboot-agent, /usr/bin/systemctl status botboot-agent, /bin/journalctl *, /usr/bin/journalctl *
SUDOERS
chmod 440 /etc/sudoers.d/agent-gateway
su - agent -c 'mkdir -p ~/.hermes/{cron,sessions,logs,memories,skills,pairing,hooks,image_cache,audio_cache,whatsapp/session}'
if [ -f /root/.ssh/authorized_keys ]; then
  su - agent -c "mkdir -p ~/.ssh && chmod 700 ~/.ssh"
  cp /root/.ssh/authorized_keys /home/agent/.ssh/authorized_keys
  chown agent:agent /home/agent/.ssh/authorized_keys
  chmod 600 /home/agent/.ssh/authorized_keys
fi
cat > /etc/systemd/system/botboot-agent.service << 'SYSTEMD'
[Unit]
Description=BotBoot Agent (Hermes Manual Bootstrap)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=agent
Group=agent
WorkingDirectory=/home/agent
ExecStart=/usr/local/bin/hermes gateway
Restart=on-failure
RestartSec=10
NoNewPrivileges=yes
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
SYSTEMD
systemctl daemon-reload
systemctl enable botboot-agent
# Do not start yet; operator will run hermes setup / configure manually.
echo "=== Hermes manual bootstrap complete: $(date -u) ==="
echo "Next steps: ssh in, run 'su - agent', then 'hermes setup' or 'hermes gateway setup'."
`;

const main = async () => {
  console.log(`🚀 Creating manual Hermes bootstrap VPS: ${name}...`);
  const machine = await provider.createMachine({
    name,
    cloudInit,
    labels: { managed_by: 'botboot', runtime: 'hermes', mode: 'manual-bootstrap' },
  });
  console.log(JSON.stringify(machine, null, 2));
  console.log(`\nSSH:\nssh -i ${process.env.HETZNER_SSH_KEY_PATH || '/home/ubuntu/.ssh/id_ed25519_hetzner'} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null root@${machine.ip}`);
  console.log("\nThen: su - agent && hermes setup");
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
