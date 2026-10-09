# Reviewed prerelease upgrades

Stable installations should follow the latest non-prerelease GitHub Release.
For explicitly invited early testing, a numbered `vX.Y.Z-rc.N` tag is built by
the same tested ARM64/AMD64 image workflow as a stable tag. Never use arbitrary
main commits or a floating `latest` image as an upgrade channel.

Publication requires merged tag/package equality, tests, architecture startup
checks and an attached release manifest. Inspect its commit and immutable image
digest before updating. A tag without an accepted manifest is not a complete
deployment handoff. Real IMA verification, platform gaps and rollback bounds
are stated separately in the Release notes.

Drain active and queued tasks before switching the single writer. Back up
private configuration and current data; retain the old code/image pointer.
An older release without the durable ledger contract must not be started on
new task state or used to silently retry uncertain tasks. Preserve new data;
select compatible recovery code instead of restoring an old data snapshot.
