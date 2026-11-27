---
name: gcloud
license: Apache-2.0
description: Use for GCP CLI configs/auth, project and resource operations, Cloud Monitoring, and Cloud Billing.
version: 0.1.0
author: tamntlib
tags:
- GCP
- Cloud
- Configuration
- Inventory
---

# Google Cloud CLI (`gcloud`)

Safely select or prepare a named `gcloud` CLI configuration and auth scope, resolve the target GCP project (and deployment environment when applicable), and run live project/resource operations, Cloud Monitoring queries, or Cloud Billing lookups. Reads are the default—this workflow does not deploy infrastructure, change IAM, or configure Application Default Credentials (ADC) unless explicitly authorized; it requires the Google Cloud CLI and an authorized identity.

## When to Use
- “List instances on GCP.”
- “Use this project and staging environment.”
- “Create a named configuration without changing my active configuration.”
- Read or operate on GCP projects/resources, Cloud Monitoring metrics, or Cloud Billing SKUs with explicit configuration, project, and account scope.

## Prerequisites
- Run `gcloud version` to verify the CLI; reuse existing installations.
- If missing, consult https://cloud.google.com/sdk/docs/install and agree on an installation method before adding host dependencies.
- Reuse existing authorized credentials. Never inspect credential files, print tokens, or automatically create service-account keys.
- No new environment variables or ADC setup are required. `$CFG`, `$PROJECT_ID`, `$ACCOUNT`, and `$DISCOVERY_CFG` below denote verified task values, not inherited defaults.
- Update package-managed installations through their package manager, not `gcloud components update`.

## How to Run
Run resource commands only after completing the selection procedure, passing `--configuration` and `--project` explicitly:

```bash
gcloud --configuration="$CFG" projects describe "$PROJECT_ID" --format='json(projectId,name,lifecycleState)'
```

Use the task-appropriate service command (for example, `compute instances list`, `run services list`, `storage ls`, or `logging read` below) rather than assuming every project enables the Compute Engine API. Never silently mutate `default`, globally activate a configuration, or rely on an unverified globally active configuration; read-only use of `default` is acceptable only when explicitly selected and verified for the task.

## Quick Reference
```bash
gcloud version
gcloud config configurations list --format='json(name,properties.core.project,properties.core.account,properties.auth.impersonate_service_account)'
gcloud --configuration="$DISCOVERY_CFG" projects list --format='json(projectId,name,lifecycleState)'
gcloud config configurations create "$CFG" --no-activate
gcloud --configuration="$CFG" config set core/project "$PROJECT_ID"
gcloud --configuration="$CFG" config set core/account "$ACCOUNT"
gcloud config configurations describe "$CFG" --format='yaml(name,properties.core.project,properties.core.account,properties.auth.impersonate_service_account)'
gcloud --configuration="$CFG" projects describe "$PROJECT_ID" --format='json(projectId,name,lifecycleState)'
gcloud --configuration="$CFG" compute instances list --project="$PROJECT_ID" --format='json(name,zone,machineType,status,labels)'
gcloud --configuration="$CFG" run services list --project="$PROJECT_ID" --region="$REGION" --format=json
gcloud --configuration="$CFG" storage ls "gs://$BUCKET/$PREFIX"
gcloud --configuration="$CFG" logging read "$FILTER" --project="$PROJECT_ID" --limit=50 --format='table(timestamp,severity,resource.type)'
```

## Procedure
1. **Discover local context.** Check the workspace name and relevant non-secret project documentation, and inspect existing CLI configurations. Do not read `.env` or credential files. Missing configurations do not prove an environment is absent.
2. **Keep scope dimensions separate:** workspace/project name, GCP project ID (`core/project`), and—when applicable—deployment environment. A project ID supplied in reply to “which project?” does not also select an environment; never derive environment solely from the project ID.
3. **Resolve the project.** If the mapping is unknown, verify an existing configuration with `gcloud config configurations describe` and use it only for read-only `projects list` discovery. Sort and present display names and exact IDs so the user can choose; do not omit candidates whose names look unrelated to the repo. Discovery access does not automatically select that configuration for target operations.
4. **Resolve the environment (when environment-scoped).** Required only when targeting environment-scoped workloads or resources (pure project-level queries such as Cloud Billing Catalog, project-wide Cloud Monitoring, or project metadata/IAM inspection do not require an environment label). When needed, use explicit user context or verified project docs/configurations, normalizing only generic aliases (`dev`/`development`, `staging`/`stage`, `prod`/`production`). If ambiguous, ask (batching independent missing questions); never infer environment solely from a configuration name or `core/project`.
5. **Select an existing configuration or validate a new name.**
   - Reuse an existing verified configuration whenever possible: describe candidates to confirm account, impersonation, and default project.
   - For multi-project accounts, pass `--project` explicitly per operation instead of rewriting a shared configuration's `core/project` or creating redundant configurations.
   - When creating a new configuration, validate the proposed name against gcloud's `^[a-z][a-z0-9-]*$` rule (lowercase ASCII letters, digits, and hyphens; must start with a letter; no underscores).
   - Check existing configurations for name collisions before creation; never overwrite a mismatched configuration or silently alter an explicit name.
6. **Obtain creation approval if absent.** State the missing configuration and propose its exact name, default project, and account. Ask once for permission to create it and run the requested read; do not treat an environment answer alone as creation approval.
7. **Create without activation.** After approval, run the create/set commands in Quick Reference, stopping on any failure. Always pass `--no-activate` on creation and explicit `--configuration` on property writes. Named configurations share credentials; they do not create a new authentication boundary.
8. **Read back the configuration.** Run `gcloud config configurations describe` and confirm exact project, account, and any impersonation setting. Stop on mismatches; never fall back silently to `default`, inherited `CLOUDSDK_ACTIVE_CONFIG_NAME`, or project-local environment files.
9. **Read live resources.** Run `projects describe` or the task-scoped read command and verify exit status. Parse JSON output and compute any declared counts programmatically. A failed API call is not an empty inventory; permission or disabled-API errors do not authorize enabling APIs or granting roles.
10. **Report the actual scope.** Present the queried resource fields, any configuration changes, and blockers. A configuration name does not filter project-wide resources: explicitly label unfiltered responses as project-wide, and verify label or name filters before claiming environment isolation.

## Pitfalls
- Repo folder, GCP project ID, and environment can all differ; verify their mapping in the current workspace rather than assuming they match.
- `gcloud auth login` authenticates the CLI; ADC serves applications and is not isolated by named configurations. Configure ADC only when explicitly requested.
- CLI success does not prove application authentication works; investigate runtime identity separately.
- Never print full environment or configuration dumps, authorization codes, or partial secrets. Avoid `set -x` and `--log-http` in sensitive flows.
- Reads are the default. Deployments, uploads, IAM/billing/API changes, and deletions require explicit scope. Do not use `--quiet` to bypass unapproved decisions.
- Storage scope is the bucket and prefix, not merely `--project`; uploads can trigger pipelines. Bound log queries by resource, time, and count to avoid unnecessary personal data.
- Check exit codes, do not hide errors with `|| true`, and never retry an uncertain mutation without inspecting the target first.
- After external mutations, read back the exact target and check asynchronous operation or health status before claiming success.

## Monitoring & Billing Pitfalls
- **Metric descriptor paths:** Query Cloud Monitoring descriptors with the full metric-type path under `/metricDescriptors/` without percent-encoding its `/` path separators. Keep GAUGE samples, DELTA intervals, and DISTRIBUTION aggregations distinct, and preserve actual time windows and pagination.
- **Regional pricing verification:** Verify regional pricing via paginated Cloud Billing Catalog SKUs for the exact service, region, edition, and usage type; static pricing-page HTML can remain on the default region even when a region query parameter is supplied.
- **Provisioned vs. guest disk usage:** A disk's provisioned `sizeGb` or `READY` state does not report remaining filesystem capacity. Measure guest space via authorized guest commands (`df`) or Ops Agent telemetry (`agent.googleapis.com/disk/bytes_used` filtered to the exact `gce_instance` ID and `device`/`state` labels), reporting sample freshness rather than equating telemetry with direct guest reads.

## Verification
After configuration readback matches the intended project and account, verify live access with `gcloud --configuration="$CFG" projects describe "$PROJECT_ID"` or the task-scoped read command (do not mandate `compute instances list`, which fails on projects without the Compute Engine API enabled). A successful exit status and parsed response prove live API access; local configuration creation alone does not.
