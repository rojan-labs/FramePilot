# Runbook: Public Repository Release

Use this checklist before changing FramePilot from private to public. The visibility toggle comes
only after the history, credential, licensing, and repository-surface audits are complete. Some
GitHub Free protections, including repository rulesets, become available only after the repository
is public and therefore must be configured immediately after the visibility switch.

## 1. Licensing boundary

FramePilot is intended to be **source-available, non-commercial software**. Public availability
does not make the project OSI-approved open source. The repository `LICENSE` grants free reuse,
modification, and contribution rights for non-commercial purposes only; it grants no
redistribution, hosting, or commercial rights beyond what is explicitly permitted in the license
text or that GitHub's Terms of Service or applicable law require. Third-party code and assets
keep their own licenses.

Do not merge a change that reintroduces `MIT`, `Apache-2.0`, `GPL`, or another project-level
license into a FramePilot package manifest unless the project licensing decision itself is being
changed deliberately. References to third-party dependency licenses are expected and must remain.

### Historical MIT license blocker

The private repository history predating this hardening change contains a project-level MIT
license and MIT declarations in FramePilot manifests. Do **not** make that existing history public
if the intent is to avoid publishing historical FramePilot snapshots together with a permissive
license notice.

Before changing visibility:

1. Create and verify a separate private backup or mirror of the complete existing repository
   history.
2. Establish the public repository history from the hardened proprietary tree, or rewrite every
   branch and tag that will become public so historical project-level MIT license notices are not
   exposed as licensing terms for those snapshots.
3. Remove or rewrite stale branches and tags that still expose the old licensing state before the
   repository becomes public.
4. Confirm that FramePilot has the rights needed to relicense all original code being published.
   If another person owns copyright in contributed code, get appropriate permission or legal advice
   before representing that code as proprietary.
5. Preserve third-party license notices. Never rewrite third-party licensing to make dependencies
   appear proprietary.

A new license on the latest commit should not be treated as a substitute for resolving historical
licensing and contributor-rights questions. Get IP/legal review before relying on the custom
license for a commercial public launch.

## 2. Full-history exposure audit

A clean working tree is insufficient. Public visibility exposes reachable Git history and public
GitHub metadata.

Before the visibility change:

1. Scan the complete Git history with a dedicated secret scanner such as Gitleaks or TruffleHog.
2. Search historical commits for provider keys, GitHub tokens, AWS credentials, signing material,
   OAuth secrets, Freemius secrets, database URLs, private certificates, customer data, internal
   URLs, and user media.
3. Rotate any credential that ever entered Git. Removing it from the latest commit does not make
   the old value safe.
4. Review branches and tags, not only `main`.
5. Review Actions logs and artifacts, Releases, issues and PR attachments, wiki content, Pages,
   and published packages.
6. If history contains sensitive material that must not become public, rewrite the affected history
   while the repository is still private, force-update every affected ref, invalidate old clones,
   and rotate the exposed credential anyway.

Record the completed audit in the release issue or PR. Do not store secret values in the record.

## 3. Main branch ruleset

On the current GitHub Free setup, repository rulesets are not available while FramePilot is
private. Prepare the settings below in advance, then create the ruleset immediately after changing
the repository to public. GitHub Pro or higher can configure equivalent rules while the repository
is still private.

Create an active branch ruleset targeting the default branch (`main`). Recommended protections:

- Require a pull request before merging.
- Require all conversations to be resolved before merging.
- Require status checks. Select the stable CI checks after they have run at least once.
- Require branches to be up to date before merging if the extra CI run is acceptable.
- Block force pushes.
- Restrict branch deletion.
- Require linear history if FramePilot continues to use squash/rebase merges.
- Do not require a code-owner approval while `@rjach` is the only code owner. A PR author cannot
  provide an independent approval for their own change. Enable one required approval and code-owner
  review when a second trusted maintainer exists.
- Keep bypass access minimal. Prefer an explicit emergency/admin bypass rather than broad bypass.
- Do not require signed commits until the owner's normal Git and automation commit paths are
  configured to sign commits consistently.

For the current CI, candidate required checks include the TypeScript quality gate, Python engine
quality gate, license scan, E2E smoke, E2E visual regression, desktop build, dependency review, and
the rendered-evaluation gate. Add capability-pack checks only when a ruleset/check configuration
can account for their path-filtered execution without blocking unrelated PRs.

Consider a separate tag ruleset for release tags such as `v*` that blocks tag updates and deletion.
Only enable creation restrictions if the release process and its bypass actor are already tested.

## 4. GitHub Actions

Under **Settings → Actions → General**:

- Set default workflow permissions to **Read repository contents and packages permissions**.
- Leave **Allow GitHub Actions to create and approve pull requests** disabled unless a reviewed
  workflow explicitly needs it.
- Restrict allowed Actions to the actions FramePilot actually uses. Current workflows depend on
  GitHub `actions/*`, `pnpm/action-setup`, `astral-sh/setup-uv`, and
  `apple-actions/import-codesign-certs`.
- Keep secrets only in Actions secrets/environments. Never copy signing or deployment credentials
  into workflow YAML, artifacts, or repository variables intended for public values.
- Protect production release secrets with a GitHub Environment if releases become automated enough
  to justify an approval gate.

Pull-request workflows in this repository declare `contents: read` and disable checkout credential
persistence. The release workflow retains `contents: write` because it creates draft releases and
uploads release assets.

## 5. Security features after visibility changes

Once the repository is public, verify these repository security features:

- Secret scanning and push protection.
- Dependency graph and Dependabot alerts.
- Dependabot security updates if the update volume is acceptable.
- Code scanning using CodeQL default setup.
- Private vulnerability reporting.
- Repository security advisories.

Treat every alert created immediately after the visibility change as pre-existing exposure until it
is investigated. Revoke leaked credentials before marking an alert resolved.

## 6. Pull-request and repository hygiene

Recommended repository settings:

- Enable squash merge as the default merge style and automatically delete head branches after merge.
- Keep merge commits disabled if linear history is required.
- Disable wiki, Pages, and Discussions unless FramePilot actively uses them. Every enabled public
  surface is another place that can publish data.
- Keep collaborator access at the minimum role needed.
- Review installed GitHub Apps and deploy keys before going public. Remove stale integrations.
- Review webhooks for endpoints or payloads that should not receive public-repository events.

## 7. Final visibility switch

Only after the licensing history, contributor rights, secret history, credential, Actions, and
repository-surface checks are complete:

1. Merge the hardening PR while the repository is still private.
2. Create and verify a separate private backup of the original repository history.
3. Resolve the historical MIT exposure described in section 1 across every branch and tag that will
   become public.
4. Re-run the history and secret audit against the exact repository refs that will become public.
5. Change repository visibility to public in **Settings → General → Danger Zone**.
6. Immediately create and activate the `main` branch ruleset described in section 3.
7. Immediately enable and verify the security features in section 5.
8. Confirm Actions permissions, ruleset enforcement, release assets, and the public repository page
   behave as expected.
9. Assume the repository has already been cloned after the switch. If anything sensitive is found,
   revoke or rotate it first and then clean history. Returning the repo to private does not erase
   copies already made while it was public.
