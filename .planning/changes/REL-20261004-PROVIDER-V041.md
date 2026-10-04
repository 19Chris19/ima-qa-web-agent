# REL-20261004-PROVIDER-V041

## Goal and boundary

Release the reviewed Docker initialization and private maintenance-browser fixes
as v0.4.1, with versioned ARM64/AMD64 images and the existing Node installation
path. Baseline: public main ce08c55f. Do not change QA contracts, branded UI,
running services, account stores or credentials.

## Work units

1. Test the tag/package/image publication contract before implementation.
2. Add digest-pinned build actions, image provenance and synthetic startup gates.
3. Bump the patch version and document upgrade, rollback and manual enrollment.
4. Review PR/CI, publish images from the merged tag, then verify visibility and
   publish Release. Image publication failure blocks the Release.

## Acceptance and rollback

Full tests, clean package install/pack, image smoke on both architectures and
credential-free image contents. Real IMA enrollment/QA and cloud long-running
operation are not verified by this release pipeline. Roll back code/image only;
never overwrite current account/conversation volumes. Keep main changes behind
an independently reviewed PR.
