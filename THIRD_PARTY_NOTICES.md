# Third-Party Notices

This proprietary project uses and invokes third-party open-source software. Each component remains governed by its own upstream license. External tools and containers are not relicensed by this repository.

## Runtime dependencies

### SheetJS Community Edition

SheetJS Community Edition 0.20.3 — https://sheetjs.com/

Copyright (C) 2012-present SheetJS LLC.

Licensed under the Apache License, Version 2.0. It is used only inside the isolated Office document parsing worker. The authoritative upstream package artifact is pinned by version and must remain lockfile-reproducible.

### Mammoth

Mammoth.js 1.12.3 — https://github.com/mwilliamson/mammoth.js

Licensed under the BSD 2-Clause License. Used for isolated DOCX text extraction.

### yauzl

yauzl 3.4.0 — https://github.com/thejoshwolfe/yauzl

Licensed under the MIT License. Used only to inspect ZIP metadata and Office archive expansion limits before parsing untrusted XLSX/DOCX files.

### pg-boss

pg-boss 12.33.4 — https://github.com/timgit/pg-boss

Licensed under the MIT License. Used as the PostgreSQL-backed durable job queue; no Redis broker is required.

## Zero-cost local AI stack

### Ollama

Ollama 0.34.2 — https://github.com/ollama/ollama

Licensed under the MIT License. Runs locally and exposes the structured-output and vision API consumed by WhatsApp AI.

### Qwen3-VL

Qwen3-VL — https://github.com/QwenLM/Qwen3-VL

Licensed under the Apache License, Version 2.0. The default local model is qwen3-vl:4b-instruct; model artifacts remain subject to the upstream model license and notices.

### whisper.cpp

whisper.cpp 1.9.4 — https://github.com/ggml-org/whisper.cpp

Licensed under the MIT License. Used locally for audio transcription.

## WhatsApp Web connector

### WPPConnect Server

WPPConnect Server 2.10.27 — https://github.com/wppconnect-team/wppconnect-server

The server repository declares Apache-2.0. It is run as a separately deployed container and is not copied into the WhatsApp AI source tree.

### WPPConnect library

@wppconnect-team/wppconnect 2.3.3 — https://github.com/wppconnect-team/wppconnect

The library used by WPPConnect Server declares LGPL-3.0-or-later. It remains an upstream dependency of the separately deployed WPPConnect Server container. If the deployment or distribution model changes, LGPL obligations must be reviewed again.

## Security/release tooling

### Semgrep Community Edition

Semgrep CE 1.177.0 — https://github.com/semgrep/semgrep

Licensed under LGPL-2.1. It is executed as an external local SAST container with telemetry disabled; it is not linked into the application.

### Gitleaks

Gitleaks 8.30.1 — https://github.com/gitleaks/gitleaks

Licensed under the MIT License. Used locally to scan repository history for secrets.

### Trivy

Trivy 0.74.0 — https://github.com/aquasecurity/trivy

Licensed under Apache-2.0. Used locally for filesystem, configuration and container vulnerability scanning and for CycloneDX SBOM generation.

## General release rule

Before external distribution, the release gate must produce a dependency/SBOM artifact and reject additions whose licenses conflict with the proprietary deployment model. Third-party license texts and notices distributed by upstream packages or container images must be preserved where their licenses require it.
