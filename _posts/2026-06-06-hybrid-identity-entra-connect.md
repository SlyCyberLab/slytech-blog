---
layout: post
title: "Building a Hybrid Identity Environment with Active Directory and Microsoft Entra ID"
date: 2026-06-06
categories: [homelab, cloud, iam]
tags: [entra-id, active-directory, entra-connect, hybrid-identity, microsoft-365, windows-server, identity, cloud]
permalink: /hybrid-identity-entra-connect/
---

My AD environment was solid. Tiered admin accounts, JIT elevation, PAM groups, GPO-enforced access controls, the whole thing. But it only existed on-prem. The moment someone asked me to demonstrate cloud identity or device management, I had nothing to show. This project fixes that by extending the existing slytech.us domain into Microsoft Entra ID using Entra Connect, turning a standalone Active Directory into a hybrid identity environment.

This is the foundation everything else in the cloud series builds on. Intune enrollment, Defender for Endpoint, Conditional Access policies, all of it assumes your on-prem identities are already in Entra ID. Get this right first.

## Why Entra Connect over Cloud Sync

Microsoft currently offers two sync options: Entra Connect Sync (on-premises agent on DC01) and Entra Cloud Sync (lightweight agent, cloud-managed). Cloud Sync is where Microsoft is pushing new deployments, and for a greenfield multi-forest enterprise it makes sense. For this lab, Connect Sync is the right call.

The existing slytech.us domain has a real OU structure, PAM tier groups, service accounts, and tiered admin naming conventions. Connect Sync gives you full control over attribute filtering, OU scoping, and sync rules. Cloud Sync abstracts a lot of that away. For a lab that exists specifically to demonstrate identity management depth, Connect Sync shows more.

Worth knowing for interviews: if someone asks why you chose Connect Sync over Cloud Sync, the answer is "single forest, complex OU structure, full attribute control needed." If they ask when you'd choose Cloud Sync, the answer is "multi-forest consolidation, cloud-first strategy, minimizing on-prem footprint."

## The environment going in

Everything built in the IAM and PAM labs is still in place:

- `dc01`: Windows Server 2025, AD DS, DNS, slytech.us domain
- `fs01`: Windows Server 2025, department file shares
- `WS01` / `WS02`: Windows 11, domain-joined workstations
- Users: mwebb, rholt, cnovak, jblake, plus tiered admin accounts and service accounts
- OU structure: SLYTECH > Users > Sales/IT/Disabled, Admin-Accounts > Tier0/Tier1/Tier2, Groups > PAM

Nothing gets torn down. Entra Connect syncs what's already there without touching the on-prem structure.

## Standing up the M365 tenant

The free Microsoft 365 Developer Program sandbox is the obvious choice here. It gives you 25 E5 licenses, Entra ID P2, Intune, Defender, everything you need. The catch is Microsoft tightened eligibility in 2024 and now requires an active Visual Studio subscription or verified developer activity. If you hit the "you don't qualify" wall, don't waste time trying to work around it.

The practical alternative is the Microsoft 365 Business Premium 30-day trial. One user, no charge until day 30, includes Entra ID, Intune, and Defender for Endpoint. That covers everything in this series.

During tenant creation, pick a domain prefix that makes sense. `slytech.onmicrosoft.com` was already taken (from an earlier failed attempt), so the tenant landed on `slytechlab.onmicrosoft.com`. The onmicrosoft.com domain is just the backend tenant identifier. It never appears in user UPNs once you verify your custom domain.

![Microsoft 365 admin center showing the new SlyTech tenant](/assets/images/01-m365-admin-center.png)

## Verifying the custom domain

Before Entra Connect can sync, slytech.us needs to be a verified domain in the tenant. The process is standard: add the domain, get a TXT record, add it to your public DNS, click verify.

One thing to be clear on here: slytech.us is both an internal AD domain and a public domain registered in Cloudflare. Entra ID verifies against public DNS, not your internal Technitium resolver. The TXT record goes in Cloudflare, not Technitium. That's the part worth noting because it's easy to add it to the wrong DNS server and sit there wondering why verification keeps failing.

```
Type: TXT
Name: @
Content: MS=ms25875625
TTL: Auto
```

Cloudflare propagates fast. Verification came back successful within two minutes of saving the record.

![Microsoft Entra admin center with slytech.us set as primary domain](/assets/images/02-entra-admin-center.png)

![slytech.us verified and set as primary domain in Entra ID](/assets/images/03-entra-domain-primary.png)

After verification, set slytech.us as the primary domain. This ensures synced users get `@slytech.us` UPNs instead of `@slytechlab.onmicrosoft.com`. The onmicrosoft.com domain stays in the background as the fallback.

## Installing Entra Connect on DC01

Entra Connect installs directly on DC01. Download it from the Entra admin center under the Connect Sync option. The direct download page has been moved around a few times so the most reliable path is through the portal itself rather than hunting for a static download URL.

Current version at time of writing is 2.6.3.0. Important note: versions below 2.4.18.0 will fail because Microsoft deprecated MSOnline in April 2025. If your installer is old, you'll hit authentication errors immediately. Get the latest version before you start.

Express Settings is the right choice for a single forest lab. It configures Password Hash Sync, automatic sync every 30 minutes, and sets up the AD connector with the credentials you provide.

![Entra Connect installer on the Express Settings screen](/assets/images/05-entra-connect-installer.png)

![Ready to configure screen showing sync configuration summary](/assets/images/06-entra-connect-ready.png)

## The gotcha that will waste your afternoon

The installer ran, got to the Configure screen, and threw this:

```
AADSTS700027: The certificate used to sign the client assertion is expired.
An error occurred while initializing the slytechlab.onmicrosoft.com - AAD connector.
```

The error message says expired certificate. The actual problem is time sync.

DC01 was running its Windows Time service against the local CMOS clock instead of an external NTP source. Check yours before you run the installer:

```powershell
w32tm /query /status
```

If you see this, you have a problem:

```
Source: Local CMOS Clock
ReferenceId: 0x4C4F434C (source name: "LOCL")
```

OAuth token validation is sensitive to clock skew. When DC01's clock drifts even slightly, the token Microsoft issues gets rejected because the server and client timestamps don't agree. The error message says certificate, but the root cause is time.

Fix it:

```powershell
Set-Service -Name W32Time -StartupType Automatic
Start-Service -Name W32Time
w32tm /config /manualpeerlist:"time.windows.com" /syncfromflags:manual /reliable:YES /update
w32tm /resync /force
w32tm /query /status
```

What you want to see after:

```
Source: time.windows.com
Stratum: 4 (secondary reference - syncd by (S)NTP)
```

Once time is synced, re-run the installer. It goes through clean.

![Entra Connect configuration complete](/assets/images/07-entra-connect-configured.png)

For the Entra credentials step, use your `admin@slytechlab.onmicrosoft.com` account, not `admin@slytech.us`. Even though slytech.us is the primary domain, the tenant admin account was created under slytechlab.onmicrosoft.com and that's what Entra Connect authenticates against during setup.

## Seeing the sync work

First sync runs automatically after installation. Navigate to Entra ID Users and filter by `On-premises sync enabled == Yes`. All 18 users from the slytech.us domain show up:

- mwebb, rholt, cnovak, jblake with `@slytech.us` UPNs
- All tiered admin accounts: mwebb.admin.t0, mwebb.admin.t1, rholt.admin.t0, rholt.admin.t1, cnovak.admin.t2
- Service accounts: svc.backup, svc.legacy
- All showing `On-premises sync: Yes`

![Entra ID Users list showing all 18 synced AD accounts with slytech.us UPNs](/assets/images/08-entra-users-synced.png)

The PAM structure came across intact. Every tier account, every service account, the whole thing. That's the value of building the on-prem environment properly before syncing it. There's nothing to clean up in the cloud because the source was already clean.

## Validation

The real test is authentication. Sign into `myapps.microsoft.com` with a synced user's credentials:

- Username: `mwebb@slytech.us`
- Password: Marcus Webb's AD password

It authenticates. A user whose account lives in Active Directory on dc01 in the homelab just signed into a Microsoft cloud service using the same credentials, with no separate cloud password to manage. That's Password Hash Sync working exactly as designed.

![My Apps portal showing successful sign-in as mwebb@slytech.us](/assets/images/09-entra-myapps-mwebb.png)

In an enterprise context this is the moment where a help desk technician can use the same Active Directory credentials to access SharePoint, Teams, or any Entra-integrated application without a separate account or password sync issue to troubleshoot.

## What's Next

With hybrid identity in place, the next step is device management. WS01 and WS02 are domain-joined but not cloud-managed. Project 2 enrolls them into Microsoft Intune, applies compliance policies, and integrates Defender for Endpoint, turning the existing Windows 11 workstations into managed cloud endpoints.
