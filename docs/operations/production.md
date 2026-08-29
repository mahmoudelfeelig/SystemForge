# Production release boundary

SystemForge uses a two-part release design. This public repository builds,
tests, scans, and identifies a release. A restricted release control plane owns
promotion, routing, persistence, backup, restore, and rollback.

The public repository intentionally contains no machine addressing, login
details, transport configuration, credential identifiers, internal filesystem
layout, or private service topology. Those values are operational state and
must remain outside source control, workflow logs, artifacts, issue text, and
public documentation.

## Release trigger

The production caller runs only when `SystemForge CI` completes for `main`. Its
job-level guard requires all of the following:

- the CI conclusion is successful;
- the initiating event was a push;
- the reported head branch is `main`;
- the head repository is this repository.

Pull requests, forks, manual dispatches, scheduled events, failed CI runs, and
non-main pushes cannot request a production release through this caller.

## Public caller contract

The caller grants only read access to Actions metadata, read access to repository
contents, and permission to request a short-lived identity token. It invokes one
immutable, reviewed reusable workflow revision and sends exactly three values:

- the fixed application identifier `systemforge`;
- the successful workflow run's head SHA;
- the successful workflow run's numeric identifier.

The caller contains no executable deployment steps, credential forwarding,
host commands, or infrastructure configuration. Its reusable-workflow revision
is pinned to a full commit SHA. Changes to that SHA require review and a passing
contract test before merge.

## CI artifact contract

CI builds the API, web, and worker images with the tested source SHA. It scans
that exact image set, packages it with a checksum, uploads it with short
retention, and downloads the same named artifact for integration testing. The
integration job verifies the checksum, loads the images, and starts the stack
without rebuilding.

This provides evidence that the release request refers to the same source and
container set exercised by CI. A green build is still only one release gate;
the restricted control plane independently verifies the request and performs
the operational safety gates before promotion.

## Restricted release responsibilities

Infrastructure-specific behavior belongs exclusively to the restricted control
plane. Its responsibilities include:

- authenticating the release request and checking its repository, workflow,
  commit, branch, event, and conclusion;
- resolving immutable images and rejecting missing or superseded releases;
- creating a current backup and proving an isolated restore before mutation;
- applying the candidate with bounded health and smoke checks;
- preserving the previous known-good release until acceptance;
- rolling back application state and routing when acceptance fails;
- issuing a signed, auditable receipt for the final outcome.

Public workflow changes must not recreate any of those responsibilities in this
repository. In particular, the caller must never gain direct machine access,
embed infrastructure coordinates, or receive long-lived deployment credentials.

## Data and rollback invariants

Application migrations must remain compatible with the immediately previous
release because schema rollback is not automatic. Promotion must fail closed if
backup, restore, health, or smoke evidence is missing. An incomplete candidate
must never replace the last accepted release, and a failed first promotion must
not leave a partially available stack.

Operational backup locations, retention configuration, off-site destinations,
and recovery procedures are deliberately maintained with the restricted release
configuration. This public document records the required outcomes without
publishing the infrastructure needed to reach them.

## Monitoring and incident response

Production monitoring should validate the public shell and canonical readiness
without depending on retired repository deployment variables. A readiness
failure should not disable browser-local functionality. Operators should inspect
the restricted service telemetry, preserve the accepted release, and restore
canonical submission only after queue and worker health are stable.

## Changing the boundary

Any change to the release caller must keep `scripts/deploy_workflow_contract.test.sh`
green. Reviewers should reject a change that adds another input, executable
step, mutable action reference, elevated permission, infrastructure literal, or
credential surface. Changes to private release behavior are reviewed and tested
in the restricted control-plane repository, not mirrored into this one.
