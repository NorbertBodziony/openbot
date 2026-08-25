import type {
  AvatarImageInput,
  InstalledSkill,
  MarketplaceSkillDetail,
  MarketplaceSkillSummary,
  SkillCategory,
  SkillPackagePreview,
  SkillSubmission,
} from "@openbot/contracts/ipc";
import { isSkillCategory, SKILL_CATEGORIES } from "@openbot/contracts/ipc";
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { normalizeAvatarFile } from "../avatar-image";
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
} from "./ui";

interface SkillsMarketplaceModalProps {
  open: boolean;
  bots: Array<{ id: string; name: string }>;
  activeBotId: string;
  onOpenChange: (open: boolean) => void;
}

type Tab = "discover" | "installed" | "mine";

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

export function SkillsMarketplaceModal(props: SkillsMarketplaceModalProps) {
  const [tab, setTab] = createSignal<Tab>("discover");
  const [skills, setSkills] = createSignal<MarketplaceSkillSummary[]>([]);
  const [submissions, setSubmissions] = createSignal<SkillSubmission[]>([]);
  const [installed, setInstalled] = createSignal<InstalledSkill[]>([]);
  const [query, setQuery] = createSignal("");
  const [category, setCategory] = createSignal<SkillCategory | null>(null);
  const [targetBotId, setTargetBotId] = createSignal("");
  const [loading, setLoading] = createSignal(false);
  const [busyId, setBusyId] = createSignal<string | null>(null);
  const [detail, setDetail] = createSignal<MarketplaceSkillDetail | null>(null);
  const [submissionDetail, setSubmissionDetail] = createSignal<SkillSubmission | null>(null);
  const [detailLoading, setDetailLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [preview, setPreview] = createSignal<SkillPackagePreview | null>(null);
  const [publishCategory, setPublishCategory] = createSignal<SkillCategory>("other");
  const [publishIcon, setPublishIcon] = createSignal<AvatarImageInput | null>(null);
  const [publishIconPreviewUrl, setPublishIconPreviewUrl] = createSignal<string | null>(null);
  const [publishSkillId, setPublishSkillId] = createSignal<string | undefined>();
  let marketplaceBody: HTMLDivElement | undefined;
  let listScrollTop = 0;
  let searchTimer: number | undefined;

  const installedById = createMemo(() => new Map(installed().map((item) => [item.skillId, item])));
  const targetBot = createMemo(() => props.bots.find((bot) => bot.id === targetBotId()) ?? null);

  createEffect(
    () => props.open,
    (open) => {
      if (!open) {
        setDetail(null);
        setSubmissionDetail(null);
        return;
      }
      setTargetBotId((current) => current || props.activeBotId || props.bots[0]?.id || "");
      void loadSkills();
    },
  );

  createEffect(
    () => [query(), category()] as const,
    () => {
      if (searchTimer !== undefined) window.clearTimeout(searchTimer);
      if (!props.open || tab() !== "discover") return;
      searchTimer = window.setTimeout(() => void loadSkills(), 180);
    },
  );

  createEffect(
    () => [props.open, targetBotId()] as const,
    ([open, botId]) => {
      if (open && botId) void loadInstalled(botId);
      else setInstalled([]);
    },
  );

  onCleanup(() => {
    if (searchTimer !== undefined) window.clearTimeout(searchTimer);
  });

  function clearPublishIcon() {
    setPublishIcon(null);
    setPublishIconPreviewUrl(null);
  }

  async function run<T>(work: () => Promise<T>): Promise<T | undefined> {
    setError(null);
    try {
      return await work();
    } catch (cause) {
      setError(marketplaceErrorMessage(cause));
      return undefined;
    }
  }

  async function loadSkills() {
    setLoading(true);
    const search = query().trim();
    const selectedCategory = category();
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
    if (pages) setSkills(pages.flatMap((page) => page.skills));
    setLoading(false);
  }

  async function loadInstalled(botId = targetBotId()) {
    if (!botId) {
      setInstalled([]);
      return;
    }
    const values = await run(() => window.openbot.skills.listInstalled(botId));
    if (values) setInstalled(values);
  }

  async function loadMine() {
    setLoading(true);
    const values = await run(() => window.openbot.skills.listMine());
    if (values) setSubmissions(values);
    setLoading(false);
  }

  function refresh(next: Tab = tab()) {
    if (next === "discover") void loadSkills();
    if (next === "mine") void loadMine();
    if (next === "installed") void loadInstalled();
  }

  function selectTab(next: Tab) {
    setTab(next);
    setDetail(null);
    setSubmissionDetail(null);
    setPreview(null);
    clearPublishIcon();
    setError(null);
    refresh(next);
  }

  function enterDetails() {
    if (!detail() && !submissionDetail() && !detailLoading()) {
      listScrollTop = marketplaceBody?.scrollTop ?? 0;
    }
    if (marketplaceBody) marketplaceBody.scrollTop = 0;
  }

  function leaveDetails() {
    setDetail(null);
    setSubmissionDetail(null);
    queueMicrotask(() => {
      if (marketplaceBody) marketplaceBody.scrollTop = listScrollTop;
    });
  }

  async function openDetails(skill: MarketplaceSkillSummary) {
    enterDetails();
    setSubmissionDetail(null);
    setDetail(null);
    setDetailLoading(true);
    const value = await run(() => window.openbot.skills.get(skill.id));
    if (value) setDetail(value);
    setDetailLoading(false);
    if (!value) leaveDetails();
  }

  async function openDetailsById(skillId: string) {
    const summary = skills().find((skill) => skill.id === skillId);
    if (summary) {
      await openDetails(summary);
      return;
    }
    enterDetails();
    setSubmissionDetail(null);
    setDetail(null);
    setDetailLoading(true);
    const value = await run(() => window.openbot.skills.get(skillId));
    if (value) setDetail(value);
    setDetailLoading(false);
    if (!value) leaveDetails();
  }

  function openSubmissionDetails(submission: SkillSubmission) {
    if (submission.status === "approved") {
      void openDetailsById(submission.skillId);
      return;
    }
    enterDetails();
    setDetail(null);
    setSubmissionDetail(submission);
  }

  async function install(skill: MarketplaceSkillSummary, replaceModified = false) {
    const botId = targetBotId();
    if (!botId) {
      setError("Switch to Local and create an agent before installing skills.");
      return;
    }
    setBusyId(skill.id);
    const result = await run(() => window.openbot.skills.install({ botId, skillId: skill.id, replaceModified }));
    if (result) await loadInstalled(botId);
    setBusyId(null);
  }

  async function updateInstalled(item: InstalledSkill) {
    const listing =
      skills().find((skill) => skill.id === item.skillId) ?? (await run(() => window.openbot.skills.get(item.skillId)));
    if (!listing) return;
    const replace = item.state === "modified";
    if (replace && !window.confirm(`Replace local changes in ${item.name}?`)) return;
    await install(listing, replace);
  }

  async function uninstall(item: InstalledSkill) {
    const modified = item.state === "modified";
    if (!window.confirm(modified ? `Delete ${item.name} and its local changes?` : `Uninstall ${item.name}?`)) return;
    setBusyId(item.skillId);
    const removed = await run(async () => {
      await window.openbot.skills.uninstall({
        botId: targetBotId(),
        skillId: item.skillId,
        ...(modified ? { removeModified: true } : {}),
      });
      return true;
    });
    if (removed) await loadInstalled();
    setBusyId(null);
  }

  async function choosePackage(skillId?: string) {
    const value = await run(() => window.openbot.skills.choosePackage());
    if (!value) return;
    setPublishSkillId(skillId);
    setPreview(value);
    setPublishCategory(
      skillId ? (submissions().find((item) => item.skillId === skillId)?.category ?? "other") : "other",
    );
    clearPublishIcon();
  }

  async function submit() {
    const value = preview();
    if (!value) return;
    setBusyId("publish");
    const created = await run(() =>
      window.openbot.skills.submit({
        draftId: value.draftId,
        category: publishCategory(),
        icon: publishIcon(),
        ...(publishSkillId() ? { skillId: publishSkillId() } : {}),
      }),
    );
    if (created) {
      setPreview(null);
      clearPublishIcon();
      await loadMine();
    }
    setBusyId(null);
  }

  async function chooseIcon(file: File | undefined) {
    if (!file) return;
    const icon = await run(() => normalizeAvatarFile(file));
    if (!icon) return;
    setPublishIcon(icon);
    setPublishIconPreviewUrl(avatarImageDataUrl(icon));
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
                  data-active=""
                  variant="ghost"
                  size="sm"
                  aria-current="page"
                >
                  Skills
                </Button>
                <Button class="skills-marketplace-kind-tab" variant="ghost" size="sm" disabled>
                  Agents
                </Button>
              </nav>
              <span class="skills-marketplace-topbar-divider" aria-hidden="true" />
              <nav class="skills-marketplace-view-tabs" aria-label="Skills views">
                <Button
                  class="skills-marketplace-tab"
                  data-active={tab() === "discover" ? "" : undefined}
                  variant="ghost"
                  size="sm"
                  onClick={() => selectTab("discover")}
                >
                  Discover
                </Button>
                <Button
                  class="skills-marketplace-tab"
                  data-active={tab() === "installed" ? "" : undefined}
                  variant="ghost"
                  size="sm"
                  onClick={() => selectTab("installed")}
                >
                  Installed
                </Button>
                <Button
                  class="skills-marketplace-tab"
                  data-active={tab() === "mine" ? "" : undefined}
                  variant="ghost"
                  size="sm"
                  onClick={() => selectTab("mine")}
                >
                  My submissions
                </Button>
              </nav>
              <div class="skills-marketplace-actions">
                <IconButton label="Refresh" variant="ghost" onClick={() => refresh()}>
                  <RefreshCw />
                </IconButton>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => {
                    selectTab("mine");
                    void choosePackage();
                  }}
                >
                  <Plus /> Add skill
                </Button>
                <IconButton label="Close skills marketplace" variant="ghost" onClick={() => props.onOpenChange(false)}>
                  <X />
                </IconButton>
              </div>
            </header>

            <div
              class="skills-marketplace-body"
              data-detail-open={detailLoading() || detail() || submissionDetail() ? "" : undefined}
              ref={(element) => (marketplaceBody = element)}
            >
              <Show when={tab() === "discover"}>
                <section
                  class="skills-marketplace-discover"
                  aria-label="Discover skills"
                  aria-hidden={detail() || detailLoading() ? "true" : undefined}
                  inert={detail() || detailLoading() ? true : undefined}
                >
                  <div class="skills-marketplace-heading">
                    <div>
                      <h1>Skills</h1>
                      <p>Give your agents focused capabilities for repeatable work.</p>
                    </div>
                    <AgentSelect bots={props.bots} value={targetBotId()} onChange={setTargetBotId} />
                  </div>
                  <div class="skills-marketplace-search">
                    <Search aria-hidden="true" />
                    <Input
                      aria-label="Search skills"
                      placeholder="Search skills"
                      value={query()}
                      onValueChange={setQuery}
                    />
                  </div>
                  <div class="skills-marketplace-categories">
                    <Button
                      size="sm"
                      data-active={category() === null ? "" : undefined}
                      onClick={() => setCategory(null)}
                    >
                      All
                    </Button>
                    <For each={SKILL_CATEGORIES}>
                      {(item) => (
                        <Button
                          size="sm"
                          data-active={category() === item ? "" : undefined}
                          onClick={() => setCategory(item)}
                        >
                          {CATEGORY_LABELS[item]}
                        </Button>
                      )}
                    </For>
                  </div>
                  <Show when={!loading()} fallback={<SkillsListSkeleton category={category()} />}>
                    <Show
                      when={skills().length}
                      fallback={<div class="skills-marketplace-state">No skills match this search.</div>}
                    >
                      <Show
                        when={category() === null}
                        fallback={
                          <SkillCategorySection
                            label={CATEGORY_LABELS[category() ?? "other"]}
                            skills={skills()}
                            installedById={installedById()}
                            busyId={busyId()}
                            onInstall={install}
                            onOpen={openDetails}
                          />
                        }
                      >
                        <For each={SKILL_CATEGORIES}>
                          {(item) => {
                            const categorySkills = () => skills().filter((skill) => skill.category === item);
                            return (
                              <Show when={categorySkills().length > 0}>
                                <SkillCategorySection
                                  label={CATEGORY_LABELS[item]}
                                  skills={categorySkills()}
                                  installedById={installedById()}
                                  busyId={busyId()}
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

              <Show when={tab() === "installed"}>
                <section class="skills-marketplace-panel">
                  <div class="skills-marketplace-heading">
                    <div>
                      <h1>Installed</h1>
                      <p>Manage marketplace-owned skills for one local agent.</p>
                    </div>
                    <AgentSelect bots={props.bots} value={targetBotId()} onChange={setTargetBotId} />
                  </div>
                  <Show
                    when={targetBot()}
                    fallback={
                      <div class="skills-marketplace-state">Switch to Local and choose an agent to manage skills.</div>
                    }
                  >
                    <Show
                      when={installed().length}
                      fallback={
                        <div class="skills-marketplace-state">No marketplace skills are installed for this agent.</div>
                      }
                    >
                      <div class="skills-installed-list">
                        <For each={installed()}>
                          {(item) => (
                            <article class="skills-installed-row">
                              <button
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
                                loading={busyId() === item.skillId}
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

              <Show when={tab() === "mine"}>
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
                  <Show when={preview()}>
                    {(value) => (
                      <div class="skills-publish-card">
                        <div class="skills-publish-summary">
                          <Show
                            when={publishIconPreviewUrl()}
                            fallback={
                              <span class="skills-marketplace-default-icon">
                                <Puzzle />
                              </span>
                            }
                            keyed
                          >
                            {(url) => (
                              <span class="skills-marketplace-icon">
                                <img src={url} alt="" />
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
                              value={publishCategory()}
                              onChange={(event) => {
                                const category = event.currentTarget.value;
                                if (isSkillCategory(category)) setPublishCategory(category);
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
                          <Button
                            variant="ghost"
                            onClick={() => {
                              setPreview(null);
                              clearPublishIcon();
                            }}
                          >
                            Cancel
                          </Button>
                          <Button
                            variant="primary"
                            loading={busyId() === "publish"}
                            loadingLabel="Submitting…"
                            onClick={() => void submit()}
                          >
                            Submit for review
                          </Button>
                        </div>
                      </div>
                    )}
                  </Show>
                  <Show when={!preview()}>
                    <Show
                      when={submissions().length}
                      fallback={
                        <div class="skills-marketplace-state">
                          No submissions yet. Choose a skill folder or ZIP to publish.
                        </div>
                      }
                    >
                      <div class="skills-submission-list">
                        <For each={submissions()}>
                          {(item) => (
                            <article class="skills-submission-row">
                              <button
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
              <Show when={detailLoading() || detail() || submissionDetail()}>
                <div class="skills-marketplace-detail-layer">
                  <Show when={!detailLoading()} fallback={<SkillDetailSkeleton />}>
                    <Show when={detail()} keyed>
                      {(skill) => (
                        <SkillDetailView
                          skill={skill}
                          installed={installedById().get(skill.id)}
                          busy={busyId() === skill.id}
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
              <Show when={error()}>
                {(message) => (
                  <div class="skills-marketplace-error" role="alert">
                    {message()}
                  </div>
                )}
              </Show>
            </div>
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
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
                <button
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
          variant="primary"
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
  bots: Array<{ id: string; name: string }>;
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
          disabled={!props.bots.length}
        >
          <Show when={props.bots.length} fallback={<option value="">No local agents</option>}>
            <For each={props.bots}>{(bot) => <option value={bot.id}>{bot.name}</option>}</For>
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
