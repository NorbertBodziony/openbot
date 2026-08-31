import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { createFileRoute } from "@tanstack/solid-router";

export const Route = createFileRoute("/report-site")({
  validateSearch: (value) => ({
    hostname: isDynamicRecord(value) && isString(value.hostname) ? value.hostname : "",
  }),
  component: ReportSite,
});

function ReportSite() {
  const search = Route.useSearch();
  return (
    <main class="report-site-page">
      <h1>Report a hosted site</h1>
      <p>Send a report about harmful or unlawful content hosted on openbot.site.</p>
      <form method="post" action="/v1/sites/reports">
        <label>
          Site address
          <input name="hostname" value={search().hostname} readonly required />
        </label>
        <label>
          Reason
          <select name="reason" required>
            <option value="phishing">Phishing</option>
            <option value="malware">Malware</option>
            <option value="abuse">Abuse</option>
            <option value="copyright">Copyright</option>
            <option value="other">Other</option>
          </select>
        </label>
        <label>
          Details
          <textarea name="details" maxlength="1000" />
        </label>
        <button type="submit">Send report</button>
      </form>
    </main>
  );
}
