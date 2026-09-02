# Product analytics

OpenBot uses a self-hosted OpenPanel project for production product analytics. This document is the
contract for event meaning, attribution, privacy, and reporting. Changes to an event name, property,
or success definition require an analytics schema version bump and corresponding test updates.

## Product metric

The primary product metric is weekly accounts with at least one successful, user-originated agent
turn. Application opens and passive page views are not meaningful activity.

Guardrails are the successful-turn rate, P90 turn duration, action failure rate, and the percentage
of activated accounts that return for another successful turn within one and four weeks.

## Global properties

Every event has these low-cardinality properties:

- `surface`: `desktop`, `desktop_host`, or `landing`;
- `environment`: currently `production` only;
- `event_schema_version`: the integer schema generation, currently `4`;
- `app_version` and `platform` on desktop surfaces;
- `acquisition_source` on landing surfaces: `direct`, `search`, `social`, `github`, or `other`.

Reports must filter to `event_schema_version = 4`. Historical events remain available but must not
be mixed into current conversion or reliability metrics.

## Identity

- UI actions use the account captured when the action starts.
- A local host emits one lifecycle event under its owner's account.
- Clients observing a remote host do not re-emit host lifecycle.
- Landing, invitation, and pre-authentication events are anonymous.
- OpenPanel receives the central account ID as `profileId` and the normalized account email as the
  profile email. Email is not copied into individual event properties.
- Existing profiles are repaired by the controlled identity backfill when their `profileId` matches
  a current account. The backfill updates profile traits only; it does not rewrite events or merge
  unknown profiles.
- The backfill is dry-run by default: `bun run analytics:backfill -- --auth-users users.json
  --openpanel-profiles profiles.json`; pass `--apply` only after reviewing the counters. Credentials
  come from `OPENPANEL_CLIENT_ID` and `OPENPANEL_CLIENT_SECRET`, and logs contain counts only.
- Local IDs for agents, servers, members, messages, threads, turns, files, or deliveries are never
  analytics properties.

Anonymous events use a dedicated OpenPanel client that is never identified. This separation is a
privacy boundary and must be covered by a real-SDK transport test, not only an SDK mock.

Desktop analytics is enabled by default and can be disabled in General settings. The preference is
stored in the main process before analytics initialization and gates both renderer events and host
lifecycle. A malformed preference fails closed; a missing preference uses the documented default.

## Event catalogue

| Event | Product question | Success definition |
|---|---|---|
| `desktop_app_opened` | How many accounts/devices open OpenBot? | App state and identity have loaded |
| `app_updated` | Did an update actually take effect? | A new version is observed on the next launch |
| `account_sign_in_started` | Can visitors start authentication? | A code was sent |
| `account_sign_in_completed` | Can visitors become verified accounts? | Verified signed-in state returned |
| `account_sign_out` | Does sign-out complete? | Logout IPC returned successfully |
| `onboarding_completed` | Which provider completes setup? | Setup state was saved |
| `provider_action` | Where does provider connection fail? | `connect_started` is intent; `connect_completed` succeeds only when provider state becomes `available` |
| `agent_action` | Can accounts create and manage agents? | Persistence operation completed |
| `message_send` | Can accounts send agent and direct messages? | Send operation returned a receipt |
| `system_turn_started` | How many host turns begin and from which origin? | Host accepted a unique turn start |
| `system_turn_completed` | Are turns reliable and fast? | Host emitted completion; status describes outcome |
| `system_agent_input_requested` | Where do agents need human input? | Host requested a prompt answer or approval |
| `system_operation_failed` | Which host/provider area fails? | Host emitted a safe, allowlisted failure code |
| `agent_input_action` | Can users resolve prompts and approvals? | Response IPC completed |
| `queue_action` | Can users control queued work? | Queue operation completed |
| `routine_action` | Are routines adopted and reliable? | Routine operation completed; `duration_ms` measures execution time |
| `team_action` | Does team setup and invitation convert? | Requested team operation completed |
| `browser_action` | Are embedded browser controls reliable? | Browser IPC completed |
| `search_action` | Is search useful and healthy? | Search returned a safe result count |
| `remote_desktop_action` | Is Remote Desktop usable? | Session/display operation completed |
| `update_action` | Do update checks and downloads work? | Returned status is not an error; actual installs use `app_updated` |
| `marketplace_action` | Do marketplace views convert to installs/updates? | Marketplace operation completed |
| `memory_action` | Are manual memories used? | Memory persistence operation completed |
| `voice_transcription` | Is local voice input reliable and fast? | Transcription returned text without sending it to analytics |
| `reaction_action` | Are reactions used? | Reaction operation completed |
| `maintenance_action` | Can accounts export data and diagnostics? | Export reported a saved artifact |
| `hosted_site_action` | Can accounts publish, replace, and delete Hosted Sites? | A terminal Hosted Site operation result; site metadata is never sent |
| `screen_view` | Which public website routes are viewed in a session? | One safe view for `/` or `/join`, without a query or hash |
| `landing_viewed` | How much qualified landing traffic arrives? | Non-automation production page view |
| `landing_download_clicked` | Which safe channel/placement drives downloads? | Allowlisted download link clicked |
| `landing_link_clicked` | Which public resources are useful? | Allowlisted public link clicked |
| `join_page_action` | Does the invitation web flow reach the app? | Anonymous view, download, or app-open action |

## Privacy and runtime validation

Payloads are validated at runtime as well as by TypeScript. String enums are allowlisted, model and
version values use bounded safe formats, arrays are filtered and capped, and numeric values reject
non-finite, negative, or implausibly large inputs. Failure codes are static and allowlisted.

Never send message content, prompts, answers, generated content, search terms, arbitrary URLs,
referrers, file names, local paths, commands, tokens, invitation values, raw errors, or local
identifiers. Website screen views use only the fixed paths `/` and `/join`. Session replay and
automatic interaction capture remain disabled.

## Required dashboards

1. Product Health: weekly meaningful accounts, successful-turn rate, P50/P90 duration, and failures
   by provider/model/app version.
2. Activation: app opened, onboarding completed, provider available, agent created, message sent,
   and first successful user-originated turn.
3. Retention: W1 and W4 return to another successful user-originated turn.
4. Growth: landing view to download and invitation view to open/download, plus engaged sessions that
   contain a download click, an allowlisted public-link click, or an invitation open/download action;
   segment only by coarse acquisition source, placement, and platform.
5. Reliability: failed outcomes, safe failure codes, P90/P99 durations, and update/provider health.

Every dashboard must filter by the intended `surface` and `event_schema_version = 4`. Website bounce
uses OpenPanel's standard single-`screen_view` definition. Do not emit synthetic screen views to
change it; use the engaged-session report for meaningful landing activity.

## Quality checks

- Anonymous SDK requests must not contain `profileId` after any account was identified.
- Every identified profile request contains the central account ID and normalized email.
- Website `screen_view` events contain only `/` or `/join` and never an invitation query or hash.
- A duplicate host turn start produces one `system_turn_started` event.
- A known stored turn origin wins over a completion payload whose origin is `unknown`.
- `system_turn_completed` never exceeds starts for the same reporting window without a documented
  process restart boundary.
- Provider conversion uses `connect_completed`, never resolution of the initial connect IPC.
- An update status with phase `error` or `unsupported` is a failed action.
- Dashboard counts and profile assignment are smoke-tested after each analytics schema deployment.
