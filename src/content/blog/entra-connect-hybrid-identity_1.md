---
title: "Building a Hybrid Identity Environment with Active Directory and Microsoft Entra ID"
date: 2026-06-07
description: "Extending the slytech.us on-prem Active Directory into Microsoft Entra ID using Entra Connect to build a hybrid identity foundation for Intune, Conditional Access, and Defender for Endpoint."
category: iam
tags: [entra-id, active-directory, entra-connect, hybrid-identity, microsoft-365, windows-server, identity, cloud]
---

The AD environment was solid. Tiered admin accounts, JIT elevation, PAM groups, GPO-enforced access controls, the whole thing. The homelab exists for everything production can't accommodate, breaking things, rebuilding them, testing configurations without a change window or a ticket. I extended the slytech.us domain into Microsoft Entra ID using Entra Connect, turning a standalone Active Directory into a hybrid identity environment built to be torn apart and rebuilt freely.

This is the foundation everything else in the cloud series builds on. Intune enrollment, Defender for Endpoint, Conditional Access policies, all of it assumes on-prem identities are already in Entra ID.

## Why Entra Connect over Cloud Sync

Microsoft currently offers two sync options: Entra Connect Sync, an on-premises agent that runs on the DC, and Entra Cloud Sync, a lightweight agent that's cloud-managed. Cloud Sync is where Microsoft is pushing new deployments. For this lab, Connect Sync made more sense.

The slytech.us domain has a real OU structure, PAM tier groups, service accounts, and tiered admin naming conventions built across the [IAM](https://blog.slytech.us/blog/iam-lab) and [PAM](https://blog.slytech.us/blog/pam-lab) labs. Connect Sync gave full control over attribute filtering, OU scoping, and sync rules. Cloud Sync abstracts a lot of that away, which isn't what I wanted for a lab built specifically to demonstrate identity management depth.

The distinction matters in practice. Connect Sync for a single forest with a complex OU structure and full attribute control needed. Cloud Sync when the goal is multi-forest consolidation or minimizing on-prem footprint.

## The Environment Going In

Everything from the [IAM](https://blog.slytech.us/blog/iam-lab) and [PAM](https://blog.slytech.us/blog/pam-lab) labs was still in place:

- `dc01`: Windows Server 2025, AD DS, DNS, slytech.us domain
- `fs01`: Windows Server 2025, department file shares
- `WS01` / `WS02`: Windows 11, domain-joined workstations
- Users: mwebb, rholt, cnovak, jblake, plus tiered admin accounts and service accounts
- OU structure: SLYTECH > Users > Sales/IT/Disabled, Admin-Accounts > Tier0/Tier1/Tier2, Groups > PAM

Nothing got torn down. Entra Connect syncs what's already there without touching the on-prem structure.

## Standing Up the M365 Tenant

The free Microsoft 365 Developer Program sandbox was the first thing I tried. It gives 25 E5 licenses, Entra ID P2, Intune, Defender, everything this series needs. Microsoft tightened eligibility in 2024 though and now requires an active Visual Studio subscription or verified developer activity. The portal returned "you don't qualify" so I moved on without trying to work around it.

The practical alternative was the Microsoft 365 Business Premium 30-day trial. One user, no charge until day 30, includes Entra ID, Intune, and Defender for Endpoint. That covers everything in this series.

During tenant creation I picked `slytechlab.onmicrosoft.com` as the domain prefix. `slytech.onmicrosoft.com` was already taken from an earlier failed attempt. The onmicrosoft.com domain is just the backend tenant identifier and never appears in user UPNs once the custom domain is verified.

![Microsoft 365 admin center showing the new SlyTech tenant](/images/01-m365-admin-center.png)

## Verifying the Custom Domain

Before Entra Connect could sync, slytech.us needed to be a verified domain in the tenant. The process is standard: add the domain, get a TXT record, add it to public DNS, click verify.

One thing worth noting: slytech.us is both an internal AD domain and a public domain registered in Cloudflare. Entra ID verifies against public DNS, not the internal Technitium resolver. The TXT record goes in Cloudflare, not Technitium. It's easy to add it to the wrong DNS server and sit there wondering why verification keeps failing.

```
Type: TXT
Name: @
Content: MS=ms25875625
TTL: Auto
```

Cloudflare propagates fast. Verification came back successful within two minutes of saving the record.

![Microsoft Entra admin center showing slytech.us domain verification](/images/02-entra-admin-center.png)

![slytech.us verified and set as primary domain in Entra ID](/images/03-entra-domain-primary.png)

After verification I set slytech.us as the primary domain. That's what ensures synced users get `@slytech.us` UPNs instead of `@slytechlab.onmicrosoft.com`. The onmicrosoft.com domain stays in the background as the fallback.

## Installing Entra Connect on DC01

Entra Connect installs directly on DC01. I grabbed it from the Entra admin center under the Connect Sync option. The download page has moved around a few times so going through the portal was more reliable than hunting for a static URL.

The version matters here. Anything below 2.4.18.0 will fail because Microsoft deprecated MSOnline in April 2025. The installer on the portal was current at 2.6.3.0 so that wasn't an issue.

Express Settings went in for a single forest lab. It configured Password Hash Sync, automatic sync every 30 minutes, and set up the AD connector automatically.

![Entra Connect installer on the Express Settings screen](/images/05-entra-connect-installer.png)

![Ready to configure screen showing sync configuration summary](/images/06-entra-connect-ready.png)

## The Gotcha That Stopped the Install

The installer ran, got to the Configure screen, and threw this:

```
AADSTS700027: The certificate used to sign the client assertion is expired.
An error occurred while initializing the slytechlab.onmicrosoft.com - AAD connector.
```

Spent time rotating keys, checking app registrations, re-downloading the latest installer. None of it mattered. The error message says expired certificate. The actual problem was time sync.

DC01 was running its Windows Time service against the local CMOS clock instead of an external NTP source. Running `w32tm /query /status` showed it immediately:

```
Source: Local CMOS Clock
ReferenceId: 0x4C4F434C (source name: "LOCL")
```

OAuth token validation is sensitive to clock skew. When DC01's clock drifts even slightly, the token Microsoft issues gets rejected because the server and client timestamps don't agree. The error says certificate but the root cause is time. Fixed it with:

```powershell
Set-Service -Name W32Time -StartupType Automatic
Start-Service -Name W32Time
w32tm /config /manualpeerlist:"time.windows.com" /syncfromflags:manual /reliable:YES /update
w32tm /resync /force
w32tm /query /status
```

After the fix, the status showed:

```
Source: time.windows.com
Stratum: 4 (secondary reference - syncd by (S)NTP)
```

Re-ran the installer. It went through clean.

![Entra Connect configuration complete](/images/07-entra-connect-configured.png)

The time sync issue is worth calling out because the error message is genuinely misleading. "Certificate expired" points you toward keys, app registrations, and installer versions. None of that matters. Running `w32tm /query /status` shows the real problem immediately, but it's not where you look first when an installer fails.

One more thing from the setup: at the Entra credentials step, the right account was `admin@slytechlab.onmicrosoft.com`, not `admin@slytech.us`. Even though slytech.us is the primary domain, the tenant admin account was created under slytechlab.onmicrosoft.com and that is what Entra Connect authenticates against during setup.

## Seeing the Sync Work

The first sync ran automatically after installation. In Entra ID Users, filtering by `On-premises sync enabled == Yes` showed all 18 users from the slytech.us domain:

- mwebb, rholt, cnovak, jblake with `@slytech.us` UPNs
- All tiered admin accounts: mwebb.admin.t0, mwebb.admin.t1, rholt.admin.t0, rholt.admin.t1, cnovak.admin.t2
- Service accounts: svc.backup, svc.legacy
- All showing `On-premises sync: Yes`

![Entra ID Users list showing all 18 synced AD accounts with slytech.us UPNs](/images/08-entra-users-synced.png)

The PAM structure came across intact. Every tier account, every service account, the whole thing. That's the value of building the on-prem environment properly before syncing it. There was nothing to clean up in the cloud because the source was already clean.

## Validation

The real test was authentication. Signed into `myapps.microsoft.com` as `mwebb@slytech.us` using Marcus Webb's AD password. It authenticated. A user whose account lives in Active Directory on dc01 in the homelab just signed into a Microsoft cloud service using the same credentials, with no separate cloud password to manage. That's Password Hash Sync working exactly as designed.

![My Apps portal showing successful sign-in as mwebb@slytech.us](/images/09-entra-myapps-mwebb.png)

In an enterprise context this is the moment where a help desk technician can use the same Active Directory credentials to access SharePoint, Teams, or any Entra-integrated application without a separate account or password sync issue to troubleshoot. That reduces password sprawl and the overhead that comes with managing duplicate accounts across on-premises and cloud.

## What's Next

With hybrid identity in place, the next step is device management. WS01 and WS02 are domain-joined but not cloud-managed. Project 2 enrolls them into Microsoft Intune, applies compliance policies, and integrates Defender for Endpoint, turning the existing Windows 11 workstations into managed cloud endpoints.
