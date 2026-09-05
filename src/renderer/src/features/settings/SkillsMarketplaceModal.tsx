import type {
  AgentPublicationPreview,
  AgentSubmission,
  AgentSummary,
  AvatarImageInput,
  InstalledSkill,
  MarketplaceAgentDetail,
  MarketplaceAgentSummary,
  MarketplaceSkillDetail,
  MarketplaceSkillSummary,
  SkillCategory,
  SkillPackagePreview,
  SkillSubmission,
} from "@openbot/contracts/ipc";
import { isSkillCategory, SKILL_CATEGORIES } from "@openbot/contracts/ipc";
import { createEffect, createMemo, createSignal, createStore, For, onCleanup, Show, snapshot } from "solid-js";
import { desktopAnalytics } from "../../analytics";
import { normalizeAvatarFile } from "../../avatar-image";
import { createAsyncPanel } from "../../components/createAsyncPanel";
import {
  ArrowLeft,
  Button,
  Check,
  ChevronDown,
  Dialog,
  IconButton,
  Input,
  NativeSelect,
  Plus,
  Puzzle,
  RefreshCw,
  Search,
  Skeleton,
  Trash2,
  Upload,
  X,
} from "../../components/ui";
import { AgentAvatar } from "../agents/AgentAvatar";
import { routineScheduleSummary } from "../conversation/routine-schedule-ui";

interface SkillsMarketplaceModalProps {
  open: boolean;
  agents: Array<Pick<AgentSummary, "id" | "name" | "marketplaceSource">>;
  activeAgentId: string;
  onOpenChange: (open: boolean) => void;
  onAgentInstalled?: (agent: AgentSummary) => void | Promise<void>;
}

type Tab = "discover" | "installed" | "mine";
type MarketplaceKind = "skills" | "agents";
const SKILLS_SEARCH_DEBOUNCE_MS = 500;

const CATEGORY_LABELS: Record<SkillCategory, string> = {
  coding: "Coding",
  design: "Design",
  "data-analytics": "Data & Analytics",
  documents: "Documents",
  productivity: "Productivity",
  research: "Research",
  automation: "Automation",
  other: "Other",
};

/**
 * What the detail layer shows. Three signals allowed a combination the product does not have - a
 * loaded skill and a loaded submission at once - and turned "is anything open" into a chain of
 * three reads that every caller had to spell the same way.
 */
type SkillDetail =
  | { kind: "none" }
  | { kind: "loading" }
  | { kind: "skill"; skill: MarketplaceSkillDetail }
  | { kind: "submission"; submission: SkillSubmission };

/** Which listing is on screen and what narrows it: every field a tab switch resets together. */
interface SkillsBrowse {
  category: SkillCategory | null;
  kind: MarketplaceKind;
  query: string;
  tab: Tab;
  targetAgentId: string;
}

/** The publish form. Meaningful only while `preview` holds a chosen package, and cleared with it. */
interface SkillPublication {
  category: SkillCategory;
  icon: AvatarImageInput | null;
  iconPreviewUrl: string | null;
  preview: SkillPackagePreview | null;
  skillId: string | undefined;
}

/** Everything the skills half of the marketplace shows, grouped by the surface that owns it. */
interface SkillsMarketplace {
  browse: SkillsBrowse;
  detail: SkillDetail;
  installed: InstalledSkill[];
  publication: SkillPublication;
  skills: MarketplaceSkillSummary[];
  submissions: SkillSubmission[];
}

export function SkillsMarketplaceModal(props: SkillsMarketplaceModalProps) {
  const [market, setMarket] = createStore<SkillsMarketplace>({
    browse: { category: null, kind: "skills", query: "", tab: "discover", targetAgentId: "" },
    detail: { kind: "none" },
    installed: [],
    publication: { category: "other", icon: null, iconPreviewUrl: null, preview: null, skillId: undefined },
    skills: [],
    submissions: [],
  });
  /** Pulse counters, not marketplace state: each one asks the agent panel to do something once. */
  const [agentRefreshVersion, setAgentRefreshVersion] = createSignal(0);
  const [agentAddVersion, setAgentAddVersion] = createSignal(0);
  const { panel, run, setBusy, setError, setLoading } = createAsyncPanel(marketplaceErrorMessage);
  let marketplaceBody: HTMLDivElement | undefined;
  let listScrollTop = 0;
  let searchTimer: number | undefined;
  let searchInitialized = false;

  const installedById = createMemo(() => new Map(market.installed.map((item) => [item.skillId, item])));
  const targetAgent = createMemo(() => props.agents.find((agent) => agent.id === market.browse.targetAgentId) ?? null);
  // The arms of the detail union, so the JSX narrows here once instead of at every read.
  const detailOpen = () => market.detail.kind !== "none";
  const detailLoading = () => market.detail.kind === "loading";
  const skillDetail = () => (market.detail.kind === "skill" ? market.detail.skill : null);
  const submissionDetail = () => (market.detail.kind === "submission" ? market.detail.submission : null);

  createEffect(
    () => props.open,
    (open) => {
      if (!open) {
        closeDetail();
        return;
      }
      setMarket((state) => {
        state.browse.targetAgentId = state.browse.targetAgentId || props.activeAgentId || props.agents[0]?.id || "";
      });
      void loadSkills();
    },
  );

  createEffect(
    () => market.browse.query,
    () => {
      if (searchTimer !== undefined) window.clearTimeout(searchTimer);
      if (!searchInitialized) {
        searchInitialized = true;
        return;
      }
      if (!props.open || market.browse.tab !== "discover") return;
      searchTimer = window.setTimeout(() => void loadSkills(), SKILLS_SEARCH_DEBOUNCE_MS);
    },
  );

  createEffect(
    () => [props.open, market.browse.targetAgentId] as const,
    ([open, agentId]) => {
      if (open && agentId) void loadInstalled(agentId);
      else {
        setMarket((state) => {
          state.installed = [];
        });
      }
    },
  );

  onCleanup(() => {
    if (searchTimer !== undefined) window.clearTimeout(searchTimer);
  });

  /** Clears the detail layer whichever arm it is on. */
  function closeDetail(): void {
    setMarket((state) => {
      state.detail = { kind: "none" };
    });
  }

  function selectCategory(nextCategory: SkillCategory | null) {
    if (searchTimer !== undefined) window.clearTimeout(searchTimer);
    setMarket((state) => {
      state.browse.category = nextCategory;
    });
    void loadSkills();
  }

  async function loadSkills() {
    setLoading(true);
    const search = market.browse.query.trim();
    const selectedCategory = market.browse.category;
    const pages = await run(() =>
      selectedCategory
        ? Promise.all([
            window.openbot.skills.list({
              ...(search ? { query: search } : {}),
              category: selectedCategory,
              limit: 50,
            }),
          ])
        : Promise.all(
            SKILL_CATEGORIES.map((item) =>
              window.openbot.skills.list({
                ...(search ? { query: search } : {}),
                category: item,
                sort: "installs",
                limit: 5,
              }),
            ),
          ),
    );
    if (pages) {
      const skills = pages.flatMap((page) => page.skills);
      setMarket((state) => {
        state.skills = skills;
      });
    }
    setLoading(false);
  }

  async function loadInstalled(agentId = market.browse.targetAgentId) {
    if (!agentId) {
      setMarket((state) => {
        state.installed = [];
      });
      return;
    }
    const values = await run(() => window.openbot.skills.listInstalled(agentId));
    if (values) {
      setMarket((state) => {
        state.installed = values;
      });
    }
  }

  async function loadMine() {
    setLoading(true);
    const values = await run(() => window.openbot.skills.listMine());
    if (values) {
      setMarket((state) => {
        state.submissions = values;
      });
    }
    setLoading(false);
  }

  function refresh(next: Tab = market.browse.tab) {
    if (next === "discover") void loadSkills();
    if (next === "mine") void loadMine();
    if (next === "installed") void loadInstalled();
  }

  function selectTab(next: Tab) {
    const marketplaceKind = market.browse.kind;
    if (marketplaceBody) marketplaceBody.scrollTop = 0;
    setMarket((state) => {
      state.browse.tab = next;
      state.detail = { kind: "none" };
      state.publication.preview = null;
      state.publication.icon = null;
      state.publication.iconPreviewUrl = null;
    });
    setError(null);
    if (marketplaceKind === "skills") refresh(next);
  }

  function selectKind(next: MarketplaceKind) {
    if (marketplaceBody) marketplaceBody.scrollTop = 0;
    setMarket((state) => {
      state.browse.kind = next;
      state.browse.tab = "discover";
      state.detail = { kind: "none" };
      state.publication.preview = null;
    });
    setError(null);
    if (next === "skills") void loadSkills();
  }

  function enterDetails() {
    if (!detailOpen()) {
      listScrollTop = marketplaceBody?.scrollTop ?? 0;
    }
    if (marketplaceBody) marketplaceBody.scrollTop = 0;
  }

  function leaveDetails() {
    closeDetail();
    queueMicrotask(() => {
      if (marketplaceBody) marketplaceBody.scrollTop = listScrollTop;
    });
  }

  async function openDetails(skill: MarketplaceSkillSummary) {
    const analytics = desktopAnalytics.scope();
    enterDetails();
    setMarket((state) => {
      state.detail = { kind: "loading" };
    });
    const value = await run(() => window.openbot.skills.get(skill.id));
    analytics.track("marketplace_action", {
      entity: "skill",
      action: "view",
      result: value ? "succeeded" : "failed",
      ...(value ? {} : { failure_code: "load_failed" }),
    });
    if (!value) {
      leaveDetails();
      return;
    }
    setMarket((state) => {
      state.detail = { kind: "skill", skill: value };
    });
  }

  async function openDetailsById(skillId: string) {
    const summary = market.skills.find((skill) => skill.id === skillId);
    if (summary) {
      await openDetails(summary);
      return;
    }
    enterDetails();
    const analytics = desktopAnalytics.scope();
    setMarket((state) => {
      state.detail = { kind: "loading" };
    });
    const value = await run(() => window.openbot.skills.get(skillId));
    analytics.track("marketplace_action", {
      entity: "skill",
      action: "view",
      result: value ? "succeeded" : "failed",
      ...(value ? {} : { failure_code: "load_failed" }),
    });
    if (!value) {
      leaveDetails();
      return;
    }
    setMarket((state) => {
      state.detail = { kind: "skill", skill: value };
    });
  }

  function openSubmissionDetails(submission: SkillSubmission) {
    if (submission.status === "approved") {
      void openDetailsById(submission.skillId);
      return;
    }
    enterDetails();
    setMarket((state) => {
      state.detail = { kind: "submission", submission };
    });
  }

  async function install(
    skill: MarketplaceSkillSummary,
    replaceModified = false,
    action: "install" | "update" = "install",
  ) {
    const agentId = market.browse.targetAgentId;
    if (!agentId) {
      setError("Switch to Local and create an agent before installing skills.");
      return;
    }
    const analytics = desktopAnalytics.scope();
    setBusy(skill.id);
    const result = await run(() => window.openbot.skills.install({ agentId, skillId: skill.id, replaceModified }));
    analytics.track("marketplace_action", {
      entity: "skill",
      action,
      result: result ? "succeeded" : "failed",
      ...(result ? {} : { failure_code: action === "update" ? "update_failed" : "install_failed" }),
    });
    if (result) await loadInstalled(agentId);
    setBusy(null);
  }

  async function updateInstalled(item: InstalledSkill) {
    const analytics = desktopAnalytics.scope();
    const listing =
      market.skills.find((skill) => skill.id === item.skillId) ??
      (await run(() => window.openbot.skills.get(item.skillId)));
    if (!listing) {
      analytics.track("marketplace_action", {
        entity: "skill",
        action: "update",
        result: "failed",
        failure_code: "load_failed",
      });
      return;
    }
    const replace = item.state === "modified";
    if (replace && !window.confirm(`Replace local changes in ${item.name}?`)) return;
    await install(listing, replace, "update");
  }

  async function uninstall(item: InstalledSkill) {
    const modified = item.state === "modified";
    if (!window.confirm(modified ? `Delete ${item.name} and its local changes?` : `Uninstall ${item.name}?`)) return;
    const analytics = desktopAnalytics.scope();
    setBusy(item.skillId);
    const removed = await run(async () => {
      await window.openbot.skills.uninstall({
        agentId: market.browse.targetAgentId,
        skillId: item.skillId,
        ...(modified ? { removeModified: true } : {}),
      });
      return true;
    });
    analytics.track("marketplace_action", {
      entity: "skill",
      action: "uninstall",
      result: removed ? "succeeded" : "failed",
      ...(removed ? {} : { failure_code: "uninstall_failed" }),
    });
    if (removed) await loadInstalled();
    setBusy(null);
  }

  async function choosePackage(skillId?: string) {
    const value = await run(() => window.openbot.skills.choosePackage());
    if (!value) return;
    const category = skillId
      ? (market.submissions.find((item) => item.skillId === skillId)?.category ?? "other")
      : "other";
    setMarket((state) => {
      state.publication = { category, icon: null, iconPreviewUrl: null, preview: value, skillId };
    });
  }

  async function submit() {
    const value = market.publication.preview;
    if (!value) return;
    const analytics = desktopAnalytics.scope();
    const { category, skillId } = market.publication;
    // The icon crosses to IPC, which structured-clones it, so it goes as a snapshot rather than as
    // whatever the store hands back.
    const icon = snapshot(market.publication.icon);
    setBusy("publish");
    const created = await run(() =>
      window.openbot.skills.submit({
        draftId: value.draftId,
        category,
        icon,
        ...(skillId ? { skillId } : {}),
      }),
    );
    analytics.track("marketplace_action", {
      entity: "skill",
      action: "publish",
      result: created ? "succeeded" : "failed",
      ...(created ? {} : { failure_code: "publish_failed" }),
    });
    if (created) {
      discardPublication();
      await loadMine();
    }
    setBusy(null);
  }

  async function chooseIcon(file: File | undefined) {
    if (!file) return;
    const icon = await run(() => normalizeAvatarFile(file));
    if (!icon) return;
    const iconPreviewUrl = avatarImageDataUrl(icon);
    setMarket((state) => {
      state.publication.icon = icon;
      state.publication.iconPreviewUrl = iconPreviewUrl;
    });
  }

  /** Drops the chosen package and the icon picked for it: neither outlives the other. */
  function discardPublication(): void {
    setMarket((state) => {
      state.publication.preview = null;
      state.publication.icon = null;
      state.publication.iconPreviewUrl = null;
    });
  }

  return (
    <Dialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay class="skills-marketplace-backdrop">
          <Dialog.Content class="skills-marketplace" onOpenAutoFocus={(event) => event.preventDefault()}>
            <header class="skills-marketplace-topbar">
              <Dialog.Title class="sr-only">Marketplace</Dialog.Title>
              <nav class="skills-marketplace-kind-tabs" aria-label="Marketplace content types">
                <Button
                  class="skills-marketplace-kind-tab"
                  data-active={market.browse.kind === "skills" ? "" : undefined}
                  variant="ghost"
                  size="sm"
                  aria-current={market.browse.kind === "skills" ? "page" : undefined}
                  onClick={() => selectKind("skills")}
                >
                  Skills
                </Button>
                <Button
                  class="skills-marketplace-kind-tab"
                  data-active={market.browse.kind === "agents" ? "" : undefined}
                  variant="ghost"
                  size="sm"
                  aria-current={market.browse.kind === "agents" ? "page" : undefined}
                  onClick={() => selectKind("agents")}
                >
                  Agents
                </Button>
              </nav>
              <span class="skills-marketplace-topbar-divider" aria-hidden="true" />
              <nav
                class="skills-marketplace-view-tabs"
                aria-label={`${market.browse.kind === "skills" ? "Skills" : "Agent"} views`}
              >
                <Button
                  class="skills-marketplace-tab"
                  data-active={market.browse.tab === "discover" ? "" : undefined}
                  variant="ghost"
                  size="sm"
                  onClick={() => selectTab("discover")}
                >
                  Discover
                </Button>
                <Button
                  class="skills-marketplace-tab"
                  data-active={market.browse.tab === "installed" ? "" : undefined}
                  variant="ghost"
                  size="sm"
                  onClick={() => selectTab("installed")}
                >
                  Installed
                </Button>
                <Button
                  class="skills-marketplace-tab"
                  data-active={market.browse.tab === "mine" ? "" : undefined}
                  variant="ghost"
                  size="sm"
                  onClick={() => selectTab("mine")}
                >
                  My submissions
                </Button>
              </nav>
              <div class="skills-marketplace-actions">
                <IconButton
                  label={market.browse.kind === "skills" ? "Refresh skills" : "Refresh agents"}
                  variant="ghost"
                  onClick={() =>
                    market.browse.kind === "skills" ? refresh() : setAgentRefreshVersion((version) => version + 1)
                  }
                >
                  <RefreshCw />
                </IconButton>
                <Button
                  variant="default"
                  size="sm"
                  onClick={() => {
                    selectTab("mine");
                    if (market.browse.kind === "skills") void choosePackage();
                    else setAgentAddVersion((version) => version + 1);
                  }}
                >
                  <Plus /> Add {market.browse.kind === "skills" ? "skill" : "agent"}
                </Button>
                <IconButton label="Close marketplace" variant="ghost" onClick={() => props.onOpenChange(false)}>
                  <X />
                </IconButton>
              </div>
            </header>

            <div
              class="skills-marketplace-body"
              data-detail-open={detailOpen() ? "" : undefined}
              ref={(element) => (marketplaceBody = element)}
            >
              <Show when={market.browse.kind === "skills"}>
                <Show when={market.browse.tab === "discover"}>
                  <section
                    class="skills-marketplace-discover"
                    aria-label="Discover skills"
                    aria-hidden={skillDetail() || detailLoading() ? "true" : undefined}
                    inert={skillDetail() || detailLoading() ? true : undefined}
                  >
                    <div class="skills-marketplace-heading">
                      <div>
                        <h1>Skills</h1>
                        <p>Give your agents focused capabilities for repeatable work.</p>
                      </div>
                      <AgentSelect
                        agents={props.agents}
                        value={market.browse.targetAgentId}
                        onChange={(agentId) =>
                          setMarket((state) => {
                            state.browse.targetAgentId = agentId;
                          })
                        }
                      />
                    </div>
                    <div class="skills-marketplace-search">
                      <Search aria-hidden="true" />
                      <Input
                        aria-label="Search skills"
                        placeholder="Search skills"
                        value={market.browse.query}
                        onValueChange={(value) =>
                          setMarket((state) => {
                            state.browse.query = value;
                          })
                        }
                      />
                    </div>
                    <div class="skills-marketplace-categories">
                      <Button
                        size="sm"
                        data-active={market.browse.category === null ? "" : undefined}
                        onClick={() => selectCategory(null)}
                      >
                        All
                      </Button>
                      <For each={SKILL_CATEGORIES}>
                        {(item) => (
                          <Button
                            size="sm"
                            data-active={market.browse.category === item ? "" : undefined}
                            onClick={() => selectCategory(item)}
                          >
                            {CATEGORY_LABELS[item]}
                          </Button>
                        )}
                      </For>
                    </div>
                    <Show when={!panel.loading} fallback={<SkillsListSkeleton category={market.browse.category} />}>
                      <Show
                        when={market.skills.length}
                        fallback={<div class="skills-marketplace-state">No skills match this search.</div>}
                      >
                        <Show
                          when={market.browse.category === null}
                          fallback={
                            <SkillCategorySection
                              label={CATEGORY_LABELS[market.browse.category ?? "other"]}
                              skills={market.skills}
                              installedById={installedById()}
                              busyId={panel.busy}
                              onInstall={install}
                              onOpen={openDetails}
                            />
                          }
                        >
                          <For each={SKILL_CATEGORIES}>
                            {(item) => {
                              const categorySkills = () => market.skills.filter((skill) => skill.category === item);
                              return (
                                <Show when={categorySkills().length > 0}>
                                  <SkillCategorySection
                                    label={CATEGORY_LABELS[item]}
                                    skills={categorySkills()}
                                    installedById={installedById()}
                                    busyId={panel.busy}
                                    onInstall={install}
                                    onOpen={openDetails}
                                  />
                                </Show>
                              );
                            }}
                          </For>
                        </Show>
                      </Show>
                    </Show>
                  </section>
                </Show>

                <Show when={market.browse.tab === "installed"}>
                  <section class="skills-marketplace-panel">
                    <div class="skills-marketplace-heading">
                      <div>
                        <h1>Installed</h1>
                        <p>Manage marketplace-owned skills for one local agent.</p>
                      </div>
                      <AgentSelect
                        agents={props.agents}
                        value={market.browse.targetAgentId}
                        onChange={(agentId) =>
                          setMarket((state) => {
                            state.browse.targetAgentId = agentId;
                          })
                        }
                      />
                    </div>
                    <Show
                      when={targetAgent()}
                      fallback={
                        <div class="skills-marketplace-state">
                          Switch to Local and choose an agent to manage skills.
                        </div>
                      }
                    >
                      <Show
                        when={market.installed.length}
                        fallback={
                          <div class="skills-marketplace-state">
                            No marketplace skills are installed for this agent.
                          </div>
                        }
                      >
                        <div class="skills-installed-list">
                          <For each={market.installed}>
                            {(item) => (
                              <article class="skills-installed-row">
                                <Button
                                  variant="ghost"
                                  type="button"
                                  class="skills-marketplace-row-hitarea"
                                  aria-label={`View ${item.name} details`}
                                  onClick={() => void openDetailsById(item.skillId)}
                                />
                                <span class="skills-marketplace-default-icon">
                                  <Puzzle />
                                </span>
                                <div>
                                  <h3>{item.name}</h3>
                                  <p>
                                    v{item.installedVersion}
                                    {item.availableVersion > item.installedVersion
                                      ? ` · v${item.availableVersion} available`
                                      : ""}
                                  </p>
                                </div>
                                <span class="skills-installed-state" data-state={item.state}>
                                  {item.state.replaceAll("-", " ")}
                                </span>
                                <Button
                                  size="sm"
                                  loading={panel.busy === item.skillId}
                                  onClick={() => void updateInstalled(item)}
                                >
                                  <RefreshCw /> {item.state === "installed" ? "Repair" : "Update"}
                                </Button>
                                <IconButton
                                  label={`Uninstall ${item.name}`}
                                  variant="ghost"
                                  onClick={() => void uninstall(item)}
                                >
                                  <Trash2 />
                                </IconButton>
                              </article>
                            )}
                          </For>
                        </div>
                      </Show>
                    </Show>
                  </section>
                </Show>

                <Show when={market.browse.tab === "mine"}>
                  <section class="skills-marketplace-panel">
                    <div class="skills-marketplace-heading">
                      <div>
                        <h1>My submissions</h1>
                        <p>Package a focused, safe skill and submit it for marketplace review.</p>
                      </div>
                      <Button onClick={() => void choosePackage()}>
                        <Upload /> Choose folder or ZIP
                      </Button>
                    </div>
                    <section class="skills-submission-guide" aria-labelledby="skills-submission-guide-title">
                      <div class="skills-submission-guide-heading">
                        <h2 id="skills-submission-guide-title">Submission requirements</h2>
                        <p>Your skill is validated before it can be sent for review.</p>
                      </div>
                      <div class="skills-submission-guide-grid">
                        <div>
                          <h3>Package</h3>
                          <ul>
                            <li>
                              <Check />
                              <span>
                                Choose a folder or ZIP with <code>SKILL.md</code> at its root.
                              </span>
                            </li>
                            <li>
                              <Check />
                              <span>
                                Include no more than 200 files and keep both packaged and expanded size under 10 MB.
                              </span>
                            </li>
                            <li>
                              <Check />
                              <span>Include only the scripts, references, and assets the skill needs.</span>
                            </li>
                          </ul>
                        </div>
                        <div>
                          <h3>Safety and review</h3>
                          <ul>
                            <li>
                              <Check />
                              <span>Explain when to use the skill, its workflow, and the expected output.</span>
                            </li>
                            <li>
                              <Check />
                              <span>
                                Never include secrets, <code>.env</code> files, private keys, or user data.
                              </span>
                            </li>
                            <li>
                              <Check />
                              <span>
                                Exclude <code>.git</code>, <code>node_modules</code>, symlinks, and nested archives.
                              </span>
                            </li>
                          </ul>
                        </div>
                      </div>
                      <div class="skills-submission-example">
                        <div>
                          <h3>Required SKILL.md metadata</h3>
                          <p>Name: 80 characters maximum · Description: 500 characters maximum</p>
                        </div>
                        <pre>{`---
name: Release Notes
description: Turn merged work into clear, consistent release notes.
---`}</pre>
                      </div>
                      <p class="skills-submission-limit">
                        Limits: 5 skills total · 5 submitted versions per skill · 10 submitted versions per 24 hours
                      </p>
                    </section>
                    <Show when={market.publication.preview}>
                      {(value) => (
                        <div class="skills-publish-card">
                          <div class="skills-publish-summary">
                            <Show
                              when={market.publication.iconPreviewUrl}
                              fallback={
                                <span class="skills-marketplace-default-icon">
                                  <Puzzle />
                                </span>
                              }
                              keyed
                            >
                              {(url) => (
                                <span class="skills-marketplace-icon">
                                  <img src={url} alt="Skill icon preview" />
                                </span>
                              )}
                            </Show>
                            <div>
                              <h2>{value().name}</h2>
                              <p>{value().description}</p>
                              <small>
                                {value().files.length} files · {(value().size / 1024).toFixed(1)} KB
                              </small>
                            </div>
                          </div>
                          <div class="skills-publish-fields">
                            <label class="skills-publish-category">
                              Category
                              <NativeSelect
                                value={market.publication.category}
                                onChange={(event) => {
                                  const category = event.currentTarget.value;
                                  if (isSkillCategory(category)) {
                                    setMarket((state) => {
                                      state.publication.category = category;
                                    });
                                  }
                                }}
                              >
                                <For each={SKILL_CATEGORIES}>
                                  {(item) => <option value={item}>{CATEGORY_LABELS[item]}</option>}
                                </For>
                              </NativeSelect>
                              <ChevronDown aria-hidden="true" />
                            </label>
                            <label>
                              Icon (optional)
                              <Input
                                type="file"
                                accept="image/png,image/jpeg,image/webp"
                                onChange={(event) => void chooseIcon(event.currentTarget.files?.[0])}
                              />
                            </label>
                          </div>
                          <div class="skills-publish-actions">
                            <Button variant="ghost" onClick={discardPublication}>
                              Cancel
                            </Button>
                            <Button
                              variant="default"
                              loading={panel.busy === "publish"}
                              loadingLabel="Submitting…"
                              onClick={() => void submit()}
                            >
                              Submit for review
                            </Button>
                          </div>
                        </div>
                      )}
                    </Show>
                    <Show when={!market.publication.preview}>
                      <Show
                        when={market.submissions.length}
                        fallback={
                          <div class="skills-marketplace-state">
                            No submissions yet. Choose a skill folder or ZIP to publish.
                          </div>
                        }
                      >
                        <div class="skills-submission-list">
                          <For each={market.submissions}>
                            {(item) => (
                              <article class="skills-submission-row">
                                <Button
                                  variant="ghost"
                                  type="button"
                                  class="skills-marketplace-row-hitarea"
                                  aria-label={`View ${item.name} submission details`}
                                  onClick={() => openSubmissionDetails(item)}
                                />
                                <SkillIcon skill={item} />
                                <div>
                                  <h3>{item.name}</h3>
                                  <p>
                                    {CATEGORY_LABELS[item.category]} · version {item.version}
                                  </p>
                                  <Show when={item.rejectionNote}>
                                    <small>{item.rejectionNote}</small>
                                  </Show>
                                </div>
                                <span class="skills-submission-status" data-status={item.status}>
                                  {item.status}
                                </span>
                                <Show when={item.status === "approved" || item.status === "rejected"}>
                                  <Button size="sm" onClick={() => void choosePackage(item.skillId)}>
                                    <Plus /> New version
                                  </Button>
                                </Show>
                              </article>
                            )}
                          </For>
                        </div>
                      </Show>
                    </Show>
                  </section>
                </Show>
                <Show when={detailOpen()}>
                  <div class="skills-marketplace-detail-layer">
                    <Show when={!detailLoading()} fallback={<SkillDetailSkeleton />}>
                      <Show when={skillDetail()} keyed>
                        {(skill) => (
                          <SkillDetailView
                            skill={skill}
                            installed={installedById().get(skill.id)}
                            busy={panel.busy === skill.id}
                            onBack={leaveDetails}
                            onInstall={install}
                          />
                        )}
                      </Show>
                      <Show when={submissionDetail()} keyed>
                        {(submission) => <SkillSubmissionDetailView submission={submission} onBack={leaveDetails} />}
                      </Show>
                    </Show>
                  </div>
                </Show>
                <Show when={panel.error}>
                  {(message) => (
                    <div class="skills-marketplace-error" role="alert">
                      {message()}
                    </div>
                  )}
                </Show>
              </Show>
              <Show when={market.browse.kind === "agents"}>
                <AgentMarketplacePanel
                  agents={props.agents}
                  view={market.browse.tab}
                  refreshVersion={agentRefreshVersion()}
                  addVersion={agentAddVersion()}
                  onInstalled={props.onAgentInstalled}
                  onEnterDetail={enterDetails}
                  onLeaveDetail={leaveDetails}
                />
              </Show>
            </div>
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** The agent half's listing, its detail layer, and the one publication being prepared. */
interface AgentsMarketplace {
  agents: MarketplaceAgentSummary[];
  detail: MarketplaceAgentDetail | null;
  publication: {
    /** The marketplace listing a new version is for, or `undefined` for a first submission. */
    listingId: string | undefined;
    preview: AgentPublicationPreview | null;
    sourceAgentId: string;
  };
  query: string;
  submissions: AgentSubmission[];
}

function AgentMarketplacePanel(props: {
  agents: Array<Pick<AgentSummary, "id" | "name" | "marketplaceSource">>;
  view: Tab;
  refreshVersion: number;
  addVersion: number;
  onInstalled?: (agent: AgentSummary) => void | Promise<void>;
  onEnterDetail: () => void;
  onLeaveDetail: () => void;
}) {
  const [market, setMarket] = createStore<AgentsMarketplace>({
    agents: [],
    detail: null,
    publication: { listingId: undefined, preview: null, sourceAgentId: props.agents[0]?.id ?? "" },
    query: "",
    submissions: [],
  });
  const { panel, run, setBusy, setError, setLoading } = createAsyncPanel(marketplaceErrorMessage);
  const installedAgents = createMemo(
    () =>
      new Map(
        props.agents.flatMap((agent) => (agent.marketplaceSource ? [[agent.marketplaceSource.listingId, agent]] : [])),
      ),
  );
  let searchTimer: number | undefined;
  let initialized = false;
  let handledAddVersion = 0;

  createEffect(
    () => [props.view, props.refreshVersion] as const,
    ([view]) => {
      setMarket((state) => {
        state.detail = null;
        state.publication.preview = null;
      });
      setError(null);
      if (view === "discover") void loadAgents();
      if (view === "mine") void loadMine();
      initialized = true;
    },
  );

  createEffect(
    () => props.addVersion,
    (version) => {
      if (!initialized || version === handledAddVersion) return;
      handledAddVersion = version;
      void preparePublication();
    },
  );

  onCleanup(() => {
    if (searchTimer !== undefined) window.clearTimeout(searchTimer);
  });

  async function loadAgents() {
    setLoading(true);
    const search = market.query.trim();
    const page = await run(() =>
      window.openbot.marketplaceAgents.list({ ...(search ? { query: search } : {}), limit: 50 }),
    );
    if (page) {
      const agents = page.agents;
      setMarket((state) => {
        state.agents = agents;
      });
    }
    setLoading(false);
  }

  async function loadMine() {
    setLoading(true);
    const values = await run(() => window.openbot.marketplaceAgents.listMine());
    if (values) {
      setMarket((state) => {
        state.submissions = values;
      });
    }
    setLoading(false);
  }

  function updateSearch(value: string) {
    setMarket((state) => {
      state.query = value;
    });
    if (searchTimer !== undefined) window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => void loadAgents(), SKILLS_SEARCH_DEBOUNCE_MS);
  }

  async function openAgent(agent: MarketplaceAgentSummary) {
    const analytics = desktopAnalytics.scope();
    props.onEnterDetail();
    setLoading(true);
    const value = await run(() => window.openbot.marketplaceAgents.get(agent.id));
    analytics.track("marketplace_action", {
      entity: "agent",
      action: "view",
      result: value ? "succeeded" : "failed",
      ...(value ? {} : { failure_code: "load_failed" }),
    });
    if (value) {
      setMarket((state) => {
        state.detail = value;
      });
    } else props.onLeaveDetail();
    setLoading(false);
  }

  function closeAgent() {
    setMarket((state) => {
      state.detail = null;
    });
    props.onLeaveDetail();
  }

  async function installAgentSummary(agent: MarketplaceAgentSummary) {
    const analytics = desktopAnalytics.scope();
    const action = installedAgent(agent) ? "update" : "install";
    const value = await run(() => window.openbot.marketplaceAgents.get(agent.id));
    if (value) {
      await installAgent(value);
      return;
    }
    analytics.track("marketplace_action", {
      entity: "agent",
      action,
      result: "failed",
      failure_code: "load_failed",
    });
  }

  async function installAgent(agent: MarketplaceAgentDetail) {
    const installation = installedAgent(agent);
    if (installation?.marketplaceSource?.versionId === agent.versionId) return;
    const updating = Boolean(installation);
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (
      agent.activeRoutineCount > 0 &&
      !window.confirm(
        `${agent.name} includes ${agent.activeRoutineCount} active ${agent.activeRoutineCount === 1 ? "routine" : "routines"}. ` +
          `They will run automatically in ${timezone}. ${updating ? "Update" : "Install"} this agent?`,
      )
    )
      return;
    const analytics = desktopAnalytics.scope();
    setBusy(agent.id);
    const value = await run(() =>
      window.openbot.marketplaceAgents.install({
        listingId: agent.id,
        ...(installation ? { agentId: installation.id } : {}),
        timezone,
        receiptId: crypto.randomUUID(),
      }),
    );
    analytics.track("marketplace_action", {
      entity: "agent",
      action: updating ? "update" : "install",
      result: value ? "succeeded" : "failed",
      ...(value ? {} : { failure_code: updating ? "update_failed" : "install_failed" }),
    });
    if (value) await props.onInstalled?.(value.agent);
    setBusy(null);
  }

  function installedAgent(agent: MarketplaceAgentSummary) {
    return installedAgents().get(agent.id);
  }

  function agentAction(agent: MarketplaceAgentSummary): "Install" | "Update" | "Installed" {
    const installed = installedAgent(agent);
    if (!installed) return "Install";
    return installed.marketplaceSource?.versionId === ("versionId" in agent ? agent.versionId : undefined) ||
      (installed.marketplaceSource?.version ?? 0) >= agent.version
      ? "Installed"
      : "Update";
  }

  async function preparePublication(listingId?: string) {
    const agentId = market.publication.sourceAgentId || props.agents[0]?.id;
    if (!agentId) {
      setError("Switch to Local and choose an agent to publish.");
      return;
    }
    setMarket((state) => {
      state.publication.listingId = listingId;
    });
    setBusy("publish");
    const value = await run(() => window.openbot.marketplaceAgents.preview(agentId));
    if (value) {
      setMarket((state) => {
        state.publication.preview = value;
      });
    }
    setBusy(null);
  }

  /** Drops the previewed publication and the agent it was going to update. */
  function discardPublication(): void {
    setMarket((state) => {
      state.publication.preview = null;
      state.publication.listingId = undefined;
    });
  }

  async function submitPublication() {
    const value = market.publication.preview;
    if (!value) return;
    const analytics = desktopAnalytics.scope();
    const listingId = market.publication.listingId;
    setBusy("submit");
    const result = await run(() =>
      window.openbot.marketplaceAgents.submit({
        agentId: value.agentId,
        ...(listingId ? { listingId } : {}),
      }),
    );
    analytics.track("marketplace_action", {
      entity: "agent",
      action: "publish",
      result: result ? "succeeded" : "failed",
      ...(result ? {} : { failure_code: "publish_failed" }),
    });
    if (result) {
      discardPublication();
      await loadMine();
    }
    setBusy(null);
  }

  return (
    <section class="skills-marketplace-panel agent-marketplace-panel" aria-label="Agent marketplace">
      <Show when={props.view === "discover"}>
        <Show
          when={market.detail}
          keyed
          fallback={
            <>
              <div class="skills-marketplace-heading">
                <div>
                  <h1>Agents</h1>
                  <p>Start with a trusted role, its skills, and ready-made routines.</p>
                </div>
              </div>
              <div class="skills-marketplace-search">
                <Search aria-hidden="true" />
                <Input
                  aria-label="Search agents"
                  placeholder="Search agents"
                  value={market.query}
                  onValueChange={updateSearch}
                />
              </div>
              <Show when={!panel.loading} fallback={<div class="skills-marketplace-state">Loading agents…</div>}>
                <Show
                  when={market.agents.length}
                  fallback={<div class="skills-marketplace-state">No agents match this search.</div>}
                >
                  <AgentCardSection
                    agents={market.agents}
                    busy={panel.busy !== null}
                    action={agentAction}
                    onOpen={openAgent}
                    onInstall={installAgentSummary}
                  />
                </Show>
              </Show>
            </>
          }
        >
          {(agent) => (
            <div class="skills-marketplace-detail agent-marketplace-detail">
              <Button class="skills-marketplace-detail-back" variant="ghost" size="sm" onClick={closeAgent}>
                <ArrowLeft /> Back to agents
              </Button>
              <div class="skills-marketplace-detail-hero">
                <AgentAvatar seed={agent.avatarSeed} hue={agent.avatarHue} url={agent.avatarUrl} motion="hover" />
                <div>
                  <p class="skills-marketplace-detail-category">Agent template</p>
                  <h1>{agent.name}</h1>
                  <p>{agent.title || agent.description}</p>
                  <div class="skills-marketplace-detail-meta">
                    <span>By {agent.creatorName}</span>
                    <span>Version {agent.version}</span>
                    <span>{agent.installs.toLocaleString()} installs</span>
                  </div>
                </div>
                <Button
                  disabled={agentAction(agent) === "Installed"}
                  loading={panel.busy !== null}
                  loadingLabel={agentAction(agent) === "Update" ? "Updating…" : "Installing…"}
                  onClick={() => void installAgent(agent)}
                >
                  {agentAction(agent) === "Installed" ? "Installed" : `${agentAction(agent)} agent`}
                </Button>
              </div>
              <div class="skills-marketplace-detail-content agent-marketplace-detail-content">
                <section class="agent-marketplace-detail-remit">
                  <h2>Standing remit</h2>
                  <p>{agent.description}</p>
                </section>
                <div class="agent-marketplace-detail-columns">
                  <section class="agent-marketplace-detail-section">
                    <header>
                      <h2>Skills</h2>
                    </header>
                    <Show when={agent.skills.length} fallback={<p>No marketplace skills included.</p>}>
                      <ul class="agent-marketplace-dependency-list">
                        <For each={agent.skills}>
                          {(skill) => (
                            <li>
                              <span>{skill.name}</span>
                              <small>v{skill.version}</small>
                            </li>
                          )}
                        </For>
                      </ul>
                    </Show>
                  </section>
                  <section class="agent-marketplace-detail-section">
                    <header>
                      <h2>Routines</h2>
                    </header>
                    <Show when={agent.routines.length} fallback={<p>No routines included.</p>}>
                      <ul class="agent-marketplace-routine-list">
                        <For each={agent.routines}>
                          {(routine) => (
                            <li>
                              <span>
                                {routine.name}
                                <small>{routineScheduleSummary(routine.schedule)}</small>
                              </span>
                              <small>{routine.active ? "Active" : "Inactive"}</small>
                            </li>
                          )}
                        </For>
                      </ul>
                    </Show>
                  </section>
                </div>
              </div>
            </div>
          )}
        </Show>
      </Show>

      <Show when={props.view === "installed"}>
        <div class="skills-marketplace-heading">
          <div>
            <h1>Installed</h1>
            <p>Agents available in your local sidebar.</p>
          </div>
        </div>
        <Show
          when={props.agents.length}
          fallback={<div class="skills-marketplace-state">No agents installed yet.</div>}
        >
          <section class="skills-marketplace-category-section">
            <div class="skills-marketplace-section-title">
              <h2>Local agents</h2>
              <span>{props.agents.length} installed</span>
            </div>
            <div class="skills-marketplace-grid agent-marketplace-grid">
              <For each={props.agents}>
                {(agent) => (
                  <article class="skills-marketplace-card agent-marketplace-card">
                    <AgentAvatar seed={agent.id} hue={null} motion="hover" />
                    <div class="skills-marketplace-card-copy">
                      <div>
                        <h3>{agent.name}</h3>
                        <span>Installed</span>
                      </div>
                      <p>Available in Local</p>
                    </div>
                  </article>
                )}
              </For>
            </div>
          </section>
        </Show>
      </Show>

      <Show when={props.view === "mine"}>
        <div class="skills-marketplace-heading">
          <div>
            <h1>My agent submissions</h1>
            <p>Publish a reusable snapshot of a local agent for review.</p>
          </div>
          <div class="agent-marketplace-publish-picker">
            <span class="skills-agent-select-control">
              <NativeSelect
                aria-label="Agent to publish"
                value={market.publication.sourceAgentId}
                onChange={(event) => {
                  const agentId = event.currentTarget.value;
                  setMarket((state) => {
                    state.publication.sourceAgentId = agentId;
                  });
                }}
                disabled={!props.agents.length}
              >
                <Show when={props.agents.length} fallback={<option value="">No local agents</option>}>
                  <For each={props.agents}>{(agent) => <option value={agent.id}>{agent.name}</option>}</For>
                </Show>
              </NativeSelect>
              <ChevronDown aria-hidden="true" />
            </span>
            <Button loading={panel.busy !== null} onClick={() => void preparePublication()}>
              <Plus /> Add agent
            </Button>
          </div>
        </div>
        <Show when={market.publication.preview} keyed>
          {(value) => (
            <div class="skills-publish-card agent-publish-card">
              <div class="skills-publish-summary">
                <AgentAvatar seed={value.avatarSeed} hue={value.avatarHue} url={value.avatarUrl} motion="hover" />
                <div>
                  <h2>{value.name}</h2>
                  <p>{value.description}</p>
                  <small>
                    {value.skills.length} skills · {value.routines.length} routines
                  </small>
                </div>
              </div>
              <p>Conversation history, memories, model settings, and workspace files are not included.</p>
              <div class="skills-publish-actions">
                <Button variant="ghost" onClick={discardPublication}>
                  Cancel
                </Button>
                <Button
                  loading={panel.busy !== null}
                  loadingLabel="Submitting…"
                  onClick={() => void submitPublication()}
                >
                  Submit for review
                </Button>
              </div>
            </div>
          )}
        </Show>
        <Show when={!market.publication.preview}>
          <Show when={!panel.loading} fallback={<div class="skills-marketplace-state">Loading submissions…</div>}>
            <Show
              when={market.submissions.length}
              fallback={<div class="skills-marketplace-state">No agent submissions yet.</div>}
            >
              <div class="skills-submission-list">
                <For each={market.submissions}>
                  {(item) => (
                    <article class="skills-submission-row agent-submission-row">
                      <AgentAvatar seed={item.avatarSeed} hue={item.avatarHue} url={item.avatarUrl} motion="hover" />
                      <div>
                        <h3>{item.name}</h3>
                        <p>
                          Version {item.version} · {item.skillCount} skills · {item.routineCount} routines
                        </p>
                        <Show when={item.rejectionNote}>
                          <small>{item.rejectionNote}</small>
                        </Show>
                      </div>
                      <span class="skills-submission-status" data-status={item.status}>
                        {item.status}
                      </span>
                      <Show when={item.status === "approved" || item.status === "rejected"}>
                        <Button size="sm" onClick={() => void preparePublication(item.listingId)}>
                          <Plus /> New version
                        </Button>
                      </Show>
                    </article>
                  )}
                </For>
              </div>
            </Show>
          </Show>
        </Show>
      </Show>
      <Show when={panel.error}>
        {(message) => (
          <div class="skills-marketplace-error" role="alert">
            {message()}
          </div>
        )}
      </Show>
    </section>
  );
}

function AgentCardSection(props: {
  agents: MarketplaceAgentSummary[];
  busy: boolean;
  action: (agent: MarketplaceAgentSummary) => "Install" | "Update" | "Installed";
  onOpen: (agent: MarketplaceAgentSummary) => void | Promise<void>;
  onInstall: (agent: MarketplaceAgentSummary) => void | Promise<void>;
}) {
  return (
    <section class="skills-marketplace-category-section">
      <div class="skills-marketplace-section-title">
        <h2>Agents</h2>
        <span>{props.agents.length} available</span>
      </div>
      <div class="skills-marketplace-grid agent-marketplace-grid">
        <For each={props.agents}>
          {(agent, index) => (
            <article class="skills-marketplace-card agent-marketplace-card">
              <Button
                class="skills-marketplace-card-hitarea"
                variant="ghost"
                type="button"
                aria-label={`View ${agent.name}`}
                onClick={() => void props.onOpen(agent)}
              />
              <AgentAvatar
                seed={agent.avatarSeed}
                hue={agent.avatarHue}
                url={agent.avatarUrl}
                motion="hover"
                cycleOffset={index()}
                animationOffset={index() * 0.65}
              />
              <div class="skills-marketplace-card-copy">
                <div>
                  <h3>{agent.name}</h3>
                  <span>{agent.installs.toLocaleString()} installs</span>
                </div>
                <p>{agent.title || agent.description}</p>
                <small>
                  {agent.skillCount} skills · {agent.routineCount} routines
                </small>
              </div>
              <Button
                class="skills-marketplace-card-action"
                size="sm"
                disabled={props.action(agent) === "Installed"}
                loading={props.busy}
                onClick={(event) => {
                  event.stopPropagation();
                  void props.onInstall(agent);
                }}
              >
                {props.action(agent)}
              </Button>
            </article>
          )}
        </For>
      </div>
    </section>
  );
}

function SkillsListSkeleton(props: { category: SkillCategory | null }) {
  const categories = () => (props.category ? [props.category] : SKILL_CATEGORIES);

  return (
    <div class="skills-marketplace-list-skeleton" role="status" aria-label="Loading skills">
      <For each={categories()}>
        {() => (
          <section class="skills-marketplace-category-section">
            <div class="skills-marketplace-section-title">
              <Skeleton class="skills-marketplace-skeleton-section-label" />
              <Skeleton class="skills-marketplace-skeleton-count" />
            </div>
            <div class="skills-marketplace-grid">
              <For each={Array.from({ length: 5 })}>
                {() => (
                  <article class="skills-marketplace-card skills-marketplace-card-skeleton">
                    <Skeleton class="skills-marketplace-skeleton-icon" />
                    <div class="skills-marketplace-card-copy">
                      <div>
                        <Skeleton class="skills-marketplace-skeleton-name" />
                        <Skeleton class="skills-marketplace-skeleton-installs" />
                      </div>
                      <Skeleton class="skills-marketplace-skeleton-description" />
                    </div>
                    <Skeleton class="skills-marketplace-skeleton-action" />
                  </article>
                )}
              </For>
            </div>
          </section>
        )}
      </For>
    </div>
  );
}

function SkillDetailSkeleton() {
  return (
    <section
      class="skills-marketplace-detail skills-marketplace-detail-skeleton"
      role="status"
      aria-label="Loading skill"
    >
      <Skeleton class="skills-marketplace-detail-skeleton-back" />
      <div class="skills-marketplace-detail-hero">
        <Skeleton class="skills-marketplace-detail-skeleton-icon" />
        <div>
          <Skeleton class="skills-marketplace-detail-skeleton-category" />
          <Skeleton class="skills-marketplace-detail-skeleton-title" />
          <Skeleton class="skills-marketplace-detail-skeleton-description" />
          <div class="skills-marketplace-detail-meta">
            <Skeleton />
            <Skeleton />
            <Skeleton />
          </div>
        </div>
        <Skeleton class="skills-marketplace-detail-skeleton-action" />
      </div>
      <div class="skills-marketplace-detail-content">
        <div class="skills-marketplace-detail-instructions">
          <Skeleton class="skills-marketplace-detail-skeleton-heading" />
          <div class="skills-marketplace-detail-skeleton-copy">
            <Skeleton />
            <Skeleton />
            <Skeleton />
            <Skeleton />
          </div>
        </div>
        <aside class="skills-marketplace-detail-package">
          <Skeleton class="skills-marketplace-detail-skeleton-package-heading" />
          <Skeleton class="skills-marketplace-detail-skeleton-package-count" />
          <div class="skills-marketplace-detail-skeleton-files">
            <Skeleton />
            <Skeleton />
            <Skeleton />
            <Skeleton />
          </div>
        </aside>
      </div>
    </section>
  );
}

function SkillCategorySection(props: {
  label: string;
  skills: MarketplaceSkillSummary[];
  installedById: Map<string, InstalledSkill>;
  busyId: string | null;
  onInstall: (skill: MarketplaceSkillSummary) => Promise<void>;
  onOpen: (skill: MarketplaceSkillSummary) => Promise<void>;
}) {
  return (
    <section class="skills-marketplace-category-section">
      <div class="skills-marketplace-section-title">
        <h2>{props.label}</h2>
        <span>{props.skills.length} skills</span>
      </div>
      <div class="skills-marketplace-grid">
        <For each={props.skills}>
          {(skill) => {
            const local = () => props.installedById.get(skill.id);
            return (
              <article class="skills-marketplace-card">
                <Button
                  variant="ghost"
                  type="button"
                  class="skills-marketplace-card-hitarea"
                  aria-label={`View ${skill.name} details`}
                  onClick={() => void props.onOpen(skill)}
                />
                <SkillIcon skill={skill} />
                <div class="skills-marketplace-card-copy">
                  <div>
                    <h3>{skill.name}</h3>
                    <span>{skill.installs.toLocaleString()} installs</span>
                  </div>
                  <p>{skill.description}</p>
                </div>
                <Button
                  class="skills-marketplace-card-action"
                  size="sm"
                  loading={props.busyId === skill.id}
                  disabled={Boolean(local() && local()?.state === "installed")}
                  onClick={(event) => {
                    event.stopPropagation();
                    void props.onInstall(skill);
                  }}
                >
                  <Show when={local()} fallback="Install">
                    {(item) =>
                      item().state === "installed" ? (
                        <>
                          <Check /> Installed
                        </>
                      ) : (
                        "Update"
                      )
                    }
                  </Show>
                </Button>
              </article>
            );
          }}
        </For>
      </div>
    </section>
  );
}

function SkillDetailView(props: {
  skill: MarketplaceSkillDetail;
  installed: InstalledSkill | undefined;
  busy: boolean;
  onBack: () => void;
  onInstall: (skill: MarketplaceSkillSummary) => Promise<void>;
}) {
  return (
    <section class="skills-marketplace-detail" aria-label={`${props.skill.name} details`}>
      <Button class="skills-marketplace-detail-back" variant="ghost" size="sm" onClick={props.onBack}>
        <ArrowLeft /> Back to skills
      </Button>
      <div class="skills-marketplace-detail-hero">
        <SkillIcon skill={props.skill} />
        <div>
          <p class="skills-marketplace-detail-category">{CATEGORY_LABELS[props.skill.category]}</p>
          <h1>{props.skill.name}</h1>
          <p>{props.skill.description}</p>
          <div class="skills-marketplace-detail-meta">
            <span>by {props.skill.creatorName}</span>
            <span>{props.skill.installs.toLocaleString()} installs</span>
            <span>Version {props.skill.version}</span>
          </div>
        </div>
        <Button
          variant="default"
          loading={props.busy}
          disabled={props.installed?.state === "installed"}
          onClick={() => void props.onInstall(props.skill)}
        >
          <Show when={props.installed} fallback="Install skill">
            {(item) =>
              item().state === "installed" ? (
                <>
                  <Check /> Installed
                </>
              ) : (
                "Update skill"
              )
            }
          </Show>
        </Button>
      </div>
      <div class="skills-marketplace-detail-content">
        <div class="skills-marketplace-detail-instructions">
          <h2>What this skill does</h2>
          <div>{displayInstructions(props.skill)}</div>
        </div>
        <aside class="skills-marketplace-detail-package">
          <h2>Package contents</h2>
          <p>{props.skill.files.length} files included</p>
          <ul>
            <For each={props.skill.files}>{(file) => <li>{file}</li>}</For>
          </ul>
        </aside>
      </div>
    </section>
  );
}

function SkillSubmissionDetailView(props: { submission: SkillSubmission; onBack: () => void }) {
  return (
    <section class="skills-marketplace-detail" aria-label={`${props.submission.name} submission details`}>
      <Button class="skills-marketplace-detail-back" variant="ghost" size="sm" onClick={props.onBack}>
        <ArrowLeft /> Back to submissions
      </Button>
      <div class="skills-marketplace-detail-hero skills-submission-detail-hero">
        <SkillIcon skill={props.submission} />
        <div>
          <p class="skills-marketplace-detail-category">{CATEGORY_LABELS[props.submission.category]}</p>
          <h1>{props.submission.name}</h1>
          <p>{props.submission.description}</p>
          <div class="skills-marketplace-detail-meta">
            <span>Submitted by you</span>
            <span>Version {props.submission.version}</span>
            <span>{new Date(props.submission.createdAt).toLocaleDateString()}</span>
          </div>
        </div>
      </div>
      <div class="skills-marketplace-detail-content">
        <div class="skills-marketplace-detail-instructions">
          <h2>What this skill does</h2>
          <div>{props.submission.description}</div>
        </div>
        <aside class="skills-marketplace-detail-package skills-submission-detail-review">
          <h2>Review status</h2>
          <span class="skills-submission-status" data-status={props.submission.status}>
            {props.submission.status}
          </span>
          <Show when={props.submission.rejectionNote}>
            {(note) => <p class="skills-submission-detail-note">{note()}</p>}
          </Show>
        </aside>
      </div>
    </section>
  );
}

function displayInstructions(skill: MarketplaceSkillDetail): string {
  const instructions = skill.instructions || skill.description;
  const [firstLine, ...remaining] = instructions.split(/\r?\n/u);
  if (firstLine?.replace(/^#\s+/u, "").trim() === skill.name) return remaining.join("\n").trim();
  return instructions;
}

function avatarImageDataUrl(image: AvatarImageInput): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < image.bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...image.bytes.subarray(offset, offset + chunkSize));
  }
  return `data:${image.mimeType};base64,${btoa(binary)}`;
}

function marketplaceErrorMessage(cause: unknown): string {
  const rawMessage = cause instanceof Error ? cause.message : String(cause);
  const message = rawMessage.replace(/^Error invoking remote method '[^']+': (?:Error: )?/u, "");
  if (message === "A skill with this name already exists.") {
    return "That skill name is already taken. Choose a different name in SKILL.md, then try again.";
  }
  return message;
}

function AgentSelect(props: {
  agents: Array<{ id: string; name: string }>;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label class="skills-agent-select">
      <span>Install to</span>
      <span class="skills-agent-select-control">
        <NativeSelect
          value={props.value}
          onChange={(event) => props.onChange(event.currentTarget.value)}
          disabled={!props.agents.length}
        >
          <Show when={props.agents.length} fallback={<option value="">No local agents</option>}>
            <For each={props.agents}>{(agent) => <option value={agent.id}>{agent.name}</option>}</For>
          </Show>
        </NativeSelect>
        <ChevronDown aria-hidden="true" />
      </span>
    </label>
  );
}

function SkillIcon(props: { skill: { name: string; iconUrl: string | null } }) {
  const [failedUrl, setFailedUrl] = createSignal<string | null>(null);
  const iconUrl = createMemo(() => {
    const url = props.skill.iconUrl;
    return url && failedUrl() !== url ? url : null;
  });

  return (
    <span class="skills-marketplace-icon">
      <Show when={iconUrl()} fallback={<Puzzle />} keyed>
        {(url) => <img src={url} alt="" onError={() => setFailedUrl(url)} />}
      </Show>
    </span>
  );
}
