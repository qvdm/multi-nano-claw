import * as cdk from 'aws-cdk-lib';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as backup from 'aws-cdk-lib/aws-backup';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as events from 'aws-cdk-lib/aws-events';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export class NanoClawStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // --- VPC: use default VPC, pick first public subnet in one AZ ---
    const vpc = ec2.Vpc.fromLookup(this, 'DefaultVpc', { isDefault: true });

    // Pin to a single AZ for EBS volume attachment
    const az = cdk.Stack.of(this).availabilityZones[0];

    // --- Security Group: zero inbound, HTTPS outbound ---
    const sg = new ec2.SecurityGroup(this, 'NanoClawSG', {
      vpc,
      description: 'NanoClaw - outbound HTTPS only, no inbound',
      allowAllOutbound: false,
    });
    sg.addEgressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      'HTTPS to APIs and channels',
    );
    sg.addEgressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(53),
      'DNS over TCP',
    );
    sg.addEgressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.udp(53),
      'DNS over UDP',
    );
    // HTTP needed for package managers and Docker image pulls
    sg.addEgressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(80),
      'HTTP for package repos',
    );

    // --- Secrets Manager ---
    const secret = new secretsmanager.Secret(this, 'NanoClawSecrets', {
      secretName: 'nanoclaw/secrets',
      description: 'NanoClaw API keys and channel tokens',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({
          ANTHROPIC_API_KEY: 'REPLACE_ME',
          CLAUDE_CODE_OAUTH_TOKEN: 'REPLACE_ME',
          ASSISTANT_NAME: 'Andy',
        }),
        generateStringKey: '_placeholder',
      },
    });

    // --- CloudWatch Log Group ---
    const logGroup = new logs.LogGroup(this, 'NanoClawLogs', {
      logGroupName: '/nanoclaw/application',
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // --- IAM Role ---
    const role = new iam.Role(this, 'NanoClawRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      description: 'NanoClaw EC2 instance role',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'AmazonSSMManagedInstanceCore',
        ),
      ],
    });

    // Secrets Manager read (scoped)
    secret.grantRead(role);

    // CloudWatch Logs write (scoped)
    logGroup.grantWrite(role);

    // EC2 volume operations for data volume attachment
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ec2:AttachVolume', 'ec2:DetachVolume', 'ec2:DescribeVolumes'],
        resources: ['*'],
      }),
    );

    // S3 read access for deploy script (tar+S3 local deploys)
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetObject'],
        resources: [
          `arn:aws:s3:::nanoclaw-deploy-${cdk.Stack.of(this).account}/*`,
        ],
      }),
    );

    // --- Persistent EBS Data Volume ---
    const dataVolume = new ec2.Volume(this, 'NanoClawDataVolume', {
      availabilityZone: az,
      size: cdk.Size.gibibytes(20),
      volumeType: ec2.EbsDeviceVolumeType.GP3,
      encrypted: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    cdk.Tags.of(dataVolume).add('Name', 'nanoclaw-data');

    // --- User Data Script ---
    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      '#!/bin/bash',
      'set -euo pipefail',
      'exec > >(tee /var/log/user-data.log) 2>&1',
      '',
      '# System packages',
      'dnf update -y -q',
      'dnf install -y -q docker git',
      '',
      '# Node.js 20 via nodesource',
      'curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -',
      'dnf install -y -q nodejs',
      '',
      '# Docker',
      'systemctl enable docker',
      'systemctl start docker',
      'usermod -aG docker ec2-user',
      '',
      '# Swap (1GB insurance for Chromium peaks)',
      'if [ ! -f /swapfile ]; then',
      '  dd if=/dev/zero of=/swapfile bs=1M count=1024',
      '  chmod 600 /swapfile',
      '  mkswap /swapfile',
      '  swapon /swapfile',
      "  echo '/swapfile swap swap defaults 0 0' >> /etc/fstab",
      'fi',
      '',
      '# Attach persistent EBS data volume',
      'TOKEN=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")',
      'INSTANCE_ID=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/instance-id)',
      `REGION=${cdk.Stack.of(this).region}`,
      `VOLUME_ID=${dataVolume.volumeId}`,
      '',
      '# Wait for volume to be available, then attach',
      'aws ec2 attach-volume --volume-id $VOLUME_ID --instance-id $INSTANCE_ID --device /dev/xvdf --region $REGION || true',
      'sleep 10',
      '',
      '# Format if new (no filesystem)',
      'DEVICE=/dev/xvdf',
      '[ -b /dev/nvme1n1 ] && DEVICE=/dev/nvme1n1',
      'if ! blkid $DEVICE; then',
      '  mkfs.ext4 $DEVICE',
      'fi',
      'mkdir -p /opt/nanoclaw-data',
      'mount $DEVICE /opt/nanoclaw-data',
      "echo \"$DEVICE /opt/nanoclaw-data ext4 defaults,nofail 0 2\" >> /etc/fstab",
      '',
      '# Application setup',
      'APP_DIR=/opt/nanoclaw',
      'DATA_DIR=/opt/nanoclaw-data',
      '',
      '# Persistent directories on data volume',
      'mkdir -p $DATA_DIR/{store,data,logs,groups}',
      '',
      '# Clone or update app code',
      'if [ ! -d "$APP_DIR/.git" ]; then',
      '  git clone https://github.com/qvdm/multi-nano-claw.git $APP_DIR',
      'else',
      '  cd $APP_DIR && git pull || true',
      'fi',
      '',
      'cd $APP_DIR',
      '',
      '# Symlink persistent dirs to data volume',
      'for dir in store data logs groups; do',
      '  rm -rf "$APP_DIR/$dir"',
      '  ln -sfn "$DATA_DIR/$dir" "$APP_DIR/$dir"',
      'done',
      '',
      '# Build (full install for devDeps like typescript, then prune)',
      'npm install --ignore-scripts',
      'npm run build',
      'npm prune --production --ignore-scripts',
      'npm rebuild better-sqlite3',
      '',
      '# Install kiro-cli (for kiro provider mode)',
      'sudo -u ec2-user mkdir -p /home/ec2-user/.local/bin',
      'if ! sudo -u ec2-user /home/ec2-user/.local/bin/kiro-cli --version &>/dev/null; then',
      '  sudo -u ec2-user bash -c "curl -fsSL https://cli.kiro.dev/install | bash"',
      'fi',
      '',
      '# Add kiro-cli to ec2-user PATH for interactive sessions',
      'if ! grep -q ".local/bin" /home/ec2-user/.bashrc 2>/dev/null; then',
      "  echo 'export PATH=\"$HOME/.local/bin:$PATH\"' >> /home/ec2-user/.bashrc",
      'fi',
      '',
      '# Persist kiro-cli auth on data volume (survives spot replacement)',
      'mkdir -p $DATA_DIR/.kiro-cli-auth',
      'chown ec2-user:ec2-user $DATA_DIR/.kiro-cli-auth',
      'sudo -u ec2-user mkdir -p /home/ec2-user/.local/share',
      'if [ ! -L /home/ec2-user/.local/share/kiro-cli ]; then',
      '  rm -rf /home/ec2-user/.local/share/kiro-cli',
      '  sudo -u ec2-user ln -sfn $DATA_DIR/.kiro-cli-auth /home/ec2-user/.local/share/kiro-cli',
      'fi',
      '',
      '# Install systemd service',
      `cat > /etc/systemd/system/nanoclaw.service << 'SERVICEEOF'`,
      '[Unit]',
      'Description=NanoClaw AI Assistant',
      'After=network-online.target docker.service',
      'Wants=network-online.target',
      '',
      '[Service]',
      'Type=simple',
      'User=ec2-user',
      'WorkingDirectory=/opt/nanoclaw',
      'ExecStart=/usr/bin/node dist/index.js',
      'Restart=always',
      'RestartSec=10',
      `Environment=NANOCLAW_SECRETS_ARN=${secret.secretArn}`,
      'Environment=MAX_CONCURRENT_CONTAINERS=1',
      'Environment=LOG_LEVEL=info',
      `Environment=AWS_REGION=${cdk.Stack.of(this).region}`,
      'Environment=KIRO_CLI_PATH=/home/ec2-user/.local/bin/kiro-cli',
      'TimeoutStopSec=15',
      'KillSignal=SIGTERM',
      '',
      '[Install]',
      'WantedBy=multi-user.target',
      'SERVICEEOF',
      '',
      'chown -R ec2-user:ec2-user $APP_DIR $DATA_DIR',
      'systemctl daemon-reload',
      'systemctl enable nanoclaw',
      'systemctl start nanoclaw',
    );

    // --- Launch Template ---
    const launchTemplate = new ec2.LaunchTemplate(this, 'NanoClawLT', {
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T4G,
        ec2.InstanceSize.SMALL,
      ),
      machineImage: ec2.MachineImage.latestAmazonLinux2023({
        cpuType: ec2.AmazonLinuxCpuType.ARM_64,
      }),
      securityGroup: sg,
      role,
      userData,
      httpTokens: ec2.LaunchTemplateHttpTokens.REQUIRED, // IMDSv2
      associatePublicIpAddress: true,
      spotOptions: {
        requestType: ec2.SpotRequestType.ONE_TIME,
        maxPrice: 0.02, // ~$14/mo cap, well above typical ~$5/mo
      },
      blockDevices: [
        {
          deviceName: '/dev/xvda',
          volume: ec2.BlockDeviceVolume.ebs(20, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
            encrypted: true,
          }),
        },
      ],
    });

    // --- Auto Scaling Group (spot, min=1/max=1, single AZ) ---
    const asg = new autoscaling.AutoScalingGroup(this, 'NanoClawASG', {
      vpc,
      launchTemplate,
      minCapacity: 1,
      maxCapacity: 1,
      vpcSubnets: {
        availabilityZones: [az],
        subnetType: ec2.SubnetType.PUBLIC,
      },
    });

    cdk.Tags.of(asg).add('Name', 'nanoclaw');

    // --- AWS Backup for data volume ---
    const backupVault = new backup.BackupVault(this, 'NanoClawBackupVault', {
      backupVaultName: 'nanoclaw-backup',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const backupPlan = new backup.BackupPlan(this, 'NanoClawBackupPlan', {
      backupPlanName: 'nanoclaw-daily',
      backupVault,
      backupPlanRules: [
        new backup.BackupPlanRule({
          ruleName: 'daily-7day-retention',
          scheduleExpression: events.Schedule.cron({
            hour: '3',
            minute: '0',
          }),
          deleteAfter: cdk.Duration.days(7),
        }),
      ],
    });

    backupPlan.addSelection('DataVolume', {
      resources: [
        backup.BackupResource.fromArn(
          `arn:aws:ec2:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:volume/${dataVolume.volumeId}`,
        ),
      ],
    });

    // --- Outputs ---
    new cdk.CfnOutput(this, 'SecretArn', {
      value: secret.secretArn,
      description: 'Secrets Manager ARN — populate with: aws secretsmanager put-secret-value',
    });

    new cdk.CfnOutput(this, 'DataVolumeId', {
      value: dataVolume.volumeId,
      description: 'Persistent EBS data volume ID',
    });

    new cdk.CfnOutput(this, 'AsgName', {
      value: asg.autoScalingGroupName,
      description: 'ASG name — find instance ID via: aws autoscaling describe-auto-scaling-groups',
    });

    new cdk.CfnOutput(this, 'ConnectCommand', {
      value: `aws ssm start-session --target <instance-id> --region ${cdk.Stack.of(this).region}`,
      description: 'SSM connect command (replace <instance-id>)',
    });
  }
}
