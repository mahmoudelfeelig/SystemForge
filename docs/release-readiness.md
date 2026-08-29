# Release-readiness evidence

SystemForge production releases now use the two-part deployment boundary
documented in `docs/operations/production.md`. Protected CI builds, scans,
checksums, and integration-tests the exact application images. The minimal OIDC
caller then sends only the application identifier, successful source SHA, and CI
run identifier to an immutable reusable workflow.

The restricted release controller is responsible for provenance validation,
immutable image promotion, backup and restore gates, bounded application smoke
checks, routing, rollback, and signed release receipts. Machine addressing,
credentials, private paths, service placement, and recovery destinations are
not release evidence that belongs in this public repository.

Repository evidence establishes application behavior and the public caller
contract. It does not by itself establish that a release was accepted, that a
current backup is independently recoverable, or that a live endpoint is healthy.
Those claims require a controller receipt and fresh external checks for the same
source SHA.

Historical deployment transcripts and infrastructure-specific rehearsal notes
were retired when the central controller became authoritative. Git history may
still contain earlier public text; removing files from the current revision is
not a substitute for credential rotation or history rewriting if a real secret
is ever discovered.
