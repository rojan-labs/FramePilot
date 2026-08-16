# Public Repository Hardening

**Status:** In progress until the manual GitHub controls and history audit are complete.
**Owner:** @rjach
**Target:** Make `rjach/FramePilot` public without treating the source as open source.

## Repository-side work

- [x] Replace the MIT license with explicit proprietary source-visible terms.
- [x] Remove MIT declarations from Node, Python engine, and Capability Pack manifests.
- [x] Keep third-party components under their own licenses and notices.
- [x] Add repository-wide CODEOWNERS metadata.
- [x] Give pull-request CI an explicit read-only `GITHUB_TOKEN`.
- [x] Disable persisted checkout credentials in pull-request CI paths.
- [x] Add dependency review for newly introduced high-severity dependency risk.
- [x] Ignore generated renders/exports and common local signing credential files.
- [x] Document the visibility-change preflight and GitHub settings in a runbook.
- [x] Update README and contribution language so public visibility is never described as MIT/open source.
- [x] Relicense from fully proprietary (no run/modify/contribute rights) to source-available
      non-commercial terms (LICENSE v2.0, 2026-08-16): free to run, modify, and contribute for
      non-commercial purposes; all commercial use still requires a separate written license.

## Required owner actions before changing visibility

- [ ] Create and verify a separate private backup or mirror of the existing repository history.
- [ ] Resolve the historical MIT licensing state before any old commit becomes public. Establish a
      clean public history from the hardened proprietary tree, or rewrite every public branch and
      tag so project-level MIT license notices from the private history are not published.
- [ ] Confirm FramePilot has the rights required to relicense all original code that will be
      published. Preserve all third-party license notices and get legal review where contributor
      ownership is not clear.
- [ ] Perform a full-history secret scan, including deleted files and old commits.
- [ ] Rotate every credential that has ever appeared in Git history, Actions logs, artifacts,
      releases, issues, pull requests, or committed local configuration.
- [ ] Inspect repository branches, tags, releases, Actions artifacts/logs, wiki, Pages, and
      packages for material that was safe only while the repository was private.
- [ ] Review GitHub Apps, deploy keys, webhooks, Actions secrets, and release credentials.
- [ ] Set default Actions workflow permissions to read-only and keep Actions PR approval disabled.
- [ ] Merge this hardening PR while the repository is still private.

## Required actions immediately after making the repository public

- [ ] Create and activate the `main` branch ruleset from
      `docs/runbooks/public-repository-release.md`. The current GitHub Free setup cannot create
      repository rulesets while FramePilot is private.
- [ ] Enable and verify CodeQL/default code scanning, Dependabot alerts, secret scanning and push
      protection, and private vulnerability reporting.
- [ ] Confirm the public repository page, Actions permissions, release assets, and ruleset behave
      as expected before announcing the repository.

## Non-goals

- Preventing people from technically viewing, cloning, or forking a public GitHub repository.
  Public visibility necessarily exposes the source, and GitHub's Terms permit GitHub users to
  view and fork public repositories.
- Calling FramePilot open source. The repository is source-available under a non-commercial
  license, not an OSI-approved open-source license.
- Replacing a lawyer's review of the custom license before a commercial launch.
