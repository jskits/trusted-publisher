# Product Positioning

As of June 20, 2026, npm trusted publishing is available through the official
`npm trust` command, but the command documentation states that it is unaware of
workspaces. npm also documents bulk usage as a shell loop over package names,
with a 2 second delay between calls to avoid rate limiting.

This project should therefore focus on the work npm does not do for monorepos:

- discover publishable packages from npm, pnpm, Yarn, Lerna, Nx, and Turbo layouts;
- infer the GitHub `owner/repo` value from local git remotes;
- inspect GitHub Actions workflow files and identify the publishing workflow filename npm expects;
- classify plans by confidence instead of blindly changing npm package settings;
- check whether packages already exist and whether trusted publisher settings are already present;
- render and execute the correct `npm trust github` commands with throttling and a clear summary.

## Related Tools And Gaps

Official npm support:

- `npm trust github` is the authoritative low-level command for creating GitHub Actions trusted
  publisher relationships.
- The npm docs say packages must already exist, trust commands require npm with trusted-publishing
  support, and each package can have only one trusted publisher configuration.
- GitHub announced bulk trusted publishing configuration in npm CLI v11.10.0+, but the current
  command documentation still says `npm trust` is not workspace-aware and describes bulk operation
  as scripting over packages.

Adjacent community tooling:

- Changesets, semantic-release, Lerna, Nx, Turbo, release-it presets, and similar tools help with
  versioning and publishing, but they do not configure npm trusted publisher relationships for every
  package in a monorepo.
- Several repositories document a one-off `npm trust github ...` command in their README, but this
  is project-specific guidance rather than a reusable monorepo setup tool.
- GitHub Community discussions include requests for organization-level defaults, wildcard package
  matching, and bulk APIs, which confirms this is still painful for maintainers with many packages.

## Product Boundary

The first release should be GitHub Actions only. GitLab and CircleCI can be added later because
their trust claims and required fields differ.

The CLI should be conservative by default:

- `trusted-publisher` scans and prints a plan.
- `trusted-publisher --dry-run` prints the exact commands without changing npm.
- `trusted-publisher --yes` applies only high-confidence plans.
- `trusted-publisher --replace` is required before revoking and recreating an existing conflicting
  trusted publisher configuration.
