import { isDynamicRecord, isNumber, isString } from "@openbot/contracts/runtime-values";
import { hmacSha256, sha256 } from "./crypto";
import {
  expectedFile,
  HOSTED_SITE_LIMITS,
  type HostedSiteFileManifest,
  HostedSiteInputError,
  type HostedSiteUploadRequest,
} from "./hosted-site-contract";

interface SiteRow {
  id: string;
  user_id: string;
  hostname: string;
  title: string;
  description: string;
  framework: "vanilla" | "astro";
  spa_fallback: number;
  status: "uploading" | "active" | "deleted" | "expired" | "blocked";
  current_deployment_id: string | null;
  created_at: number;
  updated_at: number;
  expires_at: number | null;
  route_synced_at: number | null;
}

interface DeploymentRow {
  id: string;
  site_id: string;
  user_id: string;
  status: "uploading" | "activating" | "active" | "superseded" | "abandoned";
  base_deployment_id: string | null;
  manifest_json: string;
  file_count: number;
  total_bytes: number;
  upload_expires_at: number;
  site_title: string;
  site_description: string;
  site_framework: "vanilla" | "astro";
  site_spa_fallback: number;
  request_hash: string;
  objects_deleted_at: number | null;
  activation_authorized_at: number | null;
  in_flight_uploads: number;
  upload_claims: number;
  upload_bytes_claimed: number;
}

export interface HostedSiteSummary {
  id: string;
  hostname: string;
  url: string;
  title: string;
  description: string;
  framework: "vanilla" | "astro";
  status: SiteRow["status"];
  fileCount: number;
  size: number;
  expiresAt: string | null;
  updatedAt: string;
}

export interface HostedSiteUploadSession {
  uploadId: string;
  site: HostedSiteSummary;
  expiresAt: string;
}

interface RouteManifest {
  version: 1;
  status: "active" | "deleted" | "expired" | "blocked";
  siteId: string;
  deploymentId: string | null;
  expiresAt: number | null;
  spaFallback: boolean;
  files: Record<string, { key: string; size: number; mimeType: string }>;
}

type OperationClaim = { status: "pending"; token: string } | { status: "completed"; response: string };

const CLEANUP_BATCH_SIZE = 50;
const CLEANUP_RUNTIME_BUDGET_MS = 20_000;

export class HostedSiteService {
  constructor(
    private readonly database: D1Database,
    private readonly bucket: R2Bucket,
    private readonly now: () => number = Date.now,
    private readonly reportHashSecret?: string,
  ) {}

  async list(userId: string): Promise<HostedSiteSummary[]> {
    const now = this.now();
    const rows = await this.database
      .prepare(
        `SELECT s.*, COALESCE(d.file_count, 0) AS file_count, COALESCE(d.total_bytes, 0) AS total_bytes
         FROM hosted_sites s LEFT JOIN site_deployments d ON d.id = s.current_deployment_id
         WHERE s.user_id = ? AND s.status != 'uploading'
         ORDER BY s.updated_at DESC`,
      )
      .bind(userId)
      .all<SiteRow & { file_count: number; total_bytes: number }>();
    return rows.results.map((row) =>
      mapSite({
        ...row,
        status:
          (row.status === "active" || row.status === "blocked") && row.expires_at !== null && row.expires_at <= now
            ? "expired"
            : row.status,
      }),
    );
  }

  async createUpload(
    userId: string,
    request: HostedSiteUploadRequest,
    idempotencyKey: string,
  ): Promise<HostedSiteUploadSession> {
    const requestHash = await uploadRequestHash(request);
    const prior = await this.deploymentByIdempotency(userId, idempotencyKey);
    if (prior) return this.uploadSessionForRequest(prior, requestHash);
    const now = this.now();
    await this.abandonExpiredUploads(userId, now);
    const concurrent = await this.database
      .prepare(
        "SELECT COUNT(*) AS count FROM site_deployments WHERE user_id = ? AND status = 'uploading' AND upload_expires_at > ?",
      )
      .bind(userId, now)
      .first<{ count: number }>();
    if ((concurrent?.count ?? 0) >= HOSTED_SITE_LIMITS.concurrentUploads) {
      throw new HostedSiteInputError(429, "upload_session_limit", "Finish or wait for an existing upload first.");
    }

    const deploymentId = crypto.randomUUID();
    const uploadExpiresAt = now + HOSTED_SITE_LIMITS.uploadLifetimeMs;
    const totalBytes = request.files.reduce((sum, file) => sum + file.size, 0);
    if (request.siteId) {
      const site = await this.requireOwnedSite(userId, request.siteId);
      if (!site.expires_at || site.expires_at <= now) throw inactiveSiteError("expired");
      const spaFallback = request.spaFallback ?? site.spa_fallback === 1;
      let insert: D1Result<unknown>;
      try {
        insert = await this.database
          .prepare(
            `INSERT INTO site_deployments(
            id, site_id, user_id, status, base_deployment_id, file_count, total_bytes, manifest_json,
            site_title, site_description, site_framework, site_spa_fallback,
            idempotency_key, request_hash, created_at, upload_expires_at
          ) SELECT ?, ?, ?, 'uploading', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
            WHERE (SELECT COUNT(*) FROM site_deployments
                   WHERE user_id = ? AND status = 'uploading' AND upload_expires_at > ?) < ?
              AND EXISTS (
                SELECT 1 FROM hosted_sites
                WHERE id = ? AND user_id = ? AND status = 'active' AND expires_at > ?
                  AND current_deployment_id IS ?
              )`,
          )
          .bind(
            deploymentId,
            site.id,
            userId,
            site.current_deployment_id,
            request.files.length,
            totalBytes,
            JSON.stringify(request.files),
            request.title,
            request.description,
            request.framework,
            spaFallback ? 1 : 0,
            idempotencyKey,
            requestHash,
            now,
            uploadExpiresAt,
            userId,
            now,
            HOSTED_SITE_LIMITS.concurrentUploads,
            site.id,
            userId,
            now,
            site.current_deployment_id,
          )
          .run();
      } catch (error) {
        return this.recoverConcurrentUpload(userId, idempotencyKey, requestHash, error);
      }
      if (insert.meta.changes !== 1) {
        const currentSite = await this.requireOwnedSite(userId, site.id, true);
        if (currentSite.status !== "active") throw inactiveSiteError(currentSite.status);
        if (!currentSite.expires_at || currentSite.expires_at <= now) throw inactiveSiteError("expired");
        if (currentSite.current_deployment_id !== site.current_deployment_id) {
          throw new HostedSiteInputError(409, "activation_superseded", "A newer site deployment is active.");
        }
        throw new HostedSiteInputError(429, "upload_session_limit", "Finish or wait for an existing upload first.");
      }
      return this.uploadSession(await this.requireDeployment(userId, deploymentId));
    }

    await this.enforceCreationRate(userId, now);
    const siteId = crypto.randomUUID();
    const hostname = await this.uniqueHostname(`${request.title} ${request.description}`);
    const statements = [
      this.database
        .prepare(
          `INSERT INTO hosted_sites(
             id, user_id, hostname, title, description, framework, spa_fallback, status, created_at, updated_at
           )
           SELECT ?, ?, ?, ?, ?, ?, ?, 'uploading', ?, ?
           WHERE (SELECT COUNT(*) FROM hosted_sites
                  WHERE user_id = ? AND status IN ('uploading', 'active', 'blocked')
                    AND (expires_at IS NULL OR expires_at > ?)) < ?
             AND (SELECT COUNT(*) FROM site_deployments
                  WHERE user_id = ? AND status = 'uploading' AND upload_expires_at > ?) < ?
             AND (SELECT COUNT(*) FROM site_creation_events WHERE user_id = ? AND created_at > ?) < ?
             AND (SELECT COUNT(*) FROM site_creation_events WHERE user_id = ? AND created_at > ?) < ?`,
        )
        .bind(
          siteId,
          userId,
          hostname,
          request.title,
          request.description,
          request.framework,
          request.spaFallback === true ? 1 : 0,
          now,
          now,
          userId,
          now,
          HOSTED_SITE_LIMITS.activeSites,
          userId,
          now,
          HOSTED_SITE_LIMITS.concurrentUploads,
          userId,
          now - 3_600_000,
          HOSTED_SITE_LIMITS.creationsPerHour,
          userId,
          now - 86_400_000,
          HOSTED_SITE_LIMITS.creationsPerDay,
        ),
      this.database
        .prepare(
          `INSERT INTO site_deployments(
            id, site_id, user_id, status, base_deployment_id, file_count, total_bytes, manifest_json,
            site_title, site_description, site_framework, site_spa_fallback,
            idempotency_key, request_hash, created_at, upload_expires_at
          ) SELECT ?, ?, ?, 'uploading', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
            WHERE EXISTS (SELECT 1 FROM hosted_sites WHERE id = ? AND user_id = ?)
              AND (SELECT COUNT(*) FROM site_deployments
                   WHERE user_id = ? AND status = 'uploading' AND upload_expires_at > ?) < ?`,
        )
        .bind(
          deploymentId,
          siteId,
          userId,
          request.files.length,
          totalBytes,
          JSON.stringify(request.files),
          request.title,
          request.description,
          request.framework,
          request.spaFallback === true ? 1 : 0,
          idempotencyKey,
          requestHash,
          now,
          uploadExpiresAt,
          siteId,
          userId,
          userId,
          now,
          HOSTED_SITE_LIMITS.concurrentUploads,
        ),
      this.database
        .prepare(
          `INSERT INTO site_hostname_reservations(hostname, created_at)
           SELECT hostname, ? FROM hosted_sites WHERE id = ? AND user_id = ?`,
        )
        .bind(now, siteId, userId),
      this.database
        .prepare(
          `INSERT INTO site_creation_events(id, user_id, created_at)
           SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM hosted_sites WHERE id = ? AND user_id = ?)`,
        )
        .bind(siteId, userId, now, siteId, userId),
    ];
    let results: D1Result<unknown>[];
    try {
      results = await this.database.batch(statements);
    } catch (error) {
      return this.recoverConcurrentUpload(userId, idempotencyKey, requestHash, error);
    }
    const [siteInsert, deploymentInsert, hostnameReservation, creationEvent] = results;
    if (
      siteInsert.meta.changes !== 1 ||
      deploymentInsert.meta.changes !== 1 ||
      hostnameReservation.meta.changes !== 1 ||
      creationEvent.meta.changes !== 1
    ) {
      const currentUploads = await this.database
        .prepare(
          "SELECT COUNT(*) AS count FROM site_deployments WHERE user_id = ? AND status = 'uploading' AND upload_expires_at > ?",
        )
        .bind(userId, now)
        .first<{ count: number }>();
      if ((currentUploads?.count ?? 0) >= HOSTED_SITE_LIMITS.concurrentUploads) {
        throw new HostedSiteInputError(429, "upload_session_limit", "Finish or wait for an existing upload first.");
      }
      await this.enforceCreationRate(userId, now);
      throw new HostedSiteInputError(409, "site_limit", "This account already has 10 active sites.");
    }
    return this.uploadSession(await this.requireDeployment(userId, deploymentId));
  }

  async uploadFile(userId: string, uploadId: string, path: string, request: Request): Promise<void> {
    const deployment = await this.requireDeployment(userId, uploadId);
    if (deployment.status !== "uploading" || deployment.upload_expires_at <= this.now()) {
      throw new HostedSiteInputError(409, "upload_expired", "This upload session has expired.");
    }
    const files = parseManifest(deployment.manifest_json);
    const file = expectedFile(files, path);
    const contentLengthHeader = request.headers.get("Content-Length");
    if (contentLengthHeader === null) {
      throw new HostedSiteInputError(400, "size_mismatch", "The file size does not match the manifest.");
    }
    const contentLength = Number(contentLengthHeader);
    if (!Number.isSafeInteger(contentLength) || contentLength !== file.size) {
      throw new HostedSiteInputError(400, "size_mismatch", "The file size does not match the manifest.");
    }
    const contentType = request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== file.mimeType) {
      throw new HostedSiteInputError(400, "mime_mismatch", "The file type does not match the manifest.");
    }
    if (!request.body) throw new HostedSiteInputError(400, "missing_file", "The file body is missing.");
    const key = assetKey(deployment.site_id, deployment.id, file.path);
    const claimTime = this.now();
    const uploadClaim = await this.database
      .prepare(
        `UPDATE site_deployments
         SET in_flight_uploads = in_flight_uploads + 1,
             upload_claims = upload_claims + 1,
             upload_bytes_claimed = upload_bytes_claimed + ?
         WHERE id = ? AND user_id = ? AND status = 'uploading' AND upload_expires_at > ?
           AND upload_claims < file_count * ?
           AND upload_bytes_claimed + ? <= total_bytes * ?
           AND (
             SELECT COALESCE(SUM(candidate.in_flight_uploads), 0)
             FROM site_deployments candidate
             WHERE candidate.user_id = ? AND candidate.status = 'uploading' AND candidate.upload_expires_at > ?
           ) < ?
           AND (
             SELECT COALESCE(SUM(candidate.upload_claims), 0)
             FROM site_deployments candidate
             WHERE candidate.user_id = ? AND candidate.status = 'uploading' AND candidate.upload_expires_at > ?
           ) < (
             SELECT COALESCE(SUM(candidate.file_count), 0) * ?
             FROM site_deployments candidate
             WHERE candidate.user_id = ? AND candidate.status = 'uploading' AND candidate.upload_expires_at > ?
           )
           AND (
             SELECT COALESCE(SUM(candidate.upload_bytes_claimed), 0)
             FROM site_deployments candidate
             WHERE candidate.user_id = ? AND candidate.status = 'uploading' AND candidate.upload_expires_at > ?
           ) + ? <= (
             SELECT COALESCE(SUM(candidate.total_bytes), 0) * ?
             FROM site_deployments candidate
             WHERE candidate.user_id = ? AND candidate.status = 'uploading' AND candidate.upload_expires_at > ?
           )`,
      )
      .bind(
        file.size,
        deployment.id,
        userId,
        claimTime,
        HOSTED_SITE_LIMITS.uploadAttemptMultiplier,
        file.size,
        HOSTED_SITE_LIMITS.uploadAttemptMultiplier,
        userId,
        claimTime,
        HOSTED_SITE_LIMITS.concurrentFileUploads,
        userId,
        claimTime,
        HOSTED_SITE_LIMITS.uploadAttemptMultiplier,
        userId,
        claimTime,
        userId,
        claimTime,
        file.size,
        HOSTED_SITE_LIMITS.uploadAttemptMultiplier,
        userId,
        claimTime,
      )
      .run();
    if (uploadClaim.meta.changes !== 1) {
      const current = await this.requireDeployment(userId, deployment.id);
      if (current.status !== "uploading" || current.upload_expires_at <= this.now()) {
        throw new HostedSiteInputError(409, "upload_expired", "This upload session has expired.");
      }
      throw new HostedSiteInputError(429, "upload_rate_limit", "The upload retry limit for this account was reached.");
    }
    try {
      const body = await readUploadBody(request.body, file.size);
      await this.bucket.put(key, body, { httpMetadata: { contentType: file.mimeType } });
      const stored = await this.bucket.head(key);
      if (!stored || stored.size !== file.size) {
        await this.bucket.delete(key);
        throw new HostedSiteInputError(400, "size_mismatch", "The uploaded file size is invalid.");
      }
      const storedDeployment = await this.requireDeployment(userId, deployment.id);
      if (storedDeployment.status !== "uploading" || storedDeployment.upload_expires_at <= this.now()) {
        await this.bucket.delete(key);
        throw new HostedSiteInputError(409, "upload_expired", "This upload session has expired.");
      }
      await this.database
        .prepare(
          `INSERT INTO site_upload_files(deployment_id, path, size, mime_type, uploaded_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(deployment_id, path) DO UPDATE SET
             size = excluded.size, mime_type = excluded.mime_type, uploaded_at = excluded.uploaded_at`,
        )
        .bind(deployment.id, file.path, file.size, file.mimeType, this.now())
        .run();
    } finally {
      await this.database
        .prepare(
          `UPDATE site_deployments SET in_flight_uploads = MAX(0, in_flight_uploads - 1)
           WHERE id = ? AND user_id = ?`,
        )
        .bind(deployment.id, userId)
        .run();
    }
  }

  async activate(userId: string, uploadId: string, idempotencyKey: string): Promise<HostedSiteSummary> {
    const deployment = await this.requireDeployment(userId, uploadId);
    return this.runClaimedOperation(
      userId,
      idempotencyKey,
      "activate",
      deployment.id,
      parseStoredSiteSummary,
      (summary) => summary,
      async () => {
        const now = this.now();
        const site = await this.requireOwnedSite(userId, deployment.site_id, true);
        if (site.status !== "uploading" && site.status !== "active") {
          await this.abandonDeployment(deployment);
          throw inactiveSiteError(site.status);
        }
        if (
          (deployment.status === "uploading" || deployment.status === "activating") &&
          deployment.upload_expires_at <= now
        ) {
          await this.abandonDeployment(deployment);
          await this.deleteDeployment(site.id, deployment.id);
          await this.deleteEmptyUploadingSite(site.id);
          throw new HostedSiteInputError(409, "upload_expired", "This upload session has expired.");
        }
        if (site.status === "active" && (!site.expires_at || site.expires_at <= now)) {
          await this.abandonDeployment(deployment);
          await this.deleteDeployment(site.id, deployment.id);
          throw inactiveSiteError("expired");
        }
        if (deployment.status === "active") {
          if (site.current_deployment_id !== deployment.id) {
            throw new HostedSiteInputError(409, "activation_superseded", "A newer site deployment is active.");
          }
          await this.publishAuthoritativeRoute(site.id);
          const summary = await this.summaryForSite(userId, deployment.site_id);
          if (deployment.base_deployment_id && deployment.base_deployment_id !== deployment.id) {
            await this.deleteDeployment(site.id, deployment.base_deployment_id);
          }
          return summary;
        }
        if (!["uploading", "activating"].includes(deployment.status) || deployment.upload_expires_at <= now) {
          throw new HostedSiteInputError(409, "upload_expired", "This upload session has expired.");
        }
        if (deployment.status === "uploading") {
          const uploaded = await this.database
            .prepare("SELECT path, size, mime_type FROM site_upload_files WHERE deployment_id = ?")
            .bind(deployment.id)
            .all<{ path: string; size: number; mime_type: string }>();
          const files = parseManifest(deployment.manifest_json);
          if (
            uploaded.results.length !== files.length ||
            files.some(
              (file) =>
                !uploaded.results.some(
                  (item) => item.path === file.path && item.size === file.size && item.mime_type === file.mimeType,
                ),
            )
          ) {
            throw new HostedSiteInputError(409, "upload_incomplete", "Upload every manifest file before activation.");
          }
        }
        const expiresAt = now + HOSTED_SITE_LIMITS.siteLifetimeMs;
        const authorizedDeployment = await this.authorizeActivation(userId, deployment, now);
        try {
          return await this.finalizeActivation(userId, site, authorizedDeployment, expiresAt, now);
        } catch (error) {
          await this.database
            .prepare("UPDATE site_deployments SET status = 'uploading' WHERE id = ? AND status = 'activating'")
            .bind(deployment.id)
            .run();
          throw error;
        }
      },
    );
  }

  async delete(userId: string, siteId: string, idempotencyKey: string): Promise<void> {
    const site = await this.requireOwnedSite(userId, siteId, true);
    if (site.status === "deleted" && (await this.completedDeletion(userId, site.id))) return;
    return this.runClaimedOperation(
      userId,
      idempotencyKey,
      "delete",
      siteId,
      () => undefined,
      () => ({ deleted: true }),
      async () => {
        const now = this.now();
        const statements = [
          this.database
            .prepare(
              `UPDATE hosted_sites SET status = 'deleted', deleted_at = ?, expires_at = NULL,
               route_synced_at = NULL, updated_at = ?
               WHERE id = ? AND user_id = ? AND status != 'deleted'`,
            )
            .bind(now, now, site.id, userId),
          this.database
            .prepare(
              `UPDATE site_deployments SET status = 'abandoned'
               WHERE site_id = ? AND status IN ('uploading', 'activating', 'active', 'superseded')
                 AND EXISTS (SELECT 1 FROM hosted_sites WHERE id = ? AND status = 'deleted')
               RETURNING id`,
            )
            .bind(site.id, site.id),
        ];
        if (site.status !== "deleted") {
          statements.push(
            this.database
              .prepare(
                "INSERT INTO site_audit_log(id, user_id, site_id, operation, created_at) VALUES (?, ?, ?, 'delete', ?)",
              )
              .bind(crypto.randomUUID(), userId, site.id, now),
          );
        }
        const results = await this.database.batch(statements);
        const deploymentIds = deploymentResultIds(results[1]);
        await this.publishAuthoritativeRoute(site.id);
        try {
          await this.deleteBlockMarker(site.id, site.hostname);
        } finally {
          for (const deploymentId of deploymentIds) await this.deleteDeployment(site.id, deploymentId);
        }
      },
    );
  }

  async report(hostname: string, reason: string, details: string | null, sourceIp: string): Promise<void> {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.openbot\.site$/u.test(hostname)) {
      throw new HostedSiteInputError(400, "invalid_hostname", "The hosted site address is invalid.");
    }
    if (!["abuse", "malware", "phishing", "copyright", "other"].includes(reason)) {
      throw new HostedSiteInputError(400, "invalid_reason", "Choose a valid report reason.");
    }
    if (details !== null && details.length > 1_000) {
      throw new HostedSiteInputError(400, "invalid_details", "Report details are too long.");
    }
    const site = await this.database
      .prepare("SELECT id FROM hosted_sites WHERE hostname = ?")
      .bind(hostname)
      .first<{ id: string }>();
    if (!site) throw new HostedSiteInputError(404, "site_not_found", "The hosted site was not found.");
    const now = this.now();
    const deduplicationWindow = Math.floor(now / 86_400_000);
    const secret = this.reportHashSecret?.trim();
    if (!secret || secret.length < 32) throw new Error("The hosted site report hash secret is unavailable.");
    const ipHash = await sourceIpHash(secret, sourceIp, deduplicationWindow);
    const reportId = await sha256(`${hostname}\0${reason}\0${ipHash}\0${deduplicationWindow}`);
    await this.database
      .prepare(
        `INSERT INTO site_reports(id, hostname, reason, details, source_ip_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .bind(reportId, hostname, reason, details, ipHash, now)
      .run();
  }

  async setBlocked(siteId: string, blocked: boolean): Promise<void> {
    const site = await this.database.prepare("SELECT * FROM hosted_sites WHERE id = ?").bind(siteId).first<SiteRow>();
    if (!site) throw new HostedSiteInputError(409, "site_not_found", "The site was not found.");
    const now = this.now();
    if (blocked) {
      await this.bucket.put(blockKey(site.hostname), "blocked", { httpMetadata: { contentType: "text/plain" } });
    }
    let status: SiteRow["status"];
    let allowedStatuses: string;
    if (blocked) {
      status = "blocked";
      allowedStatuses = "('active', 'blocked')";
    } else if (!site.current_deployment_id || !site.expires_at || site.expires_at <= now) {
      status = "expired";
      allowedStatuses = "('blocked', 'active', 'expired')";
    } else {
      status = "active";
      allowedStatuses = "('blocked', 'active')";
    }
    let results: D1Result<unknown>[];
    try {
      results = await this.database.batch([
        this.database
          .prepare(
            `UPDATE hosted_sites SET status = ?, blocked_at = ?, route_synced_at = NULL, updated_at = ?
             WHERE id = ? AND status IN ${allowedStatuses} AND (? = 0 OR expires_at > ?)`,
          )
          .bind(status, blocked ? now : null, now, site.id, blocked ? 1 : 0, now),
        this.database
          .prepare(
            `UPDATE site_deployments SET status = 'abandoned'
             WHERE site_id = ? AND status IN ('uploading', 'activating') AND ? = 1
               AND EXISTS (
                 SELECT 1 FROM hosted_sites WHERE id = ? AND status = ? AND updated_at = ?
               )
             RETURNING id`,
          )
          .bind(site.id, blocked ? 1 : 0, site.id, status, now),
        this.database
          .prepare(
            `INSERT INTO site_audit_log(id, user_id, site_id, operation, created_at)
             SELECT ?, NULL, ?, ?, ?
             WHERE EXISTS (
               SELECT 1 FROM hosted_sites WHERE id = ? AND status = ? AND updated_at = ?
             )`,
          )
          .bind(crypto.randomUUID(), site.id, blocked ? "block" : "unblock", now, site.id, status, now),
      ]);
    } catch (error) {
      if (blocked) await this.bucket.delete(blockKey(site.hostname)).catch(() => undefined);
      throw error;
    }
    if (results[0].meta.changes !== 1) {
      if (blocked) await this.bucket.delete(blockKey(site.hostname)).catch(() => undefined);
      const current = await this.siteById(site.id);
      if (current?.status === "deleted" || current?.status === "expired") throw inactiveSiteError(current.status);
      if (current?.expires_at != null && current.expires_at <= now) throw inactiveSiteError("expired");
      throw new HostedSiteInputError(409, "site_not_active", "This site cannot be blocked or unblocked.");
    }
    await this.reconcileRouteAndMarker(site.id);
    for (const deploymentId of deploymentResultIds(results[1])) {
      await this.deleteDeployment(site.id, deploymentId);
    }
  }

  async cleanup(now = this.now()): Promise<{ uploads: number; expired: number; tombstones: number }> {
    const deadline = performance.now() + CLEANUP_RUNTIME_BUDGET_MS;
    let abandonedUploads = 0;
    let expiredSites = 0;
    let deletedTombstones = 0;
    const tombstoneCutoff = now - HOSTED_SITE_LIMITS.tombstoneLifetimeMs;
    let hasMore = true;
    cleanupBatches: while (hasMore && performance.now() < deadline) {
      hasMore = false;
      const staleUploads = await this.database
        .prepare(
          `SELECT id, site_id FROM site_deployments
           WHERE status IN ('uploading', 'activating') AND upload_expires_at <= ?
           LIMIT ${CLEANUP_BATCH_SIZE}`,
        )
        .bind(now)
        .all<{ id: string; site_id: string }>();
      hasMore ||= staleUploads.results.length === CLEANUP_BATCH_SIZE;
      for (const upload of staleUploads.results) {
        if (performance.now() >= deadline) break cleanupBatches;
        const claim = await this.database
          .prepare(
            `UPDATE site_deployments SET status = 'abandoned'
             WHERE id = ? AND status IN ('uploading', 'activating') AND upload_expires_at <= ?`,
          )
          .bind(upload.id, now)
          .run();
        if (claim.meta.changes !== 1) continue;
        abandonedUploads += 1;
        await this.deleteDeployment(upload.site_id, upload.id);
      }

      const unsyncedSites = await this.database
        .prepare(
          `SELECT id, hostname FROM hosted_sites
           WHERE status IN ('active', 'blocked', 'deleted', 'expired') AND route_synced_at IS NULL
           ORDER BY updated_at, id LIMIT ${CLEANUP_BATCH_SIZE}`,
        )
        .all<{ id: string; hostname: string }>();
      hasMore ||= unsyncedSites.results.length === CLEANUP_BATCH_SIZE;
      for (const site of unsyncedSites.results) {
        if (performance.now() >= deadline) break cleanupBatches;
        await this.reconcileRouteAndMarker(site.id);
      }

      const obsoleteDeployments = await this.database
        .prepare(
          `SELECT deployment.id, deployment.site_id FROM site_deployments AS deployment
           WHERE deployment.status IN ('abandoned', 'superseded')
             AND deployment.objects_deleted_at IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM hosted_sites AS site
               WHERE site.id = deployment.site_id AND site.route_synced_at IS NULL
             )
           LIMIT ${CLEANUP_BATCH_SIZE}`,
        )
        .all<{ id: string; site_id: string }>();
      hasMore ||= obsoleteDeployments.results.length === CLEANUP_BATCH_SIZE;
      for (const deployment of obsoleteDeployments.results) {
        if (performance.now() >= deadline) break cleanupBatches;
        await this.deleteDeployment(deployment.site_id, deployment.id);
      }
      await this.database
        .prepare(
          `DELETE FROM hosted_sites WHERE status = 'uploading'
           AND NOT EXISTS (
             SELECT 1 FROM site_deployments d
             WHERE d.site_id = hosted_sites.id AND d.status IN ('uploading', 'activating')
           )`,
        )
        .run();

      const expired = await this.database
        .prepare(
          `SELECT * FROM hosted_sites
           WHERE status IN ('active', 'blocked') AND expires_at <= ? LIMIT ${CLEANUP_BATCH_SIZE}`,
        )
        .bind(now)
        .all<SiteRow>();
      hasMore ||= expired.results.length === CLEANUP_BATCH_SIZE;
      for (const site of expired.results) {
        if (performance.now() >= deadline) break cleanupBatches;
        const results = await this.database.batch([
          this.database
            .prepare(
              `UPDATE hosted_sites SET status = 'expired', route_synced_at = NULL, updated_at = ?
               WHERE id = ? AND status IN ('active', 'blocked') AND expires_at <= ?`,
            )
            .bind(now, site.id, now),
          this.database
            .prepare(
              `UPDATE site_deployments SET status = 'abandoned'
               WHERE site_id = ? AND status IN ('uploading', 'activating')
                 AND EXISTS (SELECT 1 FROM hosted_sites WHERE id = ? AND status = 'expired')`,
            )
            .bind(site.id, site.id),
        ]);
        if (results[0].meta.changes !== 1) continue;
        expiredSites += 1;
        try {
          await this.publishAuthoritativeRoute(site.id);
        } finally {
          await this.deleteBlockMarker(site.id, site.hostname);
        }
        const current = await this.siteById(site.id);
        if (current?.current_deployment_id) await this.deleteDeployment(site.id, current.current_deployment_id);
      }

      const tombstones = await this.database
        .prepare(
          `SELECT id, hostname FROM hosted_sites
           WHERE status IN ('deleted', 'expired') AND updated_at <= ? LIMIT ${CLEANUP_BATCH_SIZE}`,
        )
        .bind(tombstoneCutoff)
        .all<{ id: string; hostname: string }>();
      hasMore ||= tombstones.results.length === CLEANUP_BATCH_SIZE;
      const processedTombstones: { id: string }[] = [];
      for (const site of tombstones.results) {
        if (performance.now() >= deadline) break;
        await this.bucket.delete([routeKey(site.hostname), blockKey(site.hostname)]);
        processedTombstones.push(site);
      }
      if (processedTombstones.length) {
        const results = await this.database.batch(
          processedTombstones.map((site) =>
            this.database.prepare("DELETE FROM hosted_sites WHERE id = ?").bind(site.id),
          ),
        );
        deletedTombstones += results.reduce((total, result) => total + result.meta.changes, 0);
      }
    }
    await this.database
      .prepare("DELETE FROM site_creation_events WHERE created_at < ?")
      .bind(now - 2 * 24 * 60 * 60_000)
      .run();
    await this.database
      .prepare("DELETE FROM site_operation_receipts WHERE created_at < ?")
      .bind(now - 90 * 24 * 60 * 60_000)
      .run();
    await this.database
      .prepare("DELETE FROM site_reports WHERE created_at < ?")
      .bind(now - 180 * 24 * 60 * 60_000)
      .run();
    return {
      uploads: abandonedUploads,
      expired: expiredSites,
      tombstones: deletedTombstones,
    };
  }

  private async finalizeActivation(
    userId: string,
    site: SiteRow,
    deployment: DeploymentRow,
    expiresAt: number,
    now: number,
  ): Promise<HostedSiteSummary> {
    const previousDeployment = deployment.base_deployment_id;
    const results = await this.database.batch([
      this.database
        .prepare(
          `UPDATE hosted_sites SET status = 'active', current_deployment_id = ?, expires_at = ?,
           route_synced_at = NULL,
           updated_at = ?, title = ?, description = ?, framework = ?, spa_fallback = ?
           WHERE id = ? AND user_id = ? AND status IN ('uploading', 'active')
             AND (status = 'uploading' OR expires_at > ?)
             AND (
               SELECT COUNT(*) FROM hosted_sites
               WHERE user_id = ? AND id != ? AND status IN ('uploading', 'active', 'blocked')
                 AND (expires_at IS NULL OR expires_at > ?)
             ) < ?
             AND current_deployment_id IS ?
             AND EXISTS (SELECT 1 FROM site_deployments WHERE id = ? AND status = 'activating')`,
        )
        .bind(
          deployment.id,
          expiresAt,
          now,
          deployment.site_title,
          deployment.site_description,
          deployment.site_framework,
          deployment.site_spa_fallback,
          site.id,
          userId,
          now,
          userId,
          site.id,
          now,
          HOSTED_SITE_LIMITS.activeSites,
          previousDeployment,
          deployment.id,
        ),
      this.database
        .prepare(
          `INSERT INTO site_audit_log(id, user_id, site_id, operation, created_at)
           SELECT ?, ?, ?, 'activate', ?
           WHERE EXISTS (SELECT 1 FROM site_deployments WHERE id = ? AND status = 'activating')
             AND EXISTS (
               SELECT 1 FROM hosted_sites WHERE id = ? AND user_id = ? AND status = 'active'
                 AND current_deployment_id = ?
             )`,
        )
        .bind(crypto.randomUUID(), userId, site.id, now, deployment.id, site.id, userId, deployment.id),
      this.database
        .prepare(
          `UPDATE site_deployments SET status = 'superseded'
           WHERE site_id = ? AND id != ? AND status = 'active'
             AND EXISTS (SELECT 1 FROM site_deployments WHERE id = ? AND status = 'activating')
             AND EXISTS (
               SELECT 1 FROM hosted_sites WHERE id = ? AND user_id = ? AND status = 'active'
                 AND current_deployment_id = ?
             )`,
        )
        .bind(site.id, deployment.id, deployment.id, site.id, userId, deployment.id),
      this.database
        .prepare(
          `UPDATE site_deployments SET status = 'active', activated_at = ?
           WHERE id = ? AND status = 'activating'
             AND EXISTS (
               SELECT 1 FROM hosted_sites WHERE id = ? AND user_id = ? AND status = 'active'
                 AND current_deployment_id = ?
             )`,
        )
        .bind(now, deployment.id, site.id, userId, deployment.id),
      this.database
        .prepare(
          `UPDATE site_deployments SET status = 'abandoned'
           WHERE site_id = ? AND id != ? AND status IN ('uploading', 'activating')
             AND base_deployment_id IS ?
             AND EXISTS (
               SELECT 1 FROM hosted_sites WHERE id = ? AND user_id = ? AND status = 'active'
                 AND current_deployment_id = ?
             )
           RETURNING id`,
        )
        .bind(site.id, deployment.id, previousDeployment, site.id, userId, deployment.id),
    ]);
    if (results[3].meta.changes !== 1) {
      const currentSite = await this.requireOwnedSite(userId, site.id, true);
      const currentDeployment = await this.requireDeployment(userId, deployment.id);
      const alreadyActive =
        currentSite.status === "active" &&
        currentSite.current_deployment_id === deployment.id &&
        currentDeployment.status === "active";
      if (!alreadyActive) {
        await this.abandonDeployment(currentDeployment);
        if (currentSite.status !== "uploading") await this.publishAuthoritativeRoute(site.id);
        await this.deleteDeployment(site.id, deployment.id);
        if (currentSite.status !== "uploading" && currentSite.status !== "active") {
          throw inactiveSiteError(currentSite.status);
        }
        if (currentDeployment.upload_expires_at <= now) {
          throw new HostedSiteInputError(409, "upload_expired", "This upload session has expired.");
        }
        if (currentSite.status === "active" && (!currentSite.expires_at || currentSite.expires_at <= now)) {
          throw inactiveSiteError("expired");
        }
        if ((await this.activeSiteSlotCount(userId, site.id, now)) >= HOSTED_SITE_LIMITS.activeSites) {
          throw new HostedSiteInputError(409, "site_limit", "This account already has 10 active sites.");
        }
        throw new HostedSiteInputError(409, "activation_superseded", "A newer site deployment is active.");
      }
    }
    await this.publishAuthoritativeRoute(site.id);
    const summary = await this.summaryForSite(userId, site.id);
    if (previousDeployment && previousDeployment !== deployment.id) {
      await this.deleteDeployment(site.id, previousDeployment);
    }
    for (const abandonedDeploymentId of deploymentResultIds(results[4])) {
      await this.deleteDeployment(site.id, abandonedDeploymentId);
    }
    return summary;
  }

  private async abandonDeployment(deployment: DeploymentRow): Promise<void> {
    await this.database
      .prepare(
        `UPDATE site_deployments SET status = 'abandoned'
         WHERE id = ? AND status IN ('uploading', 'activating')`,
      )
      .bind(deployment.id)
      .run();
  }

  private async deleteEmptyUploadingSite(siteId: string): Promise<void> {
    await this.database
      .prepare(
        `DELETE FROM hosted_sites
         WHERE id = ? AND status = 'uploading' AND current_deployment_id IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM site_deployments d
             WHERE d.site_id = hosted_sites.id AND d.status IN ('uploading', 'activating')
           )`,
      )
      .bind(siteId)
      .run();
  }

  private async publishAuthoritativeRoute(siteId: string): Promise<void> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const before = await this.siteById(siteId);
      if (!before) throw new HostedSiteInputError(409, "site_not_found", "The site was not found.");
      const route = await this.routeForSite(before);
      await this.bucket.put(routeKey(before.hostname), JSON.stringify(route), {
        httpMetadata: { contentType: "application/json" },
      });
      const after = await this.siteById(siteId);
      if (after && siteRouteIdentity(after) === siteRouteIdentity(before)) {
        await this.database
          .prepare(
            `UPDATE hosted_sites SET route_synced_at = ?
             WHERE id = ? AND status = ? AND current_deployment_id IS ? AND expires_at IS ?`,
          )
          .bind(this.now(), before.id, before.status, before.current_deployment_id, before.expires_at)
          .run();
        return;
      }
    }
    throw new Error("The site route changed too often during publication.");
  }

  private async routeForSite(site: SiteRow): Promise<RouteManifest> {
    if (site.status !== "active") {
      if (site.status === "uploading") throw new Error("An uploading site does not have a public route.");
      return {
        version: 1,
        status: site.status,
        siteId: site.id,
        deploymentId: null,
        expiresAt: site.expires_at,
        spaFallback: false,
        files: {},
      };
    }
    if (!site.current_deployment_id) throw new Error("The active site deployment is missing.");
    const deployment = await this.database
      .prepare("SELECT * FROM site_deployments WHERE id = ? AND site_id = ? AND status = 'active'")
      .bind(site.current_deployment_id, site.id)
      .first<DeploymentRow>();
    if (!deployment) throw new Error("The active deployment is missing.");
    const files = parseManifest(deployment.manifest_json);
    return {
      version: 1,
      status: "active",
      siteId: site.id,
      deploymentId: deployment.id,
      expiresAt: site.expires_at,
      spaFallback: deployment.site_spa_fallback === 1,
      files: Object.fromEntries(
        files.map((file) => [
          file.path,
          { key: assetKey(site.id, deployment.id, file.path), size: file.size, mimeType: file.mimeType },
        ]),
      ),
    };
  }

  private siteById(siteId: string): Promise<SiteRow | null> {
    return this.database.prepare("SELECT * FROM hosted_sites WHERE id = ?").bind(siteId).first<SiteRow>();
  }

  private async activeSiteSlotCount(userId: string, excludeSiteId: string, now: number): Promise<number> {
    const row = await this.database
      .prepare(
        `SELECT COUNT(*) AS count FROM hosted_sites
         WHERE user_id = ? AND id != ? AND status IN ('uploading', 'active', 'blocked')
           AND (expires_at IS NULL OR expires_at > ?)`,
      )
      .bind(userId, excludeSiteId, now)
      .first<{ count: number }>();
    return row?.count ?? 0;
  }

  private async authorizeActivation(userId: string, deployment: DeploymentRow, now: number): Promise<DeploymentRow> {
    if (deployment.activation_authorized_at !== null) {
      if (deployment.status === "activating") return deployment;
      const retryClaim = await this.database
        .prepare(
          `UPDATE site_deployments SET status = 'activating'
           WHERE id = ? AND user_id = ? AND status = 'uploading' AND activation_authorized_at IS NOT NULL
             AND in_flight_uploads = 0`,
        )
        .bind(deployment.id, userId)
        .run();
      if (retryClaim.meta.changes === 1) return { ...deployment, status: "activating" };
    }
    const hour = Math.floor(now / 3_600_000) * 3_600_000;
    const day = Math.floor(now / 86_400_000) * 86_400_000;
    const claim = await this.database
      .prepare(
        `UPDATE site_deployments SET status = 'activating', activation_authorized_at = ?
         WHERE id = ? AND user_id = ? AND status IN ('uploading', 'activating')
           AND activation_authorized_at IS NULL
           AND in_flight_uploads = 0
           AND (
             SELECT COUNT(*) FROM site_deployments
             WHERE user_id = ? AND activation_authorized_at >= ?
           ) < 20
           AND (
             SELECT COUNT(*) FROM site_deployments
             WHERE user_id = ? AND activation_authorized_at >= ?
           ) < 100`,
      )
      .bind(now, deployment.id, userId, userId, hour, userId, day)
      .run();
    if (claim.meta.changes === 1) {
      return { ...deployment, status: "activating", activation_authorized_at: now };
    }
    const current = await this.requireDeployment(userId, deployment.id);
    if (current.status === "activating" && current.activation_authorized_at !== null) return current;
    if (current.in_flight_uploads > 0) {
      throw new HostedSiteInputError(409, "upload_in_progress", "Wait for the file upload to finish.");
    }
    await this.database
      .prepare(
        `UPDATE site_deployments SET status = 'uploading'
         WHERE id = ? AND user_id = ? AND status = 'activating' AND activation_authorized_at IS NULL`,
      )
      .bind(deployment.id, userId)
      .run();
    throw new HostedSiteInputError(429, "activation_rate_limit", "The publish limit for this account was reached.");
  }

  private async enforceCreationRate(userId: string, now: number): Promise<void> {
    const [hour, day] = await this.database.batch([
      this.database
        .prepare("SELECT COUNT(*) AS count FROM site_creation_events WHERE user_id = ? AND created_at > ?")
        .bind(userId, now - 3_600_000),
      this.database
        .prepare("SELECT COUNT(*) AS count FROM site_creation_events WHERE user_id = ? AND created_at > ?")
        .bind(userId, now - 86_400_000),
    ]);
    const hourCount = creationCount(hour.results?.[0]);
    const dayCount = creationCount(day.results?.[0]);
    if (hourCount >= HOSTED_SITE_LIMITS.creationsPerHour || dayCount >= HOSTED_SITE_LIMITS.creationsPerDay) {
      throw new HostedSiteInputError(
        429,
        "site_creation_rate_limit",
        "The new-site creation limit for this account was reached.",
      );
    }
  }

  private async uniqueHostname(source: string): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const words = slugWords(source);
      const descriptive = descriptiveSlug(words);
      const hostname = `${descriptive}-${randomBase32(10)}.openbot.site`;
      const existing = await this.database
        .prepare("SELECT hostname FROM site_hostname_reservations WHERE hostname = ?")
        .bind(hostname)
        .first<{ hostname: string }>();
      if (!existing) return hostname;
    }
    throw new Error("A unique site hostname could not be created.");
  }

  private async requireOwnedSite(userId: string, siteId: string, allowInactive = false): Promise<SiteRow> {
    const site = await this.database
      .prepare("SELECT * FROM hosted_sites WHERE id = ? AND user_id = ?")
      .bind(siteId, userId)
      .first<SiteRow>();
    if (!site || (!allowInactive && site.status !== "active")) {
      throw new HostedSiteInputError(409, "site_not_found", "The site was not found.");
    }
    return site;
  }

  private async requireDeployment(userId: string, deploymentId: string): Promise<DeploymentRow> {
    const deployment = await this.database
      .prepare("SELECT * FROM site_deployments WHERE id = ? AND user_id = ?")
      .bind(deploymentId, userId)
      .first<DeploymentRow>();
    if (!deployment) throw new HostedSiteInputError(409, "upload_not_found", "The upload was not found.");
    return deployment;
  }

  private deploymentByIdempotency(userId: string, key: string): Promise<DeploymentRow | null> {
    return this.database
      .prepare("SELECT * FROM site_deployments WHERE user_id = ? AND idempotency_key = ?")
      .bind(userId, key)
      .first<DeploymentRow>();
  }

  private async uploadSession(deployment: DeploymentRow): Promise<HostedSiteUploadSession> {
    return {
      uploadId: deployment.id,
      site: await this.summaryForSite(deployment.user_id, deployment.site_id),
      expiresAt: new Date(deployment.upload_expires_at).toISOString(),
    };
  }

  private uploadSessionForRequest(deployment: DeploymentRow, requestHash: string): Promise<HostedSiteUploadSession> {
    if (deployment.request_hash !== requestHash) {
      throw new HostedSiteInputError(
        409,
        "idempotency_conflict",
        "This idempotency key was already used for a different upload request.",
      );
    }
    return this.uploadSession(deployment);
  }

  private async summaryForSite(userId: string, siteId: string): Promise<HostedSiteSummary> {
    const row = await this.database
      .prepare(
        `SELECT s.*, COALESCE(d.file_count, 0) AS file_count, COALESCE(d.total_bytes, 0) AS total_bytes
         FROM hosted_sites s LEFT JOIN site_deployments d ON d.id = s.current_deployment_id
         WHERE s.id = ? AND s.user_id = ?`,
      )
      .bind(siteId, userId)
      .first<SiteRow & { file_count: number; total_bytes: number }>();
    if (!row) throw new HostedSiteInputError(409, "site_not_found", "The site was not found.");
    return mapSite(row);
  }

  private async runClaimedOperation<T>(
    userId: string,
    key: string,
    operation: string,
    resourceId: string,
    parseResponse: (value: string) => T,
    responseFor: (value: T) => unknown,
    run: () => Promise<T>,
  ): Promise<T> {
    const claim = await this.claimOperation(userId, key, operation, resourceId);
    if (claim.status === "completed") return parseResponse(claim.response);
    try {
      const result = await run();
      await this.completeOperation(userId, key, operation, resourceId, claim.token, responseFor(result));
      return result;
    } catch (error) {
      await this.releaseOperation(userId, key, operation, resourceId, claim.token);
      throw error;
    }
  }

  private async claimOperation(
    userId: string,
    key: string,
    operation: string,
    resourceId: string,
  ): Promise<OperationClaim> {
    const now = this.now();
    const token = crypto.randomUUID();
    const insert = await this.database
      .prepare(
        `INSERT INTO site_operation_receipts(
           user_id, idempotency_key, operation, resource_id, status, claim_token,
           response_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'pending', ?, NULL, ?, ?)
         ON CONFLICT(user_id, idempotency_key) DO NOTHING`,
      )
      .bind(userId, key, operation, resourceId, token, now, now)
      .run();
    if (insert.meta.changes === 1) return { status: "pending", token };

    const row = await this.database
      .prepare(
        `SELECT operation, resource_id, status, claim_token, response_json, updated_at
         FROM site_operation_receipts WHERE user_id = ? AND idempotency_key = ?`,
      )
      .bind(userId, key)
      .first<{
        operation: string;
        resource_id: string | null;
        status: "pending" | "completed";
        claim_token: string | null;
        response_json: string | null;
        updated_at: number;
      }>();
    if (!row) throw new Error("The operation claim disappeared after its insert conflict.");
    if (row.operation !== operation || row.resource_id !== resourceId) {
      throw new HostedSiteInputError(
        409,
        "idempotency_conflict",
        "This idempotency key was already used for a different site operation.",
      );
    }
    if (row.status === "completed" && row.response_json !== null) {
      return { status: "completed", response: row.response_json };
    }

    const staleBefore = now - HOSTED_SITE_LIMITS.uploadLifetimeMs;
    if (row.status === "pending" && row.claim_token && row.updated_at <= staleBefore) {
      const stolen = await this.database
        .prepare(
          `UPDATE site_operation_receipts SET claim_token = ?, updated_at = ?
           WHERE user_id = ? AND idempotency_key = ? AND operation = ? AND resource_id = ?
             AND status = 'pending' AND claim_token = ? AND updated_at = ?`,
        )
        .bind(token, now, userId, key, operation, resourceId, row.claim_token, row.updated_at)
        .run();
      if (stolen.meta.changes === 1) return { status: "pending", token };
    }
    throw new HostedSiteInputError(409, "operation_in_progress", "This site operation is already in progress.");
  }

  private async completedDeletion(userId: string, siteId: string): Promise<boolean> {
    const row = await this.database
      .prepare(
        `SELECT 1 AS completed FROM site_operation_receipts
         WHERE user_id = ? AND resource_id = ? AND operation = 'delete' AND status = 'completed' LIMIT 1`,
      )
      .bind(userId, siteId)
      .first<{ completed: number }>();
    return row?.completed === 1;
  }

  private async completeOperation(
    userId: string,
    key: string,
    operation: string,
    resourceId: string,
    token: string,
    response: unknown,
  ): Promise<void> {
    const completed = await this.database
      .prepare(
        `UPDATE site_operation_receipts
         SET status = 'completed', claim_token = NULL, response_json = ?, updated_at = ?
         WHERE user_id = ? AND idempotency_key = ? AND operation = ? AND resource_id = ?
           AND status = 'pending' AND claim_token = ?`,
      )
      .bind(JSON.stringify(response), this.now(), userId, key, operation, resourceId, token)
      .run();
    if (completed.meta.changes !== 1) throw new Error("The site operation claim could not be completed.");
  }

  private async releaseOperation(
    userId: string,
    key: string,
    operation: string,
    resourceId: string,
    token: string,
  ): Promise<void> {
    await this.database
      .prepare(
        `DELETE FROM site_operation_receipts
         WHERE user_id = ? AND idempotency_key = ? AND operation = ? AND resource_id = ?
           AND status = 'pending' AND claim_token = ?`,
      )
      .bind(userId, key, operation, resourceId, token)
      .run();
  }

  private async abandonExpiredUploads(userId: string, now: number): Promise<void> {
    const stale = await this.database
      .prepare(
        `SELECT id, site_id FROM site_deployments
         WHERE user_id = ? AND status IN ('uploading', 'activating') AND upload_expires_at <= ?`,
      )
      .bind(userId, now)
      .all<{ id: string; site_id: string }>();
    for (const upload of stale.results) {
      const claim = await this.database
        .prepare(
          `UPDATE site_deployments SET status = 'abandoned'
           WHERE id = ? AND user_id = ? AND status IN ('uploading', 'activating') AND upload_expires_at <= ?`,
        )
        .bind(upload.id, userId, now)
        .run();
      if (claim.meta.changes === 1) await this.deleteDeployment(upload.site_id, upload.id);
    }
    await this.database
      .prepare(
        `DELETE FROM hosted_sites
         WHERE user_id = ? AND status = 'uploading' AND current_deployment_id IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM site_deployments d
             WHERE d.site_id = hosted_sites.id AND d.status IN ('uploading', 'activating')
           )`,
      )
      .bind(userId)
      .run();
  }

  private async deleteDeployment(siteId: string, deploymentId: string): Promise<void> {
    let cursor: string | undefined;
    do {
      const listed = await this.bucket.list({ prefix: `sites/${siteId}/deployments/${deploymentId}/`, cursor });
      if (listed.objects.length) await this.bucket.delete(listed.objects.map((object) => object.key));
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
    await this.database
      .prepare("UPDATE site_deployments SET objects_deleted_at = ? WHERE id = ? AND site_id = ?")
      .bind(this.now(), deploymentId, siteId)
      .run();
  }

  private async deleteBlockMarker(siteId: string, hostname: string): Promise<void> {
    try {
      await this.bucket.delete(blockKey(hostname));
    } catch (error) {
      await this.markRouteUnsynced(siteId);
      throw error;
    }
  }

  private async putBlockMarkerForSyncedRoute(siteId: string, hostname: string): Promise<void> {
    try {
      await this.bucket.put(blockKey(hostname), "blocked", { httpMetadata: { contentType: "text/plain" } });
    } catch (error) {
      await this.markRouteUnsynced(siteId);
      throw error;
    }
  }

  private async markRouteUnsynced(siteId: string): Promise<void> {
    await this.database.prepare("UPDATE hosted_sites SET route_synced_at = NULL WHERE id = ?").bind(siteId).run();
  }

  private async reconcileRouteAndMarker(siteId: string): Promise<void> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const before = await this.siteById(siteId);
      if (!before) return;
      if (before.status === "blocked") {
        await this.bucket.put(blockKey(before.hostname), "blocked", { httpMetadata: { contentType: "text/plain" } });
      }
      await this.publishAuthoritativeRoute(siteId);
      const published = await this.siteById(siteId);
      if (!published) return;
      if (published.status === "blocked") {
        await this.putBlockMarkerForSyncedRoute(published.id, published.hostname);
      } else {
        await this.deleteBlockMarker(published.id, published.hostname);
      }
      const after = await this.siteById(siteId);
      if (after && siteRouteIdentity(after) === siteRouteIdentity(published)) return;
    }
    throw new Error("The site state changed too often during route reconciliation.");
  }

  private async recoverConcurrentUpload(
    userId: string,
    idempotencyKey: string,
    requestHash: string,
    error: unknown,
  ): Promise<HostedSiteUploadSession> {
    const prior = await this.deploymentByIdempotency(userId, idempotencyKey);
    if (prior) return this.uploadSessionForRequest(prior, requestHash);
    throw error;
  }
}

async function uploadRequestHash(request: HostedSiteUploadRequest): Promise<string> {
  return sha256(
    JSON.stringify({
      siteId: request.siteId,
      title: request.title,
      description: request.description,
      framework: request.framework,
      spaFallback: request.spaFallback,
      files: [...request.files].sort((left, right) => {
        if (left.path === right.path) return 0;
        return left.path < right.path ? -1 : 1;
      }),
    }),
  );
}

function parseManifest(value: string): HostedSiteFileManifest[] {
  const parsed = JSON.parse(value);
  if (!Array.isArray(parsed) || !parsed.every(isStoredManifestFile)) {
    throw new Error("The stored site manifest is invalid.");
  }
  return parsed.map((file) => ({ path: file.path, size: file.size, mimeType: file.mimeType }));
}

async function readUploadBody(body: ReadableStream<Uint8Array>, expectedSize: number): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let totalSize = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    totalSize += result.value.byteLength;
    if (totalSize > expectedSize) {
      await reader.cancel().catch(() => undefined);
      throw new HostedSiteInputError(400, "size_mismatch", "The file size does not match the manifest.");
    }
    chunks.push(result.value);
  }
  if (totalSize !== expectedSize) {
    throw new HostedSiteInputError(400, "size_mismatch", "The file size does not match the manifest.");
  }
  const combined = new Uint8Array(totalSize);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

function isStoredManifestFile(value: unknown): value is HostedSiteFileManifest {
  return isDynamicRecord(value) && isString(value.path) && isNumber(value.size) && isString(value.mimeType);
}

function creationCount(value: unknown): number {
  return isDynamicRecord(value) && isNumber(value.count) ? value.count : 0;
}

function deploymentResultIds(result: D1Result<unknown>): string[] {
  return result.results.map((deployment) => {
    if (!isDynamicRecord(deployment) || !isString(deployment.id)) {
      throw new Error("The deployment result is invalid.");
    }
    return deployment.id;
  });
}

function inactiveSiteError(status: SiteRow["status"]): HostedSiteInputError {
  if (status === "blocked") return new HostedSiteInputError(409, "site_blocked", "This site is blocked.");
  if (status === "deleted") return new HostedSiteInputError(409, "site_deleted", "This site was deleted.");
  if (status === "expired") return new HostedSiteInputError(409, "site_expired", "This site has expired.");
  return new HostedSiteInputError(409, "site_not_active", "This site cannot accept this deployment.");
}

function siteRouteIdentity(site: SiteRow): string {
  return `${site.status}:${site.current_deployment_id ?? ""}:${site.expires_at ?? ""}`;
}

function parseStoredSiteSummary(value: string): HostedSiteSummary {
  const parsed = JSON.parse(value);
  if (
    !isDynamicRecord(parsed) ||
    !isString(parsed.id) ||
    !isString(parsed.hostname) ||
    !isString(parsed.url) ||
    !isString(parsed.title) ||
    !isString(parsed.description) ||
    (parsed.framework !== "vanilla" && parsed.framework !== "astro") ||
    !["uploading", "active", "deleted", "expired", "blocked"].includes(String(parsed.status)) ||
    !isNumber(parsed.fileCount) ||
    !isNumber(parsed.size) ||
    (parsed.expiresAt !== null && !isString(parsed.expiresAt)) ||
    !isString(parsed.updatedAt)
  ) {
    throw new Error("The stored site receipt is invalid.");
  }
  return {
    id: parsed.id,
    hostname: parsed.hostname,
    url: parsed.url,
    title: parsed.title,
    description: parsed.description,
    framework: parsed.framework,
    status: parseSiteStatus(parsed.status),
    fileCount: parsed.fileCount,
    size: parsed.size,
    expiresAt: parsed.expiresAt,
    updatedAt: parsed.updatedAt,
  };
}

function parseSiteStatus(value: unknown): SiteRow["status"] {
  if (
    value === "uploading" ||
    value === "active" ||
    value === "deleted" ||
    value === "expired" ||
    value === "blocked"
  ) {
    return value;
  }
  throw new Error("The stored site status is invalid.");
}

function mapSite(row: SiteRow & { file_count: number; total_bytes: number }): HostedSiteSummary {
  return {
    id: row.id,
    hostname: row.hostname,
    url: `https://${row.hostname}`,
    title: row.title,
    description: row.description,
    framework: row.framework,
    status: row.status,
    fileCount: row.file_count,
    size: row.total_bytes,
    expiresAt: row.expires_at === null ? null : new Date(row.expires_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function assetKey(siteId: string, deploymentId: string, path: string): string {
  return `sites/${siteId}/deployments/${deploymentId}/${path}`;
}

function routeKey(hostname: string): string {
  return `routes/${hostname}.json`;
}

function blockKey(hostname: string): string {
  return `blocks/${hostname}`;
}

const RESERVED_PREFIXES = new Set([
  "admin",
  "api",
  "auth",
  "billing",
  "login",
  "support",
  "security",
  "status",
  "mail",
  "www",
]);

function slugWords(value: string): string[] {
  const words = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .trim()
    .split(/\s+/u)
    .filter((word) => word.length >= 2 && !RESERVED_PREFIXES.has(word));
  while (words.length < 3) words.push(["interactive", "static", "website"][words.length] ?? "project");
  return words;
}

export function descriptiveSlug(words: string[]): string {
  const usable = words.map((word) => word.slice(0, 14)).filter(Boolean);
  while (usable.length < 3) usable.push(["static", "web", "project"][usable.length] ?? "page");
  let slug = usable.slice(0, 3).join("-");
  for (const word of usable.slice(3)) {
    const next = slug ? `${slug}-${word}` : word;
    if (next.length > 48) break;
    slug = next;
  }
  while (slug.length < 32) {
    const extra = ["interactive", "web", "project", "page", "experience", "online", "tool"].find(
      (word) => !slug.split("-").includes(word),
    );
    if (!extra || `${slug}-${extra}`.length > 48) break;
    slug = `${slug}-${extra}`;
  }
  return slug.slice(0, 48).replace(/-+$/u, "");
}

function randomBase32(length: number): string {
  const alphabet = "23456789abcdefghjkmnpqrstuvwxyz";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

export async function sourceIpHash(secret: string, value: string, deduplicationWindow: number): Promise<string> {
  return hmacSha256(secret, `${deduplicationWindow}\0${value}`);
}
