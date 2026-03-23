---
layout: post
title: "Building a Splunk SIEM Lab on Proxmox, Part 1: Install and Data Onboarding"
date: 2026-04-22
categories: [homelab, security, siem]
tags: [splunk, proxmox, windows, universal-forwarder, siem, cybersecurity, active-directory]
---

I wanted a Splunk lab. Not a cloud trial, not a pre-built VM. An actual deployment on my own infrastructure that I could break, rebuild, and learn from. So I spun up a fresh Ubuntu Server VM on Citadel, installed Splunk Enterprise, and wired up Universal Forwarders on two Windows endpoints. By the end of this post, I had 16 EventCode 4625 alerts hitting Splunk from a standalone Windows machine.

This is Part 1 of a 3-part series. Part 2 covers SPL searches and correlation rules. Part 3 brings in MITRE ATT&CK mapping and a Splunk vs Wazuh comparison.

<!--more-->

## Why Splunk

I already run Wazuh in my homelab and it's solid for what it is. But Splunk is what shows up in job postings. It's what SOC teams actually use. If I'm going to sit in a security interview and talk about SIEM experience, I want it to be real.

The 60-day free trial of Splunk Enterprise gives you full functionality with a 500MB/day ingest limit. That's more than enough for a lab environment.

## Before You Install, Check Your Disk

This is the part I learned the hard way. Splunk installs three components: the manager, the indexer, and the dashboard. The dashboard package alone is close to 1GB. By the time everything is down, you're looking at roughly 3GB on top of your OS.

My fresh Ubuntu VM had the LVM only using half the disk. Check before you start:

```bash
df -h
```

If you're tight, expand your LVM first before running the installer:

```bash
sudo lvextend -l +100%FREE /dev/ubuntu-vg/ubuntu-lv && sudo resize2fs /dev/ubuntu-vg/ubuntu-lv
```

The install will roll back silently mid-way if it runs out of space. No obvious error, just a clean removal and a log entry that says "disk full." Save yourself the confusion.

## Installing Splunk

The VM is running Ubuntu 22.04 on Citadel, my dedicated security lab Proxmox node. 8GB RAM, 80GB disk after the resize.

```bash
wget -O splunk-10.2.1-c892b66d163d-linux-amd64.deb "https://download.splunk.com/products/splunk/releases/10.2.1/linux/splunk-10.2.1-c892b66d163d-linux-amd64.deb"

sudo dpkg -i splunk-10.2.1-c892b66d163d-linux-amd64.deb

sudo /opt/splunk/bin/splunk start --accept-license --run-as-root
```

The `--accept-license` flag skips the interactive prompt and the `--run-as-root` flag is required on Ubuntu since running Splunk as root is deprecated but still functional. It installs the manager, indexer, and dashboard all on one box. Right for a homelab, wrong for production.

When the install finishes it prints your admin credentials directly in the terminal. Screenshot that immediately, it only appears once. Then Splunk starts and gives you the web interface URL.

![Splunk first start showing web interface URL](/assets/images/splunk-02-first-start.png)

Enable boot-start so it survives reboots:

```bash
sudo /opt/splunk/bin/splunk enable boot-start --run-as-root
```

## First Login

Head to `http://your-splunk-ip:8000` and log in with the credentials from the install output. The dashboard loads immediately and already shows activity from the Splunk server monitoring itself.

![Splunk dashboard first login](/assets/images/splunk-03-dashboard-first-login.png)

## Setting Up the Receiving Port

Before any forwarder can send data, Splunk needs to be listening. Go to **Settings → Forwarding and receiving → Configure receiving → New Receiving Port** and add port `9997`. That's the standard Splunk forwarder port.

![Receiving port 9997 configured](/assets/images/splunk-05-receiving-port.png)

## Installing Universal Forwarders

The lab has two Windows endpoints: dc01 (domain controller, `10.0.0.210`) and win11-002 (standalone workstation, `10.0.0.181`). Both are on the same flat network as the Splunk server at `10.0.0.228`.

On each Windows machine, download the forwarder MSI and install it silently:

```powershell
Invoke-WebRequest -Uri "https://download.splunk.com/products/universalforwarder/releases/10.2.1/windows/splunkforwarder-10.2.1-c892b66d163d-windows-x64.msi" -OutFile "C:\splunkforwarder.msi"

msiexec.exe /i "C:\splunkforwarder.msi" RECEIVING_INDEXER="10.0.0.228:9997" WINEVENTLOG_SEC_ENABLE=1 WINEVENTLOG_SYS_ENABLE=1 WINEVENTLOG_APP_ENABLE=1 AGREETOLICENSE=Yes /quiet
```

Then create the outputs.conf to tell the forwarder where to send data:

```powershell
$outputs = "[tcpout]`r`ndefaultGroup = splunk-server`r`n`r`n[tcpout:splunk-server]`r`nserver = 10.0.0.228:9997"

[System.IO.File]::WriteAllText("C:\Program Files\SplunkUniversalForwarder\etc\system\local\outputs.conf", $outputs)
```

And the inputs.conf to specify exactly what to collect:

```powershell
$inputs = "[WinEventLog://Security]`r`nindex = main`r`ndisabled = 0`r`nstart_from = oldest`r`ncurrent_only = 0`r`ncheckpointInterval = 5`r`n`r`n[WinEventLog://System]`r`nindex = main`r`ndisabled = 0`r`n`r`n[WinEventLog://Application]`r`nindex = main`r`ndisabled = 0"

[System.IO.File]::WriteAllText("C:\Program Files\SplunkUniversalForwarder\etc\system\local\inputs.conf", $inputs)

Restart-Service SplunkForwarder
```

## A Note on Domain Controllers and Kerberos

On dc01, Windows Event Logs from Application and System started flowing immediately. Security logs took more troubleshooting. The short version: domain controllers use Kerberos by default, which means failed authentication events show up as EventCode 4771 (Kerberos pre-auth failure) rather than the classic 4625 (failed logon) you'd see on a standalone machine. The CIS Baseline Policy that was still applied from a previous compliance lab was also interfering with the audit configuration. Removing that policy and switching to NTLM auth using the loopback IP resolved it.

For straightforward 4625 detection, a standalone workstation like win11-002 is the cleaner target. This is why the lab includes both.

## Data Flowing

With both forwarders running, a quick SPL search confirms what's coming in:

```
index=main | stats count by host
```

![Both hosts sending data to Splunk, WIN11 with 553 events and dc01 with 2816](/assets/images/splunk-08-both-hosts-stats.png)

WIN11 has 553 events and dc01 has 2,816.

## Catching Failed Logons

To test detection I made deliberate failed RDP attempts against win11-002 from DarkShell. The forwarder picked them up within a minute.

```
index=main sourcetype=WinEventLog:Security EventCode=4625
```

![16 EventCode 4625 events in Splunk](/assets/images/splunk-09-brute-force-detected.png)

16 events. EventCode 4625, LogName Security, ComputerName win11-002. The interesting fields panel on the left already parsed out `Failure_Reason`, `Workstation_Name`, `Account_Name`, and `Source_Network_Address`. That's the detection working exactly as it should.

## What's Next

Part 2 covers SPL searches in depth, building correlation rules, and creating a dashboard that makes the data actually readable. Part 3 brings in MITRE ATT&CK mapping with the Security Essentials app and a comparison between Splunk and Wazuh for the same detections.

If you have a Windows lab sitting idle and want detection engineering experience that shows up in interviews, this stack is worth building.
