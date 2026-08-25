import type {
  AvatarImageInput,
  InstalledSkill,
  MarketplaceSkillSummary,
  SkillCategory,
  SkillPackagePreview,
  SkillSubmission,
} from "@openbot/contracts/ipc";
import { isSkillCategory, SKILL_CATEGORIES } from "@openbot/contracts/ipc";
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { normalizeAvatarFile } from "../avatar-image";
import {
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
  Spinner,
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
  const [error, setError] = createSignal<string | null>(null);
  const [preview, setPreview] = createSignal<SkillPackagePreview | null>(null);
  const [publishCategory, setPublishCategory] = createSignal<SkillCategory>("other");
  const [publishIcon, setPublishIcon] = createSignal<AvatarImageInput | null>(null);
  const [publishSkillId, setPublishSkillId] = createSignal<string | undefined>();
  let iconInput: HTMLInputElement | undefined;
  let searchTimer: number | undefined;

  const installedById = createMemo(() => new Map(installed().map((item) => [item.skillId, item])));
  const targetBot = createMemo(() => props.bots.find((bot) => bot.id === targetBotId()) ?? null);

  createEffect(
    () => props.open,
    (open) => {
      if (!open) return;
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

  async function run<T>(work: () => Promise<T>): Promise<T | undefined> {
    setError(null);
    try {
      return await work();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
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
    setPreview(null);
    setError(null);
    refresh(next);
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
    setPublishIcon(null);
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
      await loadMine();
    }
    setBusyId(null);
  }

  async function chooseIcon(file: File | undefined) {
    if (!file) return;
    const icon = await run(() => normalizeAvatarFile(file));
    if (icon) setPublishIcon(icon);
    if (iconInput) iconInput.value = "";
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

            <div class="skills-marketplace-body">
              <Show when={tab() === "discover"}>
                <section class="skills-marketplace-discover" aria-label="Discover skills">
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
                  <Show
                    when={!loading()}
                    fallback={
                      <div class="skills-marketplace-state">
                        <Spinner /> Loading skills…
                      </div>
                    }
                  >
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
                          <span class="skills-marketplace-default-icon">
                            <Puzzle />
                          </span>
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
                              ref={(element) => (iconInput = element)}
                              type="file"
                              accept="image/png,image/jpeg,image/webp"
                              onChange={(event) => void chooseIcon(event.currentTarget.files?.[0])}
                            />
                          </label>
                        </div>
                        <div class="skills-publish-actions">
                          <Button variant="ghost" onClick={() => setPreview(null)}>
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

function SkillCategorySection(props: {
  label: string;
  skills: MarketplaceSkillSummary[];
  installedById: Map<string, InstalledSkill>;
  busyId: string | null;
  onInstall: (skill: MarketplaceSkillSummary) => Promise<void>;
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
                <SkillIcon skill={skill} />
                <div class="skills-marketplace-card-copy">
                  <div>
                    <h3>{skill.name}</h3>
                    <span>{skill.installs.toLocaleString()} installs</span>
                  </div>
                  <p>{skill.description}</p>
                </div>
                <Button
                  size="sm"
                  loading={props.busyId === skill.id}
                  disabled={Boolean(local() && local()?.state === "installed")}
                  onClick={() => void props.onInstall(skill)}
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

function AgentSelect(props: {
  bots: Array<{ id: string; name: string }>;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label class="skills-agent-select">
      <span>Install to</span>
      <NativeSelect
        value={props.value}
        onChange={(event) => props.onChange(event.currentTarget.value)}
        disabled={!props.bots.length}
      >
        <Show when={props.bots.length} fallback={<option value="">No local agents</option>}>
          <For each={props.bots}>{(bot) => <option value={bot.id}>{bot.name}</option>}</For>
        </Show>
      </NativeSelect>
    </label>
  );
}

function SkillIcon(props: { skill: { name: string; iconUrl: string | null } }) {
  return (
    <span class="skills-marketplace-icon">
      <Show when={props.skill.iconUrl} fallback={<Puzzle />} keyed>
        {(url) => <img src={url} alt="" />}
      </Show>
    </span>
  );
}
