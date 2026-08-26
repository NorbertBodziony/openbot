---
name: secure-code-guidance
description: Review or write Python, JavaScript, TypeScript, or Go code using secure defaults. Use only for explicit security guidance, security reviews, or secure implementation requests, not ordinary code review.
---

<!-- Modified by OpenBot from OpenAI's security-best-practices skill. See NOTICE.txt. -->

# Secure Code Guidance

Ground the work in the repository before giving security advice. Identify the languages, frameworks, exposed entry points, trust boundaries, and existing project rules that apply.

For a review, report only concrete issues supported by code evidence. Give each finding a severity, impact, location, and smallest practical remediation. Distinguish confirmed vulnerabilities from defense-in-depth suggestions, and do not inflate local-development choices into production findings.

For implementation, prefer secure defaults that preserve intended behavior. Pay particular attention to authorization at resource boundaries, validation of untrusted input, injection risks, secret handling, unsafe deserialization, path traversal, outbound request controls, and sensitive data exposure.

Before proposing a change, inspect callers and tests for compatibility constraints. Verify fixes with the narrowest relevant checks. If the requested stack falls outside Python, JavaScript, TypeScript, or Go, state that this skill has no stack-specific guidance and limit the response to well-established general principles.
