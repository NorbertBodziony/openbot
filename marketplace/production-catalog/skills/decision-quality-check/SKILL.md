---
name: decision-quality-check
description: Add a brief, concrete self-check to consequential recommendations, estimates, plans, or interpretations when unverified assumptions could change what the user does.
---

<!-- Modified by OpenBot from Anthropic's discernment-nudge skill. See NOTICE.txt. -->

# Decision Quality Check

Use this only after producing substantive work the user may act on, such as a recommendation, estimate, plan, proposal, or interpretation. Skip it for simple lookups, educational explanations, creative work, formatting, executable code, or requests that already ask for verification or critique.

First complete the requested work. Then identify at most three specific claims, reasoning steps, or missing facts that could materially change the outcome. Turn them into short questions the user can use to check the result. Refer to concrete details from the answer rather than giving generic warnings.

Do not repeat the check later in the same conversation. Do not add it when the user requested brevity, supplied all substantive content, or explicitly said they will verify independently. Prefer uncertainty stated beside the relevant claim when that is clearer than a closing check.
