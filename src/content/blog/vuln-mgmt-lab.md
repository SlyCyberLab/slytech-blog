---
title: "Vulnerability Management Lab: Scanning, Breaking, and Fixing a Windows VM with Nessus"
date: 2027-03-30
description: "A three-scan vulnerability management exercise using Nessus on Azure: baseline scan, deliberate vulnerable software install, then full remediation."
category: detection
tags:
  - nessus
  - vulnerability-management
  - azure
  - windows
  - remediation
  - cybersecurity
---

Before I built out the Proxmox homelab, I did this work on Azure. I'm documenting it now because the methodology holds up and because the numbers from this lab directly shaped how I think about detection and hardening in everything I've built since.

The idea was simple. Take a clean Windows 10 VM, scan it with Nessus to get a baseline, deliberately install a bunch of vulnerable software, scan it again, then remediate and scan a third time. Three scans, three snapshots of the same machine in different states. The before and after numbers are what make this worth doing.



## Why Nessus on Azure

Tenable Nessus Professional is what enterprise vulnerability management teams actually use. The free version (Essentials) caps you at 16 IPs. For a single VM lab the Professional trial gives you full capability including credentialed scanning, which is the only way to get a complete picture of what's actually installed and configured on a system.

Azure made sense at the time because I didn't have a dedicated homelab yet. A Standard D2s v3 (2 vCPUs, 8GB RAM) running Windows 10 Pro is enough to install Nessus and run scans against itself. The whole lab cost maybe a few dollars in compute time.

## Setting Up the VM

Nothing unusual here. Windows 10 Pro on Azure, Standard HDD, firewall disabled for the lab environment. The one thing that trips people up is credentialed scanning.

Nessus needs to authenticate to the target machine to see what's actually installed, not just what's listening on the network. Non-credentialed scans miss a huge percentage of vulnerabilities because they can only see what's exposed externally. For a Windows machine you need to enable the Remote Registry and make sure local account tokens aren't being filtered.

One PowerShell command handles the token filtering issue:

```powershell
Set-ItemProperty -Path "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System" -Name "LocalAccountTokenFilterPolicy" -Value 1 -Type DWord -Force
```

Without this, Nessus authenticates but then gets access denied when it tries to enumerate installed software and registry values. The scan completes but misses most findings. It looks like it worked until you compare results with a properly configured credentialed scan and see the difference.

![PowerShell registry command for credentialed scanning](https://imgur.com/fv37Z1A.png)

## Scan 1: The Baseline

Fresh Windows 10 Pro install, fully updated, nothing extra installed. This is what a clean machine looks like to a vulnerability scanner.

![Baseline scan configuration in Nessus](https://imgur.com/Sodg9O4.png)

![Baseline scan credentials configuration](https://imgur.com/Aa1AnAS.png)

The baseline results were unremarkable by design. A few informational findings, maybe some medium severity items related to Windows configuration. This is the control state. Everything after this is the experiment.

![Baseline scan vulnerability results](https://imgur.com/Qr0iaO4.png)

## Deliberately Breaking It

This is the part that makes the lab actually interesting. I installed four things specifically chosen because they're known to introduce significant vulnerabilities:

**MySQL 5.6.21** is five major versions behind current. It has documented CVEs for remote code execution, privilege escalation, and information disclosure. I also created weak user accounts to compound the issue.

```batch
cd C:\mysql-5.6.21-winx64\bin
mysqld --initialize-insecure
mysqld --install
net start mysql
```

```sql
CREATE USER 'admin'@'%' IDENTIFIED BY 'password123';
GRANT ALL PRIVILEGES ON *.* TO 'admin'@'%' WITH GRANT OPTION;
```

![MySQL service initialization](https://imgur.com/1Hd64g3.png)

**SMBv1** is the protocol behind EternalBlue, the exploit used in WannaCry. Enabling it on a modern Windows machine immediately introduces one of the most well-known critical vulnerabilities in Windows history.

```powershell
Enable-WindowsOptionalFeature -Online -FeatureName "SMB1Protocol"
```

![Enabling SMBv1 protocol](https://imgur.com/e64AdXL.png)

**Firefox 110** is multiple major versions behind. Outdated browsers are consistently one of the highest-volume vulnerability sources on enterprise endpoints because they're easy to forget about and updates are easy to defer.

**XAMPP** brought in an outdated Apache and PHP stack. Web server components installed on endpoints that don't need them are a classic attack surface expansion.

## Scan 2: The Damage

The second scan ran against the same machine after all four of those were installed. The jump in findings was significant. Critical and high severity counts went from minimal to substantial, driven primarily by the MySQL version, the SMBv1 enablement, and the browser vulnerabilities.

![Compromised system scan overview](https://imgur.com/T4nAIBB.png)

![Full vulnerability list after compromise](https://imgur.com/OKnxBWa.png)

This is the point of the exercise. One outdated database, one legacy protocol, one old browser, and a web stack that shouldn't be there in the first place. Each one feels minor in isolation. Together they represent a machine that would be relatively trivial to exploit from multiple angles.

## Remediation

The fix list was straightforward. Uninstall MySQL 5.6, disable SMBv1, uninstall outdated Firefox and install current, remove XAMPP, re-enable UAC, run Windows Update to completion.

```powershell
Disable-WindowsOptionalFeature -Online -FeatureName "SMB1Protocol"
```

![Windows Update running during remediation](https://imgur.com/M5fiPUP.png)

Nothing fancy. This is what patch management and software inventory management actually prevents. The vulnerability reduction wasn't from running some specialized hardening tool. It was from removing outdated software and keeping what remained current.

## Scan 3: After Remediation

The final scan showed the machine back near baseline levels. The critical and high findings that came from the vulnerable software were gone. What remained were findings inherent to the Windows configuration itself, things that would require more targeted hardening work beyond just software currency.

![Final scan results after remediation](https://imgur.com/EfwNqXZ.png)

![Scan history showing all three scans and the trend](https://imgur.com/Aug8nXz.png)

The scan history view tells the whole story in one image. Baseline, spike, reduction. That arc is what a vulnerability management program looks like in practice at every organization running one.

## What I Took Away From This

The technical steps here are not complicated. The insight is in the numbers and what they represent. A single unpatched database server introduced more risk than everything else on the machine combined. Software inventory and patch currency are not glamorous security work but they account for a disproportionate share of exploitable attack surface.

This lab also shaped how I think about detection. When I later built Wazuh and Splunk detection rules around EventCode 4625 and process execution, I was thinking about the same attack surface this lab demonstrated. The attackers hitting that MySQL instance with weak credentials would generate exactly the kind of authentication failure events I was building detections for.

The tools changed as my homelab evolved from Azure VMs to a Proxmox cluster, but the mental model from this lab carried forward into everything else.

## What's Next

The next step beyond running Nessus scans is automating the remediation workflow. Scheduled scans, automated ticketing on new critical findings, and integration with a SIEM so vulnerability data shows up alongside detection alerts in the same dashboard. That's where vulnerability management and detection engineering start to converge.
