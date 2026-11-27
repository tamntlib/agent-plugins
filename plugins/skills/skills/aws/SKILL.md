---
name: aws
license: Apache-2.0
description: Use for AWS CLI auth/SSO, profile setup or selection, and resource operations.
version: 0.1.0
author: tamntlib
tags:
- AWS
- Cloud
- Profiles
- Inventory
---

# AWS Profile and Resource Selection

Resolve repository context, environment, AWS identity, and region before reading or modifying cloud resources with AWS CLI v2.

## When to Use
- Listing or inspecting AWS resources in a target account and region (e.g., EC2 instances, S3 buckets, IAM roles).
- Selecting or verifying an AWS profile and caller identity before AWS CLI operations.
- Setting up a project-specific AWS profile without altering global defaults.

## Prerequisites
- Run `aws --version` to reuse an existing AWS CLI v2 installation. If missing, consult https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html and obtain approval before installing host dependencies.
- Confirm the target account's approved auth method from the user or verified project docs (IAM Identity Center / SSO, existing role or credential provider, ambient workload identity, or IAM user access keys). Another project's SSO profile does not establish the auth method for this account.

## Security and Scope
- Read-only is the default. Account creation, IAM grants, resource mutations, SSM commands, uploads, and deletions require explicit task authorization; local profile creation never authorizes cloud mutations.
- Never collect, type, log, print, or store passwords, access keys, session tokens, MFA/OTP codes, OAuth authorization codes, `device_code` values, or credential-file contents in chat, CLI arguments, repo files, or reports.
- Reuse existing authorized access; do not create IAM access keys, copy credentials between profiles, or reuse CI/CD credentials for read-only work.
- Inspect local config only via the allowlisted non-secret `aws configure get` keys below—never read `~/.aws/credentials`, dump env vars, run `aws configure list` (may expose partial keys), or enable debug logging.
- Keep TLS verification enabled and never substitute local emulator output for live AWS evidence.

## How to Run

After selecting the profile/identity and verifying caller identity via STS, invoke AWS CLI v2 with `--no-cli-pager` and `--output json`:

```bash
aws --profile "$PROFILE" --region "$REGION" --no-cli-pager <service> <operation> --output json
# Example:
aws --profile "$PROFILE" --region "$REGION" --no-cli-pager ec2 describe-instances --output json
```

- Pass `--profile` and `--region` explicitly when using named profiles.
- Never silently modify `default` or global profile/region defaults, and never fall back to `default` on auth or profile mismatch.
- Read-only use of `default`, `AWS_PROFILE`, or ambient workload identity (e.g., EC2 IMDS, ECS task roles, IRSA) is permitted when explicitly configured for the target environment and verified via `sts get-caller-identity`.

## Quick Reference
```bash
aws --version
aws configure list-profiles
aws configure get region --profile "$PROFILE"
aws configure get sso_account_id --profile "$PROFILE"
aws configure get sso_role_name --profile "$PROFILE"
aws configure get sso_session --profile "$PROFILE"
aws configure get sso_start_url --profile "$PROFILE"
aws configure get sso_region --profile "$PROFILE"
aws configure get role_arn --profile "$PROFILE"
aws configure get source_profile --profile "$PROFILE"
aws configure get credential_process --profile "$PROFILE"
aws configure get endpoint_url --profile "$PROFILE"
aws configure get services --profile "$PROFILE"
aws --profile "$PROFILE" --region "$REGION" --no-cli-pager sts get-caller-identity --output json
```

## Procedure
1. **Discover context.** Inspect relevant non-secret repository documentation and run `aws --version` and `aws configure list-profiles` (local read-only).
2. **Separate scope dimensions.** Keep repository, deployment environment, profile name, expected AWS account ID, expected role/principal, and resource region distinct. Resolve missing values from verified docs or batch focused questions for the user.
3. **Inspect candidate metadata safely.** Query only the allowlisted `aws configure get` keys above; missing optional keys are not auth failures, and `configure get` reads config files only (not runtime env overrides).
4. **Select or create a profile.**
   - Prefer an existing matching profile and preserve its exact name (including underscores).
   - Verify account/role/region metadata before use; do not parse profile names to infer environment or IAM boundaries.
   - Check the existing profile list for collisions before creating a new profile; never overwrite an existing profile or invent suffixes silently.
   - For a new profile, follow documented project naming rules or ask the user for an explicit name, confirming target account, role/provider, region, and auth method before creation.
5. **Set up only the confirmed auth method.**
   - *Existing role or credential provider:* follow its approved workflow (temporary session credentials require the provider's setup, not the static key wizard).
   - *Approved IAM user access keys:* have the user run `aws configure --profile "$PROFILE"` locally in a private, unrecorded terminal as the executing OS user (writing keys to `~/.aws/credentials` and region/output to `~/.aws/config`), setting region and `json` output, then share only the non-secret profile name and scope.
   - *Confirmed IAM Identity Center (SSO):*
     - Consult https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-sso.html if needed, then run `aws configure sso --profile "$PROFILE" --use-device-code --no-browser` in an interactive PTY/background shell, entering known session name, start URL, SSO region, and registration scope directly.
     - Share the CLI-generated verification URL and temporary device **user code** together so the user can approve on AWS (narrowly permitted for user-requested login; do not persist the user code). After approval, complete account/role, client region, and output prompts from verified scope (ask only if ambiguous); if a raw-terminal menu ignores `\n`, send `\r` for Enter and verify the selection.
     - For expired SSO sessions, run `aws sso login --profile "$PROFILE" --use-device-code --no-browser` with the same handoff (if expired, initiate a fresh login), and read back allowlisted profile metadata afterward.
6. **Verify effective identity.** Run `sts get-caller-identity` with the selected profile/identity and region. Compare `Account` and `Arn` against expectations (STS assumed-role session ARNs need semantic role comparison, not literal equality with an IAM role ARN). If expected identity was unknown, confirm it with the user before reading resources. Stop on mismatch or auth failure; never switch to `default`.
7. **Read scoped resources.** Run the authorized AWS CLI read with automatic pagination enabled (never use `--no-paginate` or `--max-items` and claim completeness). Parse JSON with Python or `jq` (e.g., flattening `Reservations[].Instances[]` for EC2), deduplicating by region and resource ID and computing counts programmatically. Persist batches to a task-local JSON file for multi-region queries.
8. **Report actual coverage.** Show account, region(s), resource IDs, requested attributes/tags (never invent absent values), and any per-region errors. Label unfiltered reads as the full selected account/region; for environment-specific subsets, establish verified tag keys/values or exact resource IDs first. For all-region queries, confirm the enabled/authorized region set and record every success/failure before claiming totals.

## Pitfalls
- **Metadata != effective identity:** Role chains, credential providers, and env overrides can change effective credentials; STS verification is mandatory. If overrides are suspected, check variable names/presence and allowlisted metadata only—never print secrets, silently unset env vars, or run unfamiliar credential providers.
- **Endpoint overrides:** Unexpected `AWS_ENDPOINT_URL*` or profile endpoints can divert traffic from AWS; resolve them before treating output as live AWS evidence.
- **STS != permissions:** `sts get-caller-identity` identifies the caller only. Treat `AccessDenied` as a blocker, never an empty inventory.
- **Regionality & SSO region:** Most resources (including EC2) are regional, and the SSO region often differs from the workload region; do not conflate them.
- **Eventual consistency:** Recently changed or terminated resources (e.g., terminated EC2 instances) can remain visible briefly; preserve returned states and verify mutations with bounded retries.
- **Shared accounts:** One AWS account can host multiple environments; neither account ID, `Name` tag, nor profile name alone proves isolation.
- **Mutations:** Never suppress failures or blindly retry uncertain writes; after authorized changes, read back the exact target and verify health.

## Verification
For profile creation or SSO login alone, verify allowlisted profile metadata and a matching `sts get-caller-identity` result—do not run unrelated resource inventories. When resource access is requested, verify the scoped read using the same profile/region with complete pagination. A genuine empty result set (e.g., empty `Reservations` for EC2) is a valid empty inventory; a failed command, `AccessDenied`, or a locally created profile is not. Distinguish local/static checks from live AWS calls.
