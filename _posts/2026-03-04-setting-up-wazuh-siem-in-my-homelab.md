---
layout: post
title: "Setting Up Wazuh SIEM in My Homelab"
date: 2026-03-04
categories: [homelab, security, siem]
tags: [wazuh, proxmox, lxc, monitoring, siem, cybersecurity]
---

If you're running a homelab and want to get into security monitoring without spinning up a full enterprise stack, Wazuh is one of the best starting points. I've had it running for about three months now and it's become one of the most valuable tools in my setup.

## Why Wazuh

I wanted something that would let me practice real security monitoring while also keeping an eye on my infrastructure. Most SIEM solutions are either too heavy for a homelab or locked behind a paywall. Wazuh hits the sweet spot, it's open source, actively maintained, and mirrors what you'd actually use in a real SOC environment.

## How I Deployed It

I run Wazuh as an LXC container on my Proxmox server, Forge. The decision to go LXC over a full VM was deliberate, the Proxmox community has solid documentation around it, and a full VM felt like overkill for what I needed. LXC keeps the resource footprint light while still giving Wazuh everything it needs to run properly.

The install itself was straightforward. Proxmox community scripts made it almost hands-off.

## Adding Agents

Right now I'm monitoring four endpoints, my Mac, my main Proxmox host, and a couple of VMs. The Mac agent was surprisingly painless. Wazuh generates a script you run on the endpoint and it handles everything automatically. I half expected macOS to fight me on it but it didn't.

## Tuning Out the Noise

Out of the box Wazuh is verbose. I spent some time going through the YAML configuration files on the Proxmox box to tighten up what actually triggers alerts. I wanted precision over volume, fewer alerts that actually mean something rather than a firehose of noise I'd start ignoring. Getting that balance right is honestly one of the more valuable parts of the process because it forces you to think about what you actually care about monitoring.

## Catching Real Events

To test detection I deliberately ran failed SSH login attempts against my Proxmox server. Wazuh caught them immediately. Seeing that alert fire in real time, knowing it came from something I actually did, makes the whole setup feel tangible in a way that just reading about SIEMs never does. It's monitoring failed logins, SSH activity, and authentication events across all agents.

## What's Next

I'm planning to build out a proper Grafana dashboard for Wazuh data and add agents to any new VMs that come online. The goal long term is a unified monitoring view across the entire homelab.

If you're sitting on a Proxmox box and haven't set up any security monitoring yet, Wazuh is worth an afternoon of your time.
