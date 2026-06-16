---
title: "Microsoft Sentinel and a Honeypot That Got Hit in Under an Hour"
date: 2026-06-15
description: "Connecting Microsoft Sentinel to the slytech.us hybrid environment, building custom detection rules mapped to MITRE ATT&CK, deploying a deliberately exposed honeypot VM, and watching real global attack traffic roll in."
category: detection
draft: true
tags: [sentinel, honeypot, azure, siem, kql, threat-detection, defender, log-analytics]
---

The governance layer was in place. Logs flowing. Policies enforcing. Everything looked clean from the inside. The question was what it looked like from the outside, and whether anything was watching for the answer. This project connects Microsoft Sentinel to the existing slytech.us environment, builds detection rules against real identity data, and deploys a honeypot VM with RDP intentionally exposed to see what shows up.

It builds on the [hybrid identity](https://blog.slytech.us/blog/entra-connect-hybrid-identity), [endpoint management](https://blog.slytech.us/blog/intune-defender-endpoint-management), and [governance](https://blog.slytech.us/blog/cloud-governance-terraform-policy-workbooks) work from the previous three posts.

## Eight Connectors, Zero Configuration

The Log Analytics workspace was already running. Sentinel connected to it directly. No new infrastructure, no separate data pipeline. Eight Microsoft data connectors auto-discovered and connected on first login.

- Microsoft Defender for Endpoint
- Microsoft Entra ID
- Microsoft Entra ID Protection
- Microsoft Defender XDR
- Microsoft Defender for Cloud Apps
- Microsoft Defender for Identity
- Microsoft Defender for Office 365
- Microsoft 365 Insider Risk Management

Everything already running in the tenant started feeding into the SIEM automatically.

![Sentinel connected to law-slytech-lab workspace in the Defender portal](/images/01-sentinel-connected.png)

![Eight Microsoft data connectors auto-connected in Sentinel](/images/02-sentinel-data-connectors.png)

![Sentinel overview showing events in previous 24 hours](/images/03-sentinel-overview.png)

## The Detection Rules

Three custom analytics rules against identity data already flowing from Entra ID.

**Brute Force Sign-in Attempt** detects multiple failed logins from the same IP within an hour:

```kql
SigninLogs
| where TimeGenerated > ago(1h)
| where ResultType != "0"
| summarize FailedAttempts = count() by IPAddress, UserPrincipalName
| where FailedAttempts >= 5
| project IPAddress, UserPrincipalName, FailedAttempts
```

**Disabled Account Sign-in Attempt** catches authentication attempts against deprovisioned accounts. Result code `50057` is specifically "user account is disabled" in Entra ID:

```kql
SigninLogs
| where TimeGenerated > ago(1h)
| where ResultType == "50057"
| project TimeGenerated, UserPrincipalName, IPAddress, Location, ResultDescription
```

**Privileged Account Created** flags any account added to an admin or global role:

```kql
AuditLogs
| where TimeGenerated > ago(1h)
| where OperationName == "Add member to role"
| where Result == "success"
| extend TargetUser = tostring(TargetResources[0].userPrincipalName)
| extend Role = tostring(TargetResources[0].displayName)
| where Role contains "Admin" or Role contains "Global"
| project TimeGenerated, TargetUser, Role, InitiatedBy = tostring(InitiatedBy.user.userPrincipalName)
```

All three ran every 5 minutes, evaluated the last hour of data, and alerted on any result.

![Brute force rule configuration showing query, scheduling, and severity settings](/images/04-sentinel-brute-force-rule.png)

![All three analytics rules enabled in Sentinel](/images/05-sentinel-analytics-rules.png)

## MITRE ATT&CK Mapping

| Rule | Tactic | Technique |
|---|---|---|
| Brute Force Sign-in Attempt | Credential Access | T1110 — Brute Force |
| Disabled Account Sign-in Attempt | Defense Evasion / Initial Access | T1078 — Valid Accounts |
| Privileged Account Created | Privilege Escalation | T1098 — Account Manipulation |

T1110 is what automated scanners do the moment they find an exposed service. T1078 covers what happens after an account gets compromised and then deprovisioned. T1098 is the endgame: persistence through privilege escalation.

## Alerts Were Firing but Incidents Weren't

The rules were enabled, data was flowing, and the queries returned results in Advanced Hunting. Nothing appeared in the incidents queue.

Two things were working against each other. The original brute force query used `bin(TimeGenerated, 5m)` to group events into time buckets. Failed logins from the same IP got split across multiple bins and none crossed the threshold individually. Removing the time bin fixed it.

The second issue was incident correlation being disabled. Alerts were sitting in the SecurityAlert table without rolling up into the incidents queue. Enabling correlation and alert grouping on all three rules fixed that.

The way to check whether rules are generating alerts before blaming the rule logic:

```kql
SecurityAlert
| where TimeGenerated > ago(24h)
| project TimeGenerated, AlertName, AlertSeverity, Description
| order by TimeGenerated desc
```

Alerts were there. The incidents queue was the problem, not the detection.

![Advanced Hunting showing failed login attempts from two accounts](/images/07-sentinel-hunting-failed-logins.png)

![Brute force incident created in Sentinel with 3 grouped alerts](/images/08-sentinel-incident-created.png)

![Incident detail showing attack timeline and severity](/images/09-sentinel-incident-details.png)

## The Honeypot

A Windows Server 2019 VM provisioned via Terraform into a dedicated subnet with all inbound traffic allowed. Named `CORPDC02` internally to look like a backup domain controller. Public IP exposed to the internet with RDP on port 3389 wide open.

```hcl
resource "azurerm_network_security_group" "honeypot" {
  name                = "nsg-honeypot"
  location            = azurerm_resource_group.slytech.location
  resource_group_name = azurerm_resource_group.slytech.name
  security_rule {
    name                       = "allow-all-inbound"
    priority                   = 100
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "*"
    source_port_range          = "*"
    destination_port_range     = "*"
    source_address_prefix      = "*"
    destination_address_prefix = "*"
  }
}
```

The VM went on its own subnet because the main lab subnet NSG has RDP deny rules. Traffic hits the subnet NSG before the NIC-level NSG, so the honeypot's allow-all rule was getting overridden. A dedicated subnet with no restrictive rules fixed it.

![Terraform plan showing honeypot resources to be created](/images/10-honeypot-terraform-plan-1.png)

![Terraform plan continued showing VM configuration details](/images/11-honeypot-terraform-plan-2.png)

![Terraform apply complete showing all resources created successfully](/images/12-honeypot-terraform-apply.png)

![Public IP address assigned to the honeypot VM](/images/13-honeypot-public-ip.png)

![RDP session connected to CORPDC02](/images/14-honeypot-rdp-connected.png)

Getting logs from the honeypot into Sentinel required switching from the deprecated MMA agent to the Azure Monitor Agent and creating a Data Collection Rule targeting Security Events. The AMA agent also needed a managed identity assigned to the VM before it would connect.

```powershell
az vm identity assign -g rg-slytech-lab -n vm-honeypot
az vm extension set `
    --resource-group rg-slytech-lab `
    --vm-name vm-honeypot `
    --name AzureMonitorWindowsAgent `
    --publisher Microsoft.Azure.Monitor `
    --version 1.22 `
    --enable-auto-upgrade true
```

## The First Few Hours

Within the first few hours of the VM being live, 53 attacks were already visible on the map. The geographic enrichment query joins attack IPs against a 54,000-record GeoIP watchlist imported into Sentinel:

```kql
let GeoIPDB_FULL = _GetWatchlist("geoip");
SecurityEvent
| where EventID == 4625
| where TimeGenerated > ago(24h)
| where Computer contains "CORPDC02"
| evaluate ipv4_lookup(GeoIPDB_FULL, IpAddress, network)
| summarize AttackCount = count() by IpAddress, cityname, countryname, latitude, longitude
| where AttackCount > 0 and isnotempty(latitude) and isnotempty(longitude)
```

The automated tools hitting the machine cycled through the same username list: `admin`, `administrator`, `user`, `sa`, `root`, `guest`, `test`. They didn't know what was on the machine. Every RDP-exposed IP on the internet gets the same treatment.

![Attack map showing 53 attacks from multiple countries in the first few hours](/images/16-honeypot-attack-map-early.png)

One thing worth noting on the map setup: the Defender portal workbook editor wouldn't accept latitude/longitude column mappings through its UI. Opening the same workbook in the Azure portal editor, configuring the map settings there, and the changes synced back to the Defender portal.

## Overnight

Left the honeypot running overnight. The numbers tell the rest of the story.

![Attack map showing global attack distribution after overnight run](/images/16-honeypot-attack-map.png)

![Country breakdown showing top attacking nations by volume](/images/17-honeypot-countries.png)

![Hourly attack trend showing volume over 24 hours](/images/18-honeypot-attack-trend.png)

## Wrapping Up

Building detections in a lab against manufactured data is useful. Watching a real IP from Vietnam try `administrator`, `admin`, and `sa` against a machine built twenty minutes earlier is different. The rule firing, the incident appearing, the source IP mapping to a country on the attack map — that's when the detection pipeline stops being abstract.

The incidents queue debugging was the more valuable lesson. Alerts existing in the SecurityAlert table while the incidents queue stayed empty is a failure mode that's easy to misread as broken detection logic. It's not. The query was fine. The correlation settings were the problem. Checking SecurityAlert directly before rewriting the rule would have saved the time spent second-guessing the KQL.

The environment is still running.
