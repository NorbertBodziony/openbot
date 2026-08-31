import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { isNumber, isString } from "@openbot/contracts/runtime-values";
import { afterEach, describe, expect, it } from "vitest";
import type { HostedSiteUploadRequest } from "../src/server/hosted-site-contract";
import { HostedSiteService } from "../src/server/hosted-site-service";

const databases: DatabaseSync[] = [];
const HTML = "<h1>Hosted</h1>";
const NOW = Date.UTC(2026, 7, 31, 12);

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("hosted site control plane", () => {
  it("keeps publication idempotent, enforces ownership, and replaces atomically", async () => {
    const fixture = serviceFixture();
    const firstUpload = await fixture.service.createUpload("alice", uploadRequest(), "publish-1");
    const repeated = await fixture.service.createUpload("alice", uploadRequest(), "publish-1");
    expect(repeated.uploadId).toBe(firstUpload.uploadId);

    await uploadIndex(fixture.service, "alice", firstUpload.uploadId);
    const first = await fixture.service.activate("alice", firstUpload.uploadId, "activate-1");
    const firstDeployment = firstUpload.uploadId;

    await expect(
      fixture.service.createUpload("bob", uploadRequest({ siteId: first.id }), "replace-by-bob"),
    ).rejects.toMatchObject({ code: "site_not_found" });

    fixture.setNow(NOW + 24 * 60 * 60_000);
    const replacement = await fixture.service.createUpload(
      "alice",
      uploadRequest({ siteId: first.id, title: "Updated hosted budget planner" }),
      "replace-1",
    );
    await uploadIndex(fixture.service, "alice", replacement.uploadId);
    fixture.database.failNextBatchContaining("UPDATE hosted_sites SET status = 'active'");
    await expect(fixture.service.activate("alice", replacement.uploadId, "activate-2")).rejects.toThrow(
      "Injected D1 failure",
    );

    const recovered = await fixture.service.activate("alice", replacement.uploadId, "activate-2");
    expect(recovered.hostname).toBe(first.hostname);
    expect(recovered.expiresAt).toBe(new Date(fixture.now() + 30 * 24 * 60 * 60_000).toISOString());
    expect(fixture.bucket.keys()).not.toContain(`sites/${first.id}/deployments/${firstDeployment}/index.html`);
  });

  it("rejects an idempotency key reused for another site or operation", async () => {
    const fixture = serviceFixture();
    const first = await publish(fixture.service, "alice", "receipt-first-publish", "shared-activation-key");
    const replacement = await fixture.service.createUpload(
      "alice",
      uploadRequest({ siteId: first.id, title: "Replacement with reused activation key" }),
      "receipt-replacement-publish",
    );
    await uploadIndex(fixture.service, "alice", replacement.uploadId);

    await expect(
      fixture.service.activate("alice", replacement.uploadId, "shared-activation-key"),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    const replacementDeployment = await fixture.database
      .prepare("SELECT status FROM site_deployments WHERE id = ?")
      .bind(replacement.uploadId)
      .first<{ status: string }>();
    expect(replacementDeployment?.status).toBe("uploading");

    const second = await fixture.service.createUpload("alice", uploadRequest(), "receipt-second-publish");
    await fixture.service.delete("alice", first.id, "shared-delete-key");
    await expect(fixture.service.delete("alice", second.site.id, "shared-delete-key")).rejects.toMatchObject({
      code: "idempotency_conflict",
    });
    const secondSite = await fixture.database
      .prepare("SELECT status FROM hosted_sites WHERE id = ?")
      .bind(second.site.id)
      .first<{ status: string }>();
    expect(secondSite?.status).toBe("uploading");
  });

  it("claims an operation key before concurrent activation and deletion", async () => {
    const activationFixture = serviceFixture();
    const firstUpload = await activationFixture.service.createUpload(
      "alice",
      uploadRequest({ title: "First concurrent activation" }),
      "concurrent-operation-first-upload",
    );
    const secondUpload = await activationFixture.service.createUpload(
      "alice",
      uploadRequest({ title: "Second concurrent activation" }),
      "concurrent-operation-second-upload",
    );
    await uploadIndex(activationFixture.service, "alice", firstUpload.uploadId);
    await uploadIndex(activationFixture.service, "alice", secondUpload.uploadId);
    const activationPause = activationFixture.database.pauseNextBatchContaining(
      "UPDATE hosted_sites SET status = 'active'",
    );
    const firstActivation = activationFixture.service.activate(
      "alice",
      firstUpload.uploadId,
      "concurrent-operation-key",
    );
    await activationPause.started;
    try {
      await expect(
        activationFixture.service.activate("alice", secondUpload.uploadId, "concurrent-operation-key"),
      ).rejects.toMatchObject({ code: "idempotency_conflict" });
    } finally {
      activationPause.resume();
    }
    await firstActivation;
    const secondDeployment = await activationFixture.database
      .prepare("SELECT status FROM site_deployments WHERE id = ?")
      .bind(secondUpload.uploadId)
      .first<{ status: string }>();
    expect(secondDeployment?.status).toBe("uploading");

    const deletionFixture = serviceFixture();
    const firstSite = await publish(
      deletionFixture.service,
      "alice",
      "concurrent-delete-first-upload",
      "concurrent-delete-first-activation",
    );
    const secondSite = await publish(
      deletionFixture.service,
      "alice",
      "concurrent-delete-second-upload",
      "concurrent-delete-second-activation",
    );
    const deletionPause = deletionFixture.database.pauseNextBatchContaining("SET status = 'deleted'");
    const firstDeletion = deletionFixture.service.delete("alice", firstSite.id, "concurrent-delete-key");
    await deletionPause.started;
    try {
      await expect(
        deletionFixture.service.delete("alice", secondSite.id, "concurrent-delete-key"),
      ).rejects.toMatchObject({ code: "idempotency_conflict" });
    } finally {
      deletionPause.resume();
    }
    await firstDeletion;
    const unchangedSite = await deletionFixture.database
      .prepare("SELECT status FROM hosted_sites WHERE id = ?")
      .bind(secondSite.id)
      .first<{ status: string }>();
    expect(unchangedSite?.status).toBe("active");
  });

  it("charges the activation limit before a concurrent activating request can publish", async () => {
    const fixture = serviceFixture();
    const site = await publish(fixture.service, "alice", "rate-publish-0", "rate-activate-0");
    for (let index = 1; index < 20; index += 1) {
      const replacement = await fixture.service.createUpload(
        "alice",
        uploadRequest({ siteId: site.id, title: `Rate limited replacement ${index}` }),
        `rate-publish-${index}`,
      );
      await uploadIndex(fixture.service, "alice", replacement.uploadId);
      await fixture.service.activate("alice", replacement.uploadId, `rate-activate-${index}`);
    }
    const limited = await fixture.service.createUpload(
      "alice",
      uploadRequest({ siteId: site.id, title: "Rate limited replacement twenty one" }),
      "rate-publish-20",
    );
    await uploadIndex(fixture.service, "alice", limited.uploadId);
    await fixture.database
      .prepare("UPDATE site_deployments SET status = 'activating' WHERE id = ?")
      .bind(limited.uploadId)
      .run();

    await expect(fixture.service.activate("alice", limited.uploadId, "rate-activate-20")).rejects.toMatchObject({
      code: "activation_rate_limit",
    });
    const deployment = await fixture.database
      .prepare("SELECT status, activation_authorized_at FROM site_deployments WHERE id = ?")
      .bind(limited.uploadId)
      .first<{ status: string; activation_authorized_at: number | null }>();
    expect(deployment).toEqual({ status: "uploading", activation_authorized_at: null });
  });

  it("removes the prior deployment when activation recovers after route publication fails", async () => {
    const fixture = serviceFixture();
    const site = await publish(fixture.service, "alice", "retry-publish", "retry-activate");
    const initialDeploymentId = await fixture.database
      .prepare("SELECT current_deployment_id FROM hosted_sites WHERE id = ?")
      .bind(site.id)
      .first<{ current_deployment_id: string }>();
    const replacement = await fixture.service.createUpload(
      "alice",
      uploadRequest({ siteId: site.id, title: "Replacement after route failure" }),
      "retry-replace",
    );
    await uploadIndex(fixture.service, "alice", replacement.uploadId);
    fixture.bucket.failNextPutContaining(`routes/${site.hostname}.json`);

    await expect(fixture.service.activate("alice", replacement.uploadId, "retry-replace-activate")).rejects.toThrow(
      "Injected R2 put failure",
    );
    const initialAsset = `sites/${site.id}/deployments/${initialDeploymentId?.current_deployment_id}/index.html`;
    expect(fixture.bucket.keys()).toContain(initialAsset);

    await expect(
      fixture.service.activate("alice", replacement.uploadId, "retry-replace-activate"),
    ).resolves.toMatchObject({ id: site.id });
    expect(fixture.bucket.keys()).not.toContain(initialAsset);
    const initialDeployment = await fixture.database
      .prepare("SELECT status, objects_deleted_at FROM site_deployments WHERE id = ?")
      .bind(initialDeploymentId?.current_deployment_id ?? "")
      .first<{ status: string; objects_deleted_at: number | null }>();
    expect(initialDeployment).toMatchObject({ status: "superseded", objects_deleted_at: expect.any(Number) });
  });

  it("keeps the active objects when two requests finalize the same authorized upload", async () => {
    const fixture = serviceFixture();
    const upload = await fixture.service.createUpload("alice", uploadRequest(), "concurrent-same-upload");
    await uploadIndex(fixture.service, "alice", upload.uploadId);
    const pause = fixture.database.pauseNextBatchContaining("UPDATE hosted_sites SET status = 'active'");
    const firstActivation = fixture.service.activate("alice", upload.uploadId, "concurrent-activate-first");
    await pause.started;
    const secondActivation = await fixture.service.activate("alice", upload.uploadId, "concurrent-activate-second");
    pause.resume();
    const firstResult = await firstActivation;

    expect(firstResult.id).toBe(secondActivation.id);
    expect(fixture.bucket.keys()).toContain(`sites/${firstResult.id}/deployments/${upload.uploadId}/index.html`);
    expect(await fixture.bucket.route(firstResult.hostname)).toMatchObject({
      status: "active",
      deploymentId: upload.uploadId,
    });
  });

  it("rejects missing or false content lengths before an oversized body reaches R2", async () => {
    const fixture = serviceFixture();
    const upload = await fixture.service.createUpload(
      "alice",
      uploadRequest({ files: [{ path: "index.html", size: 0, mimeType: "text/html" }] }),
      "oversized-upload",
    );
    const request = (headers: HeadersInit) =>
      new Request("https://openbot.run/v1/sites/upload", {
        method: "PUT",
        headers,
        body: "oversized",
      });

    await expect(
      fixture.service.uploadFile("alice", upload.uploadId, "index.html", request({ "Content-Type": "text/html" })),
    ).rejects.toMatchObject({ code: "size_mismatch" });
    await expect(
      fixture.service.uploadFile(
        "alice",
        upload.uploadId,
        "index.html",
        request({ "Content-Type": "text/html", "Content-Length": "0" }),
      ),
    ).rejects.toMatchObject({ code: "size_mismatch" });
    expect(fixture.bucket.keys()).not.toContain(`sites/${upload.site.id}/deployments/${upload.uploadId}/index.html`);
  });

  it("does not activate while a duplicate upload can still mutate the asset", async () => {
    const fixture = serviceFixture();
    const upload = await fixture.service.createUpload("alice", uploadRequest(), "duplicate-file-upload");
    await uploadIndex(fixture.service, "alice", upload.uploadId);
    const asset = `sites/${upload.site.id}/deployments/${upload.uploadId}/index.html`;
    const pause = fixture.bucket.pauseNextPutContaining(asset);
    const duplicateUpload = uploadIndex(fixture.service, "alice", upload.uploadId);
    await pause.started;

    await expect(
      fixture.service.activate("alice", upload.uploadId, "activate-during-file-upload"),
    ).rejects.toMatchObject({ code: "upload_in_progress" });
    pause.resume();
    await duplicateUpload;

    await expect(
      fixture.service.activate("alice", upload.uploadId, "activate-after-file-upload"),
    ).resolves.toMatchObject({ status: "active" });
    expect(fixture.bucket.keys()).toContain(asset);
  });

  it("republishes an unsynced active route before deleting the prior deployment", async () => {
    const fixture = serviceFixture();
    for (let index = 0; index < 50; index += 1) {
      await fixture.database
        .prepare(
          `INSERT INTO hosted_sites(
             id, user_id, hostname, title, description, framework, spa_fallback, status,
             current_deployment_id, created_at, updated_at, expires_at, deleted_at, blocked_at, route_synced_at
           ) VALUES (?, 'alice', ?, 'Deleted site', 'Deleted site backlog.', 'vanilla', 0, 'deleted',
             NULL, ?, ?, NULL, ?, NULL, NULL)`,
        )
        .bind(
          `deleted-backlog-${index}`,
          `deleted-backlog-project-number-${index}-abcdefghij.openbot.site`,
          fixture.now() - 2 * 24 * 60 * 60_000,
          fixture.now() - 60_000,
          fixture.now(),
        )
        .run();
    }
    const site = await publish(fixture.service, "alice", "cleanup-route-publish", "cleanup-route-activate");
    const priorDeployment = await fixture.database
      .prepare("SELECT current_deployment_id FROM hosted_sites WHERE id = ?")
      .bind(site.id)
      .first<{ current_deployment_id: string }>();
    const replacement = await fixture.service.createUpload(
      "alice",
      uploadRequest({ siteId: site.id, title: "Cleanup route replacement" }),
      "cleanup-route-replace",
    );
    await uploadIndex(fixture.service, "alice", replacement.uploadId);
    fixture.bucket.failNextPutContaining(`routes/${site.hostname}.json`);
    await expect(
      fixture.service.activate("alice", replacement.uploadId, "cleanup-route-replace-activate"),
    ).rejects.toThrow("Injected R2 put failure");

    expect(await fixture.bucket.route(site.hostname)).toMatchObject({
      deploymentId: priorDeployment?.current_deployment_id,
    });
    await fixture.service.cleanup();
    expect(await fixture.bucket.route(site.hostname)).toMatchObject({ deploymentId: replacement.uploadId });
    expect(fixture.bucket.keys()).not.toContain(
      `sites/${site.id}/deployments/${priorDeployment?.current_deployment_id}/index.html`,
    );
  });

  it("deletes a deployment activated after deletion reads its site snapshot", async () => {
    const fixture = serviceFixture();
    const upload = await fixture.service.createUpload("alice", uploadRequest(), "delete-activation-race");
    await uploadIndex(fixture.service, "alice", upload.uploadId);
    const pause = fixture.database.pauseNextBatchContaining("SET status = 'deleted'");
    const deletion = fixture.service.delete("alice", upload.site.id, "delete-after-activation");
    await pause.started;
    await fixture.service.activate("alice", upload.uploadId, "activate-before-delete-batch");
    pause.resume();
    await deletion;

    expect(fixture.bucket.keys()).not.toContain(`sites/${upload.site.id}/deployments/${upload.uploadId}/index.html`);
    const deployment = await fixture.database
      .prepare("SELECT status, objects_deleted_at FROM site_deployments WHERE id = ?")
      .bind(upload.uploadId)
      .first<{ status: string; objects_deleted_at: number | null }>();
    expect(deployment).toMatchObject({ status: "abandoned", objects_deleted_at: expect.any(Number) });
  });

  it("does not let blocking resurrect a site deleted during the block transition", async () => {
    const fixture = serviceFixture();
    const site = await publish(fixture.service, "alice", "block-delete-publish", "block-delete-activate");
    const pause = fixture.database.pauseNextBatchContaining("UPDATE hosted_sites SET status = ?");
    const blocking = fixture.service.setBlocked(site.id, true);
    await pause.started;
    await fixture.service.delete("alice", site.id, "delete-during-block");
    pause.resume();

    await expect(blocking).rejects.toMatchObject({ code: "site_deleted" });
    expect(fixture.bucket.keys()).not.toContain(`blocks/${site.hostname}`);
    const deleted = await fixture.database
      .prepare("SELECT status FROM hosted_sites WHERE id = ?")
      .bind(site.id)
      .first<{ status: string }>();
    expect(deleted?.status).toBe("deleted");
    expect(await fixture.bucket.route(site.hostname)).toMatchObject({ status: "deleted" });
  });

  it("allows only two concurrent upload sessions", async () => {
    const fixture = serviceFixture();
    const results = await Promise.allSettled(
      ["one", "two", "three"].map((key) =>
        fixture.service.createUpload("alice", uploadRequest({ title: `${key} hosted static project` }), key),
      ),
    );

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(2);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({ reason: { code: "upload_session_limit" } });
  });

  it("returns one upload session for concurrent requests with the same idempotency key", async () => {
    const fixture = serviceFixture();
    const pause = fixture.database.pauseNextBatchContaining("INSERT INTO hosted_sites");
    const firstRequest = fixture.service.createUpload("alice", uploadRequest(), "same-upload-key");
    await pause.started;
    const secondSession = await fixture.service.createUpload("alice", uploadRequest(), "same-upload-key");
    pause.resume();
    const firstSession = await firstRequest;

    expect(firstSession.uploadId).toBe(secondSession.uploadId);
    expect(firstSession.site.id).toBe(secondSession.site.id);
    const sites = await fixture.database
      .prepare("SELECT COUNT(*) AS count FROM hosted_sites WHERE user_id = ?")
      .bind("alice")
      .first<{ count: number }>();
    expect(sites?.count).toBe(1);
  });

  it("rejects an upload idempotency key reused for another payload or target", async () => {
    const payloadFixture = serviceFixture();
    await payloadFixture.service.createUpload("alice", uploadRequest(), "upload-request-key");
    await expect(
      payloadFixture.service.createUpload(
        "alice",
        uploadRequest({ title: "A different hosted site request" }),
        "upload-request-key",
      ),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });

    const targetFixture = serviceFixture();
    const firstSite = await publish(targetFixture.service, "alice", "target-first-upload", "target-first-activate");
    const secondSite = await publish(targetFixture.service, "alice", "target-second-upload", "target-second-activate");
    await targetFixture.service.createUpload(
      "alice",
      uploadRequest({ siteId: firstSite.id }),
      "replacement-request-key",
    );
    await expect(
      targetFixture.service.createUpload("alice", uploadRequest({ siteId: secondSite.id }), "replacement-request-key"),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  it("uses one atomic slot check for the ten-site limit", async () => {
    const fixture = serviceFixture();
    for (let index = 0; index < 10; index += 1) {
      await publish(fixture.service, "alice", `publish-${index}`, `activate-${index}`, {
        title: `Hosted planner number ${index}`,
      });
    }

    await expect(
      fixture.service.createUpload("alice", uploadRequest({ title: "Eleventh hosted planner" }), "publish-11"),
    ).rejects.toMatchObject({ code: "site_limit" });
  });

  it("does not let a pending upload resurrect a deleted or expired site", async () => {
    const deletedFixture = serviceFixture();
    const deletedSite = await publish(deletedFixture.service, "alice", "publish-delete", "activate-delete");
    const pendingDelete = await deletedFixture.service.createUpload(
      "alice",
      uploadRequest({ siteId: deletedSite.id }),
      "replace-before-delete",
    );
    await uploadIndex(deletedFixture.service, "alice", pendingDelete.uploadId);

    await deletedFixture.service.delete("alice", deletedSite.id, "delete-site-once");
    await expect(
      deletedFixture.service.activate("alice", pendingDelete.uploadId, "activate-after-delete"),
    ).rejects.toMatchObject({ code: "site_deleted" });
    expect(await deletedFixture.bucket.route(deletedSite.hostname)).toMatchObject({ status: "deleted" });

    const expiredFixture = serviceFixture();
    const expiredSite = await publish(expiredFixture.service, "alice", "publish-expiry", "activate-expiry");
    expiredFixture.setNow(NOW + 30 * 24 * 60 * 60_000 - 5 * 60_000);
    const pendingExpiry = await expiredFixture.service.createUpload(
      "alice",
      uploadRequest({ siteId: expiredSite.id }),
      "replace-before-expiry",
    );
    await uploadIndex(expiredFixture.service, "alice", pendingExpiry.uploadId);
    expiredFixture.setNow(NOW + 30 * 24 * 60 * 60_000 + 5 * 60_000);

    await expiredFixture.service.cleanup();
    await expect(
      expiredFixture.service.activate("alice", pendingExpiry.uploadId, "activate-after-expiry"),
    ).rejects.toMatchObject({ code: "site_expired" });
    expect(await expiredFixture.bucket.route(expiredSite.hostname)).toMatchObject({ status: "expired" });
  });

  it("lists a site as expired as soon as its expiry time passes", async () => {
    const fixture = serviceFixture();
    const site = await publish(fixture.service, "alice", "list-expiry-upload", "list-expiry-activation");
    fixture.setNow(NOW + 30 * 24 * 60 * 60_000 + 1);

    await expect(fixture.service.list("alice")).resolves.toContainEqual(
      expect.objectContaining({
        id: site.id,
        status: "expired",
      }),
    );
    const stored = await fixture.database
      .prepare("SELECT status FROM hosted_sites WHERE id = ?")
      .bind(site.id)
      .first<{ status: string }>();
    expect(stored?.status).toBe("active");
  });

  it("lets only one concurrent replacement become the served deployment", async () => {
    const fixture = serviceFixture();
    const site = await publish(fixture.service, "alice", "publish-race", "activate-race");
    const [first, second] = await Promise.all([
      fixture.service.createUpload(
        "alice",
        uploadRequest({ siteId: site.id, title: "First replacement site" }),
        "replace-a",
      ),
      fixture.service.createUpload(
        "alice",
        uploadRequest({ siteId: site.id, title: "Second replacement site" }),
        "replace-b",
      ),
    ]);
    await Promise.all([
      uploadIndex(fixture.service, "alice", first.uploadId),
      uploadIndex(fixture.service, "alice", second.uploadId),
    ]);

    const activations = await Promise.allSettled([
      fixture.service.activate("alice", first.uploadId, "activate-replace-a"),
      fixture.service.activate("alice", second.uploadId, "activate-replace-b"),
    ]);

    expect(activations.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(activations.find((result) => result.status === "rejected")).toMatchObject({
      reason: { code: "activation_superseded" },
    });
    const current = fixture.database
      .prepare("SELECT current_deployment_id FROM hosted_sites WHERE id = ?")
      .bind(site.id);
    const row = await current.first<{ current_deployment_id: string }>();
    expect(await fixture.bucket.route(site.hostname)).toMatchObject({
      status: "active",
      deploymentId: row?.current_deployment_id,
    });
    const abandonedId = [first.uploadId, second.uploadId].find((id) => id !== row?.current_deployment_id);
    expect(fixture.bucket.keys()).not.toContain(`sites/${site.id}/deployments/${abandonedId}/index.html`);
    const abandoned = await fixture.database
      .prepare("SELECT status, objects_deleted_at FROM site_deployments WHERE id = ?")
      .bind(abandonedId ?? "")
      .first<{ status: string; objects_deleted_at: number | null }>();
    expect(abandoned).toMatchObject({ status: "abandoned", objects_deleted_at: expect.any(Number) });
  });

  it("keeps a blocked site offline when route publication fails and reconciles it during cleanup", async () => {
    const fixture = serviceFixture();
    const site = await publish(fixture.service, "alice", "publish-block", "activate-block");
    fixture.bucket.failNextPutContaining(`routes/${site.hostname}.json`);

    await expect(fixture.service.setBlocked(site.id, true)).rejects.toThrow("Injected R2 put failure");
    expect(fixture.bucket.keys()).toContain(`blocks/${site.hostname}`);
    expect(await fixture.bucket.route(site.hostname)).toMatchObject({ status: "active" });
    const blocked = await fixture.database
      .prepare("SELECT status, route_synced_at FROM hosted_sites WHERE id = ?")
      .bind(site.id)
      .first<{ status: string; route_synced_at: number | null }>();
    expect(blocked).toEqual({ status: "blocked", route_synced_at: null });

    await fixture.service.cleanup();
    expect(await fixture.bucket.route(site.hostname)).toMatchObject({ status: "blocked" });
    const reconciled = await fixture.database
      .prepare("SELECT route_synced_at FROM hosted_sites WHERE id = ?")
      .bind(site.id)
      .first<{ route_synced_at: number | null }>();
    expect(reconciled?.route_synced_at).toBe(fixture.now());

    fixture.bucket.failNextPutContaining(`routes/${site.hostname}.json`);
    await expect(fixture.service.setBlocked(site.id, false)).rejects.toThrow("Injected R2 put failure");
    expect(fixture.bucket.keys()).toContain(`blocks/${site.hostname}`);
    const unsyncedUnblock = await fixture.database
      .prepare("SELECT status, route_synced_at FROM hosted_sites WHERE id = ?")
      .bind(site.id)
      .first<{ status: string; route_synced_at: number | null }>();
    expect(unsyncedUnblock).toEqual({ status: "active", route_synced_at: null });

    await fixture.service.cleanup();
    expect(fixture.bucket.keys()).not.toContain(`blocks/${site.hostname}`);
    expect(await fixture.bucket.route(site.hostname)).toMatchObject({ status: "active" });
  });

  it("does not recreate a block marker when cleanup races with an unblock", async () => {
    const fixture = serviceFixture();
    const site = await publish(fixture.service, "alice", "marker-race-publish", "marker-race-activate");
    await fixture.service.setBlocked(site.id, true);
    await fixture.database.prepare("UPDATE hosted_sites SET route_synced_at = NULL WHERE id = ?").bind(site.id).run();
    const pause = fixture.bucket.pauseNextPutContaining(`blocks/${site.hostname}`);
    const cleanup = fixture.service.cleanup();
    await pause.started;

    await fixture.service.setBlocked(site.id, false);
    expect(fixture.bucket.keys()).not.toContain(`blocks/${site.hostname}`);
    pause.resume();
    await cleanup;

    expect(fixture.bucket.keys()).not.toContain(`blocks/${site.hostname}`);
    expect(await fixture.bucket.route(site.hostname)).toMatchObject({ status: "active" });
  });

  it("finishes concurrent block and unblock operations from the latest state", async () => {
    const fixture = serviceFixture();
    const site = await publish(fixture.service, "alice", "block-unblock-publish", "block-unblock-activate");
    const pause = fixture.bucket.pauseNextPutContaining(`routes/${site.hostname}.json`);
    const blocking = fixture.service.setBlocked(site.id, true);
    await pause.started;

    await fixture.service.setBlocked(site.id, false);
    pause.resume();
    await blocking;

    expect(fixture.bucket.keys()).not.toContain(`blocks/${site.hostname}`);
    expect(await fixture.bucket.route(site.hostname)).toMatchObject({ status: "active" });
    const active = await fixture.database
      .prepare("SELECT status, route_synced_at FROM hosted_sites WHERE id = ?")
      .bind(site.id)
      .first<{ status: string; route_synced_at: number | null }>();
    expect(active).toMatchObject({ status: "active", route_synced_at: expect.any(Number) });
  });

  it("accepts reports only for allocated hostnames, deduplicates them, and removes old rows", async () => {
    const fixture = serviceFixture();
    await expect(
      fixture.service.report("unknown-project-name-k7m2q9tz.openbot.site", "abuse", null, "203.0.113.10"),
    ).rejects.toMatchObject({ code: "site_not_found" });
    const site = await publish(fixture.service, "alice", "publish-report", "activate-report");

    await fixture.service.report(site.hostname, "phishing", "Suspicious form", "203.0.113.10");
    await fixture.service.report(site.hostname, "phishing", "Repeated report", "203.0.113.10");
    const initial = await fixture.database
      .prepare("SELECT COUNT(*) AS count FROM site_reports")
      .first<{ count: number }>();
    expect(initial?.count).toBe(1);

    fixture.setNow(NOW + 181 * 24 * 60 * 60_000);
    await fixture.service.cleanup();
    const retained = await fixture.database
      .prepare("SELECT COUNT(*) AS count FROM site_reports")
      .first<{ count: number }>();
    expect(retained?.count).toBe(0);
  });

  it("keeps a live initial activation and abandons it only after its upload expires", async () => {
    const liveFixture = serviceFixture();
    const live = await liveFixture.service.createUpload("alice", uploadRequest(), "live-initial-upload");
    await uploadIndex(liveFixture.service, "alice", live.uploadId);
    await liveFixture.database
      .prepare("UPDATE site_deployments SET status = 'activating' WHERE id = ?")
      .bind(live.uploadId)
      .run();

    expect(await liveFixture.service.cleanup()).toMatchObject({ uploads: 0 });
    await expect(liveFixture.service.activate("alice", live.uploadId, "finish-live-activation")).resolves.toMatchObject(
      {
        status: "active",
      },
    );

    const staleFixture = serviceFixture();
    const stale = await staleFixture.service.createUpload("alice", uploadRequest(), "stale-initial-upload");
    await uploadIndex(staleFixture.service, "alice", stale.uploadId);
    await staleFixture.database
      .prepare("UPDATE site_deployments SET status = 'activating' WHERE id = ?")
      .bind(stale.uploadId)
      .run();
    staleFixture.setNow(NOW + 16 * 60_000);

    expect(await staleFixture.service.cleanup()).toMatchObject({ uploads: 1 });
    const removed = await staleFixture.database
      .prepare("SELECT id FROM hosted_sites WHERE id = ?")
      .bind(stale.site.id)
      .first<{ id: string }>();
    expect(removed).toBeNull();
    const creationEvents = await staleFixture.database
      .prepare("SELECT COUNT(*) AS count FROM site_creation_events WHERE user_id = ?")
      .bind("alice")
      .first<{ count: number }>();
    expect(creationEvents?.count).toBe(1);
  });

  it("rejects a stuck activation after the upload session expires", async () => {
    const fixture = serviceFixture();
    const upload = await fixture.service.createUpload("alice", uploadRequest(), "stuck-upload");
    await uploadIndex(fixture.service, "alice", upload.uploadId);
    await fixture.database
      .prepare("UPDATE site_deployments SET status = 'activating' WHERE id = ?")
      .bind(upload.uploadId)
      .run();
    fixture.setNow(NOW + 16 * 60_000);

    await expect(fixture.service.activate("alice", upload.uploadId, "retry-stuck-upload")).rejects.toMatchObject({
      code: "upload_expired",
    });
    expect(fixture.bucket.keys()).not.toContain(`sites/${upload.site.id}/deployments/${upload.uploadId}/index.html`);
    const site = await fixture.database
      .prepare("SELECT id FROM hosted_sites WHERE id = ?")
      .bind(upload.site.id)
      .first<{ id: string }>();
    expect(site).toBeNull();
  });

  it("does not renew an expired site after its slots have been reused", async () => {
    const fixture = serviceFixture();
    const expiring = await publish(fixture.service, "alice", "publish-expiring", "activate-expiring");
    fixture.setNow(NOW + 30 * 24 * 60 * 60_000 - 5 * 60_000);
    const replacement = await fixture.service.createUpload(
      "alice",
      uploadRequest({ siteId: expiring.id }),
      "replace-expiring",
    );
    await uploadIndex(fixture.service, "alice", replacement.uploadId);
    fixture.setNow(NOW + 30 * 24 * 60 * 60_000 + 60_000);
    for (let index = 0; index < 10; index += 1) {
      await publish(fixture.service, "alice", `publish-reused-${index}`, `activate-reused-${index}`, {
        title: `Replacement slot project ${index}`,
      });
    }

    await expect(
      fixture.service.activate("alice", replacement.uploadId, "activate-expired-replacement"),
    ).rejects.toMatchObject({ code: "site_expired" });
    const active = await fixture.database
      .prepare(
        `SELECT COUNT(*) AS count FROM hosted_sites
         WHERE user_id = ? AND status = 'active' AND expires_at > ?`,
      )
      .bind("alice", fixture.now())
      .first<{ count: number }>();
    expect(active?.count).toBe(10);
  });

  it("deletes every uploaded object when an unfinished site is deleted", async () => {
    const fixture = serviceFixture();
    const upload = await fixture.service.createUpload("alice", uploadRequest(), "unfinished-upload");
    await uploadIndex(fixture.service, "alice", upload.uploadId);
    const assetKey = `sites/${upload.site.id}/deployments/${upload.uploadId}/index.html`;
    expect(fixture.bucket.keys()).toContain(assetKey);

    await fixture.service.delete("alice", upload.site.id, "delete-unfinished");

    expect(fixture.bucket.keys()).not.toContain(assetKey);
    expect(await fixture.bucket.route(upload.site.hostname)).toMatchObject({ status: "deleted" });

    await fixture.service.delete("alice", upload.site.id, "delete-unfinished-again");
    const auditRows = await fixture.database
      .prepare("SELECT COUNT(*) AS count FROM site_audit_log WHERE site_id = ? AND operation = 'delete'")
      .bind(upload.site.id)
      .first<{ count: number }>();
    const receipts = await fixture.database
      .prepare("SELECT COUNT(*) AS count FROM site_operation_receipts WHERE resource_id = ? AND operation = 'delete'")
      .bind(upload.site.id)
      .first<{ count: number }>();
    expect(auditRows?.count).toBe(1);
    expect(receipts?.count).toBe(1);
  });

  it("keeps deployment objects until a failed deletion route is reconciled", async () => {
    const fixture = serviceFixture();
    const site = await publish(fixture.service, "alice", "failed-delete-upload", "failed-delete-activation");
    const deployment = await fixture.database
      .prepare("SELECT current_deployment_id FROM hosted_sites WHERE id = ?")
      .bind(site.id)
      .first<{ current_deployment_id: string }>();
    const asset = `sites/${site.id}/deployments/${deployment?.current_deployment_id}/index.html`;
    fixture.bucket.failNextPutContaining(`routes/${site.hostname}.json`);

    await expect(fixture.service.delete("alice", site.id, "failed-delete-key")).rejects.toThrow(
      "Injected R2 put failure",
    );
    expect(await fixture.bucket.route(site.hostname)).toMatchObject({ status: "active" });
    expect(fixture.bucket.keys()).toContain(asset);

    await fixture.service.cleanup();
    expect(await fixture.bucket.route(site.hostname)).toMatchObject({ status: "deleted" });
    expect(fixture.bucket.keys()).not.toContain(asset);
  });

  it("processes more than one cleanup batch", async () => {
    const fixture = serviceFixture();
    for (let index = 0; index < 51; index += 1) {
      await fixture.database
        .prepare(
          `INSERT INTO hosted_sites(
             id, user_id, hostname, title, description, framework, spa_fallback, status,
             current_deployment_id, created_at, updated_at, expires_at, route_synced_at
           ) VALUES (?, 'alice', ?, 'Expired site', 'Expired cleanup backlog.', 'vanilla', 0, 'active',
             NULL, ?, ?, ?, ?)`,
        )
        .bind(
          `expired-cleanup-${index}`,
          `expired-cleanup-project-number-${index}-abcdefghij.openbot.site`,
          fixture.now() - 31 * 24 * 60 * 60_000,
          fixture.now() - 31 * 24 * 60 * 60_000,
          fixture.now() - 1,
          fixture.now(),
        )
        .run();
    }

    await expect(fixture.service.cleanup()).resolves.toMatchObject({ expired: 51 });
    const active = await fixture.database
      .prepare("SELECT COUNT(*) AS count FROM hosted_sites WHERE status = 'active' AND expires_at <= ?")
      .bind(fixture.now())
      .first<{ count: number }>();
    expect(active?.count).toBe(0);
  });

  it("rate limits repeated new-site creation after deleted sites release their slots", async () => {
    const fixture = serviceFixture();
    for (let index = 0; index < 20; index += 1) {
      const upload = await fixture.service.createUpload(
        "alice",
        uploadRequest({ title: `Disposable hosted project ${index}` }),
        `churn-${index}`,
      );
      await fixture.service.delete("alice", upload.site.id, `delete-churn-${index}`);
    }

    await expect(
      fixture.service.createUpload("alice", uploadRequest({ title: "One more disposable project" }), "churn-21"),
    ).rejects.toMatchObject({ code: "site_creation_rate_limit" });
  });

  it("preserves SPA fallback on replacement unless a new value is explicit", async () => {
    const fixture = serviceFixture();
    const site = await publish(fixture.service, "alice", "publish-spa", "activate-spa", { spaFallback: true });
    const preserved = await fixture.service.createUpload(
      "alice",
      uploadRequest({ siteId: site.id, spaFallback: null }),
      "replace-spa-preserved",
    );
    await uploadIndex(fixture.service, "alice", preserved.uploadId);
    await fixture.service.activate("alice", preserved.uploadId, "activate-spa-preserved");
    expect(await fixture.bucket.route(site.hostname)).toMatchObject({ spaFallback: true });

    const disabled = await fixture.service.createUpload(
      "alice",
      uploadRequest({ siteId: site.id, spaFallback: false }),
      "replace-spa-disabled",
    );
    await uploadIndex(fixture.service, "alice", disabled.uploadId);
    await fixture.service.activate("alice", disabled.uploadId, "activate-spa-disabled");
    expect(await fixture.bucket.route(site.hostname)).toMatchObject({ spaFallback: false });
  });
});

function serviceFixture(): {
  service: HostedSiteService;
  database: FakeD1Database;
  bucket: FakeR2Bucket;
  now: () => number;
  setNow: (value: number) => void;
} {
  const sqlite = new DatabaseSync(":memory:");
  databases.push(sqlite);
  sqlite.exec("PRAGMA foreign_keys = ON; CREATE TABLE users(id TEXT PRIMARY KEY);");
  sqlite.exec(migration("0012_hosted_sites.sql"));
  sqlite.prepare("INSERT INTO users(id) VALUES (?), (?)").run("alice", "bob");
  const database = new FakeD1Database(sqlite);
  const bucket = new FakeR2Bucket();
  let currentTime = NOW;
  return {
    service: new HostedSiteService(database, bucket, () => currentTime),
    database,
    bucket,
    now: () => currentTime,
    setNow: (value) => {
      currentTime = value;
    },
  };
}

async function publish(
  service: HostedSiteService,
  userId: string,
  publishKey: string,
  activateKey: string,
  changes: Partial<HostedSiteUploadRequest> = {},
) {
  const session = await service.createUpload(userId, uploadRequest(changes), publishKey);
  await uploadIndex(service, userId, session.uploadId);
  return service.activate(userId, session.uploadId, activateKey);
}

function uploadRequest(changes: Partial<HostedSiteUploadRequest> = {}): HostedSiteUploadRequest {
  return {
    title: "Interactive student budget planner",
    description: "A small static tool for university students.",
    framework: "vanilla",
    spaFallback: false,
    siteId: null,
    files: [{ path: "index.html", size: new TextEncoder().encode(HTML).byteLength, mimeType: "text/html" }],
    ...changes,
  };
}

async function uploadIndex(service: HostedSiteService, userId: string, uploadId: string): Promise<void> {
  await service.uploadFile(
    userId,
    uploadId,
    "index.html",
    new Request("https://openbot.run/v1/sites/upload", {
      method: "PUT",
      headers: { "Content-Type": "text/html", "Content-Length": String(new TextEncoder().encode(HTML).byteLength) },
      body: HTML,
    }),
  );
}

function migration(name: string): string {
  return readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8");
}

class FakeD1Database implements D1Database {
  #failFragment: string | null = null;
  #pause: { fragment: string; started: () => void; wait: Promise<void> } | null = null;

  constructor(private readonly database: DatabaseSync) {}

  failNextBatchContaining(fragment: string): void {
    this.#failFragment = fragment;
  }

  pauseNextBatchContaining(fragment: string): { started: Promise<void>; resume: () => void } {
    let markStarted: () => void = () => undefined;
    let resume: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      resume = resolve;
    });
    this.#pause = { fragment, started: markStarted, wait };
    return { started, resume };
  }

  prepare(query: string): D1PreparedStatement {
    return new FakeD1Statement(this.database, query);
  }

  async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    const owned = statements.map((statement) => {
      if (!(statement instanceof FakeD1Statement)) throw new Error("The test received an unknown D1 statement.");
      return statement;
    });
    if (this.#failFragment && owned.some((statement) => statement.query.includes(this.#failFragment ?? ""))) {
      this.#failFragment = null;
      throw new Error("Injected D1 failure");
    }
    const pause = this.#pause;
    if (pause && owned.some((statement) => statement.query.includes(pause.fragment))) {
      this.#pause = null;
      pause.started();
      await pause.wait;
    }
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results = owned.map((statement) => statement.execute<T>());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  async exec(query: string): Promise<D1ExecResult> {
    this.database.exec(query);
    return { count: 0, duration: 0 };
  }

  withSession(): D1DatabaseSession {
    throw new Error("D1 sessions are not used by this test.");
  }

  async dump(): Promise<ArrayBuffer> {
    throw new Error("D1 dumps are not used by this test.");
  }
}

class FakeD1Statement implements D1PreparedStatement {
  constructor(
    private readonly database: DatabaseSync,
    readonly query: string,
    private readonly values: SQLInputValue[] = [],
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    return new FakeD1Statement(this.database, this.query, values.map(sqlValue));
  }

  async first<T = unknown>(columnName?: string): Promise<T | null> {
    const row = this.database.prepare(this.query).get(...this.values);
    if (!row) return null;
    return genericValue<T>(columnName ? row[columnName] : row);
  }

  async run<T = unknown>(): Promise<D1Result<T>> {
    const result = this.database.prepare(this.query).run(...this.values);
    return d1Result<T>([], Number(result.changes), Number(result.lastInsertRowid));
  }

  async all<T = unknown>(): Promise<D1Result<T>> {
    const rows = this.database.prepare(this.query).all(...this.values);
    return d1Result(rows.map(genericValue<T>), 0, 0);
  }

  execute<T>(): D1Result<T> {
    if (/^\s*(?:SELECT|PRAGMA)\b|\bRETURNING\b/iu.test(this.query)) {
      const rows = this.database.prepare(this.query).all(...this.values);
      const changes = Number(this.database.prepare("SELECT changes() AS changes").get()?.changes ?? 0);
      return d1Result(rows.map(genericValue<T>), changes, 0);
    }
    const result = this.database.prepare(this.query).run(...this.values);
    return d1Result<T>([], Number(result.changes), Number(result.lastInsertRowid));
  }

  raw<T = unknown[]>(options: { columnNames: true }): Promise<[string[], ...T[]]>;
  raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
  raw(): Promise<never> {
    throw new Error("Raw D1 results are not used by this test.");
  }
}

function sqlValue(value: unknown): SQLInputValue {
  if (value === null || isString(value) || isNumber(value)) return value;
  throw new Error("The test received an unsupported D1 binding.");
}

function genericValue<T>(value: unknown): T {
  // biome-ignore lint/nursery/noUnsafeTypeAssertion: This test adapter implements D1's generic decoding boundary.
  return value as T;
}

function d1Result<T>(results: T[], changes: number, lastRowId: number): D1Result<T> {
  return {
    success: true,
    results,
    meta: {
      duration: 0,
      size_after: 0,
      rows_read: 0,
      rows_written: changes,
      last_row_id: lastRowId,
      changed_db: changes > 0,
      changes,
    },
  };
}

type Bytes = Uint8Array<ArrayBuffer>;

class FakeR2Bucket implements R2Bucket {
  private readonly objects = new Map<string, { bytes: Bytes; metadata?: R2HTTPMetadata }>();
  #failPutFragment: string | null = null;
  #pausePut: { fragment: string; started: () => void; wait: Promise<void> } | null = null;

  failNextPutContaining(fragment: string): void {
    this.#failPutFragment = fragment;
  }

  pauseNextPutContaining(fragment: string): { started: Promise<void>; resume: () => void } {
    let markStarted: () => void = () => undefined;
    let resume: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      resume = resolve;
    });
    this.#pausePut = { fragment, started: markStarted, wait };
    return { started, resume };
  }

  keys(): string[] {
    return [...this.objects.keys()];
  }

  async route(hostname: string): Promise<unknown> {
    const stored = this.objects.get(`routes/${hostname}.json`);
    return stored ? JSON.parse(new TextDecoder().decode(stored.bytes)) : null;
  }

  async head(key: string): Promise<R2Object | null> {
    const stored = this.objects.get(key);
    return stored ? new FakeR2Object(key, stored.bytes, stored.metadata) : null;
  }

  async get(key: string): Promise<R2ObjectBody | null> {
    const stored = this.objects.get(key);
    return stored ? new FakeR2Object(key, stored.bytes, stored.metadata) : null;
  }

  async put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob,
    options?: R2PutOptions,
  ): Promise<R2Object> {
    const pause = this.#pausePut;
    if (pause && key.includes(pause.fragment)) {
      this.#pausePut = null;
      pause.started();
      await pause.wait;
    }
    if (this.#failPutFragment && key.includes(this.#failPutFragment)) {
      this.#failPutFragment = null;
      throw new Error("Injected R2 put failure");
    }
    const bytes = await bodyBytes(value);
    this.objects.set(key, { bytes, ...(options?.httpMetadata ? { metadata: metadata(options.httpMetadata) } : {}) });
    return new FakeR2Object(key, bytes, options?.httpMetadata ? metadata(options.httpMetadata) : undefined);
  }

  async delete(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.objects.delete(key);
  }

  async list(options?: R2ListOptions): Promise<R2Objects> {
    const prefix = options?.prefix ?? "";
    return {
      objects: [...this.objects.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, stored]) => new FakeR2Object(key, stored.bytes, stored.metadata)),
      delimitedPrefixes: [],
      truncated: false,
    };
  }

  createMultipartUpload(): Promise<R2MultipartUpload> {
    throw new Error("Multipart R2 uploads are not used by this test.");
  }

  resumeMultipartUpload(): R2MultipartUpload {
    throw new Error("Multipart R2 uploads are not used by this test.");
  }
}

class FakeR2Object implements R2ObjectBody {
  readonly version = "test";
  readonly etag = "test";
  readonly httpEtag = '"test"';
  readonly checksums: R2Checksums = { toJSON: () => ({}) };
  readonly uploaded = new Date(NOW);
  readonly customMetadata = undefined;
  readonly range = undefined;
  readonly storageClass = "Standard";
  readonly ssecKeyMd5 = undefined;
  readonly bodyUsed = false;

  constructor(
    readonly key: string,
    private readonly content: Bytes,
    readonly httpMetadata?: R2HTTPMetadata,
  ) {}

  get size(): number {
    return this.content.byteLength;
  }

  get body(): ReadableStream<Uint8Array> {
    return new Blob([copyArrayBuffer(this.content)]).stream();
  }

  writeHttpMetadata(headers: Headers): void {
    if (this.httpMetadata?.contentType) headers.set("Content-Type", this.httpMetadata.contentType);
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    return copyArrayBuffer(this.content);
  }

  async bytes(): Promise<Uint8Array> {
    return new Uint8Array(this.content);
  }

  async text(): Promise<string> {
    return new TextDecoder().decode(this.content);
  }

  async json<T>(): Promise<T> {
    return genericValue<T>(JSON.parse(await this.text()));
  }

  async blob(): Promise<Blob> {
    return new Blob([copyArrayBuffer(this.content)]);
  }
}

async function bodyBytes(value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob): Promise<Bytes> {
  if (value === null) return new Uint8Array();
  if (isString(value)) return new TextEncoder().encode(value);
  if (value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    const copy = new Uint8Array(value.byteLength);
    copy.set(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    return copy;
  }
  return new Uint8Array(await new Response(value).arrayBuffer());
}

function copyArrayBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}

function metadata(value: R2HTTPMetadata | Headers): R2HTTPMetadata {
  if (value instanceof Headers) return { contentType: value.get("Content-Type") ?? undefined };
  return value;
}
