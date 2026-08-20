export const EXTERNAL_LINK_REL = "noopener noreferrer";

export const OPENBOT_DOWNLOAD_LINKS = {
  macos: "/download/macos",
  windows: "/download/windows",
} as const;

export const OPENBOT_LINKS = {
  contact: "https://x.com/norbertbodziony",
  download: "#download",
  releases: "https://github.com/NorbertBodziony/openbot/releases",
  repository: "https://github.com/NorbertBodziony/openbot",
  license: "https://github.com/NorbertBodziony/openbot/blob/main/LICENSE",
  documentation: "https://github.com/NorbertBodziony/openbot#readme",
  troubleshooting: "https://github.com/NorbertBodziony/openbot/blob/main/docs/TROUBLESHOOTING.md",
  architecture: "https://github.com/NorbertBodziony/openbot#architecture",
  contributing: "https://github.com/NorbertBodziony/openbot/blob/main/CONTRIBUTING.md",
  codex: "https://learn.chatgpt.com/docs/app-server",
  claude: "https://code.claude.com/docs/en/overview",
} as const;

export const FOOTER_COLUMNS = [
  {
    title: "Product",
    links: [
      { label: "Download", href: OPENBOT_LINKS.download, external: false },
      { label: "Releases", href: OPENBOT_LINKS.releases, external: true },
      { label: "Source code", href: OPENBOT_LINKS.repository, external: true },
      { label: "License", href: OPENBOT_LINKS.license, external: true },
    ],
  },
  {
    title: "Resources",
    links: [
      { label: "Documentation", href: OPENBOT_LINKS.documentation, external: true },
      { label: "Troubleshooting", href: OPENBOT_LINKS.troubleshooting, external: true },
      { label: "Architecture", href: OPENBOT_LINKS.architecture, external: true },
      { label: "Contributing", href: OPENBOT_LINKS.contributing, external: true },
      { label: "Codex", href: OPENBOT_LINKS.codex, external: true },
      { label: "Claude Code", href: OPENBOT_LINKS.claude, external: true },
    ],
  },
] as const;
