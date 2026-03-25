---
layout: post
title: "I Built an AI-Assisted SOC Triage Tool on Top of My Splunk Lab"
date: 2026-03-27
categories: [homelab, security, siem]
tags: [splunk, python, anthropic, mitre-attack, soc, ai, threat-detection, windows-security]
---

Manual log triage is slow. Even in a small homelab with one domain controller, you can generate hundreds of Windows Security events per hour that mean absolutely nothing. Sorting through that noise to find what actually matters is exactly the kind of work that kills analyst efficiency in real SOC environments. I wanted to see if I could automate the first pass using AI, so I built a Python tool that pulls events directly from Splunk and sends them to the Anthropic API for triage analysis with MITRE ATT&CK mapping.

This post documents how I built it, what broke along the way, and what the output looks like against real attack data from my lab. The code is on GitHub at [github.com/SlyCyberLab/slytech-ai-labs](https://github.com/SlyCyberLab/slytech-ai-labs).

---

## Why Build This Instead of Just Using Splunk Alerts

Splunk already does correlation searches. I use them. But there is a gap between a fired alert and understanding what it means in context. A SOC analyst does not just look at one event. They look at the pattern, the timing, the source, the sub-status codes, and they connect it to known attacker behavior. That contextual reasoning is exactly what a large language model is good at.

The goal was not to replace Splunk. The goal was to add an AI layer on top of it that does the first-pass reasoning a Tier 1 analyst would do, produces a structured triage report, and maps findings to MITRE ATT&CK automatically. If the output is good enough, it reduces the time from "alert fired" to "here is what it probably means and what to do next."

---

## The Stack

- **Splunk Enterprise** running on a dedicated Ubuntu VM in my Citadel lab cluster, with Universal Forwarders on `dc01.slytech.us` and a Linux endpoint forwarding Windows Security events and syslog
- **Python 3.10** running directly on the Splunk VM
- **Anthropic API** (Claude) for the AI triage analysis
- **Splunk REST API** on port 8089 for programmatic event retrieval

No frontend. No database. A focused script that does one thing well.

---

## The Part That Took Longer Than It Should Have

The Splunk REST API returns results as one JSON object per line, not as a single JSON array. If you try to `json.loads()` the entire response at once it fails immediately. You have to split the response by newline and parse each line individually.

```python
for line in response.text.strip().split("\n"):
    if not line:
        continue
    try:
        obj = json.loads(line)
        result = obj.get("result", {})
    except json.JSONDecodeError:
        continue
```

The other thing nobody mentions: the Message field in Windows Security events is full of `\r\n` and `\t` characters. Sending that raw to an AI API produces messy output. Clean it before you send it.

```python
message = message.replace("\r\n", " ").replace("\t", " ")
while "  " in message:
    message = message.replace("  ", " ")
```

Two lines that save you from ugly triage reports.

---

## How the Script Works

The flow is straightforward:

1. Connect to Splunk REST API on `localhost:8089`
2. Run a SPL search filtering for security-relevant event codes across a 7-day window
3. Sort results by severity priority so suspicious events surface first regardless of volume
4. Format the events into a clean block
5. Send to the Anthropic API with a structured system prompt that instructs Claude to act as a senior SOC analyst
6. Print the triage report to terminal and save it to a timestamped file

The event priority ranking was a key improvement. The initial version sorted by timestamp and the high-volume DC machine account noise (4624/4634 pairs from `DC01$`) filled all 50 event slots every time, burying the actual interesting events. Sorting by event code priority fixes that.

```python
| eval priority=case(
    EventCode="4625", 1,
    EventCode="4648", 2,
    EventCode="4720", 3,
    EventCode="4726", 4,
    EventCode="4732", 5,
    EventCode="4698", 6,
    EventCode="4688", 7,
    1=1, 8
)
| sort priority _time
```

Failed logons always come first. Everything else falls into place behind them.

---

## The Prompt Engineering

The system prompt is what determines the quality of the output. Vague prompts produce vague analysis. This is what works:

```python
system_prompt = """You are a senior SOC analyst performing security event triage.
You analyze Windows Security Event logs and produce structured triage reports.

For each analysis, you must:
1. Identify the most suspicious or notable events
2. Group related events that may indicate a pattern
3. Map findings to MITRE ATT&CK techniques where applicable
4. Assign a triage priority: CRITICAL, HIGH, MEDIUM, LOW, or INFORMATIONAL
5. Recommend a specific next action for each finding

Be direct and specific. Do not summarize benign noise in detail.
Focus on what a SOC analyst needs to act on."""
```

The key instructions are "be direct and specific" and "do not summarize benign noise in detail." Without those constraints the AI writes paragraphs about routine machine account activity that you do not need.

![Splunk search results showing 7 days of Windows Security events](/assets/images/01-splunk-search-results.png)

---

## Running It Against Real Lab Data

I ran the tool against 7 days of Windows Security events from my lab environment, which includes `dc01.slytech.us`, a domain-joined Windows 11 workstation, and a standalone `win11-002` machine. The lab also has a Kali attack VM that I use for adversary simulation.

![Script running in terminal showing Splunk query and API call status](/assets/images/02-script-running-terminal.png)

The first run with the default sort-by-time returned 20 events that were all `DC01$` machine account logons. Benign, expected, useless for a triage demo. After fixing the priority sort and expanding to 50 events across 7 days, the output got interesting fast.

![AI triage report executive summary showing brute force detection](/assets/images/03a-ai-triage-executive-summary.png)

The AI detected four distinct attack patterns:

**CRITICAL: Brute force from kali-attack (10.0.0.213)**
13 failed logons against the local `admin` account on `win11-002` in 4 seconds. The AI correctly identified the workstation name "kali-attack" as offensive tooling and mapped it to MITRE ATT&CK T1110.001.

**HIGH: Sustained credential testing from DARKSHELL (10.0.0.100)**
20+ failed logons across a 26-hour window. That is my Proxmox management VM, and those were my own failed login attempts. The AI flagged it correctly as suspicious, which is the right call. Context about what DARKSHELL is does not exist in the log data.

**HIGH: User enumeration against the domain controller**
Failed logons with sub-status `0xC0000064` (user does not exist) from a domain-joined workstation. The AI identified this as T1110.003 and T1087.002 and noted the regular 40-second interval suggesting manual or throttled automated testing.

**MEDIUM: Local account enumeration on win11-002**
Sequential `fakeuser1` through `fakeuser10` attempts from localhost. The AI recognized the sequential naming pattern as scripted enumeration.

![AI triage key findings showing MITRE ATT&CK mapping and priority levels](/assets/images/03b-ai-triage-key-findings.png)

![Terminal showing report saved confirmation](/assets/images/04-triage-report-saved.png)

---

## What the Saved Report Looks Like

Every run saves a timestamped text file with the full analysis and raw events appended at the bottom. Useful for documentation, post-incident review, or just keeping a record of what your lab generated.

![Triage report file contents in terminal](/assets/images/05-triage-report-file-contents.png)

---

## The False Positive Problem

The DARKSHELL finding is worth dwelling on. The AI correctly flagged 20+ failed logons from `10.0.0.100` as suspicious. From a pure event analysis perspective that is the right call. But anyone who knows the lab knows DARKSHELL is a trusted management VM and those failed logons were just me mistyping a password.

This is exactly the problem real SOC teams deal with daily. The tool does not have business context, asset inventory, or baseline behavior profiles. It can identify patterns and map them to frameworks. It cannot tell you whether the source is trusted without additional context.

The next version of this tool will address that by adding an asset context file: a simple JSON dictionary mapping known hostnames and IPs to their roles. The AI prompt will include that context so it can distinguish "this is the known Kali attack VM in a lab" from "this is an unknown host attempting brute force."

---

## The Code

The full script is at [github.com/SlyCyberLab/slytech-ai-labs](https://github.com/SlyCyberLab/slytech-ai-labs) under `01-splunk-log-analyzer/`.

![GitHub repo showing project files](/assets/images/06-github-repo-files.png)

![Script configuration and event code definitions on GitHub](/assets/images/07-github-script-code.png)

![AI prompt engineering section of the script](/assets/images/08-github-script-prompt.png)

To run it yourself you need a Splunk instance with Windows Security events indexed and an Anthropic API key. Set both as environment variables, never hardcode credentials in scripts you plan to push to GitHub.

```bash
export SPLUNK_PASSWORD="your_splunk_password"
export ANTHROPIC_API_KEY="your_anthropic_key"
python3 splunk_analyzer.py
```

The `.env.example` file in the repo documents exactly what variables to set.

---

## Is This Agentic AI?

Not yet. This tool requires you to run it manually. The AI analyzes what you give it and returns a report. You are still in the loop for every step.

The next post will make it autonomous: a scheduled process that monitors Splunk for new high-severity events, runs the AI analysis automatically, and sends a Telegram alert with the triage summary. That is where it becomes genuinely agentic, the AI deciding what warrants a notification without human intervention at each step.

---

## What's Next

The immediate next improvement is the asset context file to reduce false positives on known-good sources. After that I am building the autonomous version with Telegram alerting and scheduled execution. The Splunk lab series continues, and this AI tooling work is becoming its own thread alongside it.

Code is on GitHub. If you build something on top of it, let me know.
