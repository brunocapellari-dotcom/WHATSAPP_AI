# WhatsApp AI — GitHub Research Integration 2026-10-01

Status: APPROVED ARCHITECTURE ADDENDUM

## Android Device Lab

Create a generic device-test capability independent of phone model.

Benchmark:

- Mobile MCP — deterministic device/app automation and accessibility-tree interaction.
- agent-device — developer feedback loop, install/launch/log/crash/evidence capture.
- ARTEMIS — REFERENCE/POC for higher-level mobile-agent planning.

The production collector must not depend on any one physical phone.

## Required automated scenarios

Device Lab regression must cover, where technically permitted:

- install/update/start/stop;
- permission granted/revoked;
- Notification Listener recovery;
- Share Intent ingestion;
- network loss/recovery;
- offline queue;
- retry and idempotency;
- duplicate message/event;
- app/process restart;
- crash/logcat capture;
- safe synchronization;
- prohibited/unavailable WhatsApp capability handling.

## Sandbox/security

Use the shared Hermes Execution Cell for test tooling where appropriate.

External WhatsApp content remains untrusted data. It cannot modify prompts, policy, tools, permissions, destinations or internal rules.

Use shared Scenario/Inspect/Promptfoo-style tests for prompt/tool injection and regression.

## Speech Router

Benchmark local/self-hosted speech engines rather than hardcoding one:

- WhisperX/current baseline;
- WhisperLiveKit — streaming/low-latency POC;
- MOSS Transcribe-Diarize — benchmark;
- faster-whisper where already appropriate.

Benchmark Portuguese, noisy voice notes, multiple speakers, CPU/GPU cost, timestamps and diarization quality.

## Agent Manifest

WhatsApp Business AI and Freight Intelligence agents inherit Hermes Agent Manifest:

ENTRY / INSTRUCTIONS / KNOWLEDGE / TOOLS / TRIGGERS / LIMITS.

Actions that send, mutate CRM/order state or affect an external party must pass deterministic policy and tenant-scoped authorization.
