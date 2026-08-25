import { isDynamicRecord, isNumber, isString } from "@openbot/contracts/runtime-values";

const [command, targetId, ...rest] = process.argv.slice(2);
const apiUrl = process.env.OPENBOT_AUTH_API_URL ?? "http://127.0.0.1:3100";
const token = process.env.SKILLS_ADMIN_TOKEN;

if (!token) throw new Error("SKILLS_ADMIN_TOKEN is required.");

const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

if (command === "list") {
  const response = await fetch(new URL("/v1/skills/admin/submissions", apiUrl), { headers });
  if (!response.ok) throw new Error(await response.text());
  const submissions = await response.json();
  if (!Array.isArray(submissions)) throw new Error("The API returned an invalid submissions list.");
  for (const item of submissions) {
    if (!isDynamicRecord(item) || !isString(item.id) || !isString(item.name) || !isNumber(item.version)) {
      throw new Error("The API returned an invalid submission.");
    }
    process.stdout.write(`${item.id}\t${item.name}\tv${item.version}\t${item.category}\n`);
  }
} else if ((command === "approve" || command === "reject") && targetId) {
  const noteIndex = rest.indexOf("--note");
  const note =
    noteIndex >= 0
      ? rest
          .slice(noteIndex + 1)
          .join(" ")
          .trim()
      : undefined;
  if (command === "reject" && !note) throw new Error("Rejecting a skill requires --note <reason>.");
  const response = await fetch(new URL(`/v1/skills/admin/submissions/${encodeURIComponent(targetId)}`, apiUrl), {
    method: "POST",
    headers,
    body: JSON.stringify({ action: command, ...(note ? { note } : {}) }),
  });
  if (!response.ok) throw new Error(await response.text());
  process.stdout.write(`${command === "approve" ? "Approved" : "Rejected"} ${targetId}.\n`);
} else if (command === "feature" && targetId && (rest[0] === "on" || rest[0] === "off")) {
  const response = await fetch(new URL(`/v1/skills/admin/featured/${encodeURIComponent(targetId)}`, apiUrl), {
    method: "POST",
    headers,
    body: JSON.stringify({ featured: rest[0] === "on" }),
  });
  if (!response.ok) throw new Error(await response.text());
  process.stdout.write(`${rest[0] === "on" ? "Featured" : "Unfeatured"} ${targetId}.\n`);
} else {
  throw new Error(
    "Usage: bun run skills:review -- list | approve <version-id> | reject <version-id> --note <reason> | feature <skill-id> on|off",
  );
}
