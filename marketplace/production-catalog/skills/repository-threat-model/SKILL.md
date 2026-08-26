---
name: repository-threat-model
description: Produce a repository-grounded application security threat model with assets, boundaries, abuse paths, priorities, and mitigations. Use only when threat modeling is explicitly requested.
---

<!-- Modified by OpenBot from OpenAI's security-threat-model skill. See NOTICE.txt. -->

# Repository Threat Model

Build the model from repository evidence rather than a generic checklist. Establish the in-scope components, deployment assumptions, entry points, data stores, external integrations, and trust boundaries. Separate runtime behavior from development and CI tooling.

Identify the assets that drive risk and the attacker capabilities that are plausible for the stated environment. Also record meaningful attacker non-capabilities so severity is not overstated.

Describe a small set of concrete abuse paths. For each one, connect an attacker goal to an entry point, crossed boundary, affected asset, existing controls, and resulting impact. Rank it using qualitative likelihood and impact with a short justification.

Ask only for missing context that would materially change scope or ranking. Mark unresolved assumptions explicitly. Recommend mitigations at the component or boundary where they belong, distinguish existing controls from proposed work, and favor specific changes over generic advice.

Finish by checking that every important entry point and trust boundary is represented and that every architectural claim can be traced to repository evidence.
