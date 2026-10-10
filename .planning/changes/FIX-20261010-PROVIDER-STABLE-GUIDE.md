# Stable deployment guide consistency

Final audit found stale v0.4.2/RC current-state text in DEPLOYMENT.md and README
after v0.5.0 preparation tag creation. Preserve that tag; issue v0.5.1 with the
correct current installation entry and no execution/account changes. Pair website
v0.3.0 with v0.5.1. New PR, full CI and native multiarch image/manifest acceptance
remain required. No runtime cutover or real question. Rollback retains private
data and uses compatible task-aware code only.
